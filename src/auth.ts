import { join } from 'node:path';
import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import open from 'open';
import { createInterface } from 'node:readline';
import { VIBE_DIR, ensureVibeDir } from './config.js';
import { request, GITHUB_CLIENT_ID, GITHUB_BASE, ApiError } from './api.js';
import { renderLoginPrompt, renderLoginOffer, renderLoginSkipped } from './render.js';
import chalk from 'chalk';
import { PURPLE } from './colors.js';

const RED = chalk.hex('#EF4444');
const DIM = chalk.hex('#444444');

export const AUTH_PATH = join(VIBE_DIR, 'auth.json');

export interface AuthRecord {
  jwt: string;
  handle: string;
  avatarUrl: string | null;
  issuedAt: string;
  // Absent on logins from pre-v0.7 CLIs; those carry a long-lived jwt instead
  // and fall back to a fresh login when it eventually expires.
  refreshToken?: string;
  // Set when the server rejected this credential for good. The record stays on
  // disk, minus the secrets, so `vibe status` and the endcard can say you are
  // signed out. Deleting it made a broken login indistinguishable from never
  // having logged in, which is how a week of submissions failed in silence.
  signedOutAt?: string;
}

function readRecord(): AuthRecord | null {
  if (!existsSync(AUTH_PATH)) return null;
  try {
    return JSON.parse(readFileSync(AUTH_PATH, 'utf-8')) as AuthRecord;
  } catch {
    return null;
  }
}

// True when the user was signed in and the server since rejected them: the one
// state worth interrupting the endcard for, because their work stopped counting
// and only they can fix it.
export function needsLogin(): boolean {
  return !!readRecord()?.signedOutAt;
}

export function markSignedOut(): void {
  const record = readRecord();
  if (!record || record.signedOutAt) return;
  writeAuth({
    jwt: '',
    handle: record.handle,
    avatarUrl: record.avatarUrl,
    issuedAt: record.issuedAt,
    signedOutAt: new Date().toISOString(),
  });
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface PollResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface ExchangeResponse {
  jwt: string;
  refreshToken?: string;
  handle: string;
  avatarUrl: string | null;
}

function jwtPayload(jwt: string): { exp?: number; sub?: number | string } | null {
  try {
    const body = jwt.split('.')[1];
    const pad = body.length % 4 === 0 ? '' : '='.repeat(4 - (body.length % 4));
    return JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf-8'));
  } catch {
    return null;
  }
}

// Seconds-precision exp claim from the jwt body, without verifying (the server
// verifies; the client only needs it to know when to renew).
export function jwtExpiresAtMs(jwt: string): number | null {
  const exp = jwtPayload(jwt)?.exp;
  return typeof exp === 'number' ? exp * 1000 : null;
}

// A GitHub noreply address is exactly <id>+<handle>@..., and login already
// stored both halves: the jwt `sub` is the id. Empty means signed out, which
// callers read as "do not filter" rather than "match nothing".
export function commitIdentities(): string[] {
  const record = readAuth();
  if (!record?.handle) return [];

  const identities = [`${record.handle}@users.noreply.github.com`];
  const sub = jwtPayload(record.jwt)?.sub;
  if (sub !== undefined && sub !== null && String(sub).length > 0) {
    identities.unshift(`${sub}+${record.handle}@users.noreply.github.com`);
  }
  return identities;
}

// Swap the refresh token for a fresh access jwt. Returns the record to use:
// the renewed one on success, the existing one when the server is unreachable
// (the old jwt may still be valid), or null when the server rejects the
// refresh token: auth is dead, and the record is marked signed out so the next
// endcard can say so.
export async function refreshAuth(auth: AuthRecord, timeoutMs = 3000): Promise<AuthRecord | null> {
  if (!auth.refreshToken) return auth;
  try {
    const renewed = await request<ExchangeResponse>('/auth/refresh', {
      method: 'POST',
      body: { refresh_token: auth.refreshToken },
      timeoutMs,
    });
    const record: AuthRecord = {
      jwt: renewed.jwt,
      handle: renewed.handle,
      avatarUrl: renewed.avatarUrl,
      issuedAt: new Date().toISOString(),
      refreshToken: auth.refreshToken,
    };
    writeAuth(record);
    return record;
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 400)) {
      markSignedOut();
      return null;
    }
    return auth;
  }
}

// Usable credentials only: a signed-out record reads as no auth, so every
// submit path skips it exactly as it did when the file was deleted.
export function readAuth(): AuthRecord | null {
  const record = readRecord();
  return record && !record.signedOutAt ? record : null;
}

function writeAuth(record: AuthRecord): void {
  ensureVibeDir();
  // Write-then-rename: background flushes in the wrapper and hook processes
  // rewrite this file on renewal, and a torn concurrent write would read as
  // logged-out forever. Rename makes the swap atomic, like sessions.json.
  const tmp = `${AUTH_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, AUTH_PATH);
  chmodSync(AUTH_PATH, 0o600);
}

// Offer the leaderboard once setup finishes. Deliberately an offer, not an
// action: tracking works without an account, and the device flow polls GitHub
// for up to fifteen minutes, so it must never start on its own.
//
// Skipped entirely when already signed in, when stdin is not a terminal (a
// script, a pipe, CI — none of which can answer and none of which may hang),
// and when the answer is no.
// The stream is a parameter so the blocking path is testable; a hang here would
// stall someone's terminal and no smoke test would catch it.
export async function offerLogin(input: NodeJS.ReadStream = process.stdin): Promise<void> {
  if (readAuth() || needsLogin()) return;
  if (!input.isTTY) return;

  const answer = await ask(`${renderLoginOffer()} ${DIM('[Y/n]')} `, input);
  if (answer.trim().toLowerCase().startsWith('n')) {
    console.log(renderLoginSkipped());
    return;
  }
  await login();
}

function ask(question: string, input: NodeJS.ReadStream): Promise<string> {
  const rl = createInterface({ input, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`\n${question}`, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export async function login(): Promise<void> {
  let device: DeviceCodeResponse;
  try {
    device = await request<DeviceCodeResponse>(`${GITHUB_BASE}/login/device/code`, {
      method: 'POST',
      body: { client_id: GITHUB_CLIENT_ID, scope: 'read:user' },
      headers: { accept: 'application/json' },
      timeoutMs: 10_000,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown error';
    console.log(`\n  ${RED('✗')} vibe: could not reach github (${msg})\n`);
    return;
  }

  const verificationUrl = `${device.verification_uri}?user_code=${encodeURIComponent(device.user_code)}`;
  console.log(renderLoginPrompt(device.user_code, verificationUrl));

  // try to open the browser to the prefilled approval URL; silently fall back to the printed link
  open(verificationUrl).catch(() => {});

  const accessToken = await pollGithub(device);
  if (!accessToken) {
    console.log(`  ${RED('✗')} vibe: login timed out or was denied\n`);
    return;
  }

  let exchanged: ExchangeResponse;
  try {
    exchanged = await request<ExchangeResponse>('/auth/exchange', {
      method: 'POST',
      body: { github_access_token: accessToken },
      timeoutMs: 10_000,
    });
  } catch (e) {
    const msg = e instanceof ApiError ? e.message : (e instanceof Error ? e.message : 'unknown error');
    console.log(`  ${RED('✗')} vibe: server rejected login (${msg})\n`);
    return;
  }

  writeAuth({
    jwt: exchanged.jwt,
    handle: exchanged.handle,
    avatarUrl: exchanged.avatarUrl,
    issuedAt: new Date().toISOString(),
    refreshToken: exchanged.refreshToken,
  });
  console.log(`  ${PURPLE('◆')} logged in as ${PURPLE('@' + exchanged.handle)}\n`);
}

async function pollGithub(device: DeviceCodeResponse): Promise<string | null> {
  const deadline = Date.now() + device.expires_in * 1000;
  let interval = Math.max(device.interval, 5);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    let res: PollResponse;
    try {
      res = await request<PollResponse>(`${GITHUB_BASE}/login/oauth/access_token`, {
        method: 'POST',
        body: {
          client_id: GITHUB_CLIENT_ID,
          device_code: device.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        },
        headers: { accept: 'application/json' },
        timeoutMs: 10_000,
      });
    } catch {
      continue;
    }
    if (res.access_token) return res.access_token;
    if (res.error === 'slow_down') interval += 5;
    else if (res.error === 'access_denied' || res.error === 'expired_token') return null;
  }
  return null;
}

export async function logout(): Promise<void> {
  if (!existsSync(AUTH_PATH)) {
    console.log(`\n  ${PURPLE('◆')} not logged in\n`);
    return;
  }
  // Best-effort server-side revocation so the refresh token can't be reused;
  // local logout succeeds regardless.
  const auth = readRecord();
  if (auth?.refreshToken) {
    await request('/auth/logout', {
      method: 'POST',
      body: { refresh_token: auth.refreshToken },
      timeoutMs: 3000,
    }).catch(() => {});
  }
  unlinkSync(AUTH_PATH);
  console.log(`\n  ${PURPLE('◆')} logged out\n`);
}
