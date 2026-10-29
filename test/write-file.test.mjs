import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync, lstatSync, statSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const { writeFileAtomic } = await import('../dist/write-file.js');
const moduleUrl = new URL('../dist/write-file.js', import.meta.url).href;

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vibe-write-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Two apps rewriting one settings file while a third reads it: a large body
// and small ones, the shape that left ~/.claude/settings.json a short object
// followed by the tail of a long one, which Claude Code then refused to load.
// Every process spins to one wall-clock instant first, or node's staggered
// startup serializes them and the race never happens.
test('a reader never sees a torn or half-written file while writers race', async (t) => {
  const path = join(scratch(t), 'settings.json');
  writeFileSync(path, '{}\n');
  const startAt = Date.now() + 1500;
  const run = (script) => new Promise((resolve, reject) => {
    let out = '';
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('exit', () => resolve(out));
  });

  const writers = Array.from({ length: 6 }, (_, i) => {
    // Built in the child: Linux caps a single argv entry at 128 KB.
    const size = i % 2 ? 200_000 : 100;
    return run(`
      const { writeFileAtomic } = await import(${JSON.stringify(moduleUrl)});
      const body = (n) => JSON.stringify({ writer: ${i}, n, pad: 'x'.repeat(${size}) }) + '\\n';
      while (Date.now() < ${startAt}) {}
      for (let n = 0; n < 60; n++) writeFileAtomic(${JSON.stringify(path)}, body(n));
    `);
  });
  const reader = run(`
    const { readFileSync } = await import('node:fs');
    while (Date.now() < ${startAt}) {}
    let bad = 0;
    while (Date.now() < ${startAt} + 1500) {
      try { JSON.parse(readFileSync(${JSON.stringify(path)}, 'utf-8')); } catch { bad++; }
    }
    process.stdout.write(String(bad));
  `);
  const [badReads] = await Promise.all([reader, ...writers]);

  assert.equal(badReads, '0');
  assert.ok(Number.isInteger(JSON.parse(readFileSync(path, 'utf-8')).writer));
});

test('a symlinked file stays a symlink and keeps its mode', (t) => {
  const dir = scratch(t);
  const real = join(dir, 'dotfiles-settings.json');
  const link = join(dir, 'settings.json');
  writeFileSync(real, '{}\n');
  chmodSync(real, 0o600);
  symlinkSync(real, link);

  writeFileAtomic(link, '{"a":1}\n');

  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(readFileSync(real, 'utf-8'), '{"a":1}\n');
  assert.equal(statSync(real).mode & 0o777, 0o600);
});

test('identical content is not rewritten', (t) => {
  const path = join(scratch(t), 'settings.json');
  writeFileSync(path, '{"a":1}\n');
  const before = statSync(path).ino;

  writeFileAtomic(path, '{"a":1}\n');

  assert.equal(statSync(path).ino, before);
});

test('a dangling symlink stays a link and its target is created', (t) => {
  const dir = scratch(t);
  const link = join(dir, 'settings.json');
  symlinkSync(join(dir, 'dotfiles', '..', 'real.json'), link);

  writeFileAtomic(link, '{}\n');

  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(readFileSync(join(dir, 'real.json'), 'utf-8'), '{}\n');
});

test('a writable file in a folder we cannot create files in is still written', (t) => {
  const dir = scratch(t);
  const path = join(dir, 'settings.json');
  writeFileSync(path, '{}\n');
  chmodSync(dir, 0o555);
  try {
    writeFileAtomic(path, '{"a":1}\n');
  } finally {
    chmodSync(dir, 0o755);
  }

  assert.equal(readFileSync(path, 'utf-8'), '{"a":1}\n');
});

test('an unreadable file keeps its mode', (t) => {
  const path = join(scratch(t), 'settings.json');
  writeFileSync(path, '{}\n');
  chmodSync(path, 0o200);

  writeFileAtomic(path, '{"a":1}\n');

  assert.equal(statSync(path).mode & 0o777, 0o200);
});
