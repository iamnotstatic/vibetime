import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const scratch = mkdtempSync(join(tmpdir(), 'vibe-fp-'));
process.env.VIBE_DIR = scratch;
delete process.env.VIBE_SESSION;

const { branchFingerprint } = await import('../dist/fingerprint.js');

// VIBE_DIR is read at import time, so a second install means a second process.
function fingerprintIn(dir, branch) {
  const script = `
    process.env.VIBE_DIR = ${JSON.stringify(dir)};
    const { branchFingerprint } = await import(${JSON.stringify(new URL('../dist/fingerprint.js', import.meta.url).href)});
    process.stdout.write(branchFingerprint(${JSON.stringify(branch)}));
  `;
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf-8' });
}

// Parallel hook processes hit a cold install together, which is precisely when
// the fingerprint has to be right. Each spins to a shared wall-clock instant:
// without the barrier, node's staggered startup lets the first writer finish
// and the race passes by luck. It raced 6/6 before the salt was written with
// link(), which fails rather than overwrites.
test('simultaneous first runs agree on one salt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vibe-fp-race-'));
  const startAt = Date.now() + 700;
  const script = `
    process.env.VIBE_DIR = ${JSON.stringify(dir)};
    const { branchFingerprint } = await import(${JSON.stringify(new URL('../dist/fingerprint.js', import.meta.url).href)});
    while (Date.now() < ${startAt}) {}
    process.stdout.write(branchFingerprint('main'));
  `;
  const kids = Array.from({ length: 6 }, () =>
    spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'ignore'] }));

  const out = kids.map((k) => new Promise((resolve) => {
    let buf = '';
    k.stdout.on('data', (c) => { buf += c; });
    k.on('close', () => resolve(buf));
  }));

  return Promise.all(out).then((results) => {
    assert.equal(new Set(results).size, 1,
      `one branch must have one fingerprint, got ${[...new Set(results)].join(' ')}`);
  });
});

test('the same branch always fingerprints the same way', () => {
  assert.equal(branchFingerprint('main'), branchFingerprint('main'));
  assert.match(branchFingerprint('main'), /^[0-9a-f]{16}$/);
});

test('different branches fingerprint differently', () => {
  const seen = new Set(['main', 'develop', 'feature/a', 'feature/b'].map(branchFingerprint));
  assert.equal(seen.size, 4, 'four branches must be four fingerprints');
});

test('no branch produces no fingerprint', () => {
  assert.equal(branchFingerprint(''), '');
  // Non-git sessions record the literal string 'unknown', which is not a branch.
  assert.equal(branchFingerprint('unknown'), '');
});

// The point of the salt. Without it, sha256('main') is the same everywhere and
// a one-line dictionary turns the field back into a branch name.
test('the same branch on another machine fingerprints differently', () => {
  const other = mkdtempSync(join(tmpdir(), 'vibe-fp-other-'));
  assert.notEqual(fingerprintIn(scratch, 'main'), fingerprintIn(other, 'main'));
});

test('a machine keeps its salt across processes', () => {
  assert.equal(fingerprintIn(scratch, 'release/1.2'), fingerprintIn(scratch, 'release/1.2'));
});

test('the salt is stored private and never in the payload', async () => {
  branchFingerprint('main');
  const saltPath = join(scratch, 'fingerprint-salt');
  assert.ok(existsSync(saltPath), 'salt is persisted so fingerprints survive a restart');
  assert.equal(statSync(saltPath).mode & 0o777, 0o600, 'owner-only');

  const salt = readFileSync(saltPath, 'utf-8').trim();
  assert.ok(salt.length >= 32);

  const { readFileSync: read } = await import('node:fs');
  const submit = read(new URL('../src/submit.ts', import.meta.url), 'utf-8');
  assert.doesNotMatch(submit, /\bbranch:\s*s\.branch\b/, 'the raw branch name must never be sent');
  assert.match(submit, /branchHash/, 'the fingerprint is what goes');
});
