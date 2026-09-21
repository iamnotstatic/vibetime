import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { baselineRepos, getReposDiffStats } from '../dist/git.js';

const MINE = 'me@example.com';

function sh(cmd, cwd) {
  execSync(cmd, { cwd, stdio: 'pipe' });
}

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vibe-author-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function initRepo(parent, email = MINE) {
  sh('git init -qb main repo', parent);
  const path = join(parent, 'repo');
  sh(`git config user.email ${email}`, path);
  sh('git config user.name tester', path);
  sh('git -c user.email=seed@example.com -c user.name=seed commit -q --allow-empty -m init', path);
  return path;
}

// Each commit writes `lines` lines to its own file so line and file counts are
// attributable to an author, not just the commit count.
function commitAs(repo, email, name, lines) {
  const file = `${name}.txt`;
  writeFileSync(join(repo, file), 'x\n'.repeat(lines));
  sh(`git add ${file}`, repo);
  sh(`git -c user.email='${email}' -c user.name=someone commit -q -m ${name}`, repo);
}

test('signed out counts every commit, exactly as before', (t) => {
  const repo = initRepo(scratch(t));
  const baseline = baselineRepos(repo);

  commitAs(repo, MINE, 'mine', 10);
  commitAs(repo, 'them@example.com', 'theirs', 20);

  const stats = getReposDiffStats(baseline, []);
  assert.equal(stats.commits, 2);
  assert.equal(stats.linesAdded, 30);
  assert.equal(stats.filesTouched, 2);
});

// Signed in, the noreply forms alone match no locally-authored commit. If the
// filter ran on those, a repo with no resolvable identity would report zero for
// work the user actually did, which is the failure this was built to avoid.
test('no resolvable git identity falls back to unfiltered, never to zero', (t) => {
  const prev = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  try {
    const parent = scratch(t);
    sh('git init -qb main repo', parent);
    const repo = join(parent, 'repo');
    sh('git config user.name tester', repo);
    sh('git -c user.email=seed@example.com -c user.name=seed commit -q --allow-empty -m init', repo);
    const baseline = baselineRepos(repo);

    commitAs(repo, MINE, 'mine', 10);
    commitAs(repo, 'them@example.com', 'theirs', 20);

    const stats = getReposDiffStats(baseline, ['1+me@users.noreply.github.com']);
    assert.equal(stats.commits, 2, 'counting none of someone\'s work is worse than counting too much');
    assert.equal(stats.linesAdded, 30);
  } finally {
    if (prev === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = prev;
  }
});

test('signed in counts only your commits, lines and files', (t) => {
  const repo = initRepo(scratch(t));
  const baseline = baselineRepos(repo);

  commitAs(repo, MINE, 'mine', 10);
  commitAs(repo, 'them@example.com', 'theirs', 20);
  commitAs(repo, 'other@example.com', 'others', 40);

  const stats = getReposDiffStats(baseline, ['1+me@users.noreply.github.com']);
  assert.equal(stats.commits, 1, 'only the commit authored by the repo identity');
  assert.equal(stats.linesAdded, 10, 'teammate lines are not yours');
  assert.equal(stats.filesTouched, 1);
});

test('a GitHub noreply address counts as you', (t) => {
  const repo = initRepo(scratch(t));
  const baseline = baselineRepos(repo);

  commitAs(repo, MINE, 'local', 10);
  commitAs(repo, '7+me@users.noreply.github.com', 'viaweb', 15);
  commitAs(repo, 'them@example.com', 'theirs', 99);

  const stats = getReposDiffStats(baseline, ['7+me@users.noreply.github.com']);
  assert.equal(stats.commits, 2, 'the web merge is still your work');
  assert.equal(stats.linesAdded, 25);
});

// Bare `--author=bob@x.com` is a substring match and also hits bigbob@x.com.
test('one address does not match a longer one ending in it', (t) => {
  const repo = initRepo(scratch(t), 'bob@x.com');
  const baseline = baselineRepos(repo);

  commitAs(repo, 'bob@x.com', 'bob', 10);
  commitAs(repo, 'bigbob@x.com', 'bigbob', 50);

  const stats = getReposDiffStats(baseline, ['1+bob@users.noreply.github.com']);
  assert.equal(stats.commits, 1);
  assert.equal(stats.linesAdded, 10);
});

// The identity set reaches git as argv, never a shell string.
test('a shell-hostile address neither injects nor silently zeroes', (t) => {
  const dir = scratch(t);
  const repo = initRepo(dir, MINE);
  const baseline = baselineRepos(repo);

  commitAs(repo, MINE, 'mine', 10);

  const canary = join(dir, 'pwned');
  const stats = getReposDiffStats(baseline, [`x"; touch ${canary}; echo "@evil.com`]);

  assert.equal(stats.commits, 1, 'your own work still counts');
  assert.equal(stats.linesAdded, 10);
  assert.ok(!existsSync(canary), 'no shell ran the injected command');
});

test('merge commits do not re-credit work written by someone else', (t) => {
  const repo = initRepo(scratch(t));
  const baseline = baselineRepos(repo);

  sh('git checkout -qb feature', repo);
  commitAs(repo, 'them@example.com', 'theirwork', 200);
  sh('git checkout -q main', repo);
  commitAs(repo, MINE, 'minework', 5);
  sh(`git -c user.email=${MINE} -c user.name=tester merge -q --no-ff -m merge feature`, repo);

  const stats = getReposDiffStats(baseline, ['1+me@users.noreply.github.com']);
  assert.equal(stats.commits, 2, 'your commit and your merge commit, not theirs');
  assert.equal(stats.linesAdded, 5, 'merging their 200 lines does not make them yours');
});
