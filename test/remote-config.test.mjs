import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

// Both VIBE_DIR and VIBE_API are read at module load time in dist, so the
// scratch dir and the stub server must exist before the first dist import.
// Tests that need a different cache state re-import remote-config with a
// cache-busting query so its load() runs again (api.js stays loaded, which is
// fine: API_BASE points at the stub for the whole file).
const scratch = mkdtempSync(join(tmpdir(), 'vibe-remote-config-'));
process.env.VIBE_DIR = scratch;
delete process.env.VIBE_SESSION;

let hits = 0;
const server = createServer((req, res) => {
  hits++;
  assert.equal(req.url, '/config');
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ pollIntervalMs: 45_000, inProgressSubmitIntervalMs: 999, inactivityTimeoutMs: 3_600_000 }));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.VIBE_API = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const CACHE = join(scratch, 'remote-config.json');
let importSeq = 0;
async function freshModule() {
  return import(`../dist/remote-config.js?seq=${importSeq++}`);
}

test('defaults apply when no cache exists', async () => {
  const { TUNABLES } = await freshModule();
  assert.equal(TUNABLES.pollIntervalMs, 30_000);
  assert.equal(TUNABLES.inProgressSubmitIntervalMs, 300_000);
  assert.equal(TUNABLES.inactivityTimeoutMs, 1_800_000);
});

test('cached values are used, absurd ones are clamped', async () => {
  writeFileSync(CACHE, JSON.stringify({
    pollIntervalMs: 60_000,          // valid, kept
    inProgressSubmitIntervalMs: 1,   // absurd, clamped up
    inactivityTimeoutMs: 1e12,       // absurd, clamped down
    fetchedAt: new Date().toISOString(),
  }));
  const { TUNABLES } = await freshModule();
  assert.equal(TUNABLES.pollIntervalMs, 60_000);
  assert.equal(TUNABLES.inProgressSubmitIntervalMs, 60_000);
  assert.equal(TUNABLES.inactivityTimeoutMs, 4 * 60 * 60 * 1000);
});

test('corrupt cache falls back to defaults', async () => {
  writeFileSync(CACHE, 'not json at all\n');
  const { TUNABLES } = await freshModule();
  assert.equal(TUNABLES.pollIntervalMs, 30_000);
  assert.equal(TUNABLES.inactivityTimeoutMs, 1_800_000);
});

test('refreshTunables fetches, clamps, and writes the cache', async () => {
  writeFileSync(CACHE, JSON.stringify({ fetchedAt: '2020-01-01T00:00:00Z' })); // stale
  const { refreshTunables } = await freshModule();
  await refreshTunables();

  const cached = JSON.parse(readFileSync(CACHE, 'utf-8'));
  assert.equal(cached.pollIntervalMs, 45_000);
  assert.equal(cached.inProgressSubmitIntervalMs, 60_000); // clamped
  assert.equal(cached.inactivityTimeoutMs, 3_600_000);
  assert.ok(cached.fetchedAt > '2025');
});

test('a fresh cache skips the network entirely', async () => {
  writeFileSync(CACHE, JSON.stringify({ pollIntervalMs: 45_000, fetchedAt: new Date().toISOString() }));
  const before = hits;
  const { refreshTunables } = await freshModule();
  await refreshTunables();
  assert.equal(hits, before);
  assert.equal(JSON.parse(readFileSync(CACHE, 'utf-8')).pollIntervalMs, 45_000);
});
