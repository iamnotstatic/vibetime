import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

process.env.VIBE_DIR = mkdtempSync(join(tmpdir(), 'vibe-ended-at-'));
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

const DAY_MS = 24 * 60 * 60 * 1000;

function sh(cmd, cwd) {
  execSync(cmd, { cwd, stdio: 'pipe' });
}

// The server's bound on event days before it began using the request time,
// which is what every server a released CLI may still talk to enforces.
function serverAccepts(body) {
  const endedMs = Date.parse(body.endedAt);
  return (body.shipEvents ?? []).every((day) => Date.parse(day) <= endedMs + DAY_MS);
}

test('an open desktop session reports when it was last active, not when it started', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'vibe-ended-at-repo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  sh('git init -qb main repo', dir);
  const repo = join(dir, 'repo');
  sh('git config user.email vibe@test && git config user.name vibe', repo);
  sh('git commit -q --allow-empty -m init', repo);

  const id = randomUUID();
  await handleHook('session-start', JSON.stringify({ session_id: id, cwd: repo }), 'claude');

  // A session opened three days ago and still open today.
  const threeDaysAgo = new Date(Date.now() - 3 * DAY_MS).toISOString();
  await updateSession(id, {
    startedAt: threeDaysAgo,
    endedAt: threeDaysAgo,
    lastActivityAt: new Date(Date.now() - 90_000).toISOString(),
    durationSeconds: 600,
  });

  writeFileSync(join(repo, 'work.txt'), Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n') + '\n');
  sh('git add work.txt && git commit -q -m work', repo);
  await handleHook('activity', JSON.stringify({ session_id: id, cwd: repo }), 'claude');

  const s = getSessions().find((x) => x.id === id);
  assert.ok(Date.now() - Date.parse(s.endedAt) < 60_000, `endedAt moved to now, got ${s.endedAt}`);

  assert.equal(posts.length, 1, 'the day\'s ship was submitted');
  const today = new Date().toISOString().slice(0, 10);
  assert.deepEqual(posts[0].shipEvents, [today]);
  assert.ok(serverAccepts(posts[0]), `a server bounding days by endedAt accepts it: endedAt ${posts[0].endedAt}`);
});
