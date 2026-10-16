import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// sessions.json is the only copy of a user's history, and every hook event is
// its own process writing it. A lock dir left behind by a killed process sent
// every write down the unlocked fallback for good, unlocked writers shared one
// tmp file and tore it, and the torn file was then reset to empty.

process.env.VIBE_DIR = mkdtempSync(join(tmpdir(), 'vibe-home-'));
delete process.env.VIBE_SESSION;

const { addSession, getSessions } = await import('../dist/db.js');
const dbModule = new URL('../dist/db.js', import.meta.url).href;

const DB_PATH = join(process.env.VIBE_DIR, 'sessions.json');
const LOCK_DIR = join(process.env.VIBE_DIR, 'sessions.lock');

function makeSession(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    tool: 'claude',
    project: 'vibe',
    branch: 'main',
    startedAt: now,
    endedAt: now,
    durationSeconds: 60,
    commits: 0,
    linesAdded: 0,
    linesRemoved: 0,
    filesTouched: 0,
    momentum: 'none',
    exitCode: 0,
    ...overrides,
  };
}

function reset(t) {
  for (const name of readdirSync(process.env.VIBE_DIR)) {
    rmSync(join(process.env.VIBE_DIR, name), { recursive: true, force: true });
  }
  t.after(() => rmSync(LOCK_DIR, { recursive: true, force: true }));
}

const corruptCopies = () => readdirSync(process.env.VIBE_DIR).filter((n) => n.startsWith('sessions.json.corrupt.'));

function age(path, ms) {
  const then = new Date(Date.now() - ms);
  utimesSync(path, then, then);
}

test('a lock dir with no pid file is cleared once it is old enough', async (t) => {
  reset(t);
  // What a process killed between mkdir and writing its pid leaves behind.
  mkdirSync(LOCK_DIR);
  age(LOCK_DIR, 60_000);

  const session = makeSession();
  await addSession(session);

  assert.ok(getSessions().some((s) => s.id === session.id));
  // Cleared, taken, released: an ignored stale lock would still be here, with
  // the write having gone through the unlocked fallback.
  assert.equal(existsSync(LOCK_DIR), false);
});

test('a fresh lock dir with no pid file is still respected', async (t) => {
  reset(t);
  // The holder may be between mkdir and writing its pid right now.
  mkdirSync(LOCK_DIR);

  await addSession(makeSession());

  assert.equal(existsSync(LOCK_DIR), true);
});

test('a lock held by a pid that no longer exists is cleared', async (t) => {
  reset(t);
  const { pid } = spawnSync(process.execPath, ['-e', '']);
  mkdirSync(LOCK_DIR);
  writeFileSync(join(LOCK_DIR, 'pid'), String(pid));

  const session = makeSession();
  await addSession(session);

  assert.ok(getSessions().some((s) => s.id === session.id));
  assert.equal(existsSync(LOCK_DIR), false);
});

test('writers that fall back to running unlocked never tear sessions.json', async (t) => {
  reset(t);
  // A big file keeps each write in flight long enough for writers to overlap.
  const seeded = Array.from({ length: 3000 }, () => makeSession({ project: 'x'.repeat(200) }));
  writeFileSync(DB_PATH, JSON.stringify({ sessions: seeded }, null, 2) + '\n');
  // Held by this live process for the whole test, so every child waits out its
  // retries and then writes unlocked, as they did behind the stale lock.
  mkdirSync(LOCK_DIR);
  writeFileSync(join(LOCK_DIR, 'pid'), String(process.pid));

  const writer = `
    const { addSession } = await import(${JSON.stringify(dbModule)});
    for (let i = 0; i < 8; i++) {
      const now = new Date().toISOString();
      await addSession({ id: crypto.randomUUID(), tool: 'claude', project: 'w', branch: 'main', startedAt: now, endedAt: now,
        durationSeconds: 1, commits: 0, linesAdded: 0, linesRemoved: 0, filesTouched: 0, momentum: 'none', exitCode: 0 });
    }
  `;
  const children = Array.from({ length: 6 }, () => spawn(process.execPath, ['--input-type=module', '-e', writer], {
    env: process.env, stdio: ['ignore', 'ignore', 'pipe'],
  }));
  const results = await Promise.all(children.map((child) => new Promise((resolve) => {
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stderr }));
  })));

  for (const { code, stderr } of results) assert.equal(code, 0, stderr);
  assert.deepEqual(corruptCopies(), []);
  const data = JSON.parse(readFileSync(DB_PATH, 'utf-8'));
  // Unlocked writers can still lose each other's update; they must never lose
  // what was already there.
  assert.ok(data.sessions.length > seeded.length);
  assert.deepEqual(readdirSync(process.env.VIBE_DIR).filter((n) => n.endsWith('.tmp')), []);
});

test('a torn sessions.json keeps the whole document it starts with', async (t) => {
  reset(t);
  // Braces and quotes inside strings must not end the document early.
  const kept = [makeSession({ project: 'a "quoted" {brace}' }), makeSession({ branch: 'fix/}]' }), makeSession()];
  const whole = JSON.stringify({ sessions: kept }, null, 2) + '\n';
  // Two writers through one inode: the shorter document, then the tail of the
  // longer one it overwrote.
  const torn = whole + '      "exitCode": 0\n    }\n  ]\n}\n';
  writeFileSync(DB_PATH, torn);

  assert.deepEqual(getSessions().map((s) => s.id), kept.map((s) => s.id));

  const added = makeSession();
  await addSession(added);

  const data = JSON.parse(readFileSync(DB_PATH, 'utf-8'));
  assert.deepEqual(data.sessions.map((s) => s.id), [...kept, added].map((s) => s.id));
  const copies = corruptCopies();
  assert.equal(copies.length, 1);
  assert.equal(readFileSync(join(process.env.VIBE_DIR, copies[0]), 'utf-8'), torn);
});

test('a sessions.json with nothing to recover is moved aside and starts empty', async (t) => {
  reset(t);
  writeFileSync(DB_PATH, '{"sessions": [{"id": "trunc');

  assert.deepEqual(getSessions(), []);
  assert.equal(corruptCopies().length, 1);
});
