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
// Anti-gaming: at most this many ship events per user per UTC day. Enforced by
// silently dropping excess event rows — the session itself still stores, so
// clients (including pre-0.8 ones that used to see a 429 here) never retry.
const DAILY_SHIPPED_CAP = 10;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SHIP_EVENTS = 62;
const DAY_SLACK_MS = 24 * 60 * 60 * 1000;

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
  shipEvents?: string[];
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
  if (s.shipEvents !== undefined) {
    if (!Array.isArray(s.shipEvents) || s.shipEvents.length > MAX_SHIP_EVENTS) return 'invalid shipEvents';
    for (const day of s.shipEvents) {
      if (typeof day !== 'string' || !DAY_RE.test(day) || isNaN(Date.parse(day))) return 'invalid shipEvents';
    }
    // Every event needs at least one new commit in its delta, so a session can
    // never honestly claim more event days than it has commits.
    if (s.shipEvents.length > (s.commits as number)) return 'shipEvents exceed commits';
  }
  return s as unknown as IncomingSession;
}

export async function submitSession(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  let body: unknown;
  try { body = await request.json(); } catch { return error(400, 'invalid json'); }
  const parsed = parseSession(body);
  if (typeof parsed === 'string') return error(400, parsed);

  // Staleness keys on when the session ENDED: long-lived sessions are
  // first-class now that ship events count per day, so a session started
  // weeks ago but active yesterday is current, while one that ended two
  // weeks ago is a zombie resubmission whatever its start date.
  const startedAtMs = Date.parse(parsed.startedAt);
  const endedAtMs = Date.parse(parsed.endedAt);
  if (Date.now() - endedAtMs > MAX_AGE_MS) return error(400, 'session too old');
  if (parsed.durationSeconds < MIN_DURATION_S) return error(400, 'session too short');

  // Event days must fall within the session's lifespan (a day of slack each
  // side for clock skew) — no forging history outside the session.
  if (parsed.shipEvents) {
    for (const day of parsed.shipEvents) {
      const dayMs = Date.parse(day);
      if (dayMs < startedAtMs - DAY_SLACK_MS * 2 || dayMs > endedAtMs + DAY_SLACK_MS) return error(400, 'shipEvents outside session');
    }
  }

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

  // Prior state drives both the ownership check and the legacy event gate.
  const prior = await env.DB.prepare(
    `SELECT user_github_id AS uid, commits AS priorCommits FROM sessions WHERE id = ?`,
  ).bind(parsed.id).first<{ uid: number; priorCommits: number }>();
  if (prior && prior.uid !== auth.sub) return error(409, 'session id belongs to another user');

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

  // One row per (session, day); past days are announced history and immutable.
  //
  // Clients that send shipEvents delta-gate each day themselves, and their
  // submitted set replaces the session's rows for today and later only.
  //
  // Pre-0.8 clients assert nothing about events, so their submissions never
  // delete rows; a single end-day event is derived from momentum, gated on the
  // commit count having GROWN since the last stored submission. Without that
  // gate, any long-lived session that ever shipped would mint a free event
  // every day it merely revived (42 phantom events in the first hour of
  // 2026-09-07).
  const todayDay = new Date().toISOString().slice(0, 10);
  let eventDays: string[];
  if (parsed.shipEvents) {
    eventDays = [...new Set(parsed.shipEvents)].sort();
    await env.DB.prepare(
      `DELETE FROM ship_events WHERE session_id = ? AND day >= ?${eventDays.length ? ` AND day NOT IN (${eventDays.map(() => '?').join(',')})` : ''}`,
    ).bind(parsed.id, todayDay, ...eventDays).run();
  } else {
    const commitsGrew = !prior || parsed.commits > (prior.priorCommits ?? 0);
    eventDays = momentum === 'shipped' && commitsGrew ? [parsed.endedAt.slice(0, 10)] : [];
  }
  for (const day of eventDays) {
    // Conditional insert in one statement so concurrent submissions can't
    // race past the per-day cap.
    await env.DB.prepare(
      `INSERT OR IGNORE INTO ship_events (session_id, user_github_id, day)
       SELECT ?1, ?2, ?3
       WHERE (SELECT COUNT(*) FROM ship_events WHERE user_github_id = ?2 AND day = ?3 AND session_id != ?1) < ${DAILY_SHIPPED_CAP}`,
    ).bind(parsed.id, auth.sub, day).run();
  }

  await env.DB.prepare(`UPDATE users SET last_seen_at = ? WHERE github_id = ?`).bind(submittedAt, auth.sub).run();

  return json({ ok: true, submittedAt });
}
