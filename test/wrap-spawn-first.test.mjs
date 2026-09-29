import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync, spawnSync } from 'node:child_process';

// The wrapper reads git across every checkout it watches, and again for every
// other open session, before it ever used to start the tool. On a repo with
// dozens of worktrees that was ten-plus seconds of blank terminal before
// `claude` drew its prompt. None of that work is start-anchored, so the tool
// must start first and the bookkeeping follow, and a tool that exits before
// the bookkeeping lands must still get its session recorded.
//
// The git shim and the tool append to one file, so the file IS the order the
// two actually happened in. An elapsed-milliseconds budget would instead
// measure how fast the host cold-starts a shell script and a node process,
// which is why the first version of this test failed on macOS and passed in CI.

const cli = new URL('../dist/cli.js', import.meta.url);

function sh(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf-8' }).trim();
}

test('the tool starts before git is read, and a fast exit still records the session', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'vibe-wrap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const repo = join(dir, 'repo');
  sh(`git init -qb main repo`, dir);
  sh('git -c user.email=vibe@test -c user.name=vibe commit -q --allow-empty -m init', repo);
  const head = sh('git rev-parse HEAD', repo);

  // The shim marks each diff read as COMPLETE, after its sleep. Marking the
  // start instead races: the wrapper issues its first read within a few ms of
  // the spawn, so which one appends first is a coin flip. What the fix actually
  // changed is that the tool no longer waits for these to finish.
  const order = join(dir, 'order.log');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const realGit = sh('command -v git');
  writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase "$*" in *numstat*) sleep 1; echo numstat >> '${order}';; esac\nexec '${realGit}' "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);

  const home = join(dir, 'home');
  mkdirSync(home);
  writeFileSync(join(home, 'sessions.json'), JSON.stringify({ sessions: [{
    id: 'seeded', tool: 'claude', project: 'p', branch: 'main',
    startedAt: new Date().toISOString(), endedAt: '', durationSeconds: 0,
    commits: 0, linesAdded: 0, linesRemoved: 0, filesTouched: 0,
    momentum: 'idle', exitCode: -1, lastActivityAt: new Date().toISOString(),
    startSha: head, repos: [{ path: repo, startSha: head }],
  }] }));

  const env = { ...process.env, VIBE_DIR: home, VIBE_API: 'http://127.0.0.1:1', PATH: `${bin}:${process.env.PATH}` };
  delete env.VIBE_SESSION;

  const tool = `require('fs').appendFileSync(${JSON.stringify(order)}, 'tool\\n')`;
  const res = spawnSync(process.execPath, [cli.pathname, '__wrap', process.execPath, '-e', tool], {
    cwd: repo, env, encoding: 'utf-8', timeout: 60_000,
  });
  assert.equal(res.status, 0, res.stderr);

  const events = readFileSync(order, 'utf-8').trim().split('\n');
  assert.equal(events[0], 'tool', `the tool waited for git to finish reading the working tree: ${events.slice(0, 3).join(' then ')}`);

  const { sessions } = JSON.parse(readFileSync(join(home, 'sessions.json'), 'utf-8'));
  const recorded = sessions.find((s) => s.tool === process.execPath);
  assert.ok(recorded, 'wrapped session was recorded');
  assert.equal(recorded.exitCode, 0);
  assert.equal(recorded.startSha, head);
});
