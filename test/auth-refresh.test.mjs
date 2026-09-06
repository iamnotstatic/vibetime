import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

// VIBE_DIR and VIBE_API are read at module load, so scratch dir and stub
// server come up before the first dist import.
const scratch = mkdtempSync(join(tmpdir(), 'vibe-auth-refresh-'));
process.env.VIBE_DIR = scratch;
delete process.env.VIBE_SESSION;

// Scriptable stub API: each test sets handlers per path; a handler is called
// with the parsed body and returns [status, responseBody].
const handlers = {};
const calls = [];
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    calls.push(req.url);
    const handler = handlers[req.url];
    if (!handler) {
      res.statusCode = 404;
      return res.end('{"error":"no handler"}');
    }
    const [status, body] = handler(raw ? JSON.parse(raw) : null);
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.VIBE_API = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const { refreshAuth, jwtExpiresAtMs, readAuth, AUTH_PATH } = await import('../dist/auth.js');
const { addSession, getSessions } = await import('../dist/db.js');
const { flushPendingSubmissions } = await import('../dist/submit.js');

function fakeJwt(expSecondsFromNow) {
  const b64u = (s) => Buffer.from(s).toString('base64url');
  const payload = { sub: 1, handle: 't', exp: Math.floor(Date.now() / 1000) + expSecondsFromNow };
  return `${b64u('{"alg":"HS256","typ":"JWT"}')}.${b64u(JSON.stringify(payload))}.stub`;
}

function writeAuthFile(record) {
  writeFileSync(AUTH_PATH, JSON.stringify(record, null, 2) + '\n');
}

function baseAuth(overrides = {}) {
  return {
    jwt: fakeJwt(100 * 24 * 3600),
    handle: 't',
    avatarUrl: null,
    issuedAt: new Date().toISOString(),
    refreshToken: 'r'.repeat(43),
    ...overrides,
  };
}

test('jwtExpiresAtMs reads exp and rejects garbage', () => {
  const soon = jwtExpiresAtMs(fakeJwt(3600));
  assert.ok(Math.abs(soon - (Date.now() + 3600_000)) < 5000);
  assert.equal(jwtExpiresAtMs('not-a-jwt'), null);
});

test('refreshAuth swaps the jwt and keeps the refresh token', async () => {
  const auth = baseAuth();
  writeAuthFile(auth);
  const newJwt = fakeJwt(7 * 24 * 3600);
  handlers['/auth/refresh'] = (body) => {
    assert.equal(body.refresh_token, auth.refreshToken);
    return [200, { jwt: newJwt, handle: 't', avatarUrl: null }];
  };

  const renewed = await refreshAuth(auth);
  assert.equal(renewed.jwt, newJwt);
  assert.equal(renewed.refreshToken, auth.refreshToken);
  assert.equal(readAuth().jwt, newJwt);
});

test('a rejected refresh clears local auth', async () => {
  const auth = baseAuth();
  writeAuthFile(auth);
  handlers['/auth/refresh'] = () => [401, { error: 'refresh token invalid' }];

  const renewed = await refreshAuth(auth);
  assert.equal(renewed, null);
  assert.equal(existsSync(AUTH_PATH), false);
});

test('a legacy record without a refresh token never touches the network', async () => {
  const auth = baseAuth({ refreshToken: undefined });
  const before = calls.length;
  const renewed = await refreshAuth(auth);
  assert.equal(renewed, auth);
  assert.equal(calls.length, before);
});

test('flush renews once on 401 and retries the submission', async () => {
  rmSync(join(scratch, 'sessions.json'), { force: true });
  const auth = baseAuth();
  writeAuthFile(auth);
  const newJwt = fakeJwt(7 * 24 * 3600);

  const id = randomUUID();
  await addSession({
    id, tool: 'claude', project: 'repo', branch: 'main',
    startedAt: new Date(Date.now() - 600_000).toISOString(),
    endedAt: new Date().toISOString(),
    durationSeconds: 300, commits: 1, linesAdded: 10, linesRemoved: 2, filesTouched: 1,
    momentum: 'shipped', exitCode: 0, lastActivityAt: new Date().toISOString(),
  });

  let sessionCalls = 0;
  handlers['/sessions'] = () => {
    sessionCalls++;
    return sessionCalls === 1 ? [401, { error: 'token expired' }] : [200, { ok: true, submittedAt: new Date().toISOString() }];
  };
  handlers['/auth/refresh'] = () => [200, { jwt: newJwt, handle: 't', avatarUrl: null }];

  await flushPendingSubmissions(10_000);

  assert.equal(sessionCalls, 2);
  assert.equal(readAuth().jwt, newJwt);
  assert.ok(getSessions().find((s) => s.id === id).submittedAt);
});

test('flush renews proactively when the jwt is close to expiry', async () => {
  rmSync(join(scratch, 'sessions.json'), { force: true });
  const auth = baseAuth({ jwt: fakeJwt(3600) }); // expires within the 48h window
  writeAuthFile(auth);
  const newJwt = fakeJwt(7 * 24 * 3600);
  handlers['/auth/refresh'] = () => [200, { jwt: newJwt, handle: 't', avatarUrl: null }];

  await flushPendingSubmissions(10_000);
  assert.equal(readAuth().jwt, newJwt);
});
