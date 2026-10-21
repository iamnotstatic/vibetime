import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// A settled session normally waits for a clean end to be submitted. When every
// endcard flush of a day fails — one rate-limit window is enough — nothing
// retriggers, and desktop sessions can stay open for days: nine finished
// sessions with 133 commits sat that way overnight. A live session already
// ticks onto the network every few minutes, so it carries the settled queue
// with it.

process.env.VIBE_DIR = mkdtempSync(join(tmpdir(), 'vibe-flush-tick-'));
delete process.env.VIBE_SESSION;

const posts = [];
let status = 200;
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url !== '/sessions') {
      res.statusCode = 404;
      return res.end('{"error":"no handler"}');
    }
    posts.push(JSON.parse(raw));
    res.statusCode = status;
    res.end(JSON.stringify({ ok: true, submittedAt: new Date().toISOString() }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.VIBE_API = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const { AUTH_PATH } = await import('../dist/auth.js');
const { handleHook } = await import('../dist/hook.js');
const { getSessions, updateSession } = await import('../dist/db.js');
const { progressSignature } = await import('../dist/submit.js');

const b64u = (s) => Buffer.from(s).toString('base64url');
const jwt = `${b64u('{"alg":"HS256","typ":"JWT"}')}.${b64u(JSON.stringify({ sub: 1, handle: 't', exp: Math.floor(Date.now() / 1000) + 100 * 86400 }))}.stub`;
writeFileSync(AUTH_PATH, JSON.stringify({ jwt, handle: 't', avatarUrl: null, issuedAt: new Date().toISOString(), refreshToken: 'r'.repeat(43) }));

function sh(cmd, cwd) {
  execSync(cmd, { cwd, stdio: 'pipe' });
}

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function repo(t) {
  const dir = tempDir(t, 'vibe-flush-tick-repo-');
  sh('git init -qb main repo', dir);
  const path = join(dir, 'repo');
  sh('git config user.email vibe@test && git config user.name vibe', path);
  sh('git commit -q --allow-empty -m init', path);
  return path;
}

function commitWork(path) {
  const tag = randomUUID();
  writeFileSync(join(path, 'work.txt'), Array.from({ length: 80 }, (_, i) => `${tag} ${i}`).join('\n') + '\n');
  sh('git add work.txt', path);
  sh('git commit -q -m work', path);
}

// Each test starts from an empty store, so no session left by another can
// settle during its hooks.
function fresh() {
  posts.length = 0;
  status = 200;
  writeFileSync(join(process.env.VIBE_DIR, 'sessions.json'), JSON.stringify({ sessions: [] }));
}

const start = (id, cwd) => handleHook('session-start', JSON.stringify({ session_id: id, cwd }), 'claude');
const activity = (id, cwd) => handleHook('activity', JSON.stringify({ session_id: id, cwd }), 'claude');
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const find = (id) => getSessions().find((s) => s.id === id);

// A finished session whose endcard flush failed: finalized, never submitted.
async function stuckAfterFailedFlush(t) {
  const work = repo(t);
  const id = randomUUID();
  await start(id, work);
  commitWork(work);
  await updateSession(id, {
    exitCode: 0, durationSeconds: 600,
    lastActivityAt: ago(3 * 3_600_000), endedAt: ago(3 * 3_600_000),
  });
  return id;
}

test('the due tick of a live session submits settled sessions that missed their clean end', async (t) => {
  fresh();
  const stuckId = await stuckAfterFailedFlush(t);

  const live = repo(t);
  const liveId = randomUUID();
  await start(liveId, live);
  commitWork(live);

  await activity(liveId, live);

  assert.equal(posts.filter((p) => p.id === stuckId).length, 1, 'the stuck session went out on the live tick');
  assert.ok(find(stuckId).submittedAt);
});

test('a live tick inside the throttle window does not drain the queue', async (t) => {
  fresh();
  const stuckId = await stuckAfterFailedFlush(t);

  const live = repo(t);
  const liveId = randomUUID();
  await start(liveId, live);
  commitWork(live);
  await updateSession(liveId, { lastProgressSubmitAt: ago(60_000) });

  await activity(liveId, live);

  assert.equal(posts.filter((p) => p.id === stuckId).length, 0, 'the tick is throttled');
  assert.equal(find(stuckId).submittedAt, undefined);
});

test('a shipped session with nothing new to say still carries the queue', async (t) => {
  fresh();
  const stuckId = await stuckAfterFailedFlush(t);

  const live = repo(t);
  const liveId = randomUUID();
  await start(liveId, live);
  commitWork(live);
  // A shipped session the server has already seen: the old early-returns
  // would leave the queue waiting for a clean end forever.
  await updateSession(liveId, {
    momentum: 'shipped', durationSeconds: 300,
    acceptedProgressSignature: progressSignature(find(liveId)),
    lastProgressSubmitAt: ago(10 * 60_000),
  });

  await activity(liveId, live);

  assert.equal(posts.filter((p) => p.id === stuckId).length, 1, 'the queue went out anyway');
  assert.equal(posts.filter((p) => p.id === liveId).length, 0, 'the unchanged session was deduped');
  assert.ok(find(stuckId).submittedAt);
});


test('rate-limited settled work stays pending and retries on the next due tick', async (t) => {
  fresh();
  const stuckId = await stuckAfterFailedFlush(t);
  const live = repo(t);
  const liveId = randomUUID();
  await start(liveId, live);
  status = 429;
  await activity(liveId, live);
  assert.equal(find(stuckId).submittedAt, undefined);
  assert.equal(posts.filter((p) => p.id === stuckId).length, 1);
  await activity(liveId, live);
  assert.equal(posts.filter((p) => p.id === stuckId).length, 1, 'failed attempts are still throttled');
  status = 200;
  await updateSession(liveId, { lastProgressSubmitAt: ago(10 * 60_000) });
  await activity(liveId, live);
  assert.equal(posts.filter((p) => p.id === stuckId).length, 2);
  assert.ok(find(stuckId).submittedAt);
});
