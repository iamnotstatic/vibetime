import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { scoreSession } from '../dist/score.js';
import { DEFAULTS } from '../dist/config.js';

// The server package never emits JS — wrangler bundles straight from TS — so
// transpile its score module on the fly and import it as a data URI. The module
// is dependency-free, which is what makes this possible.
const serverSource = readFileSync(new URL('../server/src/score.ts', import.meta.url), 'utf-8');
const { outputText } = ts.transpileModule(serverSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const server = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

// Values straddling both thresholds (lines > 50, files > 3), so a > drifting to
// >= — or a constant drifting on either side — fails a case at the boundary.
const COMMITS = [0, 1, 3];
const LINES_ADDED = [0, 1, 24, 49, 50, 51, 200];
const LINES_REMOVED = [0, 1, 26];
const FILES_TOUCHED = [0, 1, 3, 4, 10];

test('CLI and server score identically for every non-interrupted input', () => {
  for (const commits of COMMITS) {
    for (const linesAdded of LINES_ADDED) {
      for (const linesRemoved of LINES_REMOVED) {
        for (const filesTouched of FILES_TOUCHED) {
          const stats = { commits, linesAdded, linesRemoved, filesTouched };
          const cli = scoreSession({ ...stats, exitCode: 0 }, DEFAULTS);
          const remote = server.scoreSession(stats);
          assert.equal(cli, remote, `diverged on ${JSON.stringify(stats)}: cli=${cli} server=${remote}`);
        }
      }
    }
  }
});

test('interrupted is the one deliberate divergence: CLI-only, from exitCode', () => {
  const stats = { commits: 5, linesAdded: 500, linesRemoved: 100, filesTouched: 20 };
  assert.equal(scoreSession({ ...stats, exitCode: 1 }, DEFAULTS), 'interrupted');
  // The server never sees an exitCode and must not have the tier at all — the
  // leaderboard scores reaped sessions from their raw stats.
  assert.equal(server.scoreSession(stats), 'shipped');
  assert.ok(!serverSource.includes('interrupted'), 'server score.ts must not know about interrupted');
});
