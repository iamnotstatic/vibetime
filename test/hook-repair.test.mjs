import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The installers freeze their config paths from HOME at import.
const home = mkdtempSync(join(tmpdir(), 'vibe-repair-home-'));
process.env.HOME = home;
process.env.VIBE_DIR = join(home, '.vibe');
process.env.CODEX_HOME = join(home, '.codex');
delete process.env.VIBE_SESSION;

const { reconcileInstall } = await import('../dist/reconcile.js');
const { installClaudeHooks } = await import('../dist/claude-hooks.js');
const { installCodexHooks } = await import('../dist/codex-hooks.js');
const { installCursorHooks } = await import('../dist/cursor-hooks.js');
const { installZcodeHooks } = await import('../dist/zcode-hooks.js');

const paths = {
  claude: join(home, '.claude', 'settings.json'),
  codex: join(home, '.codex', 'hooks.json'),
  cursor: join(home, '.cursor', 'hooks.json'),
  zcode: join(home, '.zcode', 'cli', 'config.json'),
};
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

function fresh() {
  for (const dir of ['.claude', '.codex', '.cursor', '.zcode', '.vibe']) rmSync(join(home, dir), { recursive: true, force: true });
}

function read(app) {
  return readFileSync(paths[app], 'utf-8');
}

function installAll() {
  installClaudeHooks('repair');
  installCodexHooks(undefined, 'repair');
  installCursorHooks(undefined, 'repair');
  installZcodeHooks(undefined, 'repair');
}

// Every hook pinned to another Node and CLI that both still exist: a second
// nvm version, or the global install when this run is a dev checkout.
function repinAll(node, entry) {
  for (const app of Object.keys(paths)) {
    const text = read(app).replaceAll(`'${process.execPath}'`, `'${node}'`).replaceAll(`'${cli}'`, `'${entry}'`);
    writeFileSync(paths[app], text);
  }
}

test('the repair leaves working hooks pinned elsewhere exactly as they are', (t) => {
  fresh();
  installAll();
  const elsewhere = mkdtempSync(join(tmpdir(), 'vibe-other-node-'));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  const node = join(elsewhere, 'node');
  const entry = join(elsewhere, 'cli.js');
  writeFileSync(node, '');
  writeFileSync(entry, '');
  repinAll(node, entry);
  const before = Object.fromEntries(Object.keys(paths).map((app) => [app, read(app)]));

  reconcileInstall();

  for (const app of Object.keys(paths)) assert.equal(read(app), before[app], `${app} rewritten`);
});

test('the repair re-pins hooks whose Node is gone', () => {
  fresh();
  installAll();
  repinAll('/gone/node', '/gone/cli.js');

  reconcileInstall();

  for (const app of Object.keys(paths)) {
    assert.doesNotMatch(read(app), /\/gone\//, app);
    assert.ok(read(app).includes(cli), app);
  }
});

test('an explicit install re-pins working hooks to the CLI that ran it', (t) => {
  fresh();
  installAll();
  const elsewhere = mkdtempSync(join(tmpdir(), 'vibe-other-node-'));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  writeFileSync(join(elsewhere, 'node'), '');
  writeFileSync(join(elsewhere, 'cli.js'), '');
  repinAll(join(elsewhere, 'node'), join(elsewhere, 'cli.js'));

  installClaudeHooks('install');

  assert.ok(read('claude').includes(cli));
});

// A command of the user's own that merely contains `__hook` is not ours.
test('a foreign command containing __hook is never replaced', () => {
  fresh();
  const theirs = 'python3 ~/bin/pre_commit__hooks.py';
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(paths.claude, JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: theirs }] }] } }));
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(paths.codex, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: theirs }] }] } }));
  mkdirSync(join(home, '.cursor'), { recursive: true });
  writeFileSync(paths.cursor, JSON.stringify({ version: 1, hooks: { stop: [{ command: theirs }] } }));

  installAll();

  const claude = JSON.parse(read('claude'));
  assert.deepEqual(claude.hooks.PostToolUse[0], { matcher: 'Edit', hooks: [{ type: 'command', command: theirs }] });
  assert.equal(claude.hooks.PostToolUse.length, 2);
  assert.equal(JSON.parse(read('codex')).hooks.Stop[0].hooks[0].command, theirs);
  assert.ok(JSON.parse(read('cursor')).hooks.stop.some((h) => h.command === theirs));
});

// One app's odd config must not crash its installer or cost the others their repair.
test('a Claude group without a hooks list neither crashes nor blocks the other apps', () => {
  fresh();
  installAll();
  const claude = JSON.parse(read('claude'));
  claude.hooks.Stop = [{ matcher: '' }, ...claude.hooks.Stop];
  claude.hooks.Stop[1].hooks[0].command = "'/gone/node' '/gone/cli.js' __hook activity";
  writeFileSync(paths.claude, JSON.stringify(claude));
  repinAll('/gone/node', '/gone/cli.js');

  assert.doesNotThrow(() => installClaudeHooks('repair'));
  reconcileInstall();

  assert.deepEqual(JSON.parse(read('claude')).hooks.Stop[0], { matcher: '' });
  for (const app of Object.keys(paths)) assert.doesNotMatch(read(app), /\/gone\//, app);
});
