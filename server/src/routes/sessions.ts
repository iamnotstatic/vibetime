import type { Env } from '../env.js';
import { error, json } from '../http.js';
import { requireAuth } from '../auth-middleware.js';
import { checkAndRecord } from '../ratelimit.js';
import { scoreSession } from '../score.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_TIERS = new Set(['shipped', 'progressed', 'tinkering', 'exploring', 'idle', 'interrupted']);
const VALID_TOOLS_RE = /^[a-z][a-z0-9_-]{0,31}$/i;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MIN_DURATION_S = 60;
const DAILY_SHIPPED_CAP = 10;
const SHIPPED_WINDOW_MS = 24 * 60 * 60 * 1000;

interface IncomingSession {
  id: string;
  tool: string;
  projectHash: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  commits: number;
  linesAdded: number;
  linesRemoved: number;
  filesTouched: number;
  momentum?: string;
}

function parseSession(raw: unknown): IncomingSession | string {
  if (typeof raw !== 'object' || raw === null) return 'body must be an object';
  const s = raw as Record<string, unknown>;
  if (typeof s.id !== 'string' || !UUID_RE.test(s.id)) return 'invalid id';
  if (typeof s.tool !== 'string' || !VALID_TOOLS_RE.test(s.tool)) return 'invalid tool';
  if (typeof s.projectHash !== 'string' || !/^[0-9a-f]{8,64}$/.test(s.projectHash)) return 'invalid projectHash';
  if (typeof s.startedAt !== 'string' || isNaN(Date.parse(s.startedAt))) return 'invalid startedAt';
  if (typeof s.endedAt !== 'string' || isNaN(Date.parse(s.endedAt))) return 'invalid endedAt';
  if (typeof s.durationSeconds !== 'number' || s.durationSeconds < 0) return 'invalid durationSeconds';
  if (typeof s.commits !== 'number' || s.commits < 0) return 'invalid commits';
  if (typeof s.linesAdded !== 'number' || s.linesAdded < 0) return 'invalid linesAdded';
  if (typeof s.linesRemoved !== 'number' || s.linesRemoved < 0) return 'invalid linesRemoved';
  if (typeof s.filesTouched !== 'number' || s.filesTouched < 0) return 'invalid filesTouched';
  // momentum is now optional — server is authoritative — but validate the shape if old clients still send it
  if (s.momentum !== undefined && (typeof s.momentum !== 'string' || !VALID_TIERS.has(s.momentum))) return 'invalid momentum';
  return s as unknown as IncomingSession;
}

export async function submitSession(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  let body: unknown;
  try { body = await request.json(); } catch { return error(400, 'invalid json'); }
  const parsed = parseSession(body);
  if (typeof parsed === 'string') return error(400, parsed);

  const startedAtMs = Date.parse(parsed.startedAt);
  if (Date.now() - startedAtMs > MAX_AGE_MS) return error(400, 'session too old');
  if (parsed.durationSeconds < MIN_DURATION_S) return error(400, 'session too short');

  // confirm the user row still exists (defends against FK insert failure if the row was deleted)
  // v1.1 follow-up: verify commit history against the user's public GitHub events
  const user = await env.DB.prepare(
    `SELECT 1 FROM users WHERE github_id = ?`,
  ).bind(auth.sub).first();
  if (!user) return error(401, 'user not found');

  if (!(await checkAndRecord(env, auth.sub))) return error(429, 'rate limit exceeded');

  // server is authoritative for momentum — recompute from raw stats and ignore whatever the client sent
  const momentum = scoreSession({
    commits: parsed.commits,
    linesAdded: parsed.linesAdded,
    linesRemoved: parsed.linesRemoved,
    filesTouched: parsed.filesTouched,
  });

  if (momentum === 'shipped') {
    const since = new Date(Date.now() - SHIPPED_WINDOW_MS).toISOString();
    const existing = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM sessions WHERE user_github_id = ? AND momentum = 'shipped' AND started_at >= ? AND id != ?`,
    ).bind(auth.sub, since, parsed.id).first<{ n: number }>();
    if ((existing?.n ?? 0) >= DAILY_SHIPPED_CAP) return error(429, 'daily shipped cap reached');
  }

  const submittedAt = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_github_id, tool, project_hash, started_at, ended_at,
                           duration_seconds, commits, lines_added, lines_removed,
                           files_touched, momentum, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       tool = excluded.tool,
       project_hash = excluded.project_hash,
       started_at = excluded.started_at,
       ended_at = excluded.ended_at,
       duration_seconds = excluded.duration_seconds,
       commits = excluded.commits,
       lines_added = excluded.lines_added,
       lines_removed = excluded.lines_removed,
       files_touched = excluded.files_touched,
       momentum = excluded.momentum
     WHERE sessions.user_github_id = excluded.user_github_id`,
  ).bind(
    parsed.id, auth.sub, parsed.tool, parsed.projectHash, parsed.startedAt, parsed.endedAt,
    parsed.durationSeconds, parsed.commits, parsed.linesAdded, parsed.linesRemoved,
    parsed.filesTouched, momentum, submittedAt,
  ).run();

  await env.DB.prepare(`UPDATE users SET last_seen_at = ? WHERE github_id = ?`).bind(submittedAt, auth.sub).run();

  return json({ ok: true, submittedAt });
}
