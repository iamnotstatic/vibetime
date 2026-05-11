import type { Env } from './env.js';
import { exchangeAuth } from './routes/auth.js';
import { submitSession } from './routes/sessions.js';
import { leaderboardJson, leaderboardHtml } from './routes/leaderboard.js';
import { error } from './http.js';

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '86400',
};

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;

    try {
      switch (route) {
        case 'POST /auth/exchange':
          return withCors(await exchangeAuth(request, env));
        case 'POST /sessions':
          return withCors(await submitSession(request, env));
        case 'GET /leaderboard.json':
          return withCors(await leaderboardJson(request, env));
        case 'GET /leaderboard':
          return await leaderboardHtml(request, env);
        case 'GET /':
          return Response.redirect(new URL('/leaderboard', request.url).toString(), 302);
        default:
          return withCors(error(404, 'not found'));
      }
    } catch (e) {
      console.error('unhandled error:', e instanceof Error ? e.message : e);
      return withCors(error(500, 'internal error'));
    }
  },
};
