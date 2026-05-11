import type { Env } from '../env.js';
import { error, json } from '../http.js';
import { signJwt } from '../jwt.js';

const JWT_TTL_SECONDS = 90 * 24 * 60 * 60;

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
  return json({ jwt, handle: gh.login, avatarUrl });
}
