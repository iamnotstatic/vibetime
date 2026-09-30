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
// api.js reads VIBE_API once, so a test that needs a different body changes
// this rather than pointing at another server.
let configExtra = {};
const server = createServer((req, res) => {
  res.setHeader('x-cli-recommended-version', '9.9.9');
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ pollIntervalMs: 30_000, inProgressSubmitIntervalMs: 300_000, inactivityTimeoutMs: 1_800_000, ...configExtra }));
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

// A stripped header, a rollback, or a response naming an older version must
// not erase what we already knew, or the nudge goes quiet until some later
// refresh happens to restore it. The server here never sets the header.
test('a response that names no newer version keeps the one we had', async () => {
  const quiet = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ pollIntervalMs: 30_000, inProgressSubmitIntervalMs: 300_000, inactivityTimeoutMs: 1_800_000 }));
  });
  await new Promise((r) => quiet.listen(0, '127.0.0.1', r));
  const prevApi = process.env.VIBE_API;
  process.env.VIBE_API = `http://127.0.0.1:${quiet.address().port}`;
  try {
    writeCache({ recommendedVersion: '9.9.9', fetchedAt: '2020-01-01T00:00:00Z' });
    const { refreshTunables } = await import(`../dist/remote-config.js?nudge=quiet`);
    await refreshTunables();
    const cached = JSON.parse(readFileSync(CACHE, 'utf-8'));
    assert.notEqual(cached.fetchedAt, '2020-01-01T00:00:00Z', 'the refresh must actually have run');
    assert.equal(cached.recommendedVersion, '9.9.9');
  } finally {
    quiet.close();
    process.env.VIBE_API = prevApi;
  }
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

function reasonInFreshProcess(dir, version) {
  const script = `
    process.env.VIBE_DIR = ${JSON.stringify(dir)};
    delete process.env.VIBE_API;
    const { recommendedUpgradeReason } = await import(${JSON.stringify(MODULE)});
    process.stdout.write(JSON.stringify(recommendedUpgradeReason(${JSON.stringify(version)})));
  `;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf-8' }));
}

test('a refresh persists the reason the server gave for its version', async () => {
  configExtra = { recommended: { version: '9.9.9', reason: 'fixes double-counted ships' } };
  try {
    writeCache({ fetchedAt: '2020-01-01T00:00:00Z' });
    const { refreshTunables } = await import(`../dist/remote-config.js?nudge=reason`);
    await refreshTunables();
    assert.equal(reasonInFreshProcess(scratch, '9.9.9'), 'fixes double-counted ships');
  } finally {
    configExtra = {};
  }
});

test('a reason is only ever shown beside the version it was written for', () => {
  writeCache({ recommendedVersion: '9.9.10', recommended: { version: '9.9.9', reason: 'fixes double-counted ships' } });
  assert.equal(reasonInFreshProcess(scratch, '9.9.10'), null);
});

test('server text cannot move the cursor or recolour the terminal', () => {
  writeCache({ recommendedVersion: '9.9.9', recommended: { version: '9.9.9', reason: '\u001b[2J\u001b[31mfixes\nships\u0007' + 'x'.repeat(200) } });
  const reason = reasonInFreshProcess(scratch, '9.9.9');
  assert.doesNotMatch(reason, /[\u0000-\u001f\u007f-\u009f]/);
  assert.ok(reason.length <= 60, `one line, got ${reason.length} characters`);
});

test('a garbage reason cannot reach the notice', () => {
  for (const recommended of [{ version: '9.9.9', reason: 42 }, { version: '9.9.9', reason: '  \n ' }, 'text', null]) {
    writeCache({ recommendedVersion: '9.9.9', recommended });
    assert.equal(reasonInFreshProcess(scratch, '9.9.9'), null, JSON.stringify(recommended));
  }
});

test('the notice carries the reason between the version and the command', () => {
  const plain = (s) => s.replace(/\u001b\[[0-9;]*m/g, '');
  assert.equal(plain(renderUpgradeNotice('9.9.9', 'fixes double-counted ships')),
    '  ◆ vibe 9.9.9 available · fixes double-counted ships · run npm i -g vibetime-cli\n');
  assert.equal(plain(renderUpgradeNotice('9.9.9')), '  ◆ vibe 9.9.9 available · run npm i -g vibetime-cli\n',
    'without a reason the line is exactly what it was');
});
