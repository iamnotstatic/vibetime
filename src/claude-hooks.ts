import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { writeFileAtomic } from './write-file.js';
import { isVibeCommand, stillRuns, type InstallMode } from './hook-command.js';
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

export function hasClaudeHooks(): boolean {
  const events = readSettings()?.hooks;
  if (!events) return false;
  return Object.values(events).some((list) => Array.isArray(list) && list.some((g) => isVibeHook(g)));
}

export function isVibeHook(group: HookGroup): boolean {
  // `__hook` is our coined subcommand — matching it alone is enough. Don't also
  // require the literal "vibe" in the path: a dev clone in a differently named
  // directory has no "vibe" in its cli.js path, which would make reinstall
  // duplicate our hooks and uninstall miss them. Don't require `--tool codex`
  // on the Codex side either: Codex can import these Claude Code entries into
  // its own hooks.json verbatim, and the Codex installer has to claim those
  // copies so it can replace them rather than run alongside them.
  return Array.isArray(group?.hooks) && group.hooks.some(isVibeHookCommand);
}

function isVibeHookCommand(hook: HookCommand): boolean {
  return isVibeCommand(hook?.command);
}

// Someone else's command can share a group with ours, and it stays.
function withoutVibeCommands(groups: HookGroup[]): HookGroup[] {
  return groups.flatMap((group) => {
    if (!isVibeHook(group)) return [group];
    const hooks = group.hooks.filter((hook) => !isVibeHookCommand(hook));
    return hooks.length ? [{ ...group, hooks }] : [];
  });
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
  writeFileAtomic(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
}

export function installClaudeHooks(mode: InstallMode = 'install'): void {
  const say = (msg: string) => { if (mode === 'install') console.log(msg); };
  const settings = readSettings();
  if (settings === null) {
    say(`\n  ${RED('✗')} vibe: ${SETTINGS_PATH} is not valid JSON — fix it and re-run\n`);
    return;
  }

  const hooks = settings.hooks ?? {};
  let added = 0;
  let existing = 0;
  let updated = 0;

  for (const [claudeEvent, vibeEvent] of Object.entries(EVENT_MAP)) {
    const list = Array.isArray(hooks[claudeEvent]) ? hooks[claudeEvent] : [];
    const command = vibeCommand(vibeEvent);
    const group: HookGroup = { hooks: [{ type: 'command', command, timeout: 10 }] };
    if (MATCHER_EVENTS.has(claudeEvent)) group.matcher = '';

    if (list.some(isVibeHook)) {
      existing++;
      const owned = list.flatMap((g) => (isVibeHook(g) ? g.hooks.filter(isVibeHookCommand) : []));
      const current = owned.length === 1
        && (owned[0].command === command || (mode === 'repair' && stillRuns(owned[0].command, command)));
      if (current) continue;
      // A pinned Node or CLI that moved, say after an nvm upgrade, fails on
      // every event without a word, and this repair is the only thing that
      // runs often enough to notice.
      hooks[claudeEvent] = [...withoutVibeCommands(list), group];
      updated++;
      continue;
    }
    list.push(group);
    hooks[claudeEvent] = list;
    added++;
  }

  settings.hooks = hooks;
  writeSettings(settings);

  if (added === 0 && updated === 0) {
    say(`\n  ${PURPLE('◆')} claude code desktop tracking already installed\n`);
    return;
  }
  if (added === 0) {
    say(`\n  ${PURPLE('◆')} claude code desktop tracking updated in ${SETTINGS_PATH}\n`);
    return;
  }
  say(`\n  ${PURPLE('◆')} claude code desktop tracking installed in ${SETTINGS_PATH}\n`);
  say(`  vibe now records a session every time you use Claude Code Desktop.`);
  say(`  settings are hot-reloaded — open a new Claude Code Desktop session to start.\n`);
  if (existing > 0) say(`  (${existing} event${existing === 1 ? '' : 's'} were already wired up)\n`);
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
