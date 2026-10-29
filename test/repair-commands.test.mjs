import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, symlinkSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The installers freeze their config paths from HOME at import.
const home = mkdtempSync(join(tmpdir(), 'vibe-repair-cmd-home-'));
process.env.HOME = home;
process.env.VIBE_DIR = join(home, '.vibe');
process.env.CODEX_HOME = join(home, '.codex');
delete process.env.VIBE_SESSION;

const { installClaudeHooks } = await import('../dist/claude-hooks.js');
const { installCodexHooks } = await import('../dist/codex-hooks.js');
const { installCursorHooks } = await import('../dist/cursor-hooks.js');
const { installZcodeHooks } = await import('../dist/zcode-hooks.js');

const repo = fileURLToPath(new URL('..', import.meta.url));
const checkoutCli = join(repo, 'dist', 'cli.js');
const configs = [
  join(home, '.claude', 'settings.json'),
  join(home, '.codex', 'hooks.json'),
  join(home, '.cursor', 'hooks.json'),
  join(home, '.zcode', 'cli', 'config.json'),
];

function fresh() {
  for (const dir of ['.claude', '.codex', '.cursor', '.zcode', '.vibe']) rmSync(join(home, dir), { recursive: true, force: true });
}

// This build laid out the way npm installs it, under `relative` in a scratch prefix.
function copyAt(t, relative) {
  const prefix = mkdtempSync(join(tmpdir(), 'vibe-prefix-'));
  t.after(() => rmSync(prefix, { recursive: true, force: true }));
  const pkg = join(prefix, relative);
  mkdirSync(pkg, { recursive: true });
  cpSync(join(repo, 'dist'), join(pkg, 'dist'), { recursive: true });
  cpSync(join(repo, 'package.json'), join(pkg, 'package.json'));
  symlinkSync(join(repo, 'node_modules'), join(pkg, 'node_modules'));
  // The path Node reports for a running script: macOS tmpdir is behind /var -> /private/var.
  return realpathSync(join(pkg, 'dist', 'cli.js'));
}

function run(cli, ...args) {
  return execFileSync(process.execPath, [cli, ...args], {
    env: { ...process.env, VIBE_API: 'http://127.0.0.1:9', FORCE_COLOR: '0' },
    encoding: 'utf-8',
  });
}

// Pins every app's hooks to this checkout, as running a dev build does.
function pinToCheckout() {
  installClaudeHooks('install');
  installCodexHooks(undefined, 'install');
  installCursorHooks(undefined, 'install');
  installZcodeHooks(undefined, 'install');
}

function pinnedTo(cli) {
  return configs.every((path) => readFileSync(path, 'utf-8').includes(`'${cli}'`));
}

test('an installed vibe moves hooks off a checkout that still exists', (t) => {
  fresh();
  pinToCheckout();
  const installed = copyAt(t, 'lib/node_modules/vibetime-cli');

  run(installed, 'status');

  assert.ok(pinnedTo(installed), 'every app now runs the installed vibe');
});

test('a checkout running vibe never takes hooks from an installed vibe', (t) => {
  fresh();
  const installed = copyAt(t, 'lib/node_modules/vibetime-cli');
  run(installed, 'hooks', 'install');
  const before = configs.map((path) => readFileSync(path, 'utf-8'));

  run(checkoutCli, 'status');

  assert.deepEqual(configs.map((path) => readFileSync(path, 'utf-8')), before);
});

// Two Node versions under nvm, each with vibetime installed: either one is
// a working install, and moving between them only costs a Codex re-review.
test('one installed vibe leaves hooks on another installed vibe alone', (t) => {
  fresh();
  const first = copyAt(t, 'versions/node/v20/lib/node_modules/vibetime-cli');
  const second = copyAt(t, 'versions/node/v22/lib/node_modules/vibetime-cli');
  run(first, 'hooks', 'install');
  const before = configs.map((path) => readFileSync(path, 'utf-8'));

  run(second, 'status');

  assert.deepEqual(configs.map((path) => readFileSync(path, 'utf-8')), before);
});

test('an npx copy never takes hooks, and an installed vibe takes them back from one', (t) => {
  fresh();
  pinToCheckout();
  const npx = copyAt(t, '_npx/4f2a9c/node_modules/vibetime-cli');
  const before = configs.map((path) => readFileSync(path, 'utf-8'));

  run(npx, 'status');
  assert.deepEqual(configs.map((path) => readFileSync(path, 'utf-8')), before, 'npx left them alone');

  run(npx, 'hooks', 'install');
  const installed = copyAt(t, 'lib/node_modules/vibetime-cli');
  run(installed, 'status');
  assert.ok(pinnedTo(installed), 'moved off the npx cache');
});

test('vibe log and vibe leaderboard run the repair too', (t) => {
  for (const command of ['log', 'leaderboard']) {
    fresh();
    pinToCheckout();
    for (const path of configs) writeFileSync(path, readFileSync(path, 'utf-8').replaceAll(`'${checkoutCli}'`, "'/gone/cli.js'"));

    run(checkoutCli, command);

    assert.ok(pinnedTo(checkoutCli), `${command} repaired the hooks`);
  }
});
