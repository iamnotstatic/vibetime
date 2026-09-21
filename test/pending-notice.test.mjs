import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const scratch = mkdtempSync(join(tmpdir(), 'vibe-pending-'));
process.env.VIBE_DIR = scratch;
delete process.env.VIBE_SESSION;

const { pendingSubmissionCount } = await import('../dist/submit.js');
const { addSession, updateSession } = await import('../dist/db.js');
const { AUTH_PATH } = await import('../dist/auth.js');
const { renderStatus } = await import('../dist/render.js');

function login(overrides = {}) {
  const b64u = (s) => Buffer.from(s).toString('base64url');
  const payload = { sub: 1, handle: 't', exp: Math.floor(Date.now() / 1000) + 100 * 24 * 3600 };
  writeFileSync(AUTH_PATH, JSON.stringify({
    jwt: `${b64u('{"alg":"HS256","typ":"JWT"}')}.${b64u(JSON.stringify(payload))}.stub`,
    handle: 't', avatarUrl: null, issuedAt: new Date().toISOString(),
    refreshToken: 'r'.repeat(43), ...overrides,
  }) + '\n');
}

const logout = () => { if (existsSync(AUTH_PATH)) rmSync(AUTH_PATH); };

async function session(overrides = {}) {
  const id = randomUUID();
  await addSession({
    id, tool: 'claude', project: 'repo', branch: 'main',
    startedAt: new Date(Date.now() - 600_000).toISOString(),
    endedAt: new Date().toISOString(),
    durationSeconds: 300, commits: 1, linesAdded: 80, linesRemoved: 5, filesTouched: 4,
    momentum: 'shipped', exitCode: 0, lastActivityAt: new Date().toISOString(),
    ...overrides,
  });
  return id;
}

// A local-only user never logged in, so nothing of theirs is waiting on the
// server and `vibe leaderboard` cannot clear a count. Gating on signedOutAt
// alone missed them: they have no auth record at all.
test('a user who never logged in is never told sessions are waiting', async () => {
  logout();
  await session();
  await session();
  assert.equal(pendingSubmissionCount(), 0);
});

test('a signed out user is not told either, the signed out notice covers it', async () => {
  login({ jwt: '', refreshToken: undefined, signedOutAt: new Date().toISOString() });
  assert.equal(pendingSubmissionCount(), 0);
});

test('a logged in user sees every unsubmitted session', async () => {
  login();
  assert.equal(pendingSubmissionCount(), 2);
  await session();
  assert.equal(pendingSubmissionCount(), 3);
});

test('submitted, running and sub-minute sessions do not count', async () => {
  login();
  const before = pendingSubmissionCount();

  const submitted = await session();
  await updateSession(submitted, { submittedAt: new Date().toISOString() });

  await session({ exitCode: -1, endedAt: undefined });
  await session({ durationSeconds: 30 });

  assert.equal(pendingSubmissionCount(), before);
});

test('the notice renders only when there is something to say', () => {
  const has = (out) => out.includes('waiting to submit');

  assert.equal(has(renderStatus([], false, 0)), false);
  assert.equal(has(renderStatus([], false, 2)), true);
  assert.match(renderStatus([], false, 1), /1 session waiting/);
  assert.match(renderStatus([], false, 4), /4 sessions waiting/);

  // Signed out already gets its own notice; two at once reads as panic.
  assert.equal(has(renderStatus([], true, 4)), false);
});
