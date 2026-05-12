import { createRequire } from 'node:module';

export const API_BASE = process.env.VIBE_API ?? 'https://api.vibetime.club';

export const WEB_BASE = process.env.VIBE_WEB ?? 'https://vibetime.club';

export const GITHUB_CLIENT_ID = process.env.VIBE_GITHUB_CLIENT_ID ?? 'Ov23liTitygBey3l86qT';

const require = createRequire(import.meta.url);
export const CLI_VERSION: string = require('../package.json').version;

let recommendedVersion: string | null = null;

export function getRecommendedVersion(): string | null {
  return recommendedVersion;
}

function isNewerVersion(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  return false;
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  baseUrl?: string;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const base = opts.baseUrl ?? API_BASE;
  const url = path.startsWith('http') ? path : `${base}${path}`;
  const init: RequestInit = {
    method: opts.method ?? 'GET',
    headers: {
      'accept': 'application/json',
      'user-agent': `vibetime-cli/${CLI_VERSION}`,
      'x-cli-version': CLI_VERSION,
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.headers ?? {}),
    },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
  };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

  const res = await fetch(url, init);
  const recommended = res.headers.get('x-cli-recommended-version');
  if (recommended && isNewerVersion(recommended, CLI_VERSION)) {
    recommendedVersion = recommended;
  }
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  if (!res.ok) {
    const msg = (parsed && typeof parsed === 'object' && 'error' in parsed && typeof (parsed as { error: unknown }).error === 'string')
      ? (parsed as { error: string }).error
      : `request failed (${res.status})`;
    throw new ApiError(res.status, msg);
  }
  return parsed as T;
}
