import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const home = mkdtempSync(join(tmpdir(), 'vibe-flush-concurrency-'));
process.env.VIBE_DIR = home;
delete process.env.VIBE_SESSION;
const posts = [];
let response = async () => 200;
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', async () => {
    const session = JSON.parse(raw);
    posts.push(session);
    const status = await response(session);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: status === 200, submittedAt: new Date().toISOString() }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.VIBE_API = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); rmSync(home, { recursive: true, force: true }); });
const { flushPendingSubmissions } = await import('../dist/submit.js');
const { getSessions, updateSession } = await import('../dist/db.js');
const submitModule = new URL('../dist/submit.js', import.meta.url).href;
const b64 = (s) => Buffer.from(JSON.stringify(s)).toString('base64url');
const jwt = `${b64({ alg: 'HS256' })}.${b64({ sub: 1, exp: Math.floor(Date.now() / 1000) + 864000 })}.stub`;
const lock = join(home, 'submit.lock');

function session() {
  return { id: randomUUID(), tool: 'claude', project: 'repo', branch: 'main',
    startedAt: new Date(Date.now() - 600000).toISOString(), endedAt: new Date().toISOString(),
    durationSeconds: 600, commits: 1, linesAdded: 80, linesRemoved: 0, filesTouched: 1,
    momentum: 'shipped', exitCode: 0 };
}
function reset(sessions = [session()]) {
  posts.length = 0;
  response = async () => 200;
  writeFileSync(join(home, 'sessions.json'), JSON.stringify({ sessions }));
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ jwt, handle: 't', issuedAt: new Date().toISOString() }));
  rmSync(lock, { recursive: true, force: true });
  rmSync(lock + '.break', { recursive: true, force: true });
  return sessions;
}

async function parallelFlushers(count) {
  const children = Array.from({ length: count }, () => spawn(process.execPath, ['--input-type=module', '-e', `
    const { flushPendingSubmissions } = await import(${JSON.stringify(submitModule)});
    process.send('ready');
    process.once('message', async () => { await flushPendingSubmissions(3000); process.disconnect(); });
  `], { env: process.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
  const completed = children.map((child) => new Promise((resolve) => {
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stderr }));
  }));
  await Promise.all(children.map((child) => new Promise((resolve) => child.once('message', resolve))));
  for (const child of children) child.send('go');
  for (const result of await Promise.all(completed)) assert.equal(result.code, 0, result.stderr);
}

test('six agents drain the queue once while database updates remain available', async () => {
  const sessions = reset([session(), session(), session()]);
  response = async (sent) => {
    // A submit lock must not hold the database lock across a network wait.
    await updateSession(sent.id, { durationSeconds: sent.durationSeconds });
    await new Promise((resolve) => setTimeout(resolve, 100));
    return 200;
  };
  await parallelFlushers(6);
  assert.deepEqual(posts.map((s) => s.id).sort(), sessions.map((s) => s.id).sort());
  assert.ok(getSessions().every((s) => s.submittedAt));
  assert.equal(existsSync(lock), false);
});

test('overlapping flushes in one process do not upload the same snapshot twice', async () => {
  reset();
  response = async () => { await new Promise((resolve) => setTimeout(resolve, 100)); return 200; };
  await Promise.all(Array.from({ length: 6 }, () => flushPendingSubmissions(2000)));
  assert.equal(posts.length, 1);
  assert.equal(existsSync(lock), false);
});

for (const status of [200, 400]) {
  test(`a ${status} for an old payload does not settle a correction made in flight`, async () => {
    const [queued] = reset();
    response = async () => { await updateSession(queued.id, { commits: 2, linesAdded: 160 }); return status; };
    await flushPendingSubmissions(2000);
    assert.equal(posts[0].commits, 1);
    assert.equal(getSessions()[0].submittedAt, undefined);
    response = async () => 200;
    await flushPendingSubmissions(2000);
    assert.equal(posts[1].commits, 2);
    assert.ok(getSessions()[0].submittedAt);
  });
}

test('a session reopened while an earlier upload is in flight is skipped', async () => {
  const [first, second] = reset([session(), session()]);
  response = async () => { await updateSession(second.id, { exitCode: -1 }); return 200; };
  await flushPendingSubmissions(2000);
  assert.deepEqual(posts.map((s) => s.id), [first.id]);
  assert.equal(getSessions().find((s) => s.id === second.id).submittedAt, undefined);
});

test('a 429 releases the queue lock and leaves work retryable', async () => {
  reset();
  response = async () => 429;
  await flushPendingSubmissions(2000);
  assert.equal(existsSync(lock), false);
  assert.equal(getSessions()[0].submittedAt, undefined);
  response = async () => 200;
  await flushPendingSubmissions(2000);
  assert.equal(posts.length, 2);
  assert.ok(getSessions()[0].submittedAt);
});

test('a live flush owner is not evicted by age', async () => {
  reset();
  mkdirSync(lock);
  writeFileSync(join(lock, 'pid'), String(process.pid));
  const old = new Date(Date.now() - 3600000);
  utimesSync(lock, old, old);
  await flushPendingSubmissions(2000);
  assert.equal(posts.length, 0);
  assert.equal(readFileSync(join(lock, 'pid'), 'utf8'), String(process.pid));
});

test('a killed flush owner is recovered once across concurrent contenders', async () => {
  reset();
  const { pid } = spawnSync(process.execPath, ['-e', '']);
  mkdirSync(lock);
  writeFileSync(join(lock, 'pid'), String(pid));
  response = async () => { await new Promise((resolve) => setTimeout(resolve, 150)); return 200; };
  await parallelFlushers(6);
  assert.equal(posts.length, 1);
  assert.equal(existsSync(lock), false);
});

test('a fresh pidless flush lock is respected and an abandoned one ages out', async () => {
  reset();
  mkdirSync(lock);
  await flushPendingSubmissions(2000);
  assert.equal(posts.length, 0);
  const old = new Date(Date.now() - 60000);
  utimesSync(lock, old, old);
  await flushPendingSubmissions(2000);
  assert.equal(posts.length, 1);
  assert.equal(existsSync(lock), false);
});


test('legacy duplicate rows settle together without later uploading the smaller copy', async () => {
  const winner = session();
  reset([{ ...winner, commits: 0, linesAdded: 0, durationSeconds: 60 }, winner]);
  await flushPendingSubmissions(2000);
  await flushPendingSubmissions(2000);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].commits, 1);
  assert.ok(getSessions().every((s) => s.submittedAt));
});
