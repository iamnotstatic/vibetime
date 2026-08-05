import { getSessions, updateSession, reapOrphanedSessions, INACTIVITY_TIMEOUT_MS, type Session } from './db.js';
import { getReposDiffStats } from './git.js';
import { readConfig } from './config.js';
import { scoreSession } from './score.js';

// How long after a session ends its work can still land. You close the tab and
// commit from the terminal a minute later; you step away mid-task and come back
// to finish. The window matches the inactivity timeout used everywhere else.
const GRACE_MS = INACTIVITY_TIMEOUT_MS;

function statsChanged(session: Session, stats: { commits: number; linesAdded: number; linesRemoved: number; filesTouched: number }): boolean {
  return (
    session.commits !== stats.commits ||
    session.linesAdded !== stats.linesAdded ||
    session.linesRemoved !== stats.linesRemoved ||
    session.filesTouched !== stats.filesTouched
  );
}

// A later session watching the same repo has its own baseline, taken after this
// one closed, so anything committed from then on belongs to it. Without this
// check the same commit could be credited to both.
function supersededBy(session: Session, all: Session[]): boolean {
  const endedMs = Date.parse(session.endedAt);
  const paths = new Set((session.repos ?? []).map((r) => r.path));
  return all.some(
    (other) =>
      other.id !== session.id &&
      Date.parse(other.startedAt) >= endedMs &&
      (other.repos ?? []).some((r) => paths.has(r.path)),
  );
}

// Re-read git for sessions whose stats can still move: the ones still open, and
// the ones that closed recently enough that work is still landing in them.
//
// This is what keeps an abandoned session honest. The reaper closes anything
// idle for 30 minutes, but it only writes a duration — the stats stay frozen at
// the last hook event. Commit, then shut the laptop without ending the session,
// and the commit is never read: the session is submitted with zero. Refreshing
// before the reaper runs means the work is recorded whether or not you came back
// to end it cleanly.
export async function refreshRecentSessions(): Promise<void> {
  const now = Date.now();
  const all = getSessions();
  const config = readConfig();

  for (const session of all) {
    // Sessions from an older CLI have no repo baselines to measure against.
    if (!session.repos?.length) continue;

    const open = session.exitCode === -1;
    if (!open) {
      if (now - Date.parse(session.endedAt) > GRACE_MS) continue;
      if (supersededBy(session, all)) continue;
    }

    const stats = getReposDiffStats(session.repos);
    if (!statsChanged(session, stats)) continue;

    await updateSession(session.id, {
      ...stats,
      momentum: scoreSession({ ...stats, exitCode: session.exitCode }, config),
      // The corrected state has to reach the server; it upserts on id, so
      // resubmitting is safe.
      submittedAt: undefined,
    });
  }
}

// Refresh first, then reap: a session the reaper is about to close carries the
// work it actually did rather than whatever the last hook event happened to see.
export async function refreshAndReap(): Promise<void> {
  await refreshRecentSessions();
  await reapOrphanedSessions();
}
