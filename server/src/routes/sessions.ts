import type { Env } from '../env.js';
import { error, json } from '../http.js';
import { requireAuth } from '../auth-middleware.js';
import { checkAndRecord } from '../ratelimit.js';
import { scoreSession, clampBaseline, earnsEvents, type Stats } from '../score.js';
import { commitKeyFor, COMMIT_KEY_VERSION } from '../commit-key.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_TIERS = new Set(['shipped', 'progressed', 'tinkering', 'exploring', 'idle', 'interrupted']);
const VALID_TOOLS_RE = /^[a-z][a-z0-9_-]{0,31}$/i;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MIN_DURATION_S = 60;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SHIP_EVENTS = 62;
const DAY_SLACK_MS = 24 * 60 * 60 * 1000;
const MAX_COMMIT_FACTS = 500;
const HEX32_RE = /^[0-9a-f]{32}$/;

interface CommitFact {
  id: string;
  authorId: string;
  treeId: string;
  committedAt: number;
  linesAdded: number;
  linesRemoved: number;
  files: number;
}

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
  commitFacts: CommitFact[] | null;
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
  return { ...(s as unknown as IncomingSession), branchHash, cliVersion: null, commitFacts: parseCommitFacts(s) };
}

const count = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

// All or nothing, and never a 400: a malformed list is dropped and the session
// is scored on its totals, exactly as if the client had sent none.
function parseCommitFacts(s: Record<string, unknown>): CommitFact[] | null {
  if (s.commitKeyVersion !== COMMIT_KEY_VERSION || !Array.isArray(s.commitFacts)) return null;
  if (s.commitFacts.length === 0 || s.commitFacts.length > MAX_COMMIT_FACTS) return null;
  const facts: CommitFact[] = [];
  for (const raw of s.commitFacts) {
    if (typeof raw !== 'object' || raw === null) return null;
    const f = raw as Record<string, unknown>;
    if (typeof f.id !== 'string' || !HEX32_RE.test(f.id)) return null;
    if (typeof f.authorId !== 'string' || !HEX32_RE.test(f.authorId)) return null;
    if (typeof f.treeId !== 'string' || !HEX32_RE.test(f.treeId)) return null;
    if (!count(f.committedAt) || !count(f.linesAdded) || !count(f.linesRemoved) || !count(f.files)) return null;
    facts.push({ id: f.id, authorId: f.authorId, treeId: f.treeId, committedAt: f.committedAt, linesAdded: f.linesAdded, linesRemoved: f.linesRemoved, files: f.files });
  }
  return facts;
}

// What this session reported that is already credited elsewhere, to be taken
// out of its totals, or null when the facts could not be recorded: a failure
// here must leave the submit scored exactly as it was before commit facts.
//
// Credit belongs to a piece of work, not a commit id. A rebase, amend or
// cherry-pick gives the same work a new id but keeps its author, author time
// and line counts, so both ids file under one piece of work and its first
// reporter keeps it: no copy is paid again, and the owner is never docked for
// its own rewrite, which would leave the work credited to nobody. A squash
// changes all of that, but a squash of an up-to-date branch produces the same
// tree as the branch's last commit, so a later commit with a tree already on
// record is a copy of work already counted.
async function creditedElsewhere(env: Env, uid: number, session: IncomingSession, facts: CommitFact[]): Promise<Stats | null> {
  try {
    const list = JSON.stringify(facts.map((f) => ({
      ...f,
      work: `${session.projectHash}:${f.authorId}:${f.linesAdded}:${f.linesRemoved}`,
    })));
    await env.DB.prepare(
      `INSERT OR IGNORE INTO commit_credits
         (user_github_id, commit_id, work_key, tree_id, project_hash, committed_at, lines_added, lines_removed, files)
       SELECT ?1, json_extract(value, '$.id'), json_extract(value, '$.work'), json_extract(value, '$.treeId'), ?2,
              json_extract(value, '$.committedAt'), json_extract(value, '$.linesAdded'),
              json_extract(value, '$.linesRemoved'), json_extract(value, '$.files')
         FROM json_each(?3)`,
    ).bind(uid, session.projectHash, list).run();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO work_credits (user_github_id, work_key, session_id, credited_at)
       SELECT DISTINCT ?1, c.work_key, ?2, ?3 FROM commit_credits c
        WHERE c.user_github_id = ?1 AND c.commit_id IN (SELECT json_extract(value, '$.id') FROM json_each(?4))`,
    ).bind(uid, session.id, new Date().toISOString(), list).run();
    const rows = await env.DB.prepare(
      `SELECT c.commit_id AS id, w.session_id AS owner,
              EXISTS (SELECT 1 FROM commit_credits t
                       WHERE t.user_github_id = c.user_github_id AND t.project_hash = c.project_hash
                         AND t.tree_id = c.tree_id AND t.commit_id <> c.commit_id
                         AND t.committed_at <= c.committed_at) AS copy
         FROM commit_credits c
         JOIN work_credits w ON w.user_github_id = c.user_github_id AND w.work_key = c.work_key
        WHERE c.user_github_id = ?1 AND c.commit_id IN (SELECT json_extract(value, '$.id') FROM json_each(?2))`,
    ).bind(uid, list).all<{ id: string; owner: string; copy: number }>();
    const elsewhere = new Set(rows.results.filter((r) => r.owner !== session.id || r.copy).map((r) => r.id));
    const dup: Stats = { commits: 0, linesAdded: 0, linesRemoved: 0, filesTouched: 0 };
    for (const f of facts) {
      if (!elsewhere.has(f.id)) continue;
      dup.commits += 1;
      dup.linesAdded += f.linesAdded;
      dup.linesRemoved += f.linesRemoved;
      dup.filesTouched += f.files;
    }
    return dup;
  } catch (e) {
    console.warn(`commit facts not recorded: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// For a submit without commit facts: every CLI before 0.14.0, and a newer one
// before it holds its commit key. Before the ledger, every session watching a
// repo counted every commit it could see, so overlapping sessions reported the
// same work and each was paid for it. Such a duplicate arrives as a state
// another session was already paid for: the same user and project, overlapping
// in time, with an event baseline equal to these exact stats. Real parallel
// work on different commits does not produce four identical numbers.
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

  // Commits another session already owns come out of this one's totals before
  // anything is scored, so a commit counts once however many sessions and
  // machines report it. Files are counts, not names, so theirs come out as a
  // count too: a floor, never a union.
  const dup = parsed.commitFacts ? await creditedElsewhere(env, auth.sub, parsed, parsed.commitFacts) : null;
  const stats: Stats = {
    commits: Math.max(parsed.commits - (dup?.commits ?? 0), 0),
    linesAdded: Math.max(parsed.linesAdded - (dup?.linesAdded ?? 0), 0),
    linesRemoved: Math.max(parsed.linesRemoved - (dup?.linesRemoved ?? 0), 0),
    filesTouched: Math.max(parsed.filesTouched - (dup?.filesTouched ?? 0), 0),
  };

  // server is authoritative for momentum — recompute from raw stats and ignore whatever the client sent
  const momentum = scoreSession(stats);

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
    parsed.durationSeconds, stats.commits, stats.linesAdded, stats.linesRemoved,
    stats.filesTouched, momentum, submittedAt,
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
  // limiter, and paidToTwin for submits that carry no commit facts.
  const bumpDay = claimedDays.filter((d) => d >= todayDay).sort().pop();
  const earns = newDays.length > 0
    ? earnsEvents(baseline, stats, newDays.length)
    : bumpDay !== undefined && earnsEvents(baseline, stats, 1);
  const paidElsewhere = earns && !parsed.commitFacts && await paidToTwin(env, auth.sub, parsed, stats);

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

  // Every submit carries the key, so an install that upgrades while logged in
  // picks it up on its next submit with nothing to run.
  const commitKey = await commitKeyFor(env.COMMIT_KEY_SECRET, auth.sub);
  return json({ ok: true, submittedAt, ...(commitKey ? { commitKey, commitKeyVersion: COMMIT_KEY_VERSION } : {}) });
}
