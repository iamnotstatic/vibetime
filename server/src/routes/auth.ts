import type { Env } from '../env.js';
import { error, json } from '../http.js';
import { signJwt, b64url } from '../jwt.js';

// Access tokens are short-lived; the CLI renews them via /auth/refresh with a
// long-lived refresh token, which lets us rotate or revoke without forcing a
// re-login. Pre-v0.7 CLIs hold 365-day JWTs; those keep verifying until they
// expire, so this change breaks nobody.
const JWT_TTL_SECONDS = 7 * 24 * 60 * 60;
const REFRESH_TTL_MS = 400 * 24 * 60 * 60 * 1000;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function newRefreshToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return b64url(bytes);
}

interface GithubUser {
  id: number;
  login: string;
  avatar_url: string;
}

export async function exchangeAuth(request: Request, env: Env): Promise<Response> {
  let body: { github_access_token?: unknown };
  try {
    body = (await request.json()) as { github_access_token?: unknown };
  } catch {
    return error(400, 'invalid json');
  }
  const token = body.github_access_token;
  if (typeof token !== 'string' || token.length < 8) return error(400, 'github_access_token required');

  const ghRes = await fetch('https://api.github.com/user', {
    headers: {
      'authorization': `Bearer ${token}`,
      'user-agent': 'vibetime-api',
      'accept': 'application/vnd.github+json',
    },
  });
  if (!ghRes.ok) return error(401, 'github token rejected');
  const gh = (await ghRes.json()) as Partial<GithubUser>;
  if (typeof gh.id !== 'number' || typeof gh.login !== 'string') return error(502, 'unexpected github response');

  // only trust avatar URLs that come from GitHub's CDN — defense against future schema drift
  const avatarUrl = typeof gh.avatar_url === 'string' && /^https:\/\/avatars\.githubusercontent\.com\//.test(gh.avatar_url)
    ? gh.avatar_url
    : null;

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO users (github_id, handle, avatar_url, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(github_id) DO UPDATE SET handle = excluded.handle,
                                          avatar_url = excluded.avatar_url,
                                          last_seen_at = excluded.last_seen_at`,
  ).bind(gh.id, gh.login, avatarUrl, now, now).run();

  const iat = Math.floor(Date.now() / 1000);
  const jwt = await signJwt({ sub: gh.id, handle: gh.login, iat, exp: iat + JWT_TTL_SECONDS }, env.JWT_SECRET);

  const refreshToken = newRefreshToken();
  await env.DB.prepare(
    `INSERT INTO refresh_tokens (token_hash, user_github_id, created_at) VALUES (?, ?, ?)`,
  ).bind(await sha256Hex(refreshToken), gh.id, now).run();

  return json({ jwt, refreshToken, handle: gh.login, avatarUrl });
}

export async function refreshAuth(request: Request, env: Env): Promise<Response> {
  let body: { refresh_token?: unknown };
  try {
    body = (await request.json()) as { refresh_token?: unknown };
  } catch {
    return error(400, 'invalid json');
  }
  const token = body.refresh_token;
  if (typeof token !== 'string' || token.length < 32) return error(400, 'refresh_token required');

  const row = await env.DB.prepare(
    `SELECT rt.user_github_id, rt.created_at, rt.revoked_at, u.handle, u.avatar_url
     FROM refresh_tokens rt JOIN users u ON u.github_id = rt.user_github_id
     WHERE rt.token_hash = ?`,
  ).bind(await sha256Hex(token)).first<{ user_github_id: number; created_at: string; revoked_at: string | null; handle: string; avatar_url: string | null }>();

  if (!row || row.revoked_at !== null) return error(401, 'refresh token invalid');
  if (Date.now() - Date.parse(row.created_at) > REFRESH_TTL_MS) return error(401, 'refresh token expired');

  await env.DB.prepare(
    `UPDATE refresh_tokens SET last_used_at = ? WHERE token_hash = ?`,
  ).bind(new Date().toISOString(), await sha256Hex(token)).run();

  const iat = Math.floor(Date.now() / 1000);
  const jwt = await signJwt({ sub: row.user_github_id, handle: row.handle, iat, exp: iat + JWT_TTL_SECONDS }, env.JWT_SECRET);
  return json({ jwt, handle: row.handle, avatarUrl: row.avatar_url });
}

export async function revokeAuth(request: Request, env: Env): Promise<Response> {
  let body: { refresh_token?: unknown };
  try {
    body = (await request.json()) as { refresh_token?: unknown };
  } catch {
    return error(400, 'invalid json');
  }
  const token = body.refresh_token;
  if (typeof token !== 'string' || token.length < 32) return error(400, 'refresh_token required');

  // Idempotent: revoking an unknown or already-revoked token still returns ok,
  // so logout never fails client-side.
  await env.DB.prepare(
    `UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`,
  ).bind(new Date().toISOString(), await sha256Hex(token)).run();

  return json({ ok: true });
}
