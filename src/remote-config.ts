import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { VIBE_DIR, ensureVibeDir } from './config.js';
import { request, getRecommendedVersion, isNewerVersion, CLI_VERSION } from './api.js';

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
// This is a local file read only, so it is safe on any path; refreshTunables()
// below does the network, and a hook may only call it where the event's
// timeout allows (session-start and activity get 10s, but codex caps
// session-end at 3s, so that path stays local).
function load(): Tunables & { fetchedAt?: string; recommendedVersion?: string } {
  if (!existsSync(CACHE_PATH)) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(readFileSync(CACHE_PATH, 'utf-8')) as Partial<Tunables> & { fetchedAt?: string; recommendedVersion?: string };
    return {
      pollIntervalMs: clamp('pollIntervalMs', raw.pollIntervalMs),
      inProgressSubmitIntervalMs: clamp('inProgressSubmitIntervalMs', raw.inProgressSubmitIntervalMs),
      inactivityTimeoutMs: clamp('inactivityTimeoutMs', raw.inactivityTimeoutMs),
      fetchedAt: raw.fetchedAt,
      recommendedVersion: typeof raw.recommendedVersion === 'string' ? raw.recommendedVersion : undefined,
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

// Skips when the cache is fresh; failures leave the cache as is. New values
// apply to the NEXT process, never mid-session. The wrapper fires and forgets
// because it outlives the request; a hook process exits immediately, so it
// awaits this with a budget small enough to sit inside the editor's timeout.
export async function refreshTunables(timeoutMs = 3000): Promise<void> {
  if (loaded.fetchedAt && Date.now() - Date.parse(loaded.fetchedAt) < STALE_AFTER_MS) return;
  try {
    const fetched = await request<Partial<Tunables>>('/config', { timeoutMs });
    ensureVibeDir();
    writeFileSync(CACHE_PATH, JSON.stringify({
      pollIntervalMs: clamp('pollIntervalMs', fetched.pollIntervalMs),
      inProgressSubmitIntervalMs: clamp('inProgressSubmitIntervalMs', fetched.inProgressSubmitIntervalMs),
      inactivityTimeoutMs: clamp('inactivityTimeoutMs', fetched.inactivityTimeoutMs),
      fetchedAt: new Date().toISOString(),
      // Persisted so a process that made no request can still report it. The
      // header only reaches whichever process happened to call the server, and
      // on the desktop path that is a hook whose stdout belongs to the editor.
      ...(getRecommendedVersion() ? { recommendedVersion: getRecommendedVersion() } : {}),
    }, null, 2) + '\n');
  } catch {}
}

// A newer CLI than this one, or null. Live value first, because a long-running
// wrapper learns of a release mid-session; otherwise the last one any process
// on this machine was told about.
//
// Comparing against CLI_VERSION on read is what makes it self-clearing: after
// an upgrade the stored value stops being newer and the nudge stops, with no
// cache to invalidate.
export function recommendedUpgrade(): string | null {
  const live = getRecommendedVersion();
  if (live) return live;
  const stored = loaded.recommendedVersion;
  return stored && isNewerVersion(stored, CLI_VERSION) ? stored : null;
}
