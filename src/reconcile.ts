import { readConfig } from './config.js';
import { hasShellHooks, reconcileShellHooks } from './init.js';
import { installClaudeHooks, hasClaudeHooks } from './claude-hooks.js';
import { installCodexHooks, hasCodexHooks } from './codex-hooks.js';
import { installCursorHooks, hasCursorHooks } from './cursor-hooks.js';
import { installZcodeHooks, hasZcodeHooks } from './zcode-hooks.js';

// Repair the install on paths that always run.
//
// Nothing here depends on the user remembering a command. A new default tool
// or a newly supported desktop app otherwise reaches only fresh installs —
// `aster` shipped in v0.9.0 and existed in zero rc files, including the
// maintainer's — and a pinned Node path left dangling by an nvm upgrade kills
// desktop tracking silently until someone re-runs `vibe hooks install`.
//
// Two rules keep this from being hostile. It only ever repairs an install that
// already exists, so a machine that never ran `vibe init` is untouched. And it
// respects deliberate removals recorded in config, so `vibe uninstall` stays
// uninstalled instead of reappearing on the next session.
export function reconcileInstall(): void {
  try {
    const config = readConfig();
    const installed = hasShellHooks() || hasClaudeHooks() || hasCodexHooks() || hasCursorHooks() || hasZcodeHooks();
    if (!installed) return;

    if (!config.shellHooksOptOut) reconcileShellHooks(config.removedTools ?? []);

    if (!config.desktopHooksOptOut) {
      // Each installer is already idempotent and refreshes stale pinned paths;
      // silent:true keeps a routine repair from printing over a session.
      installClaudeHooks(true);
      installCodexHooks(undefined, true);
      installCursorHooks(undefined, true);
      installZcodeHooks(undefined, true);
    }
  } catch {
    // Repair is best effort. A session must never fail because a config file
    // was unreadable or a home directory was read-only.
  }
}

// Has the user set vibetime up at all? Used by bare `vibe` to decide between
// setting up and showing today.
export function isInstalled(): boolean {
  try {
    return hasShellHooks() || hasClaudeHooks() || hasCodexHooks() || hasCursorHooks() || hasZcodeHooks();
  } catch {
    return false;
  }
}
