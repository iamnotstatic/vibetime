import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, linkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { VIBE_DIR, ensureVibeDir } from './config.js';

const SALT_PATH = join(VIBE_DIR, 'fingerprint-salt');

// Branch names are low entropy: an unsalted sha256('main') is identical for
// everyone and reverses with a dictionary, which is a branch name with extra
// steps. This never leaves the machine. Cached so a read-only ~/.vibe still
// gives stable answers for the life of the process.
let cached: string | null = null;

function readSalt(): string | null {
  try {
    const existing = readFileSync(SALT_PATH, 'utf-8').trim();
    return existing.length >= 32 ? existing : null;
  } catch {
    return null;
  }
}

// Parallel hook processes reach this together on a cold install, and the whole
// point of the fingerprint is telling their sessions apart. Minting one salt
// each would give one branch a different answer per process, which is worse
// than not having the field. link() is atomic and fails if the name is taken,
// so exactly one writer wins and the rest adopt its salt; writing the content
// before linking means nobody can read a half-written file.
function salt(): string {
  if (cached) return cached;

  const existing = readSalt();
  if (existing) return (cached = existing);

  const fresh = randomBytes(32).toString('hex');
  const tmp = `${SALT_PATH}.${process.pid}.tmp`;
  try {
    ensureVibeDir();
    writeFileSync(tmp, fresh + '\n', { mode: 0o600 });
    try {
      linkSync(tmp, SALT_PATH);
      return (cached = fresh);
    } catch {
      const winner = readSalt();
      if (winner) return (cached = winner);
      // The name is taken by something unusable (truncated, half-written,
      // edited), which would otherwise hold it forever and hand every process a
      // different answer. Only ever removed once it has been read and rejected,
      // so a salt another process just wrote is never destroyed.
      // Several processes can reach this together and each replace the other's
      // repair, so the last step reads back rather than trusting our own write:
      // whatever ends up on disk is what everyone converges on.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          unlinkSync(SALT_PATH);
          linkSync(tmp, SALT_PATH);
        } catch {}
        const repaired = readSalt();
        if (repaired) return (cached = repaired);
      }
      return (cached = readSalt() ?? fresh);
    } finally {
      try { unlinkSync(tmp); } catch {}
    }
  } catch {
    return (cached = readSalt() ?? fresh);
  }
}

// Comparable only against this machine's own sessions, which is all the
// same-branch-or-not question needs.
export function branchFingerprint(branch: string): string {
  if (!branch || branch === 'unknown') return '';
  return createHash('sha256').update(salt()).update('\0').update(branch).digest('hex').slice(0, 16);
}
