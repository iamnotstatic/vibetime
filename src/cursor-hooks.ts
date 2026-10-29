import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { writeFileAtomic } from './write-file.js';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { PURPLE } from './colors.js';

const RED = chalk.hex('#EF4444');

type HookEvent = 'session-start' | 'activity' | 'session-end';

// Cursor's native hook names (camelCase) -> the internal `vibe __hook <event>`.
// sessionStart opens, sessionEnd closes, and the per-turn events keep the
// active-time accumulator honest between the two — same shape as Claude/Codex.
const EVENT_MAP: Record<string, HookEvent> = {
  sessionStart: 'session-start',
  beforeSubmitPrompt: 'activity',
  postToolUse: 'activity',
  stop: 'activity',
  sessionEnd: 'session-end',
};

// Cursor's hooks.json is a flat list of commands, not Claude Code's nested
// matcher groups. See https://cursor.com/docs/hooks
interface CursorHook {
  command: string;
  timeout?: number;
  matcher?: string;
  [key: string]: unknown;
}

export interface CursorHooksConfig {
  version?: number;
  hooks?: Record<string, CursorHook[]>;
  [key: string]: unknown;
}

function defaultHooksPath(): string {
  return join(homedir(), '.cursor', 'hooks.json');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function winQuote(value: string): string {
  return `"${value}"`;
}

function quote(value: string): string {
  return process.platform === 'win32' ? winQuote(value) : shellQuote(value);
}

function cursorHookCommand(event: HookEvent): string {
  // Cursor launched from the Dock / Start Menu may not inherit the shell PATH,
  // so pin the current Node executable and this installed CLI entry point.
  // Always emit `{}` on stdout: Cursor parses hook output as JSON, and a silent
  // command shows up as a failed parse in the Hooks channel. `{}` is a no-op
  // for every event we subscribe to (no additional_context, no followup).
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  return `${quote(process.execPath)} ${quote(cli)} __hook ${event} --tool cursor --respond-json`;
}

export function isVibeCursorHook(hook: CursorHook): boolean {
  // `__hook` is our coined subcommand — matching it alone is enough. Don't also
  // require the literal "vibe" in the path: a dev clone in a differently named
  // directory has no "vibe" in its cli.js path, which would make reinstall
  // duplicate our hooks and uninstall miss them.
  return typeof hook?.command === 'string' && hook.command.includes('__hook');
}

export function mergeCursorHooks(config: CursorHooksConfig): {
  config: CursorHooksConfig;
  added: number;
  existing: number;
  updated: number;
} {
  if (config.version === undefined) config.version = 1;

  const hooks = config.hooks ?? {};
  let added = 0;
  let existing = 0;
  let updated = 0;

  for (const [cursorEvent, vibeEvent] of Object.entries(EVENT_MAP)) {
    const list = Array.isArray(hooks[cursorEvent]) ? hooks[cursorEvent] : [];
    const ours: CursorHook = {
      command: cursorHookCommand(vibeEvent),
      timeout: 10,
    };

    const previous = list.filter(isVibeCursorHook);
    if (previous.length > 0) {
      existing++;
      if (previous.length !== 1 || JSON.stringify(previous[0]) !== JSON.stringify(ours)) updated++;
      hooks[cursorEvent] = [...list.filter((candidate) => !isVibeCursorHook(candidate)), ours];
    } else {
      list.push(ours);
      hooks[cursorEvent] = list;
      added++;
    }
  }

  config.hooks = hooks;
  return { config, added, existing, updated };
}

export function stripCursorHooks(config: CursorHooksConfig): { config: CursorHooksConfig; removed: number } {
  if (!config.hooks) return { config, removed: 0 };

  let removed = 0;
  for (const event of Object.keys(config.hooks)) {
    const list = config.hooks[event];
    if (!Array.isArray(list)) continue;
    const kept = list.filter((hook) => {
      const ours = isVibeCursorHook(hook);
      if (ours) removed++;
      return !ours;
    });
    if (kept.length > 0) config.hooks[event] = kept;
    else delete config.hooks[event];
  }
  if (Object.keys(config.hooks).length === 0) delete config.hooks;

  return { config, removed };
}

export function hasCursorHooks(path = defaultHooksPath()): boolean {
  const events = readConfig(path)?.hooks;
  if (!events) return false;
  return Object.values(events).some((list) => Array.isArray(list) && list.some((h) => isVibeCursorHook(h)));
}

function readConfig(path: string): CursorHooksConfig | null {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf-8').trim();
    return raw ? (JSON.parse(raw) as CursorHooksConfig) : {};
  } catch {
    return null;
  }
}

function writeConfig(path: string, config: CursorHooksConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, JSON.stringify(config, null, 2) + '\n');
}

export function installCursorHooks(path = defaultHooksPath(), silent = false): void {
  const say = (msg: string) => { if (!silent) console.log(msg); };
  const current = readConfig(path);
  if (current === null) {
    say(`\n  ${RED('✗')} vibe: ${path} is not valid JSON — fix it and re-run\n`);
    return;
  }

  const { config, added, existing, updated } = mergeCursorHooks(current);
  writeConfig(path, config);

  if (added === 0 && updated === 0) {
    say(`\n  ${PURPLE('◆')} cursor desktop tracking already installed\n`);
    return;
  }

  const action = added > 0 ? 'installed' : 'updated';
  say(`\n  ${PURPLE('◆')} cursor desktop tracking ${action} in ${path}\n`);
  say(`  vibe now records a session every time you use Cursor Agent.`);
  say(`  hooks are hot-reloaded — open a new Cursor Agent session to start.\n`);
  if (existing > 0) say(`  (${existing} event${existing === 1 ? '' : 's'} were already wired up)\n`);
}

export function removeCursorHooks(path = defaultHooksPath()): void {
  const current = readConfig(path);
  if (current === null) {
    console.log(`\n  ${RED('✗')} vibe: ${path} is not valid JSON — fix it and re-run\n`);
    return;
  }

  const { config, removed } = stripCursorHooks(current);
  if (removed === 0) {
    console.log(`\n  ${PURPLE('◆')} no cursor desktop hooks found\n`);
    return;
  }

  writeConfig(path, config);
  console.log(`\n  ${PURPLE('◆')} cursor desktop tracking removed from ${path}\n`);
}
