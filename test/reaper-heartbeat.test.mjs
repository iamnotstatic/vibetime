import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// A terminal can sit open for hours without a commit. Its wrapper still
// rewrites the session every poll, moving endedAt forward, while lastActivityAt
// stays at the last git activity. Reaping it on lastActivityAt alone ended a
// live session on every vibe command, the poller revived it, and each round
// trip put it back in the submit queue to be sent again.

process.env.VIBE_DIR = mkdtempSync(join(tmpdir(), 'vibe-heartbeat-'));
delete process.env.VIBE_SESSION;

const { reapOrphanedSessions, getSessions } = await import('../dist/db.js');

const ago = (ms) => new Date(Date.now() - ms).toISOString();

function seed(sessions) {
  writeFileSync(join(process.env.VIBE_DIR, 'sessions.json'), JSON.stringify({ sessions }));
}

function session(over) {
  return {
    id: randomUUID(), tool: 'claude', project: 'repo', branch: 'main',
    startedAt: ago(3 * 3_600_000), durationSeconds: 600, commits: 0, linesAdded: 0, linesRemoved: 0, filesTouched: 0,
    momentum: 'idle', exitCode: -1, ...over,
  };
}

test('an idle terminal whose wrapper is still polling is not reaped', async () => {
  const live = session({ lastActivityAt: ago(2 * 3_600_000), endedAt: ago(20_000) });
  seed([live]);
  await reapOrphanedSessions();
  assert.equal(getSessions()[0].exitCode, -1, 'the wrapper wrote it seconds ago, so it is alive');
});

test('a session whose wrapper stopped writing is reaped as before', async () => {
  const dead = session({ lastActivityAt: ago(2 * 3_600_000), endedAt: ago(20 * 60_000) });
  seed([dead]);
  await reapOrphanedSessions();
  const [s] = getSessions();
  assert.equal(s.exitCode, 1);
  assert.equal(s.endedAt, new Date(Date.parse(dead.lastActivityAt) + 30 * 60_000).toISOString());
});

test('an idle desktop session is reaped as before', async () => {
  const idle = ago(40 * 60_000);
  seed([session({ lastActivityAt: idle, endedAt: idle })]);
  await reapOrphanedSessions();
  assert.equal(getSessions()[0].exitCode, 1);
});
