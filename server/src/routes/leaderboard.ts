import type { Env } from '../env.js';
import { html, json } from '../http.js';
import { renderLeaderboard } from '../views/leaderboard.js';

const WINDOWS = {
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
  all: Number.MAX_SAFE_INTEGER,
} as const;
type Window = keyof typeof WINDOWS;

const HEATMAP_DAYS = 7;

export interface LeaderboardRow {
  github_id: number;
  handle: string;
  avatar_url: string | null;
  shipped_count: number;
  last_shipped_at: string;
  first_at: string;
}

interface DailyCount {
  user_github_id: number;
  day: string;
  n: number;
}

export interface HeatmapDay {
  day: string;
  n: number;
}

export interface LeaderboardEntry {
  rank: number;
  handle: string;
  avatarUrl: string | null;
  shippedCount: number;
  lastShippedAt: string;
  recentDays: HeatmapDay[];
}

export interface LeaderboardData {
  entries: LeaderboardEntry[];
  devCount: number;
  sessionCount: number;
}

function parseWindow(value: string | null): Window {
  if (value === 'month' || value === 'all') return value;
  return 'week';
}

function startOfCalendarMonth(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

async function buildData(env: Env, window: Window): Promise<LeaderboardData> {
  const sinceMs = window === 'all' ? 0
    : window === 'month' ? startOfCalendarMonth().getTime()
    : Date.now() - WINDOWS[window];
  const sinceIso = new Date(sinceMs).toISOString();

  const totalsRes = await env.DB.prepare(
    `SELECT COUNT(DISTINCT user_github_id) AS dev_count, COUNT(*) AS session_count
     FROM sessions
     WHERE momentum = 'shipped' AND ended_at > ?`,
  ).bind(sinceIso).first<{ dev_count: number; session_count: number }>();
  const devCount = totalsRes?.dev_count ?? 0;
  const sessionCount = totalsRes?.session_count ?? 0;

  const topRes = await env.DB.prepare(
    `SELECT u.github_id, u.handle, u.avatar_url,
            COUNT(*) AS shipped_count,
            MAX(s.ended_at) AS last_shipped_at,
            MIN(s.started_at) AS first_at
     FROM sessions s JOIN users u ON s.user_github_id = u.github_id
     WHERE s.momentum = 'shipped' AND s.ended_at > ?
     GROUP BY u.github_id
     ORDER BY shipped_count DESC, first_at ASC
     LIMIT 100`,
  ).bind(sinceIso).all<LeaderboardRow>();

  const rows = topRes.results ?? [];
  if (rows.length === 0) return { entries: [], devCount, sessionCount };

  const heatmapSince = new Date(Date.now() - HEATMAP_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const placeholders = rows.map(() => '?').join(',');
  const dailyRes = await env.DB.prepare(
    `SELECT user_github_id, date(ended_at) AS day, COUNT(*) AS n
     FROM sessions
     WHERE momentum = 'shipped' AND ended_at > ? AND user_github_id IN (${placeholders})
     GROUP BY user_github_id, day`,
  ).bind(heatmapSince, ...rows.map((r) => r.github_id)).all<DailyCount>();

  const dailyByUser = new Map<number, Map<string, number>>();
  for (const d of dailyRes.results ?? []) {
    let inner = dailyByUser.get(d.user_github_id);
    if (!inner) { inner = new Map(); dailyByUser.set(d.user_github_id, inner); }
    inner.set(d.day, d.n);
  }

  const dayKeys: string[] = [];
  const now = new Date();
  for (let i = HEATMAP_DAYS - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    dayKeys.push(d.toISOString().slice(0, 10));
  }

  const entries = rows.map((r, i) => {
    const userDays = dailyByUser.get(r.github_id) ?? new Map();
    return {
      rank: i + 1,
      handle: r.handle,
      avatarUrl: r.avatar_url,
      shippedCount: r.shipped_count,
      lastShippedAt: r.last_shipped_at,
      recentDays: dayKeys.map((k) => ({ day: k, n: userDays.get(k) ?? 0 })),
    };
  });

  return { entries, devCount, sessionCount };
}

export async function leaderboardJson(request: Request, env: Env): Promise<Response> {
  const window = parseWindow(new URL(request.url).searchParams.get('window'));
  const data = await buildData(env, window);
  return json({
    window,
    updatedAt: new Date().toISOString(),
    devCount: data.devCount,
    sessionCount: data.sessionCount,
    entries: data.entries,
  }, { headers: { 'cache-control': 'public, max-age=60' } });
}

export async function leaderboardHtml(request: Request, env: Env): Promise<Response> {
  const window = parseWindow(new URL(request.url).searchParams.get('window'));
  const data = await buildData(env, window);
  return html(renderLeaderboard(data, window, new Date()), {
    headers: {
      'cache-control': 'public, max-age=60',
      'content-security-policy': "default-src 'self'; img-src https://avatars.githubusercontent.com; style-src 'unsafe-inline'; base-uri 'self'; form-action 'self'",
      'referrer-policy': 'strict-origin-when-cross-origin',
      'x-content-type-options': 'nosniff',
    },
  });
}
