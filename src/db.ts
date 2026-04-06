import { join } from 'node:path';
import { JSONFilePreset } from 'lowdb/node';
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

export async function getDb(): Promise<import('lowdb').Low<DbSchema>> {
  ensureVibeDir();
  const db = await JSONFilePreset<DbSchema>(DB_PATH, { sessions: [] });
  return db;
}

export async function addSession(session: Session): Promise<void> {
  const db = await getDb();
  db.data.sessions.push(session);
  await db.write();
}

export async function getSessions(): Promise<Session[]> {
  const db = await getDb();
  return db.data.sessions;
}
