import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { writeFileAtomic } from './write-file.js';
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

function isVibeHook(hook: ZcodeHook): boolean {
  return typeof hook?.command === 'string' && hook.command.includes('__hook');
}

export function isVibeZcodeHook(group: ZcodeHookGroup): boolean {
  return Array.isArray(group?.hooks) && group.hooks.some(isVibeHook);
}

// User commands can share a matcher group with ours. Keep both those commands
// and the group's metadata when replacing or removing Vibetime hooks.
function withoutVibeHooks(groups: ZcodeHookGroup[]): ZcodeHookGroup[] {
  return groups.flatMap((group) => {
    if (!isVibeZcodeHook(group)) return [group];
    const hooks = group.hooks.filter((hook) => !isVibeHook(hook));
    return hooks.length ? [{ ...group, hooks }] : [];
  });
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
      const owned = ours.flatMap((g) => g.hooks.filter(isVibeHook));
      const current = owned.length === 1 && owned[0].command === command;
      if (current) continue;
      // A changed command (a moved Node or CLI) is new code to run, so it goes
      // back to off and waits for the user to switch it on again.
      updated++;
      events[zcodeEvent] = [...withoutVibeHooks(list), group];
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
    removed += list.filter(isVibeZcodeHook).length;
    const kept = withoutVibeHooks(list);
    if (kept.length > 0) events[event] = kept;
    else delete events[event];
  }
  if (Object.keys(events).length === 0) delete config.hooks.events;
  if (Object.keys(config.hooks).length === 0) delete config.hooks;

  return { config, removed };
}

export function hasZcodeHooks(path = defaultConfigPath()): boolean {
  const read = readConfig(path);
  const events = 'config' in read ? read.config.hooks?.events : undefined;
  if (!events) return false;
  return Object.values(events).some((list) => Array.isArray(list) && list.some((g) => isVibeZcodeHook(g)));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Why the file can't be used, worded for the user: a parse failure and a
// valid file in a shape we don't recognize need different fixes.
type ConfigRead = { config: ZcodeConfig } | { problem: string };

function readConfig(path: string): ConfigRead {
  if (!existsSync(path)) return { config: {} };
  let value: unknown;
  try {
    const raw = readFileSync(path, 'utf-8').trim();
    value = raw ? JSON.parse(raw) : {};
  } catch {
    return { problem: 'is not valid JSON' };
  }
  const unexpected = { problem: 'has a layout vibe does not recognize (expected hooks.events to map event names to lists)' };
  if (!isObject(value)) return unexpected;
  if (value.hooks !== undefined) {
    if (!isObject(value.hooks)) return unexpected;
    if (value.hooks.events !== undefined && !isObject(value.hooks.events)) return unexpected;
    if (value.hooks.events && !Object.values(value.hooks.events).every(Array.isArray)) return unexpected;
  }
  return { config: value as ZcodeConfig };
}

function writeConfig(path: string, config: ZcodeConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, JSON.stringify(config, null, 2) + '\n');
}

export function installZcodeHooks(path = defaultConfigPath(), silent = false): void {
  const say = (msg: string) => { if (!silent) console.log(msg); };
  const read = readConfig(path);
  if (!('config' in read)) {
    say(`\n  ${RED('✗')} vibe: ${path} ${read.problem}, fix it and re-run\n`);
    return;
  }
  const current = read.config;

  const { config, added, existing, updated } = mergeZcodeHooks(current);
  if (added === 0 && updated === 0) {
    say(`\n  ${PURPLE('◆')} zcode tracking already installed\n`);
    return;
  }

  writeConfig(path, config);
  const action = added > 0 ? 'installed' : 'updated';
  say(`\n  ${PURPLE('◆')} zcode tracking ${action} in ${path}\n`);
  say(`  vibe now records a session every time you use ZCode.`);
  say(`  restart ZCode, then switch the vibe hooks on in Settings > Hooks.\n`);
  if (existing > 0) say(`  (${existing} event${existing === 1 ? '' : 's'} were already wired up)\n`);
}

export function removeZcodeHooks(path = defaultConfigPath()): void {
  const read = readConfig(path);
  if (!('config' in read)) {
    console.log(`\n  ${RED('✗')} vibe: ${path} ${read.problem}, fix it and re-run\n`);
    return;
  }
  const current = read.config;

  const { config, removed } = stripZcodeHooks(current);
  if (removed === 0) {
    console.log(`\n  ${PURPLE('◆')} no zcode hooks found\n`);
    return;
  }

  writeConfig(path, config);
  console.log(`\n  ${PURPLE('◆')} zcode tracking removed from ${path}\n`);
}
