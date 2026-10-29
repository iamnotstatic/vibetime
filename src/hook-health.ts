import { existsSync, readFileSync } from 'node:fs';
import { readConfig } from './config.js';
import { isVibeCommand, pinnedPaths } from './hook-command.js';
import { SETTINGS_PATH as claudePath } from './claude-hooks.js';
import { defaultHooksPath as codexPath } from './codex-hooks.js';
import { defaultHooksPath as cursorPath } from './cursor-hooks.js';
import { defaultConfigPath as zcodePath } from './zcode-hooks.js';

export type DesktopApp = 'claude code' | 'codex' | 'cursor' | 'zcode';

export type HookProblem =
  | { app: DesktopApp; path: string; kind: 'unparseable' }
  | { app: DesktopApp; path: string; kind: 'missing'; missing: string };

// Desktop tracking fails where nobody is looking: the editor runs the hook and
// keeps its output. A settings file left unparseable by a racing write turns
// off every hook in it, and a pinned Node removed by an nvm upgrade fails on
// every event. Both looked fine from here for days on the maintainer's own
// machine, so `vibe status` reports what the install repair could not fix.
export function desktopHookProblems(): HookProblem[] {
  if (readConfig().desktopHooksOptOut) return [];
  const apps: [DesktopApp, string][] = [
    ['claude code', claudePath],
    ['codex', codexPath()],
    ['cursor', cursorPath()],
    ['zcode', zcodePath()],
  ];
  const problems: HookProblem[] = [];
  for (const [app, path] of apps) {
    if (!existsSync(path)) continue;
    let parsed: unknown;
    try {
      const raw = readFileSync(path, 'utf-8').trim();
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      problems.push({ app, path, kind: 'unparseable' });
      continue;
    }
    // Windows reads commandWindows, quoted differently; checking the POSIX
    // command there would report a path that is fine as missing.
    if (process.platform === 'win32') continue;
    const missing = vibeCommands(parsed).flatMap(pinnedPaths).find((p) => !existsSync(p));
    if (missing) problems.push({ app, path, kind: 'missing', missing });
  }
  return problems;
}

// Every app nests its hooks differently, but each of ours is an object whose
// `command` is a vibe hook command.
function vibeCommands(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(vibeCommands);
  if (!value || typeof value !== 'object') return [];
  const command = (value as { command?: unknown }).command;
  const own = isVibeCommand(command) ? [command] : [];
  return [...own, ...Object.values(value).flatMap(vibeCommands)];
}
