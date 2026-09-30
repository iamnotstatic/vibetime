import type { Env } from '../env.js';
import { error, json } from '../http.js';
import { requireAuth } from '../auth-middleware.js';
import { checkAndRecord } from '../ratelimit.js';
import { scoreSession, clampBaseline, earnsEvents, type Stats } from '../score.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_TIERS = new Set(['shipped', 'progressed', 'tinkering', 'exploring', 'idle', 'interrupted']);
const VALID_TOOLS_RE = /^[a-z][a-z0-9_-]{0,31}$/i;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MIN_DURATION_S = 60;
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
  branchHash: string | null;
  cliVersion: string | null;
}

// The version string is attacker-controlled in the same way every header is,
// so it is matched against a shape rather than trusted: anything else is simply
// not recorded. Never rejected, for the same reason branchHash is not.
function parseCliVersion(request: Request): string | null {
  const v = request.headers.get('x-cli-version');
  return v && /^\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9a-z.]{1,20})?$/i.test(v) ? v : null;
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
  // Sanitised, never rejected: the client drops a 400 permanently and silently,
  // so a rule here would discard whole sessions to reject one field.
  const branchHash = typeof s.branchHash === 'string' && /^[0-9a-f]{8,64}$/.test(s.branchHash)
    ? s.branchHash
    : null;
  return { ...(s as unknown as IncomingSession), branchHash, cliVersion: null };
}

// 0.14.0 credits each commit to one session on the machine, so from there on a
// duplicate never reaches the server as one.
function hasCommitLedger(cliVersion: string | null): boolean {
  if (!cliVersion) return false;
  const [major = 0, minor = 0] = cliVersion.split('.').map((n) => parseInt(n, 10) || 0);
  return major > 0 || minor >= 14;
}

// Before the ledger, every session watching a repo counted every commit it
// could see, so overlapping sessions reported the same work and each was paid
// for it. Such a duplicate arrives as a state another session was already paid
// for: the same user and project, overlapping in time, with an event baseline
// equal to these exact stats. Real parallel work on different commits does not
// produce four identical numbers.
async function paidToTwin(env: Env, uid: number, session: IncomingSession, stats: Stats): Promise<boolean> {
  const latest = new Date(Math.max(Date.parse(session.endedAt), Date.now())).toISOString();
  const twin = await env.DB.prepare(
    `SELECT 1 FROM sessions s
      WHERE s.user_github_id = ? AND s.project_hash = ? AND s.id <> ?
        AND s.event_baseline_commits = ? AND s.event_baseline_lines_added = ?
        AND s.event_baseline_lines_removed = ? AND s.event_baseline_files = ?
        AND s.started_at <= ? AND s.ended_at >= ?
        AND EXISTS (SELECT 1 FROM ship_events e WHERE e.session_id = s.id)
      LIMIT 1`,
  ).bind(
    uid, session.projectHash, session.id,
    stats.commits, stats.linesAdded, stats.linesRemoved, stats.filesTouched,
    latest, session.startedAt,
  ).first();
  return twin !== null;
}

// A 400 makes the CLI drop the session for good, so the reason is logged: it
// is the only trace the rejection leaves.
function rejected(reason: string, cliVersion: string | null): Response {
  console.warn(`submit rejected: ${reason} (cli ${cliVersion ?? 'unknown'})`);
  return error(400, reason);
}

export async function submitSession(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  let body: unknown;
  const cliVersion = parseCliVersion(request);
  try { body = await request.json(); } catch { return rejected('invalid json', cliVersion); }
  const parsed = parseSession(body);
  if (typeof parsed === 'string') return rejected(parsed, cliVersion);
  parsed.cliVersion = cliVersion;

  // Staleness keys on when the session ENDED: long-lived sessions are
  // first-class now that ship events count per day, so a session started
  // weeks ago but active yesterday is current, while one that ended two
  // weeks ago is a zombie resubmission whatever its start date.
  const startedAtMs = Date.parse(parsed.startedAt);
  const endedAtMs = Date.parse(parsed.endedAt);
  if (Date.now() - endedAtMs > MAX_AGE_MS) return rejected('session too old', cliVersion);
  if (parsed.durationSeconds < MIN_DURATION_S) return rejected('session too short', cliVersion);

  // Event days must fall between the session's start and now (a day of slack
  // each side for clock skew), so no history is forged outside it. The client's
  // endedAt is no upper bound: an open desktop session reports its start as its
  // end, and the reaper winds a session's end back to its last activity, so real
  // ship days routinely fall after it.
  if (parsed.shipEvents) {
    const latestMs = Math.max(endedAtMs, Date.now());
    for (const day of parsed.shipEvents) {
      const dayMs = Date.parse(day);
      if (dayMs < startedAtMs - DAY_SLACK_MS * 2 || dayMs > latestMs + DAY_SLACK_MS) return rejected('shipEvents outside session', cliVersion);
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

  const prior = await env.DB.prepare(
    `SELECT user_github_id AS uid,
            event_baseline_commits       AS baseCommits,
            event_baseline_lines_added   AS baseLinesAdded,
            event_baseline_lines_removed AS baseLinesRemoved,
            event_baseline_files         AS baseFiles
       FROM sessions WHERE id = ?`,
  ).bind(parsed.id).first<{
    uid: number;
    baseCommits: number | null;
    baseLinesAdded: number | null;
    baseLinesRemoved: number | null;
    baseFiles: number | null;
  }>();
  if (prior && prior.uid !== auth.sub) return error(409, 'session id belongs to another user');

  const stats: Stats = {
    commits: parsed.commits,
    linesAdded: parsed.linesAdded,
    linesRemoved: parsed.linesRemoved,
    filesTouched: parsed.filesTouched,
  };
  // Uncredited sessions start from zero so a first shipping day still lands.
  const baseline: Stats = clampBaseline({
    commits: prior?.baseCommits ?? 0,
    linesAdded: prior?.baseLinesAdded ?? 0,
    linesRemoved: prior?.baseLinesRemoved ?? 0,
    filesTouched: prior?.baseFiles ?? 0,
  }, stats);

  const submittedAt = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_github_id, tool, project_hash, branch_hash, cli_version, started_at, ended_at,
                           duration_seconds, commits, lines_added, lines_removed,
                           files_touched, momentum, submitted_at,
                           event_baseline_commits, event_baseline_lines_added,
                           event_baseline_lines_removed, event_baseline_files)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       tool = excluded.tool,
       project_hash = excluded.project_hash,
       -- A client that stops sending one must not blank what we already have.
       branch_hash = COALESCE(excluded.branch_hash, sessions.branch_hash),
       -- Last writer wins, so a row reflects the CLI that most recently touched
       -- it; an upgrade mid-session moves it forward rather than blanking it.
       cli_version = COALESCE(excluded.cli_version, sessions.cli_version),
       started_at = excluded.started_at,
       ended_at = excluded.ended_at,
       duration_seconds = excluded.duration_seconds,
       commits = excluded.commits,
       lines_added = excluded.lines_added,
       lines_removed = excluded.lines_removed,
       files_touched = excluded.files_touched,
       momentum = excluded.momentum,
       -- Left out of this list, it recorded when the row was created and never
       -- moved again, so "what submitted recently" answered nothing. It has
       -- misled two investigations that both had to be redone on ended_at.
       submitted_at = excluded.submitted_at,
       event_baseline_commits = excluded.event_baseline_commits,
       event_baseline_lines_added = excluded.event_baseline_lines_added,
       event_baseline_lines_removed = excluded.event_baseline_lines_removed,
       event_baseline_files = excluded.event_baseline_files
     WHERE sessions.user_github_id = excluded.user_github_id`,
  ).bind(
    parsed.id, auth.sub, parsed.tool, parsed.projectHash, parsed.branchHash, parsed.cliVersion, parsed.startedAt, parsed.endedAt,
    parsed.durationSeconds, parsed.commits, parsed.linesAdded, parsed.linesRemoved,
    parsed.filesTouched, momentum, submittedAt,
    baseline.commits, baseline.linesAdded, baseline.linesRemoved, baseline.filesTouched,
  ).run();

  // Where the day list comes from depends on the client version; the test it
  // has to pass does not. Both go through earnsEvents.
  //
  // Past days are announced history, so this DELETE and the ships bump below
  // both stay on today or later: a published number can never move.
  const todayDay = new Date().toISOString().slice(0, 10);
  let claimedDays: string[];
  if (parsed.shipEvents) {
    claimedDays = [...new Set(parsed.shipEvents)].sort();
    await env.DB.prepare(
      `DELETE FROM ship_events WHERE session_id = ? AND day >= ?${claimedDays.length ? ` AND day NOT IN (${claimedDays.map(() => '?').join(',')})` : ''}`,
    ).bind(parsed.id, todayDay, ...claimedDays).run();
  } else {
    claimedDays = momentum === 'shipped' ? [parsed.endedAt.slice(0, 10)] : [];
  }

  // A day already credited is paid for, so re-claiming it must not spend the
  // delta a new day needs.
  const credited = claimedDays.length
    ? await env.DB.prepare(
        `SELECT day FROM ship_events WHERE session_id = ? AND day IN (${claimedDays.map(() => '?').join(',')})`,
      ).bind(parsed.id, ...claimedDays).all<{ day: string }>()
    : null;
  const already = new Set((credited?.results ?? []).map((r) => r.day));
  const newDays = claimedDays.filter((d) => !already.has(d));

  // No per-user ceiling. What bounds this table: one row per (session, day),
  // event days never exceeding commits, earnsEvents on every day, the request
  // limiter, and for clients without the ledger, paidToTwin.
  const bumpDay = claimedDays.filter((d) => d >= todayDay).sort().pop();
  const earns = newDays.length > 0
    ? earnsEvents(baseline, stats, newDays.length)
    : bumpDay !== undefined && earnsEvents(baseline, stats, 1);
  const paidElsewhere = earns && !hasCommitLedger(parsed.cliVersion) && await paidToTwin(env, auth.sub, parsed, stats);

  let landed = 0;
  if (earns && !paidElsewhere) {
    if (newDays.length > 0) {
      for (const day of newDays) {
        const res = await env.DB.prepare(
          `INSERT OR IGNORE INTO ship_events (session_id, user_github_id, day, ships) VALUES (?1, ?2, ?3, 1)`,
        ).bind(parsed.id, auth.sub, day).run();
        if (res.meta.changes > 0) landed++;
      }
    } else if (bumpDay) {
      // Shipped again on a day already credited: count up rather than drop it.
      const res = await env.DB.prepare(
        `UPDATE ship_events SET ships = ships + 1 WHERE session_id = ? AND day = ?`,
      ).bind(parsed.id, bumpDay).run();
      if (res.meta.changes > 0) landed++;
    }
  }

  // Only credited work spends the delta, so a row a concurrent writer beat us
  // to rolls forward instead of evaporating. Work already paid to a twin spends
  // it too, or this session would be paid for the same delta on its next submit.
  if (landed > 0 || paidElsewhere) {
    await env.DB.prepare(
      `UPDATE sessions SET event_baseline_commits = ?, event_baseline_lines_added = ?,
                           event_baseline_lines_removed = ?, event_baseline_files = ?
        WHERE id = ? AND user_github_id = ?`,
    ).bind(stats.commits, stats.linesAdded, stats.linesRemoved, stats.filesTouched, parsed.id, auth.sub).run();
  }

  await env.DB.prepare(`UPDATE users SET last_seen_at = ? WHERE github_id = ?`).bind(submittedAt, auth.sub).run();

  return json({ ok: true, submittedAt });
}
