// Forge verification, off unless the user turns it on with
// `vibe config set forge <host>`. When on, a session whose repo is pushed to
// that forge also sends vibetime's own server the forge repo and the raw shas
// of the commits it was credited with, so the server can ask the forge to
// check them. Nothing here talks to the forge: the only request is the normal
// submit to the vibetime API.

import { execFileSync } from 'node:child_process';
import type { Session } from './db.js';

const MAX_COMMITS = 64;
const SHA_RE = /^[0-9a-f]{40}$/i;
const HOST_RE = /^[a-z0-9.-]+(?::\d{1,5})?$/i;

export interface ForgeClaim {
  host: string;
  owner: string;
  repo: string;
  commits: string[];
}

export function validForgeHost(host: string): boolean {
  return HOST_RE.test(host);
}

interface ForgeRepo {
  dir: string;
  owner: string;
  repo: string;
}

// Only `origin` counts: it is the remote that carries the pushes the forge sees.
function forgeRepos(session: Session, host: string): ForgeRepo[] {
  const dirs = (session.repos ?? []).map((r) => r.path).filter(Boolean);
  if (dirs.length === 0 && session.project) dirs.push(session.project);
  const h = host.replace(/[.]/g, '\\.');
  const https = new RegExp(`^https?://${h}/([^/]+)/([^/]+?)(?:\\.git)?/?$`, 'i');
  const ssh = new RegExp(`^git@${h}:([^/]+)/([^/]+?)(?:\\.git)?$`, 'i');
  const out: ForgeRepo[] = [];
  for (const dir of dirs) {
    let url: string;
    try {
      url = execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      continue;
    }
    const m = url.match(https) ?? url.match(ssh);
    if (m) out.push({ dir, owner: m[1], repo: m[2] });
  }
  return out;
}

function hasCommit(dir: string, sha: string): boolean {
  try {
    execFileSync('git', ['-C', dir, 'cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// commitFacts span every repo a session watched, and the forge rejects a claim
// naming a commit it cannot find, so only the repo holding the most of them is
// claimed, with just the commits it holds.
export function forgeClaim(session: Session, host: string | undefined): ForgeClaim | null {
  if (!host || !session.commitFacts?.length) return null;
  const shas = session.commitFacts.map((f) => f.sha).filter((sha) => SHA_RE.test(sha));
  let best: ForgeClaim | null = null;
  for (const target of forgeRepos(session, host)) {
    const commits = shas.filter((sha) => hasCommit(target.dir, sha)).slice(0, MAX_COMMITS);
    if (commits.length > 0 && (!best || commits.length > best.commits.length)) {
      best = { host: host.toLowerCase(), owner: target.owner, repo: target.repo, commits };
    }
  }
  return best;
}
