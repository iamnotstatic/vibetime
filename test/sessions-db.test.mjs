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

const { addSession, getSessions, creditWork } = await import('../dist/db.js');
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

  await assert.rejects(addSession(makeSession()), /database is busy/);

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

test('concurrent writers preserve every session without tearing sessions.json', async (t) => {
  reset(t);
  // A big file keeps each write in flight long enough for writers to overlap.
  const seeded = Array.from({ length: 3000 }, () => makeSession({ project: 'x'.repeat(200) }));
  writeFileSync(DB_PATH, JSON.stringify({ sessions: seeded }, null, 2) + '\n');
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
  assert.equal(data.sessions.length, seeded.length + 6 * 8);
  assert.equal(new Set(data.sessions.map((s) => s.id)).size, data.sessions.length);
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

test('unrecoverable data is preserved on reads and backed up before the next write', async (t) => {
  reset(t);
  writeFileSync(DB_PATH, '{"sessions": [{"id": "trunc');

  assert.deepEqual(getSessions(), []);
  assert.equal(corruptCopies().length, 0);
  assert.equal(readFileSync(DB_PATH, 'utf-8'), '{"sessions": [{"id": "trunc');
  await addSession(makeSession());
  assert.equal(corruptCopies().length, 1);
  assert.equal(getSessions().length, 1);
});


test('a live lock is never stolen just because it is old', async (t) => {
  reset(t);
  const original = JSON.stringify({ sessions: [makeSession()] });
  writeFileSync(DB_PATH, original);
  mkdirSync(LOCK_DIR);
  writeFileSync(join(LOCK_DIR, 'pid'), String(process.pid));
  age(join(LOCK_DIR, 'pid'), 60_000);
  await assert.rejects(addSession(makeSession()), /database is busy/);
  assert.throws(() => creditWork({ id: 'busy', startedAt: new Date().toISOString(), repos: [] }, []), /database is busy/);
  assert.equal(readFileSync(DB_PATH, 'utf-8'), original);
  assert.equal(readFileSync(join(LOCK_DIR, 'pid'), 'utf-8'), String(process.pid));
});

test('a truncated file recovers complete records and ignores partial or nested metadata', async (t) => {
  reset(t);
  const kept = makeSession({ project: 'quotes " and \\ braces {[]}', commitFacts: [{ id: 'nested', startedAt: 'fake', tool: 'fake' }] });
  const raw = '{"sessions": [' + JSON.stringify(kept) + ', {"id": "partial"';
  writeFileSync(DB_PATH, raw);
  assert.deepEqual(getSessions(), [kept]);
  assert.equal(readFileSync(DB_PATH, 'utf-8'), raw, 'read-only recovery leaves disk alone');
  assert.deepEqual(corruptCopies(), []);
  await addSession(makeSession());
  assert.equal(getSessions().length, 2);
  assert.equal(readFileSync(join(process.env.VIBE_DIR, corruptCopies()[0]), 'utf-8'), raw);
});

test('spliced documents keep the later complete copy of each session', async (t) => {
  reset(t);
  const first = makeSession();
  const second = makeSession();
  const updated = { ...first, commits: 9 };
  writeFileSync(DB_PATH, JSON.stringify({ sessions: [first, second] }) + JSON.stringify({ sessions: [updated] }));
  assert.deepEqual(getSessions(), [updated, second]);
});

test('a competing stale-lock breaker cannot remove the dead lock while the gate is held', async (t) => {
  reset(t);
  const { pid } = spawnSync(process.execPath, ['-e', '']);
  mkdirSync(LOCK_DIR);
  writeFileSync(join(LOCK_DIR, 'pid'), String(pid));
  const gate = LOCK_DIR + '.break';
  mkdirSync(gate);
  t.after(() => rmSync(gate, { recursive: true, force: true }));
  await assert.rejects(addSession(makeSession()), /database is busy/);
  assert.equal(readFileSync(join(LOCK_DIR, 'pid'), 'utf8'), String(pid));
  assert.equal(existsSync(DB_PATH), false);
  rmSync(gate, { recursive: true });
  await addSession(makeSession());
  assert.equal(getSessions().length, 1);
  assert.equal(existsSync(gate), false);
});

test('the dead holder is rechecked after taking the breaker gate', async (t) => {
  reset(t);
  const { pid } = spawnSync(process.execPath, ['-e', '']);
  mkdirSync(LOCK_DIR);
  writeFileSync(join(LOCK_DIR, 'pid'), String(pid));
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const mkdir = fs.mkdirSync;
    fs.mkdirSync = (path, ...args) => {
      if (path === ${JSON.stringify(LOCK_DIR + '.break')}) {
        // Another contender has replaced the dead holder after our stale read.
        fs.writeFileSync(${JSON.stringify(join(LOCK_DIR, 'pid'))}, ${JSON.stringify(String(process.pid))});
      }
      return mkdir(path, ...args);
    };
    syncBuiltinESMExports();
    const { addSession } = await import(${JSON.stringify(dbModule)});
    try {
      await addSession(${JSON.stringify(makeSession())});
      process.exitCode = 1;
    } catch (err) {
      if (!/database is busy/.test(err.message)) throw err;
    }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0, stderr);
  assert.equal(readFileSync(join(LOCK_DIR, 'pid'), 'utf8'), String(process.pid));
  assert.equal(existsSync(DB_PATH), false);
});

test('simultaneous writers recover one dead lock without losing any sessions', async (t) => {
  reset(t);
  const { pid } = spawnSync(process.execPath, ['-e', '']);
  mkdirSync(LOCK_DIR);
  writeFileSync(join(LOCK_DIR, 'pid'), String(pid));
  const sessions = Array.from({ length: 8 }, () => makeSession());
  const children = sessions.map((session) => spawn(process.execPath, ['--input-type=module', '-e', `
    const { addSession } = await import(${JSON.stringify(dbModule)});
    process.send('ready');
    process.once('message', async () => { await addSession(${JSON.stringify(session)}); process.disconnect(); });
  `], { env: process.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
  const closed = children.map((child) => new Promise((resolve) => {
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stderr }));
  }));
  await Promise.all(children.map((child) => new Promise((resolve) => child.once('message', resolve))));
  for (const child of children) child.send('go');
  for (const result of await Promise.all(closed)) assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(getSessions().map((s) => s.id).sort(), sessions.map((s) => s.id).sort());
  assert.equal(existsSync(LOCK_DIR + '.break'), false);
});
