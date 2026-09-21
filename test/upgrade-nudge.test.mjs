import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';

const scratch = mkdtempSync(join(tmpdir(), 'vibe-nudge-'));
process.env.VIBE_DIR = scratch;
delete process.env.VIBE_SESSION;

// Every response carries the header, which is how the real server behaves.
const server = createServer((req, res) => {
  res.setHeader('x-cli-recommended-version', '9.9.9');
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ pollIntervalMs: 30_000, inProgressSubmitIntervalMs: 300_000, inactivityTimeoutMs: 1_800_000 }));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.VIBE_API = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const CACHE = join(scratch, 'remote-config.json');
const { renderUpgradeNotice } = await import('../dist/render.js');
const { CLI_VERSION } = await import('../dist/api.js');
const MODULE = new URL('../dist/remote-config.js', import.meta.url).href;

// `vibe status` is a fresh process that makes no request, which is the whole
// point: an in-memory value is null exactly where it would be displayed. Asking
// in-process would instead read whatever an earlier request left behind.
function upgradeInFreshProcess(dir) {
  const script = `
    process.env.VIBE_DIR = ${JSON.stringify(dir)};
    delete process.env.VIBE_API;
    const { recommendedUpgrade } = await import(${JSON.stringify(MODULE)});
    process.stdout.write(String(recommendedUpgrade()));
  `;
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf-8' });
}

const writeCache = (extra) => writeFileSync(CACHE, JSON.stringify({
  pollIntervalMs: 30_000, inProgressSubmitIntervalMs: 300_000, inactivityTimeoutMs: 1_800_000,
  fetchedAt: new Date().toISOString(), ...extra,
}, null, 2) + '\n');

test('a refresh persists the recommended version it was told about', async () => {
  if (existsSync(CACHE)) writeFileSync(CACHE, '{}');
  const { refreshTunables } = await import(`../dist/remote-config.js?nudge=persist`);
  await refreshTunables();
  const cached = JSON.parse(readFileSync(CACHE, 'utf-8'));
  assert.equal(cached.recommendedVersion, '9.9.9',
    'without this the header is known only to the process that made the request');
});

// The bug. A desktop session runs through hooks, whose stdout the editor owns,
// and `vibe status` makes no request at all.
test('a process that made no request still reports the upgrade', () => {
  writeCache({ recommendedVersion: '9.9.9' });
  assert.equal(upgradeInFreshProcess(scratch), '9.9.9');
});

test('it stops once you are on that version, with no cache to invalidate', () => {
  writeCache({ recommendedVersion: CLI_VERSION });
  assert.equal(upgradeInFreshProcess(scratch), 'null', 'the stored version is no longer newer');
});

test('an older stored version never nags', () => {
  writeCache({ recommendedVersion: '0.0.1' });
  assert.equal(upgradeInFreshProcess(scratch), 'null');
});

test('nothing stored means nothing to say', () => {
  writeCache({});
  assert.equal(upgradeInFreshProcess(scratch), 'null');
});

test('a garbage cache value cannot reach the notice', () => {
  writeCache({ recommendedVersion: { not: 'a string' } });
  assert.equal(upgradeInFreshProcess(scratch), 'null');
});

test('a corrupt cache file is survivable', () => {
  writeFileSync(CACHE, 'not json at all');
  assert.equal(upgradeInFreshProcess(scratch), 'null');
});

test('the notice names the version and the command', () => {
  const out = renderUpgradeNotice('9.9.9');
  assert.match(out, /9\.9\.9/);
  assert.match(out, /npm i -g vibetime-cli/);
});
