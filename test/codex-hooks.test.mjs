import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const {
  installCodexHooks,
  mergeCodexHooks,
  stripCodexHooks,
} = await import('../dist/codex-hooks.js');

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vibe-codex-hooks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function otherHook(command = 'notify-send done') {
  return { hooks: [{ type: 'command', command, timeout: 5 }] };
}

test('Codex hooks merge non-destructively and are idempotent', () => {
  const unrelated = otherHook();
  const config = {
    description: 'keep me',
    hooks: {
      Stop: [unrelated],
      PreToolUse: [otherHook('policy-check')],
    },
  };

  const first = mergeCodexHooks(config);
  assert.equal(first.added, 5);
  assert.equal(first.existing, 0);
  assert.equal(first.config.description, 'keep me');
  assert.equal(first.config.hooks.Stop[0], unrelated);
  assert.equal(first.config.hooks.PreToolUse.length, 1);

  const codexGroups = Object.fromEntries(
    ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd'].map((event) => [
      event,
      first.config.hooks[event].find((group) => group.hooks.some((hook) => hook.command.includes('--tool codex'))),
    ]),
  );

  assert.equal(codexGroups.PostToolUse.matcher, '');
  assert.equal('matcher' in codexGroups.UserPromptSubmit, false);
  assert.match(codexGroups.Stop.hooks[0].command, /__hook activity --tool codex --respond-json$/);
  assert.match(codexGroups.SessionStart.hooks[0].commandWindows, /^".+" ".+" __hook session-start --tool codex$/);
  assert.equal(codexGroups.Stop.hooks[0].timeout, 10);
  assert.equal(codexGroups.SessionEnd.hooks[0].timeout, 3);

  const second = mergeCodexHooks(first.config);
  assert.equal(second.added, 0);
  assert.equal(second.existing, 5);
  assert.equal(second.updated, 0);
});

test('reinstall refreshes stale commands without duplicating hooks', () => {
  const first = mergeCodexHooks({});
  const sessionStart = first.config.hooks.SessionStart.find((group) =>
    group.hooks.some((hook) => hook.command.includes('--tool codex')),
  );
  sessionStart.hooks[0].command = "'/old/node' '/old/vibe' __hook session-start --tool codex";

  const second = mergeCodexHooks(first.config);
  const vibeGroups = second.config.hooks.SessionStart.filter((group) =>
    group.hooks.some((hook) => hook.command.includes('--tool codex')),
  );

  assert.equal(second.added, 0);
  assert.equal(second.updated, 1);
  assert.equal(vibeGroups.length, 1);
  assert.doesNotMatch(vibeGroups[0].hooks[0].command, /old\/node/);
});

// What Codex writes to hooks.json when it imports ~/.claude/settings.json: the
// Claude Code entries verbatim, so no --tool codex and a SessionEnd timeout
// above the 3s Codex allows.
function importedClaudeHook(event) {
  return { hooks: [{ type: 'command', command: `'/usr/bin/node' '/lib/vibetime-cli/dist/cli.js' __hook ${event}`, timeout: 10 }] };
}

test('reinstall replaces Claude Code hooks that Codex imported', () => {
  const unrelated = otherHook();
  const config = {
    hooks: {
      SessionStart: [importedClaudeHook('session-start')],
      UserPromptSubmit: [importedClaudeHook('activity')],
      PostToolUse: [{ matcher: '', ...importedClaudeHook('activity') }],
      Stop: [importedClaudeHook('activity'), unrelated],
      SessionEnd: [importedClaudeHook('session-end')],
    },
  };

  const { config: merged, added, existing, updated } = mergeCodexHooks(config);
  assert.equal(added, 0);
  assert.equal(existing, 5);
  assert.equal(updated, 5);
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd']) {
    const vibeGroups = merged.hooks[event].filter((group) => group.hooks.some((hook) => hook.command.includes('__hook')));
    assert.equal(vibeGroups.length, 1, event);
    assert.match(vibeGroups[0].hooks[0].command, /--tool codex/, event);
  }
  assert.equal(merged.hooks.SessionEnd[0].hooks[0].timeout, 3);
  assert.equal(merged.hooks.Stop[0], unrelated);
});

test('uninstall removes Claude Code hooks that Codex imported', () => {
  const { config, removed } = stripCodexHooks({
    hooks: { SessionEnd: [importedClaudeHook('session-end'), otherHook()] },
  });
  assert.equal(removed, 1);
  assert.deepEqual(config.hooks, { SessionEnd: [otherHook()] });
});

test('Codex hook removal preserves unrelated hooks and top-level settings', () => {
  const config = mergeCodexHooks({
    description: 'keep me',
    hooks: { Stop: [otherHook()] },
  }).config;

  const { config: stripped, removed } = stripCodexHooks(config);
  assert.equal(removed, 5);
  assert.equal(stripped.description, 'keep me');
  assert.deepEqual(stripped.hooks, { Stop: [otherHook()] });
});

test('installer never clobbers an invalid hooks.json', (t) => {
  const path = join(scratch(t), 'hooks.json');
  writeFileSync(path, '{ definitely not json\n');

  const originalLog = console.log;
  console.log = () => {};
  try {
    installCodexHooks(path);
  } finally {
    console.log = originalLog;
  }

  assert.equal(readFileSync(path, 'utf8'), '{ definitely not json\n');
});

test('Codex Stop hook returns the required JSON response', () => {
  const cli = new URL('../dist/cli.js', import.meta.url);
  const result = spawnSync(process.execPath, [cli.pathname, '__hook', 'activity', '--tool', 'codex', '--respond-json'], {
    input: '{}',
    encoding: 'utf8',
    env: { ...process.env, VIBE_SESSION: '1' },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, '{}\n');
  assert.equal(result.stderr, '');
});
