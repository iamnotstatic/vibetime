import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { PURPLE } from './colors.js';

const RED = chalk.hex('#EF4444');

const CLAUDE_DIR = join(homedir(), '.claude');
const SETTINGS_PATH = join(CLAUDE_DIR, 'settings.json');

// Claude Code hook event -> the internal `vibe __hook <event>` we dispatch to.
// SessionStart opens the session, SessionEnd closes and submits it, and the
// per-turn events keep the active-time accumulator honest between the two.
const EVENT_MAP: Record<string, HookEvent> = {
  SessionStart: 'session-start',
  UserPromptSubmit: 'activity',
  PostToolUse: 'activity',
  Stop: 'activity',
  SessionEnd: 'session-end',
};

type HookEvent = 'session-start' | 'activity' | 'session-end';

// Events that match on tool name need a matcher; an empty matcher means "all tools".
const MATCHER_EVENTS = new Set(['PreToolUse', 'PostToolUse']);

interface HookCommand {
  type: 'command';
  command: string;
  timeout?: number;
}
interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}
interface Settings {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

function shellQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

function vibeCommand(event: HookEvent): string {
  // The Desktop app launched from the Dock does NOT inherit the shell PATH, so a
  // bare `vibe` would not resolve. Pin absolute paths to node and cli.js instead.
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  return `${shellQuote(process.execPath)} ${shellQuote(cli)} __hook ${event}`;
}

function isVibeHook(group: HookGroup): boolean {
  return Array.isArray(group?.hooks) && group.hooks.some(
    (h) => typeof h?.command === 'string' && h.command.includes('__hook') && h.command.includes('vibe'),
  );
}

function readSettings(): Settings | null {
  if (!existsSync(SETTINGS_PATH)) return {};
  try {
    const raw = readFileSync(SETTINGS_PATH, 'utf-8').trim();
    return raw ? (JSON.parse(raw) as Settings) : {};
  } catch {
    return null; // present but unparseable — don't clobber it
  }
}

function writeSettings(settings: Settings): void {
  mkdirSync(CLAUDE_DIR, { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
}

export function installClaudeHooks(): void {
  const settings = readSettings();
  if (settings === null) {
    console.log(`\n  ${RED('✗')} vibe: ${SETTINGS_PATH} is not valid JSON — fix it and re-run\n`);
    return;
  }

  const hooks = settings.hooks ?? {};
  let added = 0;
  let existing = 0;

  for (const [claudeEvent, vibeEvent] of Object.entries(EVENT_MAP)) {
    const list = Array.isArray(hooks[claudeEvent]) ? hooks[claudeEvent] : [];
    if (list.some(isVibeHook)) {
      existing++;
      hooks[claudeEvent] = list;
      continue;
    }
    const group: HookGroup = { hooks: [{ type: 'command', command: vibeCommand(vibeEvent), timeout: 10 }] };
    if (MATCHER_EVENTS.has(claudeEvent)) group.matcher = '';
    list.push(group);
    hooks[claudeEvent] = list;
    added++;
  }

  settings.hooks = hooks;
  writeSettings(settings);

  if (added === 0) {
    console.log(`\n  ${PURPLE('◆')} claude code desktop tracking already installed\n`);
    return;
  }
  console.log(`\n  ${PURPLE('◆')} claude code desktop tracking installed in ${SETTINGS_PATH}\n`);
  console.log(`  vibe now records a session every time you use Claude Code Desktop.`);
  console.log(`  settings are hot-reloaded — open a new Claude Code Desktop session to start.\n`);
  if (existing > 0) console.log(`  (${existing} event${existing === 1 ? '' : 's'} were already wired up)\n`);
}

export function removeClaudeHooks(): void {
  const settings = readSettings();
  if (settings === null) {
    console.log(`\n  ${RED('✗')} vibe: ${SETTINGS_PATH} is not valid JSON — fix it and re-run\n`);
    return;
  }
  if (!settings.hooks) {
    console.log(`\n  ${PURPLE('◆')} no claude code desktop hooks found\n`);
    return;
  }

  let removed = 0;
  for (const event of Object.keys(settings.hooks)) {
    const list = settings.hooks[event];
    if (!Array.isArray(list)) continue;
    const kept = list.filter((group) => {
      const ours = isVibeHook(group);
      if (ours) removed++;
      return !ours;
    });
    if (kept.length > 0) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

  writeSettings(settings);

  if (removed === 0) {
    console.log(`\n  ${PURPLE('◆')} no claude code desktop hooks found\n`);
    return;
  }
  console.log(`\n  ${PURPLE('◆')} claude code desktop tracking removed from ${SETTINGS_PATH}\n`);
}
