import { join } from 'node:path';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
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
  const data = readDb();
  data.sessions.push(session);
  writeDb(data);
}

export async function updateSession(id: string, updates: Partial<Session>): Promise<void> {
  const data = readDb();
  const session = data.sessions.find((s) => s.id === id);
  if (session) {
    Object.assign(session, updates);
    writeDb(data);
  }
}

export async function getSessions(): Promise<Session[]> {
  return readDb().sessions;
}
