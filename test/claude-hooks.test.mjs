import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The installer freezes its settings path from HOME at import.
const home = mkdtempSync(join(tmpdir(), 'vibe-claude-home-'));
process.env.HOME = home;

const { installClaudeHooks } = await import('../dist/claude-hooks.js');
const settingsPath = join(home, '.claude', 'settings.json');
const cli = new URL('../dist/cli.js', import.meta.url).pathname;

function commands(settings, event) {
  return settings.hooks[event].flatMap((g) => g.hooks.map((h) => h.command));
}

// What an nvm upgrade that removed the old Node leaves behind: every event
// pinned to a path that no longer runs, one of them sharing its group with
// somebody else's command.
test('reinstall repoints stale hooks and keeps everything else', () => {
  mkdirSync(join(home, '.claude'), { recursive: true });
  const stale = (event) => `'/old/node' '/old/vibetime-cli/dist/cli.js' __hook ${event}`;
  writeFileSync(settingsPath, JSON.stringify({
    agentPushNotifEnabled: true,
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: stale('session-start') }, { type: 'command', command: 'echo mine' }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: stale('activity') }] }],
      PostToolUse: [{ matcher: '', hooks: [{ type: 'command', command: stale('activity') }] }],
      Stop: [{ hooks: [{ type: 'command', command: stale('activity') }] }],
      SessionEnd: [{ hooks: [{ type: 'command', command: stale('session-end') }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo theirs' }] }],
    },
  }, null, 2));

  installClaudeHooks('repair');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));

  assert.equal(settings.agentPushNotifEnabled, true);
  assert.deepEqual(commands(settings, 'PreToolUse'), ['echo theirs']);
  assert.ok(commands(settings, 'SessionStart').includes('echo mine'));
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd']) {
    const ours = commands(settings, event).filter((c) => c.includes('__hook'));
    assert.equal(ours.length, 1, event);
    assert.ok(ours[0].includes(cli), `${event} still points at ${ours[0]}`);
  }
});

test('a current install is left exactly as it is', () => {
  installClaudeHooks('repair');
  const before = statSync(settingsPath).ino;
  const text = readFileSync(settingsPath, 'utf-8');

  installClaudeHooks('repair');

  assert.equal(statSync(settingsPath).ino, before);
  assert.equal(readFileSync(settingsPath, 'utf-8'), text);
});
