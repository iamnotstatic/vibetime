import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendHook, detectShell, removeHook } from '../dist/init.js';

function scratchRc(t, content = '# my rc\nexport PATH=$PATH\n') {
  const dir = mkdtempSync(join(tmpdir(), 'vibe-rc-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const rcFile = join(dir, '.zshrc');
  writeFileSync(rcFile, content);
  return rcFile;
}

test('add then remove round-trips, leaving the rest of the rc untouched', (t) => {
  const rcFile = scratchRc(t);
  const before = readFileSync(rcFile, 'utf-8');

  assert.equal(appendHook('opencode', rcFile), true);
  assert.match(readFileSync(rcFile, 'utf-8'), /opencode\(\) \{ vibe __wrap opencode "\$@"; \}/);

  assert.equal(removeHook('opencode', rcFile), true);
  const after = readFileSync(rcFile, 'utf-8');
  assert.ok(!after.includes('vibe __wrap'));
  assert.ok(after.includes('# my rc'));
  assert.ok(after.includes('export PATH=$PATH'));
  assert.equal(before.trim(), after.trim());
});

test('remove strips all three case variants of the hook', (t) => {
  const rcFile = scratchRc(t);
  appendHook('aider', rcFile);
  const withHooks = readFileSync(rcFile, 'utf-8');
  assert.equal(withHooks.match(/vibe __wrap aider /g).length, 3); // aider / Aider / AIDER

  removeHook('aider', rcFile);
  assert.ok(!readFileSync(rcFile, 'utf-8').includes('vibe __wrap aider'));
});

test('removing one tool leaves other tools tracked', (t) => {
  const rcFile = scratchRc(t);
  appendHook('opencode', rcFile);
  appendHook('aider', rcFile);

  removeHook('opencode', rcFile);
  const after = readFileSync(rcFile, 'utf-8');
  assert.ok(!after.includes('vibe __wrap opencode'));
  assert.ok(after.includes('vibe __wrap aider'));
});

test('removing an untracked tool is a no-op and says so', (t) => {
  const rcFile = scratchRc(t);
  const before = readFileSync(rcFile, 'utf-8');
  assert.equal(removeHook('aider', rcFile), false);
  assert.equal(readFileSync(rcFile, 'utf-8'), before);
});

test('a tool name that prefixes another does not collide', (t) => {
  const rcFile = scratchRc(t);
  appendHook('claudex', rcFile);
  // adding `claude` must not be blocked by the claudex hook
  assert.equal(appendHook('claude', rcFile), true);
  // and removing `claude` must not take claudex with it
  removeHook('claude', rcFile);
  const after = readFileSync(rcFile, 'utf-8');
  assert.ok(!after.includes('vibe __wrap claude '));
  assert.ok(after.includes('vibe __wrap claudex '));
});

test('a user line that merely mentions the wrap command is not ours to delete', (t) => {
  const rcFile = scratchRc(t, '# reminder: opencode() { vibe __wrap opencode "$@"; } is what vibe adds\nalias oc=opencode\n');
  assert.equal(removeHook('opencode', rcFile), false);
  assert.ok(readFileSync(rcFile, 'utf-8').includes('alias oc=opencode'));
});

test('fish hooks use fish syntax and round-trip cleanly', (t) => {
  const rcFile = scratchRc(t);
  const before = readFileSync(rcFile, 'utf-8');

  assert.equal(appendHook('opencode', rcFile, 'fish'), true);
  const withHooks = readFileSync(rcFile, 'utf-8');
  assert.match(withHooks, /function opencode; vibe __wrap opencode \$argv; end/);
  assert.ok(!withHooks.includes('"$@"'));

  assert.equal(removeHook('opencode', rcFile), true);
  assert.equal(readFileSync(rcFile, 'utf-8').trim(), before.trim());
});

test('fish is detected with its standard config path', (t) => {
  const previousShell = process.env.SHELL;
  t.after(() => {
    if (previousShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = previousShell;
  });
  process.env.SHELL = '/opt/homebrew/bin/fish';

  const detected = detectShell();
  assert.equal(detected.shell, 'fish');
  assert.ok(detected.rcFile.endsWith('/.config/fish/config.fish'));
});
