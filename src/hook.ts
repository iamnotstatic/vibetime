import { addSession, updateSession, getSessions, reapOrphanedSessions, INACTIVITY_TIMEOUT_MS, type Session } from './db.js';
import { isGitRepo, getHeadSha, getBranch, getProjectName, getDiffStats, type GitDiffStats } from './git.js';
import { readConfig } from './config.js';
import { scoreSession } from './score.js';
import { flushPendingSubmissions } from './submit.js';

// Claude Code delivers a JSON payload on stdin to every hook command. We read
// only the fields below — never the transcript contents — so hook-tracked
// sessions stay within vibetime's "git metadata only" privacy model.
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

const EMPTY_STATS: GitDiffStats = { commits: 0, linesAdded: 0, linesRemoved: 0, filesTouched: 0 };

// Active time since the last activity mark, capped at the inactivity timeout so
// idle gaps beyond the threshold are excluded — mirrors the poller in wrap.ts.
function activeSecondsSince(lastActivityAt: string | undefined, startedAt: string, now: number): number {
  const lastMs = new Date(lastActivityAt || startedAt).getTime();
  const gap = Math.max(now - lastMs, 0);
  return Math.round(Math.min(gap, INACTIVITY_TIMEOUT_MS) / 1000);
}

function diffFor(session: Session, cwd: string): GitDiffStats {
  if (!session.startSha || !isGitRepo(cwd)) return EMPTY_STATS;
  return getDiffStats(session.startSha, getHeadSha(cwd), cwd);
}

export async function handleHook(event: string, raw: string): Promise<void> {
  // The shell wrapper (`vibe __wrap`) already tracks its child session end to
  // end and marks it with VIBE_SESSION=1. Claude Code fires these hooks inside
  // that wrapped process too, so bail out to avoid double-counting.
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
      return onSessionStart(sessionId, cwd);
    case 'activity':
      return onActivity(sessionId, cwd);
    case 'session-end':
      return onSessionEnd(sessionId, cwd);
  }
}

async function onSessionStart(sessionId: string, cwd: string): Promise<void> {
  await reapOrphanedSessions();

  // SessionStart also fires on resume/clear/compact — key off the Claude
  // session id so a session is only opened once.
  if (getSessions().some((s) => s.id === sessionId)) return;

  const hasGit = isGitRepo(cwd);
  const startedAt = new Date().toISOString();
  const config = readConfig();

  const session: Session = {
    id: sessionId,
    tool: 'claude',
    project: hasGit ? getProjectName(cwd) : cwd.split('/').pop() || 'unknown',
    branch: hasGit ? getBranch(cwd) : 'unknown',
    startedAt,
    endedAt: startedAt,
    durationSeconds: 0,
    ...EMPTY_STATS,
    momentum: scoreSession({ ...EMPTY_STATS, exitCode: -1 }, config),
    exitCode: -1,
    lastActivityAt: startedAt,
    startSha: hasGit ? getHeadSha(cwd) : '',
  };

  try {
    await addSession(session);
  } catch {}
}

async function onActivity(sessionId: string, cwd: string): Promise<void> {
  const session = getSessions().find((s) => s.id === sessionId);
  if (!session || session.exitCode !== -1) return; // only live sessions

  const now = Date.now();
  const lastMs = new Date(session.lastActivityAt || session.startedAt).getTime();
  const gap = Math.max(now - lastMs, 0);

  const updates: Partial<Session> = {
    durationSeconds: session.durationSeconds + activeSecondsSince(session.lastActivityAt, session.startedAt, now),
    lastActivityAt: new Date(now).toISOString(),
  };

  if (gap >= GIT_REFRESH_MS) {
    const stats = diffFor(session, cwd);
    Object.assign(updates, stats);
    updates.momentum = scoreSession({ ...stats, exitCode: -1 }, readConfig());
  }

  try {
    await updateSession(sessionId, updates);
  } catch {}
}

async function onSessionEnd(sessionId: string, cwd: string): Promise<void> {
  const session = getSessions().find((s) => s.id === sessionId);
  if (!session || session.exitCode !== -1) return; // unknown or already finalized

  const now = Date.now();
  const stats = diffFor(session, cwd);

  try {
    await updateSession(sessionId, {
      endedAt: new Date(now).toISOString(),
      durationSeconds: session.durationSeconds + activeSecondsSince(session.lastActivityAt, session.startedAt, now),
      ...stats,
      momentum: scoreSession({ ...stats, exitCode: 0 }, readConfig()),
      exitCode: 0,
      lastActivityAt: new Date(now).toISOString(),
    });
  } catch {}

  await flushPendingSubmissions(1500).catch(() => {});
}
