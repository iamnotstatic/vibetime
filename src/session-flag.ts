// The nesting guard. `vibe __wrap` stamps this variable on the tool it spawns so
// that a second wrapper started inside that session — and the Claude Code hooks,
// which fire inside the wrapped process — know the work is already being tracked
// and stay out of the way.
const VAR = 'VIBE_SESSION';

/**
 * Environment for a wrapped child, marked with this wrapper's pid.
 *
 * The pid is what makes the marker falsifiable. Any long-lived ancestor can end
 * up holding this variable forever — a Terminal.app relaunched from inside a
 * session, a tmux server, a desktop app started from a wrapped shell — and every
 * shell it spawns inherits it. A bare "1" is indistinguishable from real nesting,
 * so tracking stays silently off for the entire life of that process. A pid can
 * be checked against the process table.
 */
export function sessionEnv(): NodeJS.ProcessEnv {
  return { ...process.env, [VAR]: String(process.pid) };
}

/**
 * True when this process is running inside a `vibe __wrap` session that is still
 * alive — the only case where skipping tracking is correct.
 *
 * A marker left behind by a wrapper that has since exited is stale and ignored,
 * so tracking recovers on its own instead of needing the stranded ancestor to be
 * killed.
 */
export function isInsideLiveSession(): boolean {
  const marker = process.env[VAR];
  if (!marker) return false;

  const pid = Number(marker);
  // Wrappers before this change wrote a literal "1", which carries no liveness
  // information — and 1 is always a live pid (init/launchd), so honouring it
  // would leave the stale-marker case unrecoverable. Treat it as stale: the cost
  // is at most one duplicate session while an old wrapper is still open during an
  // upgrade, against tracking that otherwise never comes back.
  if (!Number.isInteger(pid) || pid <= 1) return false;

  return isAlive(pid);
}

function isAlive(pid: number): boolean {
  // A recycled pid can still read as live, which skips tracking for that one
  // launch. That is self-correcting — the next launch draws a different pid —
  // unlike the stale marker it replaces, which never cleared.
  try {
    // Signal 0 runs the existence and permission checks without delivering.
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but belongs to another user — still alive.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
