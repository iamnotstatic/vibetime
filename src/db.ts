import { join } from 'node:path';
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmdirSync, unlinkSync, statSync, existsSync } from 'node:fs';
import { VIBE_DIR, ensureVibeDir } from './config.js';
import type { MomentumTier } from './score.js';
import type { RepoBaseline } from './git.js';

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
}

interface DbSchema {
  sessions: Session[];
}

export const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

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
    data.sessions.push(session);
    writeDb(data);
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
        s.momentum = 'interrupted';
      }
      changed = true;
    }

    if (changed) writeDb(data);
  });
}
