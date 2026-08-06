import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { execSync } from 'node:child_process';
import { baselineRepos, discoverRepos, getReposDiffStats } from '../dist/git.js';

function sh(cmd, cwd) {
  execSync(cmd, { cwd, stdio: 'pipe' });
}

function initRepo(parent, name) {
  sh(`git init -qb main ${name}`, parent);
  const path = join(parent, name);
  commit(path, 'init', { allowEmpty: true });
  return path;
}

function commit(cwd, msg, { allowEmpty = false } = {}) {
  sh(`git -c user.email=vibe@test -c user.name=vibe commit -q ${allowEmpty ? '--allow-empty ' : ''}-m ${msg}`, cwd);
}

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vibe-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a file both committed and re-edited counts once', (t) => {
  const dir = scratch(t);
  const repo = initRepo(dir, 'repo');
  const baseline = baselineRepos(repo);

  writeFileSync(join(repo, 'f.txt'), 'one\n');
  sh('git add f.txt', repo);
  commit(repo, 'add');
  writeFileSync(join(repo, 'f.txt'), 'two\n');

  assert.deepEqual(getReposDiffStats(baseline), {
    commits: 1,
    linesAdded: 2,
    linesRemoved: 1,
    filesTouched: 1,
  });
});

test('a repo and its sibling worktree are one repo, not two', (t) => {
  const dir = scratch(t);
  const repoA = initRepo(dir, 'repoA');
  sh('git worktree add -q ../repoA-wt -b feat', repoA);
  const repoB = initRepo(dir, 'repoB');
  writeFileSync(join(repoB, 'b.txt'), 'base\n');
  sh('git add b.txt', repoB);
  commit(repoB, 'init-b');

  const baseline = baselineRepos(dir);
  assert.equal(baseline.length, 2);

  writeFileSync(join(dir, 'repoA-wt', 'f.txt'), 'one\ntwo\n');
  sh('git add f.txt', join(dir, 'repoA-wt'));
  commit(join(dir, 'repoA-wt'), 'feat');
  writeFileSync(join(repoB, 'b.txt'), 'changed\n');
  sh('git add b.txt', repoB);
  commit(repoB, 'edit');
  writeFileSync(join(repoB, 'b.txt'), 'again\n');

  assert.deepEqual(getReposDiffStats(baseline), {
    commits: 2,
    linesAdded: 4,
    linesRemoved: 2,
    filesTouched: 2,
  });
});

test('the main checkout is kept no matter how the scan orders them', (t) => {
  const dir = scratch(t);
  const repo = initRepo(dir, 'zrepo');
  // The worktree sorts before the main checkout, so dedupe must swap, not
  // just keep the first candidate it sees.
  sh('git worktree add -q ../aaa-wt -b feat', repo);

  const discovered = discoverRepos(dir);
  assert.equal(discovered.length, 1);
  assert.equal(basename(discovered[0]), 'zrepo');
});

test('a commit made in a linked worktree counts from the main checkout', (t) => {
  const dir = scratch(t);
  const repo = initRepo(dir, 'repo');
  sh(`git worktree add -q ${join(dir, 'wt')} -b feat`, repo);
  const baseline = baselineRepos(repo);

  writeFileSync(join(dir, 'wt', 'f.txt'), 'one\n');
  sh('git add f.txt', join(dir, 'wt'));
  commit(join(dir, 'wt'), 'feat');

  assert.deepEqual(getReposDiffStats(baseline), {
    commits: 1,
    linesAdded: 1,
    linesRemoved: 0,
    filesTouched: 1,
  });
});

test('a worktree parked on an old branch adds nothing', (t) => {
  const dir = scratch(t);
  const repo = initRepo(dir, 'repo');
  writeFileSync(join(repo, 'f.txt'), 'one\n');
  sh('git add f.txt', repo);
  commit(repo, 'second');
  sh('git branch old HEAD~1', repo);
  sh(`git worktree add -q ${join(dir, 'wt')} old`, repo);

  const baseline = baselineRepos(repo);
  assert.deepEqual(getReposDiffStats(baseline), {
    commits: 0,
    linesAdded: 0,
    linesRemoved: 0,
    filesTouched: 0,
  });
});
