import type { Env } from '../env.js';
import { html } from '../http.js';
import { renderProfile, renderProfileNotFound } from '../views/profile.js';

const HEATMAP_DAYS = 7;

export interface ProfileWindowStats {
  ships: number;
  days: number;
}

export interface ProfileHeatmapDay {
  day: string;
  n: number;
}

export interface ProfileData {
  handle: string;
  avatarUrl: string | null;
  week: ProfileWindowStats;
  month: ProfileWindowStats;
  all: ProfileWindowStats;
  lastShippedAt: string | null;
  weekRank: number | null;
  weekDevCount: number;
  recentDays: ProfileHeatmapDay[];
}

// GitHub login rules: 1–39 chars, alphanumeric or hyphen, no leading/trailing hyphen.
export function parseProfileHandle(pathname: string): string | null {
  if (!pathname.startsWith('/@')) return null;
  const raw = pathname.slice(2);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(raw)) return null;
  return raw;
}

function startOfCalendarMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function startOfCalendarWeek(): Date {
  const now = new Date();
  const day = now.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - diff));
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function windowStats(
  env: Env,
  githubId: number,
  sinceDay: string,
): Promise<ProfileWindowStats> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(ships), 0) AS ships, COUNT(DISTINCT day) AS days
     FROM ship_events
     WHERE user_github_id = ? AND day >= ?`,
  ).bind(githubId, sinceDay).first<{ ships: number; days: number }>();
  return { ships: row?.ships ?? 0, days: row?.days ?? 0 };
}

async function weekRank(
  env: Env,
  githubId: number,
  sinceDay: string,
  weekShips: number,
): Promise<{ rank: number | null; devCount: number }> {
  const totals = await env.DB.prepare(
    `SELECT COUNT(DISTINCT user_github_id) AS dev_count
     FROM ship_events
     WHERE day >= ?`,
  ).bind(sinceDay).first<{ dev_count: number }>();
  const devCount = totals?.dev_count ?? 0;
  if (weekShips <= 0 || devCount === 0) return { rank: null, devCount };

  // Same ordering as the leaderboard: more ships first, earlier first ship breaks ties.
  const ahead = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM (
       SELECT e.user_github_id,
              SUM(e.ships) AS shipped_count,
              MIN(s.started_at) AS first_at
       FROM ship_events e
       JOIN sessions s ON s.id = e.session_id
       WHERE e.day >= ?
       GROUP BY e.user_github_id
       HAVING shipped_count > ?
          OR (shipped_count = ? AND first_at < (
                SELECT MIN(s2.started_at)
                FROM ship_events e2
                JOIN sessions s2 ON s2.id = e2.session_id
                WHERE e2.user_github_id = ? AND e2.day >= ?
              ))
     )`,
  ).bind(sinceDay, weekShips, weekShips, githubId, sinceDay).first<{ n: number }>();

  return { rank: (ahead?.n ?? 0) + 1, devCount };
}

async function buildProfile(env: Env, handle: string): Promise<ProfileData | null> {
  const user = await env.DB.prepare(
    `SELECT github_id, handle, avatar_url
     FROM users
     WHERE handle = ? COLLATE NOCASE`,
  ).bind(handle).first<{ github_id: number; handle: string; avatar_url: string | null }>();
  if (!user) return null;

  const weekStart = dayKey(startOfCalendarWeek());
  const monthStart = dayKey(startOfCalendarMonth());
  const allStart = '1970-01-01';

  const [week, month, all] = await Promise.all([
    windowStats(env, user.github_id, weekStart),
    windowStats(env, user.github_id, monthStart),
    windowStats(env, user.github_id, allStart),
  ]);

  const last = await env.DB.prepare(
    `SELECT MAX(s.ended_at) AS last_shipped_at
     FROM ship_events e
     JOIN sessions s ON s.id = e.session_id
     WHERE e.user_github_id = ?`,
  ).bind(user.github_id).first<{ last_shipped_at: string | null }>();

  const { rank, devCount } = await weekRank(env, user.github_id, weekStart, week.ships);

  const heatmapSinceDay = dayKey(new Date(Date.now() - HEATMAP_DAYS * 24 * 60 * 60 * 1000));
  const dailyRes = await env.DB.prepare(
    `SELECT day, SUM(ships) AS n
     FROM ship_events
     WHERE user_github_id = ? AND day >= ?
     GROUP BY day`,
  ).bind(user.github_id, heatmapSinceDay).all<{ day: string; n: number }>();

  const byDay = new Map((dailyRes.results ?? []).map((d) => [d.day, d.n]));
  const recentDays: ProfileHeatmapDay[] = [];
  const now = new Date();
  for (let i = HEATMAP_DAYS - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    const key = dayKey(d);
    recentDays.push({ day: key, n: byDay.get(key) ?? 0 });
  }

  return {
    handle: user.handle,
    avatarUrl: user.avatar_url,
    week,
    month,
    all,
    lastShippedAt: last?.last_shipped_at ?? null,
    weekRank: rank,
    weekDevCount: devCount,
    recentDays,
  };
}

const PAGE_HEADERS = {
  'cache-control': 'public, max-age=60',
  'content-security-policy': "default-src 'self'; img-src https://avatars.githubusercontent.com; style-src 'unsafe-inline'; base-uri 'self'; form-action 'self'",
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-content-type-options': 'nosniff',
} as const;

export async function profileHtml(request: Request, env: Env, handle: string): Promise<Response> {
  const data = await buildProfile(env, handle);
  if (!data) {
    return html(renderProfileNotFound(handle), { status: 404, headers: PAGE_HEADERS });
  }
  return html(renderProfile(data, new Date()), { headers: PAGE_HEADERS });
}
