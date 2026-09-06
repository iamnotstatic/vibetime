import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { PURPLE } from './colors.js';

const RED = chalk.hex('#EF4444');

type HookEvent = 'session-start' | 'activity' | 'session-end';

const EVENT_MAP: Record<string, HookEvent> = {
  SessionStart: 'session-start',
  UserPromptSubmit: 'activity',
  PostToolUse: 'activity',
  Stop: 'activity',
  SessionEnd: 'session-end',
};

interface HookCommand {
  type: 'command';
  command: string;
  commandWindows?: string;
  timeout?: number;
}

interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}

export interface CodexHooksConfig {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

function defaultHooksPath(): string {
  const codexDir = process.env.CODEX_HOME || join(homedir(), '.codex');
  return join(codexDir, 'hooks.json');
}

// Codex creates its config dir on first run, so its presence is the install signal.
// Installing hooks without it would litter ~/.codex on machines that never ran Codex.
export function codexPresent(): boolean {
  return existsSync(dirname(defaultHooksPath()));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Double quotes can't appear in Windows paths, so plain wrapping is safe.
function winQuote(value: string): string {
  return `"${value}"`;
}

function hookInvocation(event: HookEvent, hookEventName: string, quote: (value: string) => string): string {
  // Codex Desktop launched from the Dock may not inherit the shell PATH, so pin
  // the current Node executable and this installed CLI entry point.
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  const jsonResponse = hookEventName === 'Stop' ? ' --respond-json' : '';
  return `${quote(process.execPath)} ${quote(cli)} __hook ${event} --tool codex${jsonResponse}`;
}

export function codexHookCommand(event: HookEvent, hookEventName: string): string {
  return hookInvocation(event, hookEventName, shellQuote);
}

export function codexHookCommandWindows(event: HookEvent, hookEventName: string): string {
  return hookInvocation(event, hookEventName, winQuote);
}

function isCodexVibeHook(group: HookGroup): boolean {
  return Array.isArray(group?.hooks) && group.hooks.some(
    (hook) => typeof hook?.command === 'string'
      && hook.command.includes('__hook')
      && hook.command.includes('--tool codex'),
  );
}

export function mergeCodexHooks(config: CodexHooksConfig): {
  config: CodexHooksConfig;
  added: number;
  existing: number;
  updated: number;
} {
  const hooks = config.hooks ?? {};
  let added = 0;
  let existing = 0;
  let updated = 0;

  for (const [codexEvent, vibeEvent] of Object.entries(EVENT_MAP)) {
    const list = Array.isArray(hooks[codexEvent]) ? hooks[codexEvent] : [];
    const group: HookGroup = {
      hooks: [{
        type: 'command',
        command: codexHookCommand(vibeEvent, codexEvent),
        // Codex runs commandWindows on Windows, where POSIX quoting breaks.
        commandWindows: codexHookCommandWindows(vibeEvent, codexEvent),
        // Codex waits at most three seconds for SessionEnd hooks.
        timeout: codexEvent === 'SessionEnd' ? 3 : 10,
      }],
    };
    if (codexEvent === 'PostToolUse') group.matcher = '';

    const ours = list.filter(isCodexVibeHook);
    if (ours.length > 0) {
      existing++;
      if (ours.length !== 1 || JSON.stringify(ours[0]) !== JSON.stringify(group)) updated++;
      hooks[codexEvent] = [...list.filter((candidate) => !isCodexVibeHook(candidate)), group];
    } else {
      list.push(group);
      hooks[codexEvent] = list;
      added++;
    }
  }

  config.hooks = hooks;
  return { config, added, existing, updated };
}

export function stripCodexHooks(config: CodexHooksConfig): { config: CodexHooksConfig; removed: number } {
  if (!config.hooks) return { config, removed: 0 };

  let removed = 0;
  for (const event of Object.keys(config.hooks)) {
    const list = config.hooks[event];
    if (!Array.isArray(list)) continue;
    const kept = list.filter((group) => {
      const ours = isCodexVibeHook(group);
      if (ours) removed++;
      return !ours;
    });
    if (kept.length > 0) config.hooks[event] = kept;
    else delete config.hooks[event];
  }
  if (Object.keys(config.hooks).length === 0) delete config.hooks;

  return { config, removed };
}

function readConfig(path: string): CodexHooksConfig | null {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf-8').trim();
    return raw ? (JSON.parse(raw) as CodexHooksConfig) : {};
  } catch {
    return null;
  }
}

function writeConfig(path: string, config: CodexHooksConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
}

export function installCodexHooks(path = defaultHooksPath()): void {
  const current = readConfig(path);
  if (current === null) {
    console.log(`\n  ${RED('✗')} vibe: ${path} is not valid JSON — fix it and re-run\n`);
    return;
  }

  const { config, added, existing, updated } = mergeCodexHooks(current);
  writeConfig(path, config);

  if (added === 0 && updated === 0) {
    console.log(`\n  ${PURPLE('◆')} codex desktop tracking already installed\n`);
    return;
  }

  const action = added > 0 ? 'installed' : 'updated';
  console.log(`\n  ${PURPLE('◆')} codex desktop tracking ${action} in ${path}\n`);
  console.log(`  In Codex, run /hooks, review the commands, and trust the configuration.`);
  console.log(`  Then open a new Codex session to start tracking.\n`);
  if (existing > 0) console.log(`  (${existing} event${existing === 1 ? '' : 's'} were already wired up)\n`);
}

export function removeCodexHooks(path = defaultHooksPath()): void {
  const current = readConfig(path);
  if (current === null) {
    console.log(`\n  ${RED('✗')} vibe: ${path} is not valid JSON — fix it and re-run\n`);
    return;
  }

  const { config, removed } = stripCodexHooks(current);
  if (removed === 0) {
    console.log(`\n  ${PURPLE('◆')} no codex desktop hooks found\n`);
    return;
  }

  writeConfig(path, config);
  console.log(`\n  ${PURPLE('◆')} codex desktop tracking removed from ${path}\n`);
}
