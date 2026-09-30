import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync, spawn, spawnSync } from 'node:child_process';

// Two terminals on one branch are one stream of work, not two. Each wrapped
// session used to take its own baseline and then count the same commits, so a
// branch worked on from two windows earned a ship event twice. The second
// session resumes the first instead, which is what the desktop hook path
// already does when an editor reopens a conversation.

const cli = new URL('../dist/cli.js', import.meta.url);

function sh(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf-8' }).trim();
}

function commit(repo, name) {
  writeFileSync(join(repo, name), Array.from({ length: 40 }, (_, i) => `${name} ${i}`).join('\n') + '\n');
  sh(`git add ${name}`, repo);
  sh(`git -c user.email=vibe@test -c user.name=vibe commit -q -m ${name}`, repo);
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'vibe-resume-'));
  const repo = join(dir, 'repo');
  sh('git init -qb main repo', dir);
  sh('git config user.email vibe@test', repo);
  sh('git config user.name vibe', repo);
  sh('git -c user.email=vibe@test -c user.name=vibe commit -q --allow-empty -m init', repo);
  const home = join(dir, 'home');
  mkdirSync(home);
  writeFileSync(join(home, 'sessions.json'), JSON.stringify({ sessions: [] }));
  const env = { ...process.env, VIBE_DIR: home, VIBE_API: 'http://127.0.0.1:1' };
  delete env.VIBE_SESSION;
  return { dir, repo, home, env };
}

const sessionsIn = (home) => JSON.parse(readFileSync(join(home, 'sessions.json'), 'utf-8')).sessions;

test('a second wrapped session on the same branch resumes the first', async (t) => {
  const { dir, repo, home, env } = setup();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // First session stays open while the second starts, the way two terminals
  // on one branch overlap in practice.
  const held = spawn(process.execPath, [cli.pathname, '__wrap', process.execPath, '-e', 'setTimeout(() => {}, 4000)'], {
    cwd: repo, env, stdio: 'ignore',
  });
  await new Promise((r) => setTimeout(r, 1500));
  const opened = sessionsIn(home).filter((s) => s.exitCode === -1);
  assert.equal(opened.length, 1, 'the first session is open');

  commit(repo, 'work.txt');

  const second = spawnSync(process.execPath, [cli.pathname, '__wrap', process.execPath, '-e', '0'], {
    cwd: repo, env, encoding: 'utf-8', timeout: 60_000,
  });
  assert.equal(second.status, 0, second.stderr);

  const forBranch = sessionsIn(home).filter((s) => s.branch === 'main');
  assert.equal(
    forBranch.length, 1,
    `one branch, one session: got ${forBranch.length} (${forBranch.map((s) => `${s.id.slice(0, 8)} commits=${s.commits}`).join(', ')})`,
  );

  await new Promise((r) => held.on('close', r));
});

test('a session on a different branch is left alone', async (t) => {
  const { dir, repo, home, env } = setup();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const held = spawn(process.execPath, [cli.pathname, '__wrap', process.execPath, '-e', 'setTimeout(() => {}, 4000)'], {
    cwd: repo, env, stdio: 'ignore',
  });
  await new Promise((r) => setTimeout(r, 1500));

  // A worktree on its own branch is the parallel-agent workflow vibetime
  // exists to measure, and it keeps its own session and its own baseline.
  const other = join(dir, 'feature');
  sh(`git worktree add -q -b feature '${other}'`, repo);
  const second = spawnSync(process.execPath, [cli.pathname, '__wrap', process.execPath, '-e', '0'], {
    cwd: other, env, encoding: 'utf-8', timeout: 60_000,
  });
  assert.equal(second.status, 0, second.stderr);

  const branches = sessionsIn(home).map((s) => s.branch).sort();
  assert.deepEqual(branches, ['feature', 'main'], 'each branch kept its own session');

  await new Promise((r) => held.on('close', r));
});

test('simultaneous launches on one branch claim a single session', async (t) => {
  const { dir, repo, home, env } = setup();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Without a shared instant the children stagger by tens of milliseconds and
  // the first writer always wins, which is a passing test that proves nothing.
  const target = Date.now() + 1500;
  const spin = (script) => `const t=${target};while(Date.now()<t){};${script}`;
  const run = JSON.stringify(cli.pathname);
  const kids = Array.from({ length: 4 }, () => spawn(process.execPath, ['-e', spin(
    `require('child_process').spawnSync(process.execPath,[${run},'__wrap',process.execPath,'-e','setTimeout(()=>{},1200)'],{cwd:${JSON.stringify(repo)},stdio:'ignore'})`,
  )], { env, stdio: 'ignore' }));
  await Promise.all(kids.map((k) => new Promise((r) => k.on('close', r))));

  const forBranch = sessionsIn(home).filter((s) => s.branch === 'main');
  assert.equal(forBranch.length, 1, `four simultaneous launches, one branch: got ${forBranch.length} sessions`);
});

test('two repos sharing a directory name keep separate sessions', async (t) => {
  const { dir, home, env } = setup();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // No remote, so the project name falls back to the directory basename and
  // both of these are called "api" on branch main.
  const made = ['one', 'two'].map((parent) => {
    const path = join(dir, parent, 'api');
    mkdirSync(join(dir, parent), { recursive: true });
    sh(`git init -qb main '${path}'`, dir);
    sh('git -c user.email=vibe@test -c user.name=vibe commit -q --allow-empty -m init', path);
    return path;
  });

  const held = spawn(process.execPath, [cli.pathname, '__wrap', process.execPath, '-e', 'setTimeout(() => {}, 4000)'], {
    cwd: made[0], env, stdio: 'ignore',
  });
  await new Promise((r) => setTimeout(r, 1500));
  const second = spawnSync(process.execPath, [cli.pathname, '__wrap', process.execPath, '-e', '0'], {
    cwd: made[1], env, encoding: 'utf-8', timeout: 60_000,
  });
  assert.equal(second.status, 0, second.stderr);

  // git resolves the real path, and on macOS /var is a symlink to /private/var,
  // so compare the tails rather than the strings the test built.
  const tails = sessionsIn(home).map((s) => s.repos?.[0]?.path.split('/').slice(-2).join('/')).sort();
  assert.deepEqual(tails, ['one/api', 'two/api'], 'each repo kept its own session');

  await new Promise((r) => held.on('close', r));
});

test('a launch that fails to start leaves the running session alone', async (t) => {
  const { dir, repo, home, env } = setup();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const held = spawn(process.execPath, [cli.pathname, '__wrap', process.execPath, '-e', 'setTimeout(() => {}, 4000)'], {
    cwd: repo, env, stdio: 'ignore',
  });
  await new Promise((r) => setTimeout(r, 1500));
  const [running] = sessionsIn(home);

  // The failed launch adopts the running session before its spawn error
  // arrives, and cleaning up after itself must not reach into that one.
  spawnSync(process.execPath, [cli.pathname, '__wrap', 'vibe-no-such-tool'], { cwd: repo, env, encoding: 'utf-8', timeout: 60_000 });
  assert.deepEqual(sessionsIn(home).map((s) => [s.id, s.exitCode]), [[running.id, -1]], 'the running session is intact and still open');

  await new Promise((r) => held.on('close', r));
  assert.deepEqual(sessionsIn(home).map((s) => [s.id, s.exitCode]), [[running.id, 0]]);
});

test('a session ended elsewhere while still running resends when it exits', async (t) => {
  const { dir, repo, home, env } = setup();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(home, 'remote-config.json'), JSON.stringify({ pollIntervalMs: 5000, fetchedAt: new Date().toISOString() }));

  const held = spawn(process.execPath, [cli.pathname, '__wrap', process.execPath, '-e', 'setTimeout(() => {}, 9000)'], {
    cwd: repo, env, stdio: 'ignore',
  });
  await new Promise((r) => setTimeout(r, 1500));

  // What the other terminal on a shared session leaves behind when it exits
  // first, or the reaper after a long idle: ended, flushed, marked submitted.
  const path = join(home, 'sessions.json');
  const data = JSON.parse(readFileSync(path, 'utf-8'));
  Object.assign(data.sessions[0], { exitCode: 0, submittedAt: new Date().toISOString() });
  writeFileSync(path, JSON.stringify(data));

  commit(repo, 'after.txt');
  await new Promise((r) => held.on('close', r));

  const [final] = sessionsIn(home);
  assert.equal(final.commits, 1, 'the work after the other exit is recorded');
  assert.equal(final.submittedAt, undefined, 'and is still waiting to be sent, not marked as already sent');
});
