import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// A desktop session that is never ended cleanly is finalized by the reaper,
// which runs on the next session-start. Only session-end flushed the submit
// queue, so the reaped session sat unsent until some other session happened to
// end cleanly or a vibe command ran: a session with 15 commits waited over two
// hours that way.

process.env.VIBE_DIR = mkdtempSync(join(tmpdir(), 'vibe-flush-reap-'));
delete process.env.VIBE_SESSION;

const posts = [];
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
    res.end(JSON.stringify({ ok: true, submittedAt: new Date().toISOString() }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.VIBE_API = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const { AUTH_PATH } = await import('../dist/auth.js');
const { handleHook } = await import('../dist/hook.js');
const { getSessions, updateSession } = await import('../dist/db.js');

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
  const dir = tempDir(t, 'vibe-flush-reap-repo-');
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
  writeFileSync(join(process.env.VIBE_DIR, 'sessions.json'), JSON.stringify({ sessions: [] }));
}

const start = (id, cwd) => handleHook('session-start', JSON.stringify({ session_id: id, cwd }), 'claude');
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const find = (id) => getSessions().find((s) => s.id === id);

// Leaves the session idle past the reaper's cutoff, as a desktop window left
// open and never closed would be.
async function abandon(id) {
  await updateSession(id, { lastActivityAt: ago(40 * 60_000), endedAt: ago(40 * 60_000) });
}

test('a session the reaper finalizes is sent on the next session-start, with no session-end', async (t) => {
  fresh();
  const work = repo(t);
  const id = randomUUID();
  await start(id, work);
  commitWork(work);
  await abandon(id);

  // The next session starts somewhere else entirely; its hook still reaps.
  await start(randomUUID(), tempDir(t, 'vibe-flush-reap-elsewhere-'));

  const reaped = find(id);
  assert.equal(reaped.exitCode, 1, 'the reaper finalized it');
  assert.ok(reaped.submittedAt, 'and the same hook submitted it');
  const sent = posts.filter((p) => p.id === id);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].commits, 1, 'carrying the commit it made before going idle');
});

test('work that lands after the reap is sent on the next session-start', async (t) => {
  fresh();
  const work = repo(t);
  const id = randomUUID();
  await start(id, work);
  commitWork(work);
  await abandon(id);
  await start(randomUUID(), tempDir(t, 'vibe-flush-reap-elsewhere-'));
  assert.equal(posts.filter((p) => p.id === id).length, 1);

  // Still inside the grace window the reaper leaves for late commits.
  commitWork(work);
  await start(randomUUID(), tempDir(t, 'vibe-flush-reap-elsewhere-'));

  const sent = posts.filter((p) => p.id === id);
  assert.equal(sent.length, 2, 'the corrected session is resent');
  assert.equal(sent[1].commits, 2);
  assert.ok(find(id).submittedAt);
});

test('a session-start that reaps nothing does not touch the submit queue', async (t) => {
  fresh();
  const work = repo(t);
  const id = randomUUID();
  await start(id, work);
  commitWork(work);
  // Already finalized long ago and still waiting: sending it is the job of a
  // clean end or a vibe command, not of every session-start.
  await updateSession(id, {
    exitCode: 0, durationSeconds: 600,
    lastActivityAt: ago(3 * 3_600_000), endedAt: ago(3 * 3_600_000),
  });

  await start(randomUUID(), tempDir(t, 'vibe-flush-reap-elsewhere-'));

  assert.equal(posts.length, 0);
  assert.equal(find(id).submittedAt, undefined);
});
