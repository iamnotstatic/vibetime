import type { Env } from './env.js';
import { exchangeAuth, refreshAuth, revokeAuth } from './routes/auth.js';
import { submitSession } from './routes/sessions.js';
import { leaderboardJson, leaderboardHtml } from './routes/leaderboard.js';
import { statsJson, statsHtml } from './routes/stats.js';
import { homeHtml } from './routes/home.js';
import { parseBadgeHandle, parseProfileHandle, profileBadge, profileHtml } from './routes/profile.js';
import { clientConfig } from './routes/config.js';
import { githubCallback, githubStart, setTheme, signOut } from './routes/web-auth.js';
import {
  createCrewPost, crewConfirmHtml, crewHtml, crewJoinPost, crewLeavePost, crewSettingsPost, crewsHtml,
  invitePost, inviteHtml, lowercaseCrewRedirect, newCrewHtml, parseCrewPath, parseInvitePath,
} from './routes/crews.js';
import { faviconResponse } from './views/favicon.js';
import { ogImageResponse } from './views/og.js';
import { copyScriptResponse, fontResponse, stylesheetResponse } from './views/style.js';
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
      const badgeHandle = request.method === 'GET' ? parseBadgeHandle(url.pathname) : null;
      if (badgeHandle) {
        return await profileBadge(request, env, badgeHandle);
      }
      const crewPath = parseCrewPath(url.pathname);
      if (crewPath) {
        const { slug, rest } = crewPath;
        const lower = request.method === 'GET' ? lowercaseCrewRedirect(slug, rest, url.search) : null;
        if (lower) return lower;
        if (request.method === 'GET' && rest === '') return await crewHtml(request, env, slug);
        if (request.method === 'GET' && rest === '/confirm') return await crewConfirmHtml(request, env, slug);
        if (request.method === 'POST' && rest === '/join') return await crewJoinPost(request, env, slug);
        if (request.method === 'POST' && rest === '/leave') return await crewLeavePost(request, env, slug);
        if (request.method === 'POST' && rest === '/settings') return await crewSettingsPost(request, env, slug);
      }
      const inviteCode = parseInvitePath(url.pathname);
      if (inviteCode) {
        if (request.method === 'GET') return await inviteHtml(request, env, inviteCode);
        if (request.method === 'POST') return await invitePost(request, env, inviteCode);
      }

      switch (route) {
        case 'POST /auth/exchange':
          return withCors(await exchangeAuth(request, env));
        case 'POST /auth/refresh':
          return withCors(await refreshAuth(request, env));
        case 'POST /auth/logout':
          return withCors(await revokeAuth(request, env));
        case 'GET /auth/github/start':
          return await githubStart(request, env);
        case 'GET /auth/github/callback':
          return await githubCallback(request, env);
        case 'POST /auth/signout':
          return await signOut(request, env);
        case 'POST /theme':
          return await setTheme(request);
        case 'GET /crews':
          return await crewsHtml(request, env);
        case 'GET /crews/new':
          return await newCrewHtml(request, env);
        case 'POST /crews':
          return await createCrewPost(request, env);
        case 'GET /assets/copy.js':
          return copyScriptResponse();
        case 'GET /assets/site.css':
          return stylesheetResponse();
        case 'GET /assets/geist-mono.woff2':
          return fontResponse();
        case 'GET /config':
          return withCors(clientConfig());
        case 'POST /sessions': {
          // A client that times out cancels the invocation, and the session row
          // is written before its ship events, so the numbers would land and
          // the credit would not. The CLI never resends an unchanged payload.
          const work = submitSession(request, env, (later) => ctx.waitUntil(later));
          ctx.waitUntil(work.catch(() => {}));
          return withCors(await work);
        }
        case 'GET /leaderboard.json':
          return withCors(await leaderboardJson(request, env));
        case 'GET /leaderboard':
          return await leaderboardHtml(request, env);
        case 'GET /stats.json':
          return withCors(await statsJson(env));
        case 'GET /stats':
          return await statsHtml(request, env);
        case 'GET /favicon.svg':
        case 'GET /favicon.ico':
          return faviconResponse();
        case 'GET /og.png':
          return ogImageResponse();
        case 'GET /':
          return await homeHtml(request, env);
        default:
          return withCors(error(404, 'not found'));
      }
    } catch (e) {
      console.error('unhandled error:', e instanceof Error ? e.message : e);
      return withCors(error(500, 'internal error'));
    }
  },
};
