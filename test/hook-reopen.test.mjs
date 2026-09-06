import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// Both must be set before any dist module loads: config.js bakes VIBE_DIR at
// import time, and handleHook bails outright when VIBE_SESSION marks a
// wrapper-tracked process.
process.env.VIBE_DIR = mkdtempSync(join(tmpdir(), 'vibe-home-'));
delete process.env.VIBE_SESSION;

const { handleHook } = await import('../dist/hook.js');
const { getSessions, updateSession, reapOrphanedSessions } = await import('../dist/db.js');

function sh(cmd, cwd) {
  execSync(cmd, { cwd, stdio: 'pipe' });
}

function initRepo(parent, name) {
  sh(`git init -qb main ${name}`, parent);
  const path = join(parent, name);
  commit(path, 'init', { allowEmpty: true });
  return path;
}

function commit(cwd, msg, { allowEmpty = false } = {}) {
  sh(`git -c user.email=vibe@test -c user.name=vibe commit -q ${allowEmpty ? '--allow-empty ' : ''}-m ${msg}`, cwd);
}

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vibe-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Each test gets a clean slate so refresh paths never touch a prior test's
// deleted scratch repos.
function freshDb() {
  rmSync(join(process.env.VIBE_DIR, 'sessions.json'), { force: true });
}

function hook(event, sessionId, cwd, tool) {
  return handleHook(event, JSON.stringify({ session_id: sessionId, cwd }), tool);
}

function find(id) {
  return getSessions().find((s) => s.id === id);
}

test('a spurious clean SessionEnd does not kill tracking (issue #19)', async (t) => {
  freshDb();
  const repo = initRepo(scratch(t), 'repo');
  const id = randomUUID();

  await hook('session-start', id, repo);
  await hook('session-end', id, repo); // Desktop's spurious end, ~1s in

  let s = find(id);
  assert.equal(s.exitCode, 0);
  assert.equal(s.hadCleanEnd, true);

  // Mark the spurious end as submitted so the revival's resubmit-clearing is
  // actually exercised below.
  await updateSession(id, { submittedAt: new Date().toISOString() });

  writeFileSync(join(repo, 'f.txt'), 'one\ntwo\n');
  sh('git add f.txt', repo);
  commit(repo, 'work');

  await hook('activity', id, repo); // first prompt after the spurious end
  s = find(id);
  assert.equal(s.exitCode, -1); // reopened
  assert.equal(s.commits, 1); // reopen refreshes stats immediately
  assert.equal(s.submittedAt, undefined);

  await hook('session-end', id, repo); // the real end
  s = find(id);
  assert.equal(s.exitCode, 0);
  assert.equal(s.commits, 1);
  assert.equal(s.momentum, 'progressed');
});

test('idle reap after a clean-end reopen re-finalizes clean, not interrupted', async (t) => {
  freshDb();
  const repo = initRepo(scratch(t), 'repo');
  const id = randomUUID();

  await hook('session-start', id, repo);
  await hook('session-end', id, repo);
  writeFileSync(join(repo, 'f.txt'), 'one\n');
  sh('git add f.txt', repo);
  commit(repo, 'work');
  await hook('activity', id, repo); // reopen

  // Age it past the inactivity timeout, with startedAt hours back so a
  // wall-clock duration recompute would be visibly wrong.
  const now = Date.now();
  const lastActivityAt = new Date(now - 31 * 60_000).toISOString();
  await updateSession(id, {
    startedAt: new Date(now - 3 * 3_600_000).toISOString(),
    lastActivityAt,
    durationSeconds: 120,
  });

  await reapOrphanedSessions();
  const s = find(id);
  assert.equal(s.exitCode, 0);
  assert.notEqual(s.momentum, 'interrupted');
  assert.equal(s.durationSeconds, 120 + 30 * 60); // accumulated + capped tail, not wall-clock recomputed
  assert.equal(s.endedAt, new Date(Date.parse(lastActivityAt) + 30 * 60_000).toISOString());
});

test('a clean end past the inactivity window is final — stale events cannot revive it', async (t) => {
  freshDb();
  const repo = initRepo(scratch(t), 'repo');
  const id = randomUUID();

  await hook('session-start', id, repo);
  await hook('session-end', id, repo);
  const submittedAt = new Date().toISOString();
  const staleEnd = new Date(Date.now() - 2 * 3_600_000).toISOString();
  await updateSession(id, { endedAt: staleEnd, lastActivityAt: staleEnd, submittedAt });

  writeFileSync(join(repo, 'f.txt'), 'one\n');
  sh('git add f.txt', repo);
  commit(repo, 'later'); // belongs to whoever tracks the repo now, not this session

  await hook('activity', id, repo); // e.g. `claude --resume` hours later
  const s = find(id);
  assert.equal(s.exitCode, 0); // still finalized
  assert.equal(s.commits, 0); // stale baseline not re-diffed
  assert.equal(s.submittedAt, submittedAt); // no resubmit
});

test('a session that never ended cleanly still reaps as interrupted, then reopens', async (t) => {
  freshDb();
  const repo = initRepo(scratch(t), 'repo');
  const id = randomUUID();

  await hook('session-start', id, repo);
  await updateSession(id, { lastActivityAt: new Date(Date.now() - 31 * 60_000).toISOString() });

  await reapOrphanedSessions();
  let s = find(id);
  assert.equal(s.exitCode, 1);
  assert.equal(s.momentum, 'interrupted');

  writeFileSync(join(repo, 'f.txt'), 'one\n');
  sh('git add f.txt', repo);
  commit(repo, 'work');

  await hook('activity', id, repo); // reaper recovery path still works
  s = find(id);
  assert.equal(s.exitCode, -1);
  assert.equal(s.commits, 1);
});

test('Codex hook sessions are labelled separately from Claude sessions', async (t) => {
  freshDb();
  const repo = initRepo(scratch(t), 'repo');
  const codexId = randomUUID();
  const claudeId = randomUUID();

  await hook('session-start', codexId, repo, 'codex');
  await hook('session-start', claudeId, repo);

  assert.equal(find(codexId).tool, 'codex');
  assert.equal(find(claudeId).tool, 'claude');
});
