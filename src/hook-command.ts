import { existsSync } from 'node:fs';

// Every installer writes `'<node>' '<cli.js>' __hook <event> ...`, and early
// releases wrote `vibe __hook <event>`. Matching the subcommand with one of our
// events, not any `__hook` substring, keeps someone's `pre_commit__hooks.py`
// from being taken for ours and replaced.
const VIBE_COMMAND = /(?:^|\s)__hook\s+(?:session-start|activity|session-end)(?:\s|$)/;

export type InstallMode = 'install' | 'repair';

export function isVibeCommand(command: unknown): command is string {
  return typeof command === 'string' && VIBE_COMMAND.test(command);
}

export function pinnedPaths(command: string): string[] {
  const head = command.slice(0, command.search(VIBE_COMMAND));
  return [...head.matchAll(/'((?:[^']|'\\'')*)'/g)].map((m) => m[1].replace(/'\\''/g, "'"));
}

// The install repair runs on every session start and `vibe status`, from
// whichever vibe happens to run: a second Node under nvm, a dev checkout, an
// npx cache. Re-pinning a hook that still works trades it for one that may
// vanish, and Codex skips a changed hook until it is reviewed again. So a
// repair replaces our hook only when what it pins is gone or its arguments
// are not what this release writes.
export function stillRuns(existing: string, wanted: string): boolean {
  const args = (command: string) => command.slice(command.search(VIBE_COMMAND)).trim();
  const paths = pinnedPaths(existing);
  return args(existing) === args(wanted) && paths.length === 2 && paths.every((p) => existsSync(p));
}
