import { join } from 'node:path';
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmdirSync, unlinkSync, statSync, existsSync } from 'node:fs';
import { VIBE_DIR, ensureVibeDir, readConfig } from './config.js';
import { TUNABLES } from './remote-config.js';
import { scoreReaped, type MomentumTier } from './score.js';
import { sumWork, type RepoBaseline, type RepoWork, type GitDiffStats } from './git.js';

export interface Session {
  id: string;
  tool: string;
  project: string;
  branch: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  commits: number;
  linesAdded: number;
  linesRemoved: number;
  filesTouched: number;
  momentum: MomentumTier;
  exitCode: number;
  lastActivityAt?: string;
  submittedAt?: string;
  // HEAD sha when the session started. Hook-tracked sessions (Claude Code Desktop)
  // record start and end in separate processes, so the baseline sha is persisted
  // here rather than held in memory like the shell-wrapped flow.
  //
  // Superseded by `repos`, which carries a baseline per repo. Still written, and
  // still read as a fallback, so sessions recorded by an older CLI keep scoring
  // correctly across an upgrade.
  startSha?: string;
  // Every repo the session watches, each with its baseline HEAD: one entry for a
  // session started inside a repo, several for one started from a directory that
  // holds repos side by side.
  repos?: RepoBaseline[];
  // Set when the session has ended cleanly at least once. A hook session can be
  // reopened by later events carrying the same Claude session id (see hook.ts);
  // if it then goes idle, the reaper re-finalizes it as the clean end it already
  // had instead of downgrading it to `interrupted`.
  hadCleanEnd?: boolean;
  // The reaper ended this, not the editor, so revival stays unbounded. Neither
  // the exit code nor momentum can say so now that a reaped session keeps the
  // tier its work earned. Older records say it with `interrupted` instead.
  reapedAt?: string;
  // UTC days this session shipped on (one leaderboard point each), and the
  // stats snapshot at the last emitted event. Maintained by trackShipEvents in
  // score.ts; a multi-day session earns each day's event with that day's work.
  shipEvents?: string[];
  eventBaseline?: { commits: number; linesAdded: number; linesRemoved: number; filesTouched: number };
  // Throttle for the hook path's in-progress submits, persisted rather than
  // held in memory like the wrapper's: every hook event is its own process.
  lastProgressSubmitAt?: string;
  // Deliberately not `lastProgressSignature`: older CLIs saved that before
  // sending, so it can name a payload the server never received.
  acceptedProgressSignature?: string;
  // Commits this session has been credited with, as `sha key` (see CommitWork).
  // Local only, never submitted: it exists so no other session on this machine
  // can be credited with the same commit.
  credited?: string[];
}

interface DbSchema {
  sessions: Session[];
}

// Server-tunable via /config (clamped, cached in ~/.vibe/remote-config.json);
// 30 minutes unless the server says otherwise. Re-exported here because every
// consumer of the timeout historically imports it from db.
export const INACTIVITY_TIMEOUT_MS = TUNABLES.inactivityTimeoutMs;

const DB_PATH = join(VIBE_DIR, 'sessions.json');
const TMP_PATH = DB_PATH + '.tmp';
const LOCK_DIR = join(VIBE_DIR, 'sessions.lock');
const LOCK_STALE_MS = 10_000;

function acquireLock(retried = false): boolean {
  try {
    mkdirSync(LOCK_DIR);
    writeFileSync(join(LOCK_DIR, 'pid'), String(process.pid));
    return true;
  } catch {
    if (retried) return false;
    // lock exists — check if stale
    try {
      const pidFile = join(LOCK_DIR, 'pid');
      if (existsSync(pidFile)) {
        const stat = statSync(pidFile);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          releaseLock();
          return acquireLock(true);
        }
      }
    } catch {}
    return false;
  }
}

function releaseLock(): void {
  try {
    const pidFile = join(LOCK_DIR, 'pid');
    if (existsSync(pidFile)) unlinkSync(pidFile);
    rmdirSync(LOCK_DIR);
  } catch {}
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withLock<T>(fn: () => T): Promise<T> {
  const maxRetries = 20;
  const retryMs = 5;

  for (let i = 0; i < maxRetries; i++) {
    if (acquireLock()) {
      try {
        return fn();
      } finally {
        releaseLock();
      }
    }
    await delay(retryMs);
  }

  // fallback: run without lock rather than lose data
  return fn();
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// For callers that measure synchronously, like the wrapper's snapshot. Same
// lock, same fallback.
function withLockSync<T>(fn: () => T): T {
  for (let i = 0; i < 20; i++) {
    if (acquireLock()) {
      try {
        return fn();
      } finally {
        releaseLock();
      }
    }
    sleepSync(5);
  }
  return fn();
}

function readDb(): DbSchema {
  ensureVibeDir();
  if (!existsSync(DB_PATH)) return { sessions: [] };

  try {
    const raw = readFileSync(DB_PATH, 'utf-8');
    const data = JSON.parse(raw);
    if (Array.isArray(data.sessions)) return data;
    return { sessions: [] };
  } catch {
    const timestamp = Date.now();
    const corruptPath = `${DB_PATH}.corrupt.${timestamp}`;
    try { renameSync(DB_PATH, corruptPath); } catch {}
    console.error(`  vibe: sessions.json was corrupted, moved to ${corruptPath}`);
    return { sessions: [] };
  }
}

function writeDb(data: DbSchema): void {
  ensureVibeDir();
  writeFileSync(TMP_PATH, JSON.stringify(data, null, 2) + '\n');
  renameSync(TMP_PATH, DB_PATH);
}

export async function addSession(session: Session): Promise<void> {
  await withLock(() => {
    const data = readDb();
    // Parallel hook processes (Cursor native + imported Claude hooks) can both
    // pass the in-memory existence check; the lock makes this the real gate.
    if (data.sessions.some((s) => s.id === session.id)) return;
    data.sessions.push(session);
    writeDb(data);
  });
}

// Find-or-insert in one lock, returning whichever session now owns the slot.
// Two terminals launched at the same instant otherwise both read a file with no
// open session in it and each inserts its own, which is the duplicate this
// exists to prevent. Same reasoning as the id guard in addSession: the
// in-memory check is advisory, the lock is the gate.
export async function claimSession(
  session: Session,
  matches: (open: Session) => boolean,
): Promise<Session> {
  return withLock(() => {
    const data = readDb();
    const existing = data.sessions
      .filter((s) => s.exitCode === -1 && matches(s))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0];
    if (existing) return existing;
    data.sessions.push(session);
    writeDb(data);
    return session;
  });
}

export async function updateSession(id: string, updates: Partial<Session>): Promise<void> {
  await withLock(() => {
    const data = readDb();
    const session = data.sessions.find((s) => s.id === id);
    if (session) {
      Object.assign(session, updates);
      writeDb(data);
    }
  });
}

export function getSessions(): Session[] {
  return readDb().sessions;
}

export async function deleteSession(id: string): Promise<void> {
  await withLock(() => {
    const data = readDb();
    const before = data.sessions.length;
    data.sessions = data.sessions.filter((s) => s.id !== id);
    if (data.sessions.length !== before) writeDb(data);
  });
}

export async function reapOrphanedSessions(): Promise<void> {
  await withLock(() => {
    const data = readDb();
    const now = Date.now();
    let changed = false;

    for (const s of data.sessions) {
      if (s.exitCode !== -1) continue;

      const lastMs = new Date(s.lastActivityAt || s.startedAt).getTime();
      if (now - lastMs <= INACTIVITY_TIMEOUT_MS) continue;

      // durationSeconds is accumulated live with idle gaps excluded (hook
      // events and the wrapper poller both do this), so extend it by the same
      // capped tail the live path grants — never recompute from wall clock,
      // which would re-include every excluded gap. endedAt lands at the cutoff
      // so the rescore grace window still covers work committed just after.
      s.durationSeconds += Math.round(INACTIVITY_TIMEOUT_MS / 1000);
      s.endedAt = new Date(lastMs + INACTIVITY_TIMEOUT_MS).toISOString();
      if (s.hadCleanEnd) {
        // Revived after a clean end (see hook.ts): idling out again is not an
        // interruption — re-finalize as the clean end it already had, keeping
        // the momentum scored against live stats.
        s.exitCode = 0;
      } else {
        s.exitCode = 1;
        s.reapedAt = s.endedAt;
        s.momentum = scoreReaped(s, readConfig());
      }
      changed = true;
    }

    if (changed) writeDb(data);
  });
}

// A claim this old can't collide with anything still being measured, and
// sessions are kept forever, so dropping it keeps sessions.json from growing
// by every commit ever made.
const CREDIT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

type Contender = Pick<Session, 'id' | 'startedAt' | 'repos'>;

const homes = (s: Contender): string[] => (s.repos ?? []).map((r) => r.path);
const knownCheckouts = (s: Contender): string[] =>
  (s.repos ?? []).flatMap((r) => [r.path, ...(r.worktrees ?? []).map((t) => t.path)]);
const newest = (list: Contender[]): Contender | undefined =>
  [...list].sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id))[0];

// Credits this session with the work in its repos that no other session on
// this machine has, and returns the stats of what it was credited.
//
// Every open session watches every checkout of its repos, so without this a
// commit made in one worktree is also counted by the session in the main
// checkout and by every sibling worktree's session, and two editor windows on
// one branch each count the other's commits. One commit, one session, is the
// only unit that credits the effort once however the sessions overlap.
//
// A commit goes to the first session to claim it, and stays there. Only a
// checkout's owner may claim what its tip reaches: the newest open session
// started in it, or failing that the newest open session watching the repo.
// That keeps a worktree's commits with the session working in it rather than
// whichever sibling happened to poll first. Newest, because an editor window
// left open for days is still an open session, and the one just started in
// that checkout is the one doing the work its endcard should show. Uncommitted
// work follows the same ownership, since it too sits in exactly one checkout.
export function creditWork(session: Contender, work: RepoWork[]): GitDiffStats {
  return withLockSync(() => {
    const data = readDb();
    const now = Date.now();
    const cutoff = now - CREDIT_RETENTION_MS;
    let changed = false;

    const takenShas = new Set<string>();
    const takenKeys = new Map<string, string[]>();
    for (const other of data.sessions) {
      if (!Array.isArray(other.credited)) continue;
      if (other.exitCode !== -1 && Date.parse(other.endedAt) < cutoff) {
        delete other.credited;
        changed = true;
        continue;
      }
      if (other.id === session.id) continue;
      for (const entry of other.credited) {
        const [sha, ...key] = String(entry).split(' ');
        takenShas.add(sha);
        const k = key.join(' ');
        takenKeys.set(k, [...(takenKeys.get(k) ?? []), sha]);
      }
    }

    const self = data.sessions.find((s) => s.id === session.id);
    const ownShas = new Set((Array.isArray(self?.credited) ? self.credited : []).map((e) => String(e).split(' ')[0]));
    const contenders = [
      ...data.sessions.filter((s) => s.exitCode === -1 && s.id !== session.id),
      session,
    ];
    const ownsCheckout = (path: string, repoCheckouts: string[]): boolean => {
      const homed = contenders.filter((s) => homes(s).includes(path));
      const owner = newest(homed.length ? homed : contenders.filter((s) => knownCheckouts(s).some((p) => repoCheckouts.includes(p))));
      return !owner || owner.id === session.id;
    };

    const credited = new Set<string>();
    const claimed: string[] = [];
    for (const repo of work) {
      const inRange = new Set(repo.commits.map((c) => c.sha));
      // A key another session holds for a sha no longer in range is a
      // rewritten copy of its commit. Two distinct commits can share an author
      // second, so each held key excuses only as many commits as it was held for.
      const rewrittenLeft = new Map<string, number>();
      for (const [k, shas] of takenKeys) rewrittenLeft.set(k, shas.filter((sha) => !inRange.has(sha)).length);

      for (const commit of repo.commits) {
        if (ownShas.has(commit.sha)) {
          credited.add(commit.sha);
          continue;
        }
        if (takenShas.has(commit.sha)) continue;
        const left = rewrittenLeft.get(commit.key) ?? 0;
        if (left > 0) {
          rewrittenLeft.set(commit.key, left - 1);
          continue;
        }
        if (!commit.checkouts.some((p) => ownsCheckout(p, repo.checkouts))) continue;
        credited.add(commit.sha);
        claimed.push(`${commit.sha} ${commit.key}`);
      }
    }

    if (self && claimed.length) {
      self.credited = [...(Array.isArray(self.credited) ? self.credited : []), ...claimed];
      changed = true;
    }
    // Measuring must never fail on account of the ledger. Claims that could not
    // be written are made again on the next measure, which is all they need.
    if (changed) {
      try { writeDb(data); } catch {}
    }

    return sumWork(
      work,
      (c) => credited.has(c.sha),
      (path) => ownsCheckout(path, work.find((r) => r.checkouts.includes(path))?.checkouts ?? []),
    );
  });
}
