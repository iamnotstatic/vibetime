import { join } from 'node:path';
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmdirSync, unlinkSync, statSync, existsSync } from 'node:fs';
import { VIBE_DIR, ensureVibeDir } from './config.js';

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
  momentum: string;
  exitCode: number;
}

interface DbSchema {
  sessions: Session[];
}

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

function withLock<T>(fn: () => T): T {
  const maxRetries = 20;
  const retryMs = 50;

  for (let i = 0; i < maxRetries; i++) {
    if (acquireLock()) {
      try {
        return fn();
      } finally {
        releaseLock();
      }
    }
    const start = Date.now();
    while (Date.now() - start < retryMs) { /* spin wait */ }
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
  withLock(() => {
    const data = readDb();
    data.sessions.push(session);
    writeDb(data);
  });
}

export async function updateSession(id: string, updates: Partial<Session>): Promise<void> {
  withLock(() => {
    const data = readDb();
    const session = data.sessions.find((s) => s.id === id);
    if (session) {
      Object.assign(session, updates);
      writeDb(data);
    }
  });
}

export async function getSessions(): Promise<Session[]> {
  return readDb().sessions;
}
