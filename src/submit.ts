import { createHash, createHmac } from 'node:crypto';
import { getSessions, updateSession, type Session } from './db.js';
import { readAuth, markSignedOut, refreshAuth, jwtExpiresAtMs, rememberCommitKey, type AuthRecord } from './auth.js';
import { request, ApiError } from './api.js';
import { branchFingerprint } from './fingerprint.js';

// Renew ahead of expiry so submissions rarely meet a 401. Two days of slack on
// a seven-day token means one successful flush a week keeps auth alive forever.
const RENEW_BEFORE_MS = 48 * 60 * 60 * 1000;

function projectHash(project: string): string {
  return createHash('sha256').update(project).digest('hex').slice(0, 16);
}

// Keyed with the account's commit key, so the server can tell that two
// sessions, on any machines, reported the same commit without ever learning
// which commit it is.
function keyed(commitKey: string, value: string): string {
  return createHmac('sha256', commitKey).update(value).digest('hex').slice(0, 32);
}

// Only with a key, and only commits this session is credited with. Without a
// key the server scores the totals alone, as it does for every older CLI.
function commitFacts(s: Session, auth: AuthRecord): Record<string, unknown> {
  if (!auth.commitKey || !auth.commitKeyVersion || !s.commitFacts?.length) return {};
  const key = auth.commitKey;
  return {
    commitKeyVersion: auth.commitKeyVersion,
    commitFacts: s.commitFacts.map((f) => ({
      id: keyed(key, f.sha),
      authorId: keyed(key, f.key),
      committedAt: Math.floor(f.committedAt / 1000),
      linesAdded: f.linesAdded,
      linesRemoved: f.linesRemoved,
      files: f.files,
    })),
  };
}

function buildPayload(s: Session, auth: AuthRecord): Record<string, unknown> {
  return {
    id: s.id,
    tool: s.tool.split('/').pop() || s.tool,
    projectHash: projectHash(s.project),
    // Salted locally: tells two sessions apart by branch without the name.
    ...(branchFingerprint(s.branch) ? { branchHash: branchFingerprint(s.branch) } : {}),
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    durationSeconds: s.durationSeconds,
    commits: s.commits,
    linesAdded: s.linesAdded,
    linesRemoved: s.linesRemoved,
    filesTouched: s.filesTouched,
    momentum: s.momentum,
    // Absent on sessions recorded by a pre-0.8 CLI; the server derives a
    // single end-day event from momentum for those. The server rejects more
    // event days than commits, and stats can shrink after events were emitted
    // (dedupe, rescore), so send at most `commits` days, newest first — the
    // ones still backed by the current stats.
    ...(s.shipEvents?.length && s.commits > 0
      ? { shipEvents: s.shipEvents.slice(-Math.min(s.commits, s.shipEvents.length)) }
      : {}),
    ...commitFacts(s, auth),
  };
}

interface SubmitResponse {
  ok: true;
  submittedAt: string;
  commitKey?: unknown;
  commitKeyVersion?: unknown;
}

async function postSession(session: Session, auth: AuthRecord, timeoutMs: number): Promise<void> {
  const res = await request<SubmitResponse>('/sessions', {
    method: 'POST',
    body: buildPayload(session, auth),
    headers: { authorization: `Bearer ${auth.jwt}` },
    timeoutMs,
  });
  if (typeof res?.commitKey === 'string' && /^[0-9a-f]{64}$/.test(res.commitKey) && typeof res.commitKeyVersion === 'number') {
    rememberCommitKey(auth.jwt, res.commitKey, res.commitKeyVersion);
  }
}

// Auth for a submission, renewed when the access token is near or past expiry.
// Both submit paths go through this. In-progress submits are the ONLY thing a
// long-lived open session ever calls, so without renewal here a session that
// outlives its access token stops reporting and never recovers: the flush path
// skips open sessions, so nothing else would ever renew for that user.
async function currentAuth(budgetMs: number): Promise<AuthRecord | null> {
  const auth = readAuth();
  if (!auth?.refreshToken) return auth;
  const exp = jwtExpiresAtMs(auth.jwt);
  if (exp !== null && exp - Date.now() >= RENEW_BEFORE_MS) return auth;
  return refreshAuth(auth, Math.min(budgetMs, 3000));
}

// What an in-progress submit is deduplicated on: an unchanged signature has
// nothing new for the server.
export function progressSignature(s: Pick<Session, 'commits' | 'linesAdded' | 'linesRemoved' | 'filesTouched' | 'shipEvents'>): string {
  return `${s.commits}:${s.linesAdded}:${s.linesRemoved}:${s.filesTouched}:${(s.shipEvents ?? []).length}`;
}

// A 400 is the one failure no resend can change, so it settles the payload
// the same way an acceptance does.
function settledBy(e: unknown): boolean {
  return e instanceof ApiError && e.status === 400;
}

// True once the server has settled this payload. Callers must only stop
// resending on true: a timeout, a 5xx, a 429 or a dead token all leave the
// server without it, and an open session has no other path that sends it.
export async function submitInProgress(session: Session, budgetMs = 1500): Promise<boolean> {
  if (session.durationSeconds < 60) return false;
  const auth = await currentAuth(budgetMs);
  if (!auth) return false;
  try {
    await postSession(session, auth, budgetMs);
    return true;
  } catch (e) {
    if (settledBy(e)) return true;
    if (!(e instanceof ApiError) || e.status !== 401) return false;
    // No refresh token means a pre-0.7 login: drop it so a fresh login retries.
    if (!auth.refreshToken) {
      markSignedOut();
      return false;
    }
    const renewed = await refreshAuth(auth, Math.min(budgetMs, 3000));
    if (!renewed || renewed.jwt === auth.jwt) return false;
    try {
      await postSession(session, renewed, budgetMs);
      return true;
    } catch (retry) {
      return settledBy(retry);
    }
  }
}

// Deduped by id: parallel hook processes could both pass the existence check
// and write the same session twice, and a flush would then upload the empty
// copy over the real one. More commits wins, longer session breaks the tie.
function pendingSessions(): Session[] {
  const byId = new Map<string, Session>();
  for (const s of getSessions()) {
    if (s.submittedAt || s.exitCode === -1 || s.durationSeconds < 60) continue;
    const prev = byId.get(s.id);
    if (!prev || s.commits > prev.commits || (s.commits === prev.commits && s.durationSeconds > prev.durationSeconds)) {
      byId.set(s.id, s);
    }
  }
  return [...byId.values()];
}

// Shares pendingSessions with the flush on purpose: a second copy of the rule
// drifts and the count starts naming work the flush was never going to send.
// The login gate is the flush's own, or a local-only user with no account by
// design is told every session they ever ran is stuck.
export function pendingSubmissionCount(): number {
  if (!readAuth()) return 0;
  return pendingSessions().length;
}

export async function flushPendingSubmissions(budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;

  // Renewed here when near expiry; a failed renewal falls through with the
  // current jwt, which may still be valid.
  let auth: AuthRecord | null = await currentAuth(budgetMs);
  if (!auth) return;

  const pending = pendingSessions().sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  let renewedOnce = false;
  for (let i = 0; i < pending.length; i++) {
    const session = pending[i];
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    const perRequest = Math.min(remaining, 1500);
    try {
      await postSession(session, auth, perRequest);
      await updateSession(session.id, { submittedAt: new Date().toISOString() });
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status === 401) {
          if (auth.refreshToken && !renewedOnce) {
            renewedOnce = true;
            const renewed = await refreshAuth(auth, Math.min(deadline - Date.now(), 3000));
            if (!renewed) return; // refresh rejected: local auth already cleared
            if (renewed.jwt !== auth.jwt) {
              auth = renewed;
              i--; // retry this session with the fresh token
              continue;
            }
            return; // couldn't reach the server to renew: retry next flush
          }
          // no refresh token (pre-v0.7 login) or still 401 after renewing:
          // drop the token, leave sessions unsubmitted so a fresh login retries them
          markSignedOut();
          return;
        }
        if (e.status === 400) {
          // validation failure: nothing about waiting will fix this. stop retrying this one.
          await updateSession(session.id, { submittedAt: new Date().toISOString() });
          continue;
        }
        // 403 (account too new), 429 (rate limit), 5xx: retry later
        return;
      }
      // network error: retry later
      return;
    }
  }
}
