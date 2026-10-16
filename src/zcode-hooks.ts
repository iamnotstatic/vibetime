import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { PURPLE } from './colors.js';

const RED = chalk.hex('#EF4444');

type HookEvent = 'session-start' | 'activity';

// ZCode's hook event names -> the internal `vibe __hook <event>`. ZCode has no
// session-end event, so there is nothing to map it from: a ZCode session is
// closed by the reaper once it has been idle past the inactivity timeout, the
// same path that closes a desktop session the editor never ended.
const EVENT_MAP: Record<string, HookEvent> = {
  SessionStart: 'session-start',
  UserPromptSubmit: 'activity',
  PostToolUse: 'activity',
  Stop: 'activity',
};

// ZCode keeps user hooks in its CLI config under `hooks.events`, each event a
// list of matcher groups like Claude Code's. A new hook stays off until the
// user switches it on in Settings > Hooks, which ZCode records by writing
// `enabled: true` onto the hook (and onto `hooks`), so that flag is the user's
// approval and never ours to set.
interface ZcodeHook {
  type: string;
  command: string;
  timeout?: number;
  enabled?: boolean;
  [key: string]: unknown;
}

interface ZcodeHookGroup {
  matcher?: string;
  hooks: ZcodeHook[];
  [key: string]: unknown;
}

export interface ZcodeConfig {
  hooks?: {
    events?: Record<string, ZcodeHookGroup[]>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function defaultConfigPath(): string {
  return join(homedir(), '.zcode', 'cli', 'config.json');
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

function zcodeHookCommand(event: HookEvent): string {
  // ZCode launched from the Dock does not inherit the shell PATH, so pin the
  // current Node executable and this installed CLI entry point.
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  return `${quote(process.execPath)} ${quote(cli)} __hook ${event} --tool zcode`;
}

export function isVibeZcodeHook(group: ZcodeHookGroup): boolean {
  // `__hook` is our coined subcommand, so matching it alone is enough, as for
  // the other editors.
  return Array.isArray(group?.hooks) && group.hooks.some((h) => typeof h?.command === 'string' && h.command.includes('__hook'));
}

export function mergeZcodeHooks(config: ZcodeConfig): {
  config: ZcodeConfig;
  added: number;
  existing: number;
  updated: number;
} {
  const hooks = config.hooks ?? {};
  const events = hooks.events ?? {};
  let added = 0;
  let existing = 0;
  let updated = 0;

  for (const [zcodeEvent, vibeEvent] of Object.entries(EVENT_MAP)) {
    const list = Array.isArray(events[zcodeEvent]) ? events[zcodeEvent] : [];
    const command = zcodeHookCommand(vibeEvent);
    // Seconds, the unit ZCode itself writes back when it saves the hook.
    const group: ZcodeHookGroup = { hooks: [{ type: 'command', command, timeout: 10 }] };

    const ours = list.filter(isVibeZcodeHook);
    if (ours.length > 0) {
      existing++;
      // Same command: leave the group exactly as ZCode last saved it. Rewriting
      // it would drop the user's switch-on, and the session-start repair runs
      // this on every session, so tracking would turn itself off each time.
      const current = ours.length === 1 && ours[0].hooks.length === 1 && ours[0].hooks[0].command === command;
      if (current) continue;
      // A changed command (a moved Node or CLI) is new code to run, so it goes
      // back to off and waits for the user to switch it on again.
      updated++;
      events[zcodeEvent] = [...list.filter((candidate) => !isVibeZcodeHook(candidate)), group];
    } else {
      list.push(group);
      events[zcodeEvent] = list;
      added++;
    }
  }

  hooks.events = events;
  config.hooks = hooks;
  return { config, added, existing, updated };
}

export function stripZcodeHooks(config: ZcodeConfig): { config: ZcodeConfig; removed: number } {
  const events = config.hooks?.events;
  if (!config.hooks || !events) return { config, removed: 0 };

  let removed = 0;
  for (const event of Object.keys(events)) {
    const list = events[event];
    if (!Array.isArray(list)) continue;
    const kept = list.filter((group) => {
      const ours = isVibeZcodeHook(group);
      if (ours) removed++;
      return !ours;
    });
    if (kept.length > 0) events[event] = kept;
    else delete events[event];
  }
  if (Object.keys(events).length === 0) delete config.hooks.events;
  if (Object.keys(config.hooks).length === 0) delete config.hooks;

  return { config, removed };
}

export function hasZcodeHooks(path = defaultConfigPath()): boolean {
  const events = readConfig(path)?.hooks?.events;
  if (!events) return false;
  return Object.values(events).some((list) => Array.isArray(list) && list.some((g) => isVibeZcodeHook(g)));
}

function readConfig(path: string): ZcodeConfig | null {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf-8').trim();
    return raw ? (JSON.parse(raw) as ZcodeConfig) : {};
  } catch {
    return null;
  }
}

function writeConfig(path: string, config: ZcodeConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
}

export function installZcodeHooks(path = defaultConfigPath(), silent = false): void {
  const say = (msg: string) => { if (!silent) console.log(msg); };
  const current = readConfig(path);
  if (current === null) {
    say(`\n  ${RED('✗')} vibe: ${path} is not valid JSON, fix it and re-run\n`);
    return;
  }

  const { config, added, existing, updated } = mergeZcodeHooks(current);
  writeConfig(path, config);

  if (added === 0 && updated === 0) {
    say(`\n  ${PURPLE('◆')} zcode tracking already installed\n`);
    return;
  }

  const action = added > 0 ? 'installed' : 'updated';
  say(`\n  ${PURPLE('◆')} zcode tracking ${action} in ${path}\n`);
  say(`  vibe now records a session every time you use ZCode.`);
  say(`  restart ZCode, then switch the vibe hooks on in Settings > Hooks.\n`);
  if (existing > 0) say(`  (${existing} event${existing === 1 ? '' : 's'} were already wired up)\n`);
}

export function removeZcodeHooks(path = defaultConfigPath()): void {
  const current = readConfig(path);
  if (current === null) {
    console.log(`\n  ${RED('✗')} vibe: ${path} is not valid JSON, fix it and re-run\n`);
    return;
  }

  const { config, removed } = stripZcodeHooks(current);
  if (removed === 0) {
    console.log(`\n  ${PURPLE('◆')} no zcode hooks found\n`);
    return;
  }

  writeConfig(path, config);
  console.log(`\n  ${PURPLE('◆')} zcode tracking removed from ${path}\n`);
}
