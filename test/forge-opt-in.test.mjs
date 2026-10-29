import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

process.env.VIBE_DIR = mkdtempSync(join(tmpdir(), 'vibe-forge-'));
after(() => rmSync(process.env.VIBE_DIR, { recursive: true, force: true }));

const { forgeClaim } = await import('../dist/forge.js');

function repoWithOrigin(t, origin) {
  const dir = mkdtempSync(join(tmpdir(), 'vibe-forge-repo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sh = (cmd) => execSync(cmd, { cwd: dir, stdio: 'pipe', encoding: 'utf8' }).trim();
  sh('git init -qb main');
  sh('git config user.email vibe@test && git config user.name vibe');
  writeFileSync(join(dir, 'a.txt'), `${randomUUID()}\n`);
  sh('git add a.txt && git commit -qm work');
  if (origin) sh(`git remote add origin ${origin}`);
  return { dir, sha: sh('git rev-parse HEAD') };
}

const session = (dir, shas) => ({
  id: randomUUID(), project: dir, repos: [{ path: dir }],
  commitFacts: shas.map((sha) => ({ sha, key: 'k', tree: 't', committedAt: Date.now(), linesAdded: 60, linesRemoved: 0, files: 4 })),
});

test('off by default: no forge configured sends nothing', (t) => {
  const { dir, sha } = repoWithOrigin(t, 'https://forge.example/acme/app.git');
  assert.equal(forgeClaim(session(dir, [sha]), undefined), null);
});

test('opted in: names the forge repo and only commits it holds', (t) => {
  const { dir, sha } = repoWithOrigin(t, 'https://forge.example/acme/app.git');
  const stranger = 'f'.repeat(40);
  assert.deepEqual(forgeClaim(session(dir, [sha, stranger]), 'forge.example'), {
    host: 'forge.example', owner: 'acme', repo: 'app', commits: [sha],
  });
});

test('opted in, but origin is elsewhere: sends nothing', (t) => {
  const { dir, sha } = repoWithOrigin(t, 'https://github.com/acme/app.git');
  assert.equal(forgeClaim(session(dir, [sha]), 'forge.example'), null);
});

test('opted in, no origin: sends nothing', (t) => {
  const { dir, sha } = repoWithOrigin(t, null);
  assert.equal(forgeClaim(session(dir, [sha]), 'forge.example'), null);
});
