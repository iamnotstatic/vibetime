import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

process.env.VIBE_DIR = mkdtempSync(join(tmpdir(), 'vibe-resend-'));
delete process.env.VIBE_SESSION;

// Each POST /sessions takes the next scripted status; the rest get 200.
let script = [];
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
    const next = script.shift() ?? 200;
    if (next === 'hang') {
      posts.push({ status: 'hang', body: JSON.parse(raw) });
      return setTimeout(() => { res.statusCode = 200; res.end('{"ok":true}'); }, 1000);
    }
    const status = next;
    posts.push({ status, body: JSON.parse(raw) });
    res.statusCode = status;
    res.end(JSON.stringify(status === 200 ? { ok: true, submittedAt: new Date().toISOString() } : { error: 'scripted' }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.VIBE_API = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const { AUTH_PATH } = await import('../dist/auth.js');
const { handleHook } = await import('../dist/hook.js');
const { getSessions, updateSession, addSession } = await import('../dist/db.js');
const { submitInProgress } = await import('../dist/submit.js');

const b64u = (s) => Buffer.from(s).toString('base64url');
const jwt = `${b64u('{"alg":"HS256","typ":"JWT"}')}.${b64u(JSON.stringify({ sub: 1, handle: 't', exp: Math.floor(Date.now() / 1000) + 100 * 86400 }))}.stub`;
writeFileSync(AUTH_PATH, JSON.stringify({ jwt, handle: 't', avatarUrl: null, issuedAt: new Date().toISOString(), refreshToken: 'r'.repeat(43) }));

function sh(cmd, cwd) {
  execSync(cmd, { cwd, stdio: 'pipe' });
}

function shippedRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vibe-resend-repo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  sh('git init -qb main repo', dir);
  const repo = join(dir, 'repo');
  // Committed as the repo's own identity, so the author filter counts it.
  sh('git config user.email vibe@test && git config user.name vibe', repo);
  sh('git commit -q --allow-empty -m init', repo);
  return repo;
}

function commitWork(repo) {
  writeFileSync(join(repo, 'work.txt'), Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n') + '\n');
  sh('git add work.txt', repo);
  sh('git commit -q -m work', repo);
}

// Pushes the session's clocks back so the next activity event refreshes git,
// accrues submittable duration, and is past the in-progress throttle.
async function age(id) {
  const back = (ms) => new Date(Date.now() - ms).toISOString();
  const s = getSessions().find((x) => x.id === id);
  await updateSession(id, {
    lastActivityAt: back(90_000),
    ...(s.lastProgressSubmitAt ? { lastProgressSubmitAt: back(6 * 60_000) } : {}),
  });
}

function activity(id, repo) {
  return handleHook('activity', JSON.stringify({ session_id: id, cwd: repo }), 'claude');
}

test('a failed in-progress submit is resent once the throttle allows, then not again', async (t) => {
  posts.length = 0;
  const repo = shippedRepo(t);
  const id = randomUUID();
  await handleHook('session-start', JSON.stringify({ session_id: id, cwd: repo }), 'claude');
  commitWork(repo);

  script = [503];
  await age(id);
  await activity(id, repo);
  assert.deepEqual(posts.map((p) => p.status), [503], 'first submit reaches the server and fails');

  await age(id);
  await activity(id, repo);
  assert.deepEqual(posts.map((p) => p.status), [503, 200], 'unchanged payload is resent after a failure');
  assert.deepEqual(posts[1].body.shipEvents, posts[0].body.shipEvents);

  await age(id);
  await activity(id, repo);
  assert.equal(posts.length, 2, 'an accepted payload is not sent again');
});

test('a signature recorded by an older CLI does not block the resend', async (t) => {
  posts.length = 0;
  const repo = shippedRepo(t);
  const id = randomUUID();
  await handleHook('session-start', JSON.stringify({ session_id: id, cwd: repo }), 'claude');
  commitWork(repo);

  // Older CLIs saved the signature before sending, so a stored one may name a
  // payload the server never saw.
  script = [503];
  await age(id);
  await activity(id, repo);
  const s = getSessions().find((x) => x.id === id);
  await updateSession(id, {
    lastProgressSignature: `${s.commits}:${s.linesAdded}:${s.linesRemoved}:${s.filesTouched}:${(s.shipEvents ?? []).length}`,
  });

  await age(id);
  await activity(id, repo);
  assert.deepEqual(posts.map((p) => p.status), [503, 200]);
});

test('submitInProgress reports whether the server settled the payload', async () => {
  const session = {
    id: randomUUID(), tool: 'claude', project: 'p', branch: 'main',
    startedAt: new Date(Date.now() - 3600_000).toISOString(), endedAt: new Date().toISOString(),
    durationSeconds: 600, commits: 1, linesAdded: 80, linesRemoved: 0, filesTouched: 1,
    momentum: 'shipped', exitCode: -1, lastActivityAt: new Date().toISOString(), startSha: '',
  };
  await addSession(session);

  script = [200];
  assert.equal(await submitInProgress(session), true);
  script = [503];
  assert.equal(await submitInProgress(session), false);
  script = [429];
  assert.equal(await submitInProgress(session), false);
  // A 400 will never change on resend, so it counts as settled rather than
  // being retried every five minutes forever.
  script = [400];
  assert.equal(await submitInProgress(session), true);
  script = ['hang'];
  assert.equal(await submitInProgress(session, 200), false, 'a timeout is not an acceptance');
});
