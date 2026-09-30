import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// The server counts each commit once across sessions and machines, which only
// works if it is told which commits a session was credited with. It is told in
// keyed hashes: a commit's sha and author never leave the machine as they are.

process.env.VIBE_DIR = mkdtempSync(join(tmpdir(), 'vibe-facts-'));
delete process.env.VIBE_SESSION;

const KEY = 'a'.repeat(64);
let respondWith = {};
const posts = [];
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/auth/refresh') {
      return res.end(JSON.stringify({ jwt: jwt(), handle: 't', avatarUrl: null }));
    }
    posts.push({ raw, body: JSON.parse(raw) });
    res.end(JSON.stringify({ ok: true, submittedAt: new Date().toISOString(), ...respondWith }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.VIBE_API = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const { AUTH_PATH, readAuth, refreshAuth, rememberCommitKey } = await import('../dist/auth.js');
const { addSession, getSessions, creditWork } = await import('../dist/db.js');
const { measureRepos, baselineRepos } = await import('../dist/git.js');
const { submitInProgress, flushPendingSubmissions } = await import('../dist/submit.js');

const b64u = (s) => Buffer.from(s).toString('base64url');
function jwt(expDays = 100) {
  return `${b64u('{"alg":"HS256","typ":"JWT"}')}.${b64u(JSON.stringify({ sub: 1, handle: 't', exp: Math.floor(Date.now() / 1000) + expDays * 86400, n: randomUUID() }))}.stub`;
}
function login(extra = {}) {
  writeFileSync(AUTH_PATH, JSON.stringify({ jwt: jwt(), handle: 't', avatarUrl: null, issuedAt: new Date().toISOString(), refreshToken: 'r'.repeat(43), ...extra }));
}

function sh(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf-8' }).trim();
}

// A measured session with one credited commit, stored the way the wrapper and
// the hooks store it.
async function measuredSession(t) {
  rmSync(join(process.env.VIBE_DIR, 'sessions.json'), { force: true });
  const dir = mkdtempSync(join(tmpdir(), 'vibe-facts-repo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  sh('git init -qb main repo', dir);
  const repo = join(dir, 'repo');
  sh('git config user.email secret-author@example.com && git config user.name vibe', repo);
  sh('git commit -q --allow-empty -m init', repo);
  const repos = baselineRepos(repo);
  const now = new Date().toISOString();
  const session = {
    id: randomUUID(), tool: 'claude', project: 'repo', branch: 'main', startedAt: new Date(Date.now() - 600_000).toISOString(),
    endedAt: now, durationSeconds: 600, commits: 0, linesAdded: 0, linesRemoved: 0, filesTouched: 0,
    momentum: 'idle', exitCode: -1, lastActivityAt: now, repos,
  };
  await addSession(session);
  writeFileSync(join(repo, 'work.txt'), Array.from({ length: 60 }, (_, i) => `${randomUUID()} ${i}`).join('\n'));
  sh('git add work.txt && git commit -q -m work', repo);
  const sha = sh('git rev-parse HEAD', repo);
  const stats = creditWork(session, measureRepos(repos));
  return { session: { ...session, ...stats, momentum: 'shipped' }, sha, repo };
}

test('without a key nothing about individual commits is sent, and the key that comes back is kept', async (t) => {
  posts.length = 0;
  login();
  respondWith = { commitKey: KEY, commitKeyVersion: 1 };
  const { session } = await measuredSession(t);

  assert.equal(await submitInProgress(session), true);
  assert.equal(posts[0].body.commitFacts, undefined);
  assert.equal(readAuth().commitKey, KEY, 'the next submit can carry facts');
});

test('with a key, commits go as keyed hashes and never as themselves', async (t) => {
  posts.length = 0;
  login({ commitKey: KEY, commitKeyVersion: 1 });
  respondWith = {};
  const { session, sha } = await measuredSession(t);

  assert.equal(await submitInProgress(session), true);
  const [{ raw, body }] = posts;
  assert.equal(body.commitKeyVersion, 1);
  assert.equal(body.commitFacts.length, 1);
  const [fact] = body.commitFacts;
  assert.match(fact.id, /^[0-9a-f]{32}$/);
  assert.match(fact.authorId, /^[0-9a-f]{32}$/);
  assert.equal(fact.linesAdded, 60);
  assert.equal(fact.files, 1);
  assert.ok(Number.isInteger(fact.committedAt) && fact.committedAt < Date.now() / 1000 + 5, 'seconds, not ms');
  for (const secret of [sha, sha.slice(0, 7), 'secret-author@example.com', 'work.txt']) {
    assert.ok(!raw.includes(secret), `the request must not contain ${secret}`);
  }
});

test('the ended-session flush carries facts and picks up the key too', async (t) => {
  posts.length = 0;
  login();
  respondWith = { commitKey: KEY, commitKeyVersion: 1 };
  const { session } = await measuredSession(t);
  const { updateSession } = await import('../dist/db.js');
  await updateSession(session.id, { ...session, exitCode: 0 });
  await flushPendingSubmissions(3000);
  assert.equal(posts.length, 1);
  assert.equal(readAuth().commitKey, KEY);
});

test('a renewed token keeps the key: same account, same key', async () => {
  login({ commitKey: KEY, commitKeyVersion: 1 });
  const renewed = await refreshAuth(readAuth());
  assert.equal(renewed.commitKey, KEY);
  assert.equal(readAuth().commitKey, KEY);
});

test('a key is never attached to a login other than the one that asked for it', () => {
  login();
  rememberCommitKey('some-other-jwt', KEY, 1);
  assert.equal(readAuth().commitKey, undefined);
});

test('a key the server sends in the wrong shape is ignored', async (t) => {
  posts.length = 0;
  login();
  const { session } = await measuredSession(t);
  for (const bad of [{ commitKey: 'short', commitKeyVersion: 1 }, { commitKey: KEY }, { commitKey: 42, commitKeyVersion: 1 }]) {
    respondWith = bad;
    await submitInProgress(session);
    assert.equal(readAuth().commitKey, undefined, JSON.stringify(bad));
  }
});

test('facts only ever name commits still in the session', async (t) => {
  const { session, repo } = await measuredSession(t);
  assert.equal(session.commitFacts.length, 1);
  sh('git reset -q --hard HEAD~1', repo);
  const again = creditWork(session, measureRepos(session.repos));
  assert.deepEqual(again.commitFacts, [], 'a commit reset away must not be reported as this session\'s');
});
