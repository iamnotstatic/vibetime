import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// Config paths are frozen from HOME at import.
const home = mkdtempSync(join(tmpdir(), 'vibe-health-home-'));
process.env.HOME = home;
process.env.VIBE_DIR = join(home, '.vibe');
process.env.CODEX_HOME = join(home, '.codex');
delete process.env.VIBE_SESSION;

const { desktopHookProblems } = await import('../dist/hook-health.js');
const { installClaudeHooks } = await import('../dist/claude-hooks.js');
const { installCodexHooks } = await import('../dist/codex-hooks.js');
const { installCursorHooks } = await import('../dist/cursor-hooks.js');
const { setInstallOptOut } = await import('../dist/config.js');

const cli = new URL('../dist/cli.js', import.meta.url).pathname;
const claude = join(home, '.claude', 'settings.json');
const codex = join(home, '.codex', 'hooks.json');
const cursor = join(home, '.cursor', 'hooks.json');

function fresh() {
  for (const dir of ['.claude', '.codex', '.cursor', '.zcode', '.vibe']) rmSync(join(home, dir), { recursive: true, force: true });
}

function put(path, text) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

function status() {
  return execFileSync(process.execPath, [cli, 'status'], {
    env: { ...process.env, VIBE_API: 'http://127.0.0.1:9', FORCE_COLOR: '0' },
    encoding: 'utf-8',
  });
}

const stale = (event, tool) => `'/old/node' '/old/vibetime-cli/dist/cli.js' __hook ${event} --tool ${tool}`;

test('a working install reports nothing', () => {
  fresh();
  installClaudeHooks(true);
  installCodexHooks(undefined, true);
  installCursorHooks(undefined, true);

  assert.deepEqual(desktopHookProblems(), []);
});

// The two failures found on the maintainer's machine, where nothing said a word.
test('an unparseable config and a pinned Node that is gone are both reported', () => {
  fresh();
  put(claude, '{\n  "hooks": {}\n}\n  "tail": "of a longer file" }\n');
  put(cursor, JSON.stringify({ version: 1, hooks: { stop: [{ command: stale('activity', 'cursor') }] } }));

  assert.deepEqual(desktopHookProblems(), [
    { app: 'claude code', path: claude, kind: 'unparseable' },
    { app: 'cursor', path: cursor, kind: 'missing', missing: '/old/node' },
  ]);
});

test('someone else\'s hook with a missing path is not ours to report', () => {
  fresh();
  put(cursor, JSON.stringify({ version: 1, hooks: { stop: [{ command: "'/gone/tool' --flag" }] } }));

  assert.deepEqual(desktopHookProblems(), []);
});

test('after vibe uninstall nothing is reported', () => {
  fresh();
  put(claude, '{ not json');
  setInstallOptOut({ desktop: true });

  assert.deepEqual(desktopHookProblems(), []);
});

test('vibe status repairs what it can and reports what it cannot', () => {
  fresh();
  put(claude, '{ not json');
  put(codex, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: stale('session-start', 'codex') }] }] } }));

  const out = status();

  assert.match(out, /claude code isn't being tracked · ~\/\.claude\/settings\.json isn't valid JSON/);
  assert.doesNotMatch(out, /codex isn't being tracked/);
  assert.ok(readFileSync(codex, 'utf-8').includes(cli), 'codex hooks repointed at the running CLI');
});
