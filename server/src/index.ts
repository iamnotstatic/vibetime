import type { Env } from './env.js';
import { exchangeAuth, refreshAuth, revokeAuth } from './routes/auth.js';
import { submitSession } from './routes/sessions.js';
import { leaderboardJson, leaderboardHtml } from './routes/leaderboard.js';
import { parseProfileHandle, profileHtml } from './routes/profile.js';
import { clientConfig } from './routes/config.js';
import { faviconResponse } from './views/favicon.js';
import { error } from './http.js';
import { CLI_RECOMMENDED } from './release.js';

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '86400',
};

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  headers.set('x-cli-recommended-version', CLI_RECOMMENDED.version);
  return new Response(res.body, { status: res.status, headers });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    const profileHandle = request.method === 'GET' ? parseProfileHandle(url.pathname) : null;

    try {
      if (profileHandle) {
        return await profileHtml(request, env, profileHandle);
      }

      switch (route) {
        case 'POST /auth/exchange':
          return withCors(await exchangeAuth(request, env));
        case 'POST /auth/refresh':
          return withCors(await refreshAuth(request, env));
        case 'POST /auth/logout':
          return withCors(await revokeAuth(request, env));
        case 'GET /config':
          return withCors(clientConfig());
        case 'POST /sessions': {
          // A client that times out cancels the invocation, and the session row
          // is written before its ship events, so the numbers would land and
          // the credit would not. The CLI never resends an unchanged payload.
          const work = submitSession(request, env);
          ctx.waitUntil(work.catch(() => {}));
          return withCors(await work);
        }
        case 'GET /leaderboard.json':
          return withCors(await leaderboardJson(request, env));
        case 'GET /leaderboard':
          return await leaderboardHtml(request, env);
        case 'GET /favicon.svg':
        case 'GET /favicon.ico':
          return faviconResponse();
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
