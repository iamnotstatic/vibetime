import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// One commit is one piece of effort, however many sessions can see it. Every
// open session watches every checkout of its repos, so without a ledger a
// commit in one worktree was credited to every sibling's session too, and two
// editor windows on one branch each earned the other's ships.

process.env.VIBE_DIR = mkdtempSync(join(tmpdir(), 'vibe-home-'));
delete process.env.VIBE_SESSION;

const { handleHook } = await import('../dist/hook.js');
const { getSessions } = await import('../dist/db.js');
const cli = new URL('../dist/cli.js', import.meta.url);

function sh(cmd, cwd, env = {}) {
  return execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf-8', env: { ...process.env, ...env } }).trim();
}

const author = { GIT_AUTHOR_NAME: 'vibe', GIT_AUTHOR_EMAIL: 'vibe@test', GIT_COMMITTER_NAME: 'vibe', GIT_COMMITTER_EMAIL: 'vibe@test' };

function commit(cwd, name, env = {}) {
  writeFileSync(join(cwd, name), Array.from({ length: 60 }, (_, i) => `${name} ${i}`).join('\n') + '\n');
  sh(`git add ${name}`, cwd);
  sh(`git commit -q -m ${name}`, cwd, { ...author, ...env });
}

function setup(t) {
  rmSync(join(process.env.VIBE_DIR, 'sessions.json'), { force: true });
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vibe-credit-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  sh('git init -qb main repo', dir);
  sh('git commit -q --allow-empty -m init', repo, author);
  return { dir, repo };
}

const hook = (event, id, cwd) => handleHook(event, JSON.stringify({ session_id: id, cwd }), 'claude');
const find = (id) => getSessions().find((s) => s.id === id);
const creditedCommits = () => getSessions().reduce((n, s) => n + s.commits, 0);

test('a commit in one worktree is credited once, to the session working there', async (t) => {
  const { dir, repo } = setup(t);
  const wa = join(dir, 'wa');
  const wb = join(dir, 'wb');
  sh(`git worktree add -q -b feat-a '${wa}'`, repo);
  sh(`git worktree add -q -b feat-b '${wb}'`, repo);

  const env = { ...process.env, VIBE_API: 'http://127.0.0.1:1' };
  const held = [repo, wa, wb].map((cwd) => spawn(process.execPath, [cli.pathname, '__wrap', process.execPath, '-e', 'setTimeout(() => {}, 5000)'], {
    cwd, env, stdio: 'ignore',
  }));
  await new Promise((r) => setTimeout(r, 2500));
  commit(wa, 'work.txt');
  await Promise.all(held.map((p) => new Promise((r) => p.on('close', r))));

  const byBranch = Object.fromEntries(getSessions().map((s) => [s.branch, s.commits]));
  assert.deepEqual(byBranch, { main: 0, 'feat-a': 1, 'feat-b': 0 });
});

test('two editor windows on one branch credit a commit once', async (t) => {
  const { repo } = setup(t);
  const [a, b] = [randomUUID(), randomUUID()];
  await hook('session-start', a, repo);
  await hook('session-start', b, repo);
  commit(repo, 'work.txt');
  await hook('session-end', b, repo);
  await hook('session-end', a, repo);

  assert.equal(creditedCommits(), 1, `a=${find(a).commits} b=${find(b).commits}`);
});

test('a session on a parent directory and one in the repo credit a commit once', async (t) => {
  const { dir, repo } = setup(t);
  const [parent, inside] = [randomUUID(), randomUUID()];
  await hook('session-start', parent, dir);
  await hook('session-start', inside, repo);
  commit(repo, 'work.txt');
  await hook('session-end', inside, repo);
  await hook('session-end', parent, dir);

  assert.equal(creditedCommits(), 1, `parent=${find(parent).commits} inside=${find(inside).commits}`);
});

test('merging a branch credited earlier does not credit its commits again', async (t) => {
  const { repo } = setup(t);
  sh('git switch -q -c feature', repo);
  const first = randomUUID();
  await hook('session-start', first, repo);
  commit(repo, 'feature.txt');
  await hook('session-end', first, repo);
  assert.equal(find(first).linesAdded, 60);

  sh('git switch -q main', repo);
  const later = randomUUID();
  await hook('session-start', later, repo);
  sh('git merge -q --no-ff -m merge feature', repo, author);
  await hook('session-end', later, repo);

  assert.equal(find(later).linesAdded, 0, 'the merged work was already credited to the session that wrote it');
});

test('amending a credited commit in a later session does not credit it again', async (t) => {
  const { repo } = setup(t);
  const first = randomUUID();
  await hook('session-start', first, repo);
  commit(repo, 'work.txt');
  await hook('session-end', first, repo);

  const later = randomUUID();
  await hook('session-start', later, repo);
  sh('git commit -q --amend -m reworded', repo, author);
  await hook('session-end', later, repo);

  assert.equal(find(later).commits, 0, 'an amend keeps the author time, so it is the same work');
});

test('a squash merged on github.com is not credited when pulled', async (t) => {
  const { repo } = setup(t);
  const id = randomUUID();
  await hook('session-start', id, repo);
  commit(repo, 'squash.txt', { GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com' });
  await hook('session-end', id, repo);

  assert.equal(find(id).commits, 0);
});

test('sessions crediting at the same instant claim a commit once', async (t) => {
  const { dir, repo } = setup(t);
  const init = sh('git rev-parse HEAD', repo);
  commit(repo, 'shared.txt');
  const paths = [repo, join(dir, 'wa'), join(dir, 'wb'), join(dir, 'wc')];
  for (const [i, p] of paths.slice(1).entries()) sh(`git worktree add -q -b w${i} '${p}' main`, repo);

  // Each session works in its own checkout and every checkout's tip reaches
  // the commit, so each one is entitled to claim it and only the lock decides.
  const now = new Date().toISOString();
  const sessions = paths.map((path, i) => ({
    id: randomUUID(), tool: 'claude', project: 'repo', branch: `w${i}`,
    startedAt: now, endedAt: now, durationSeconds: 0, commits: 0, linesAdded: 0, linesRemoved: 0, filesTouched: 0,
    momentum: 'idle', exitCode: -1, lastActivityAt: now,
    repos: [{ path, startSha: init, worktrees: paths.filter((p) => p !== path).map((p) => ({ path: p, startSha: init })) }],
  }));
  mkdirSync(process.env.VIBE_DIR, { recursive: true });
  writeFileSync(join(process.env.VIBE_DIR, 'sessions.json'), JSON.stringify({ sessions }));

  // Without a shared instant the children stagger by tens of milliseconds and
  // the first writer always wins, which is a passing test that proves nothing.
  const target = Date.now() + 1500;
  const db = new URL('../dist/db.js', import.meta.url).href;
  const git = new URL('../dist/git.js', import.meta.url).href;
  const counts = await Promise.all(sessions.map((s) => new Promise((resolve) => {
    const script = `const [{ creditWork }, { measureRepos }] = await Promise.all([import(${JSON.stringify(db)}), import(${JSON.stringify(git)})]);
      const s = ${JSON.stringify(s)}; const work = measureRepos(s.repos);
      while (Date.now() < ${target}) {}
      process.stdout.write(String(creditWork(s, work).commits));`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: process.env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    // A crashed child prints nothing, and Number('') is 0: read as a pass.
    child.on('close', () => resolve(out === '' ? NaN : Number(out)));
  })));

  assert.equal(counts.reduce((a, b) => a + b, 0), 1, `credited per session: ${counts.join(', ')}`);
});

test('an older window left open does not take a newer session\'s work', async (t) => {
  const { repo } = setup(t);
  const [idle, working] = [randomUUID(), randomUUID()];
  await hook('session-start', idle, repo);
  await new Promise((r) => setTimeout(r, 20));
  await hook('session-start', working, repo);
  commit(repo, 'work.txt');
  await hook('session-end', idle, repo);
  await hook('session-end', working, repo);

  assert.deepEqual([find(idle).commits, find(working).commits], [0, 1]);
});

test('measuring still works when the ledger cannot be written', async (t) => {
  const { repo } = setup(t);
  const { creditWork } = await import('../dist/db.js');
  const { measureRepos, baselineRepos } = await import('../dist/git.js');
  const repos = baselineRepos(repo);
  const now = new Date().toISOString();
  const session = { id: randomUUID(), tool: 'claude', project: 'repo', branch: 'main', startedAt: now, endedAt: now,
    durationSeconds: 0, commits: 0, linesAdded: 0, linesRemoved: 0, filesTouched: 0, momentum: 'idle', exitCode: -1, repos };
  writeFileSync(join(process.env.VIBE_DIR, 'sessions.json'), JSON.stringify({ sessions: [session] }));
  commit(repo, 'work.txt');

  const tmp = join(process.env.VIBE_DIR, 'sessions.json.tmp');
  mkdirSync(tmp);
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  assert.equal(creditWork(session, measureRepos(repos)).commits, 1);
});

test('a hand-edited ledger is ignored rather than trusted or fatal', async (t) => {
  const { repo } = setup(t);
  const { creditWork } = await import('../dist/db.js');
  const { measureRepos, baselineRepos } = await import('../dist/git.js');
  const repos = baselineRepos(repo);
  const now = new Date().toISOString();
  const base = { tool: 'claude', project: 'repo', branch: 'main', startedAt: now, endedAt: now,
    durationSeconds: 0, commits: 0, linesAdded: 0, linesRemoved: 0, filesTouched: 0, momentum: 'idle', exitCode: 0 };
  const session = { ...base, id: randomUUID(), exitCode: -1, repos };
  writeFileSync(join(process.env.VIBE_DIR, 'sessions.json'), JSON.stringify({ sessions: [
    { ...base, id: randomUUID(), credited: 'not a list' },
    { ...base, id: randomUUID(), credited: [42, null] },
    { ...base, id: randomUUID(), credited: { sha: 'x' } },
    session,
  ] }));
  commit(repo, 'work.txt');

  assert.equal(creditWork(session, measureRepos(repos)).commits, 1);
});

test('commits in two repos in the same second are both credited', async (t) => {
  const { dir, repo } = setup(t);
  const other = join(dir, 'other');
  sh('git init -qb main other', dir);
  sh('git commit -q --allow-empty -m init', other, author);

  // Same author, same second: what parallel agents in two repos produce, and
  // exactly what a rewritten copy of a commit looks like, so only the repo
  // can tell them apart.
  const when = { GIT_AUTHOR_DATE: '2026-09-30T12:00:00Z', GIT_COMMITTER_DATE: '2026-09-30T12:00:00Z' };
  const [a, b] = [randomUUID(), randomUUID()];
  await hook('session-start', a, repo);
  commit(repo, 'a.txt', when);
  await hook('session-end', a, repo);
  await hook('session-start', b, other);
  commit(other, 'b.txt', when);
  await hook('session-end', b, other);

  assert.deepEqual([find(a).commits, find(b).commits], [1, 1]);
});
