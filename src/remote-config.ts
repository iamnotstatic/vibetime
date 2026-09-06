import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { VIBE_DIR, ensureVibeDir } from './config.js';
import { request } from './api.js';

export interface Tunables {
  pollIntervalMs: number;
  inProgressSubmitIntervalMs: number;
  inactivityTimeoutMs: number;
}

// Baked-in values, used whenever the server has never been reached. These must
// stay safe to run forever: an installed CLI that never updates and never gets
// a config fetch through still behaves exactly like v0.6.
const DEFAULTS: Tunables = {
  pollIntervalMs: 30_000,
  inProgressSubmitIntervalMs: 5 * 60_000,
  inactivityTimeoutMs: 30 * 60 * 1000,
};

// Server values are clamped so a bad deploy (or a compromised response) can't
// brick installed clients: no 1ms poll loops, no 1-second idle timeouts that
// zero every session.
const CLAMPS: Record<keyof Tunables, [number, number]> = {
  pollIntervalMs: [5_000, 5 * 60_000],
  inProgressSubmitIntervalMs: [60_000, 60 * 60_000],
  inactivityTimeoutMs: [5 * 60_000, 4 * 60 * 60 * 1000],
};

const CACHE_PATH = join(VIBE_DIR, 'remote-config.json');
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

function clamp(key: keyof Tunables, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULTS[key];
  const [lo, hi] = CLAMPS[key];
  return Math.min(Math.max(Math.round(value), lo), hi);
}

// Read once at module load: every consumer (wrapper poller, hook engine,
// reaper, grace rescore) sees the same values for the life of the process.
// Hook processes must never fetch — codex gives session-end hooks 3 seconds —
// so this is a local file read only; refreshTunables() below does the network.
function load(): Tunables & { fetchedAt?: string } {
  if (!existsSync(CACHE_PATH)) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(readFileSync(CACHE_PATH, 'utf-8')) as Partial<Tunables> & { fetchedAt?: string };
    return {
      pollIntervalMs: clamp('pollIntervalMs', raw.pollIntervalMs),
      inProgressSubmitIntervalMs: clamp('inProgressSubmitIntervalMs', raw.inProgressSubmitIntervalMs),
      inactivityTimeoutMs: clamp('inactivityTimeoutMs', raw.inactivityTimeoutMs),
      fetchedAt: raw.fetchedAt,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

const loaded = load();

export const TUNABLES: Tunables = {
  pollIntervalMs: loaded.pollIntervalMs,
  inProgressSubmitIntervalMs: loaded.inProgressSubmitIntervalMs,
  inactivityTimeoutMs: loaded.inactivityTimeoutMs,
};

// Fire-and-forget refresh for contexts that can afford network (the wrapper at
// session start). Skips when the cache is fresh; failures leave the cache as
// is. New values apply to the NEXT process, never mid-session.
export async function refreshTunables(): Promise<void> {
  if (loaded.fetchedAt && Date.now() - Date.parse(loaded.fetchedAt) < STALE_AFTER_MS) return;
  try {
    const fetched = await request<Partial<Tunables>>('/config', { timeoutMs: 3000 });
    ensureVibeDir();
    writeFileSync(CACHE_PATH, JSON.stringify({
      pollIntervalMs: clamp('pollIntervalMs', fetched.pollIntervalMs),
      inProgressSubmitIntervalMs: clamp('inProgressSubmitIntervalMs', fetched.inProgressSubmitIntervalMs),
      inactivityTimeoutMs: clamp('inactivityTimeoutMs', fetched.inactivityTimeoutMs),
      fetchedAt: new Date().toISOString(),
    }, null, 2) + '\n');
  } catch {}
}
