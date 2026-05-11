import type { Env } from './env.js';

const WINDOW_SECONDS = 3600;
const MAX_PER_WINDOW = 30;

export async function checkAndRecord(env: Env, userGithubId: number): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - WINDOW_SECONDS;
  await env.DB.prepare(`DELETE FROM submission_log WHERE at < ?`).bind(cutoff).run();
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM submission_log WHERE user_github_id = ? AND at >= ?`,
  ).bind(userGithubId, cutoff).first<{ n: number }>();
  if ((row?.n ?? 0) >= MAX_PER_WINDOW) return false;
  await env.DB.prepare(`INSERT INTO submission_log (user_github_id, at) VALUES (?, ?)`).bind(userGithubId, now).run();
  return true;
}
