import { execSync } from 'node:child_process';
import { basename } from 'node:path';

const SHA_RE = /^[0-9a-f]{4,40}$/;

const GIT_TIMEOUT_MS = 3_000;

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
