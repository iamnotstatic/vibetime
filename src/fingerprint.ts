import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VIBE_DIR, ensureVibeDir } from './config.js';

const SALT_PATH = join(VIBE_DIR, 'fingerprint-salt');

// Branch names are low entropy: an unsalted sha256('main') is identical for
// everyone and reverses with a dictionary, which is a branch name with extra
// steps. This never leaves the machine. Cached so a read-only ~/.vibe still
// gives stable answers for the life of the process.
let cached: string | null = null;

function salt(): string {
  if (cached) return cached;
  try {
    if (existsSync(SALT_PATH)) {
      const existing = readFileSync(SALT_PATH, 'utf-8').trim();
      if (existing.length >= 32) return (cached = existing);
    }
  } catch {}

  const fresh = randomBytes(32).toString('hex');
  try {
    ensureVibeDir();
    writeFileSync(SALT_PATH, fresh + '\n', { mode: 0o600 });
  } catch {}
  return (cached = fresh);
}

// Comparable only against this machine's own sessions, which is all the
// same-branch-or-not question needs.
export function branchFingerprint(branch: string): string {
  if (!branch || branch === 'unknown') return '';
  return createHash('sha256').update(salt()).update('\0').update(branch).digest('hex').slice(0, 16);
}
