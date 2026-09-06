import { existsSync } from 'node:fs';
import { addSession, updateSession, getSessions, INACTIVITY_TIMEOUT_MS, type Session } from './db.js';
import { isGitRepo, getHeadSha, getDiffStats, getReposDiffStats, baselineRepos, describeRepos, type GitDiffStats } from './git.js';
import { refreshAndReap } from './rescore.js';
import { readConfig } from './config.js';
import { scoreSession } from './score.js';
import { flushPendingSubmissions } from './submit.js';

// Claude Code and Codex deliver a JSON payload on stdin to every hook command.
// We read only the fields below — never the transcript contents — so hook-
// tracked sessions stay within vibetime's "git metadata only" privacy model.
interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: string; // SessionStart: startup | resume | clear | compact
  reason?: string; // SessionEnd: clear | logout | prompt_input_exit | other
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Skip a git diff on rapid-fire activity events (e.g. bursts of parallel tool
// calls); duration still accumulates, only the git stats refresh is throttled.
const GIT_REFRESH_MS = 15_000;

type HookEvent = 'session-start' | 'activity' | 'session-end';
export type HookTool = 'claude' | 'codex';

const EMPTY_STATS: GitDiffStats = { commits: 0, linesAdded: 0, linesRemoved: 0, filesTouched: 0 };

// Active time since the last activity mark, capped at the inactivity timeout so
// idle gaps beyond the threshold are excluded — mirrors the poller in wrap.ts.
function activeSecondsSince(lastActivityAt: string | undefined, startedAt: string, now: number): number {
  const lastMs = new Date(lastActivityAt || startedAt).getTime();
  const gap = Math.max(now - lastMs, 0);
  return Math.round(Math.min(gap, INACTIVITY_TIMEOUT_MS) / 1000);
}

// What the session's repos show now, or null when they can't be measured — a
// moved or deleted repo reads as an all-zero diff (git failures return empty
// output), and a zero must never overwrite real recorded stats on a revival.
function diffFor(session: Session, cwd: string): GitDiffStats | null {
  if (session.repos?.length) {
    const alive = session.repos.filter((r) => existsSync(r.path));
    return alive.length ? getReposDiffStats(alive) : null;
  }
  // Fallback for sessions opened by an older CLI, which recorded a single
  // baseline sha against the session cwd.
  if (!session.startSha || !isGitRepo(cwd)) return null;
  return getDiffStats(session.startSha, getHeadSha(cwd), cwd);
}

// A finalized hook session must come back to life when later events arrive for
// its id, or the remaining work is silently dropped. Two kinds of revival:
//
//  - 'reaped': the shared reaper (reapOrphanedSessions) finalized it as
//    `interrupted` after 30 idle minutes. Terminal sessions survive the reaper
//    because their poller rewrites the row every 30s; a hook session only
//    writes on hook events, so a Desktop session idle over a lunch break gets
//    reaped mid-flight. Any later event revives it, however long the break —
//    the reap itself is proof the session never really ended — and the idle
//    gap stays uncounted because the reap already granted the active tail.
//
//  - 'clean': Desktop sometimes fires a spurious clean SessionEnd seconds
//    after SessionStart while the conversation runs on for hours (issue #19).
//    Only events inside the inactivity window of that end revive it, and the
//    gap counts as active time — as if the end never happened. Past the
//    window a clean end is final: reviving a days-old session (`--resume`)
//    would re-diff from its stale baseline and double-credit work that later
//    sessions on the same repos already claimed.
//
// Sessions that ended cleanly once carry `hadCleanEnd`, so a revived one that
// idles out again re-finalizes clean instead of downgrading to `interrupted`
// (the reaper checks it — see db.ts). SessionStart alone never revives:
// resuming a conversation just to look at it isn't work, and the first prompt
// or tool call revives it within the same second anyway.
function reopenKind(session: Session, now: number): 'reaped' | 'clean' | null {
  if (session.exitCode === -1) return null; // still open — nothing to revive
  if (session.momentum === 'interrupted') return 'reaped';
  if (now - new Date(session.endedAt).getTime() <= INACTIVITY_TIMEOUT_MS) return 'clean';
  return null;
}

export async function handleHook(event: string, raw: string, tool: HookTool = 'claude'): Promise<void> {
  // The shell wrapper (`vibe __wrap`) already tracks its child session end to
  // end and marks it with VIBE_SESSION=1. Desktop hooks may also fire inside
  // that wrapped process, so bail out to avoid double-counting.
  if (process.env.VIBE_SESSION === '1') return;

  let input: HookInput;
  try {
    input = raw ? JSON.parse(raw) : {};
  } catch {
    return;
  }

  const sessionId = input.session_id;
  if (!sessionId || !UUID_RE.test(sessionId)) return;
  const cwd = input.cwd || process.cwd();

  switch (event as HookEvent) {
    case 'session-start':
      return onSessionStart(sessionId, cwd, tool);
    case 'activity':
      return onActivity(sessionId, cwd);
    case 'session-end':
      return onSessionEnd(sessionId, cwd);
  }
}

async function onSessionStart(sessionId: string, cwd: string, tool: HookTool): Promise<void> {
  await refreshAndReap();

  // SessionStart can also fire when an existing conversation is resumed — key
  // off the provider's session id so a session is only opened once.
  if (getSessions().some((s) => s.id === sessionId)) return;

  // The repo the session started in, or — when it started from a directory that
  // holds repos rather than being one — the repos inside it. Desktop fires
  // SessionStart for every session, including quick questions asked from a
  // directory with no code under it at all; those can never score, so skip them
  // instead of piling up idle rows in `vibe log`.
  const repos = baselineRepos(cwd);
  if (repos.length === 0) return;

  const startedAt = new Date().toISOString();
  const config = readConfig();

  const session: Session = {
    id: sessionId,
    tool,
    ...describeRepos(repos, cwd),
    startedAt,
    endedAt: startedAt,
    durationSeconds: 0,
    ...EMPTY_STATS,
    momentum: scoreSession({ ...EMPTY_STATS, exitCode: -1 }, config),
    exitCode: -1,
    lastActivityAt: startedAt,
    startSha: repos.length === 1 ? repos[0].startSha : '',
    repos,
  };

  try {
    await addSession(session);
  } catch {}
}

async function onActivity(sessionId: string, cwd: string): Promise<void> {
  const session = getSessions().find((s) => s.id === sessionId);
  if (!session) return;

  const now = Date.now();
  const reopen = reopenKind(session, now);
  if (session.exitCode !== -1 && !reopen) return; // finalized — stale events can't revive it

  const lastMs = new Date(session.lastActivityAt || session.startedAt).getTime();
  const gap = Math.max(now - lastMs, 0);

  const updates: Partial<Session> = {
    // A reap already settled the duration through its active tail, so revival
    // from one adds nothing; otherwise the gap counts as live time, capped.
    durationSeconds: session.durationSeconds + (reopen === 'reaped' ? 0 : activeSecondsSince(session.lastActivityAt, session.startedAt, now)),
    lastActivityAt: new Date(now).toISOString(),
  };

  if (reopen) {
    // Back to live; clear the submission so the corrected final state
    // resubmits — the server upserts on id, so it's safe.
    updates.exitCode = -1;
    updates.submittedAt = undefined;
  }

  // Refresh git stats on revival (to recover work shipped while closed) and
  // otherwise only past the throttle window.
  if (reopen || gap >= GIT_REFRESH_MS) {
    const stats = diffFor(session, cwd);
    if (stats) {
      Object.assign(updates, stats);
      updates.momentum = scoreSession({ ...stats, exitCode: -1 }, readConfig());
    }
  }

  try {
    await updateSession(sessionId, updates);
  } catch {}
}

async function onSessionEnd(sessionId: string, cwd: string): Promise<void> {
  const session = getSessions().find((s) => s.id === sessionId);
  if (!session) return;

  const now = Date.now();
  const reopen = reopenKind(session, now);
  if (session.exitCode !== -1 && !reopen) return; // finalized — stale events can't revive it

  const stats = diffFor(session, cwd);
  const updates: Partial<Session> = {
    endedAt: new Date(now).toISOString(),
    durationSeconds: session.durationSeconds + (reopen === 'reaped' ? 0 : activeSecondsSince(session.lastActivityAt, session.startedAt, now)),
    // Rescore as a clean end even when the repos can't be measured (moved or
    // deleted): the recorded stats stand, but a reaped `interrupted` must not.
    momentum: scoreSession({ ...(stats ?? session), exitCode: 0 }, readConfig()),
    exitCode: 0,
    hadCleanEnd: true,
    lastActivityAt: new Date(now).toISOString(),
    // Clear any earlier submission so the corrected final state resubmits.
    submittedAt: undefined,
  };
  if (stats) Object.assign(updates, stats);

  try {
    await updateSession(sessionId, updates);
  } catch {}

  await flushPendingSubmissions(1500).catch(() => {});
}
