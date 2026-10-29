import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

// Opening a session runs the install repair, which writes the editors' hook
// configs under HOME, so HOME is scratch before the first dist import.
const home = mkdtempSync(join(tmpdir(), 'vibe-adopt-home-'));
process.env.HOME = home;
process.env.VIBE_DIR = join(home, '.vibe');
process.env.CODEX_HOME = join(home, '.codex');
// A local stand-in for the API, counting the tunables fetch that only the
// start housekeeping makes.
let configFetches = 0;
const api = createServer((req, res) => {
  if (req.url?.startsWith('/config')) configFetches++;
  res.setHeader('content-type', 'application/json');
  res.end('{}');
});
await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
api.unref();
process.env.VIBE_API = `http://127.0.0.1:${api.address().port}`;
delete process.env.VIBE_SESSION;

const { handleHook } = await import('../dist/hook.js');
const { getSessions, updateSession } = await import('../dist/db.js');

const cursorHooks = join(home, '.cursor', 'hooks.json');

function sh(cmd, cwd) {
  execSync(cmd, { cwd, stdio: 'pipe' });
}

function repoWithCommit(t) {
  const parent = mkdtempSync(join(tmpdir(), 'vibe-adopt-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  sh('git init -qb main repo', parent);
  const repo = join(parent, 'repo');
  sh('git -c user.email=vibe@test -c user.name=vibe commit -q --allow-empty -m init', repo);
  return repo;
}

function fresh() {
  configFetches = 0;
  rmSync(join(home, '.vibe'), { recursive: true, force: true });
  rmSync(join(home, '.cursor'), { recursive: true, force: true });
}

// The payload Cursor 3.20.17 sent on the first prompt of an Agent conversation
// that never fired sessionStart, logged 2026-10-29, minus the prompt and email.
function cursorPrompt(conversationId, root) {
  return {
    conversation_id: conversationId,
    generation_id: randomUUID(),
    model: 'cursor-grok-4.6-medium',
    composer_mode: 'agent',
    attachments: [],
    session_id: conversationId,
    hook_event_name: 'beforeSubmitPrompt',
    cursor_version: '3.20.17',
    workspace_roots: [root],
    transcript_path: null,
  };
}

// Cursor runs its own hooks and the Claude Code hooks it imports, so every
// event reaches vibe twice, at once.
function cursorEvent(payload) {
  const raw = JSON.stringify(payload);
  return Promise.all([handleHook('activity', raw, 'cursor'), handleHook('activity', raw, 'claude')]);
}

test('a Cursor Agent conversation is tracked from its first prompt', async (t) => {
  fresh();
  const repo = repoWithCommit(t);
  const id = randomUUID();

  await cursorEvent(cursorPrompt(id, repo));

  const sessions = getSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, id);
  assert.equal(sessions[0].tool, 'cursor');

  writeFileSync(join(repo, 'work.txt'), 'x\n'.repeat(80));
  sh('git add work.txt', repo);
  sh('git -c user.email=vibe@test -c user.name=vibe commit -q -m work', repo);
  await updateSession(id, { lastActivityAt: new Date(Date.now() - 20_000).toISOString() });

  await cursorEvent({ ...cursorPrompt(id, repo), hook_event_name: 'postToolUse', tool_name: 'Shell' });

  const s = getSessions().find((x) => x.id === id);
  assert.equal(s.commits, 1);
  assert.equal(s.momentum, 'shipped');
});

// What Cursor sends for a subagent: the parent's conversation id, the subagent
// named by an id that is not a uuid. Should one ever arrive as the session id,
// it must not open a session that would take the parent's commits.
test('a Cursor subagent id never opens a session of its own', async (t) => {
  fresh();
  const repo = repoWithCommit(t);
  const parent = randomUUID();
  await cursorEvent(cursorPrompt(parent, repo));

  const subagent = `call-${randomUUID()}-2\nfc_${randomUUID()}_0`;
  await cursorEvent({ ...cursorPrompt(subagent, repo), hook_event_name: 'postToolUse' });

  assert.deepEqual(getSessions().map((s) => s.id), [parent]);
});

// The repair and the tunables refresh live on SessionStart, which Cursor never
// sends, so opening a session late has to run them, and only then.
test('opening a session late runs the start housekeeping once, not per event', async (t) => {
  fresh();
  const stale = { version: 1, hooks: { stop: [{ command: "'/old/node' '/old/cli.js' __hook activity --tool cursor --respond-json" }] } };
  mkdirSync(join(home, '.cursor'), { recursive: true });
  writeFileSync(cursorHooks, JSON.stringify(stale));
  const noRepo = mkdtempSync(join(tmpdir(), 'vibe-adopt-empty-'));
  t.after(() => rmSync(noRepo, { recursive: true, force: true }));

  await cursorEvent(cursorPrompt(randomUUID(), noRepo));
  assert.equal(readFileSync(cursorHooks, 'utf-8'), JSON.stringify(stale), 'no session, no repair');

  await cursorEvent(cursorPrompt(randomUUID(), repoWithCommit(t)));
  assert.doesNotMatch(readFileSync(cursorHooks, 'utf-8'), /\/old\/node/, 'repaired when a session opened');
});

// Cursor fires both copies of the hook at once, as separate processes; only
// the one whose insert landed opens the session, so only it spends the first
// prompt's time on the housekeeping. In-process copies would share the
// tunables fetch and hide a double run, hence real processes on one instant.
test('two copies of the first event run the housekeeping once', async (t) => {
  fresh();
  const repo = repoWithCommit(t);
  const payload = JSON.stringify(cursorPrompt(randomUUID(), repo));
  const hookModule = new URL('../dist/hook.js', import.meta.url).href;
  const startAt = Date.now() + 1500;
  const copy = (tool) => new Promise((resolve, reject) => {
    const script = `
      const { handleHook } = await import(${JSON.stringify(hookModule)});
      while (Date.now() < ${startAt}) {}
      await handleHook('activity', ${JSON.stringify(payload)}, '${tool}');
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: process.env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', resolve);
  });

  await Promise.all([copy('cursor'), copy('claude')]);

  assert.equal(getSessions().length, 1);
  assert.equal(configFetches, 1);
});
