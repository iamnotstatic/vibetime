import { execSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

const SHA_RE = /^[0-9a-f]{4,40}$/;

const GIT_TIMEOUT_MS = 3_000;

// Bounds for the one-level repo scan below. A container directory with more
// entries than this is almost certainly not a project root, and tracking every
// repo under it would cost a git spawn each on every refresh.
const MAX_SCANNED_ENTRIES = 100;
const MAX_DISCOVERED_REPOS = 10;

function run(cmd: string, cwd?: string) {
  try {
    return execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: GIT_TIMEOUT_MS }).trim();
  } catch {
    return '';
  }
}

function isSha(s: string) {
  return SHA_RE.test(s);
}

export function isGitRepo(cwd?: string): boolean {
  return run('git rev-parse --is-inside-work-tree', cwd) === 'true';
}

export function getHeadSha(cwd?: string): string {
  return run('git rev-parse HEAD', cwd);
}

export function getBranch(cwd?: string): string {
  return run('git rev-parse --abbrev-ref HEAD', cwd) || 'unknown';
}

export function getProjectName(cwd?: string): string {
  const remote = run('git remote get-url origin', cwd);
  if (remote) {
    const cleaned = remote.replace(/\.git$/, '');
    const parts = cleaned.split(/[/:]/);
    if (parts.length >= 2) {
      return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
    }
  }
  return basename(cwd || process.cwd());
}

export function getRepoRoot(cwd?: string): string {
  return run('git rev-parse --show-toplevel', cwd);
}

// A repo a session watches, paired with the HEAD it had when the session opened.
export interface RepoBaseline {
  path: string;
  startSha: string;
}

// The repos a session should measure. Usually that's the one repo the session
// started inside. But a session is just as often started from a directory that
// holds several repos side by side — a monorepo-ish parent like ~/work/acme with
// `api/` and `web/` in it, or a plain ~/dev. That directory has no HEAD of its
// own, so measuring only `cwd` scores every such session as idle no matter how
// much shipped. So: fall back to the repos one level down.
//
// Discovery is a filesystem check rather than a git spawn per child, and never
// recurses past one level, so it stays cheap enough to run inside a hook.
export function discoverRepos(cwd: string): string[] {
  const root = getRepoRoot(cwd);
  if (root) return [root];

  let entries: string[];
  try {
    entries = readdirSync(cwd, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }

  const repos: string[] = [];
  for (const name of entries.slice(0, MAX_SCANNED_ENTRIES)) {
    if (repos.length >= MAX_DISCOVERED_REPOS) break;
    const child = join(cwd, name);
    // `.git` is a directory in a normal clone and a file in a worktree or
    // submodule — existsSync covers both.
    if (existsSync(join(child, '.git'))) repos.push(child);
  }
  return repos;
}

export function baselineRepos(cwd: string): RepoBaseline[] {
  return discoverRepos(cwd).map((path) => ({ path, startSha: getHeadSha(path) }));
}

// How a session labels itself. One repo reads as that repo on whatever branch it
// is on; several read as the directory holding them, since no single branch
// describes the work.
export function describeRepos(repos: RepoBaseline[], cwd: string): { project: string; branch: string } {
  if (repos.length === 1) {
    return { project: getProjectName(repos[0].path), branch: getBranch(repos[0].path) };
  }
  return { project: basename(cwd) || 'unknown', branch: 'multiple' };
}

export interface GitDiffStats {
  commits: number;
  linesAdded: number;
  linesRemoved: number;
  filesTouched: number;
}

function parseNumstat(numstat: string) {
  let added = 0;
  let removed = 0;
  const files = new Set<string>();
  if (!numstat) return { added, removed, files };

  for (const line of numstat.split('\n').filter(Boolean)) {
    const [a, r, file] = line.split('\t');
    added += parseInt(a, 10) || 0;
    removed += parseInt(r, 10) || 0;
    if (file) files.add(file);
  }
  return { added, removed, files };
}

export function getWorkingTreeFingerprint(cwd?: string): string {
  return run('git status --porcelain', cwd);
}

export function getReposFingerprint(repos: RepoBaseline[]): string {
  return repos.map((r) => `${r.path}\n${getWorkingTreeFingerprint(r.path)}`).join('\n');
}

export function getDiffStats(fromSha: string, toSha: string, cwd?: string): GitDiffStats {
  let commits = 0;
  let linesAdded = 0;
  let linesRemoved = 0;
  const allFiles = new Set<string>();

  if (isSha(fromSha) && isSha(toSha) && fromSha !== toSha) {
    const logCount = run(`git rev-list --count ${fromSha}..${toSha}`, cwd);
    commits = parseInt(logCount, 10) || 0;

    const committed = parseNumstat(run(`git diff --numstat ${fromSha}..${toSha}`, cwd));
    linesAdded += committed.added;
    linesRemoved += committed.removed;
    for (const f of committed.files) allFiles.add(f);
  }

  const hasHead = run('git rev-parse --verify HEAD', cwd) !== '';
  const uncommitted = parseNumstat(
    hasHead ? run('git diff --numstat HEAD', cwd) : run('git diff --numstat --cached', cwd)
  );
  linesAdded += uncommitted.added;
  linesRemoved += uncommitted.removed;
  for (const f of uncommitted.files) allFiles.add(f);

  return { commits, linesAdded, linesRemoved, filesTouched: allFiles.size };
}

// Stats for every repo the session watches, summed. Files are counted per repo
// and added up — two repos can hold the same relative path without it being the
// same file, so there is nothing to de-duplicate across them.
export function getReposDiffStats(repos: RepoBaseline[]): GitDiffStats {
  const total: GitDiffStats = { commits: 0, linesAdded: 0, linesRemoved: 0, filesTouched: 0 };
  for (const repo of repos) {
    const stats = getDiffStats(repo.startSha, getHeadSha(repo.path), repo.path);
    total.commits += stats.commits;
    total.linesAdded += stats.linesAdded;
    total.linesRemoved += stats.linesRemoved;
    total.filesTouched += stats.filesTouched;
  }
  return total;
}
