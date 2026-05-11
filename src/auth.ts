import { join } from 'node:path';
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import open from 'open';
import { VIBE_DIR, ensureVibeDir } from './config.js';
import { request, GITHUB_CLIENT_ID, ApiError } from './api.js';
import { renderLoginPrompt } from './render.js';
import chalk from 'chalk';
import { PURPLE } from './colors.js';

const RED = chalk.hex('#EF4444');

export const AUTH_PATH = join(VIBE_DIR, 'auth.json');

export interface AuthRecord {
  jwt: string;
  handle: string;
  avatarUrl: string | null;
  issuedAt: string;
}

export function clearAuth(): void {
  try { unlinkSync(AUTH_PATH); } catch {}
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
  handle: string;
  avatarUrl: string | null;
}

export function readAuth(): AuthRecord | null {
  if (!existsSync(AUTH_PATH)) return null;
  try {
    return JSON.parse(readFileSync(AUTH_PATH, 'utf-8')) as AuthRecord;
  } catch {
    return null;
  }
}

function writeAuth(record: AuthRecord): void {
  ensureVibeDir();
  writeFileSync(AUTH_PATH, JSON.stringify(record, null, 2) + '\n');
  chmodSync(AUTH_PATH, 0o600);
}

export async function login(): Promise<void> {
  let device: DeviceCodeResponse;
  try {
    device = await request<DeviceCodeResponse>('https://github.com/login/device/code', {
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
      res = await request<PollResponse>('https://github.com/login/oauth/access_token', {
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

export function logout(): void {
  if (!existsSync(AUTH_PATH)) {
    console.log(`\n  ${PURPLE('◆')} not logged in\n`);
    return;
  }
  unlinkSync(AUTH_PATH);
  console.log(`\n  ${PURPLE('◆')} logged out\n`);
}
