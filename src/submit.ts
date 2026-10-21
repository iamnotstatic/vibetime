import { mkdirSync, rmdirSync, readFileSync, writeFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { VIBE_DIR, ensureVibeDir } from './config.js';
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
      treeId: keyed(key, f.tree),
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
function pendingSessions(sessions = getSessions()): Session[] {
  const byId = new Map<string, Session>();
  for (const s of sessions) {
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

const FLUSH_LOCK = join(VIBE_DIR, 'submit.lock');
const FLUSH_BREAK = FLUSH_LOCK + '.break';

function staleFlushLock(): boolean {
  try {
    const pid = Number(readFileSync(join(FLUSH_LOCK, 'pid'), 'utf8'));
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); return false; }
      catch (err) { return (err as NodeJS.ErrnoException).code === 'ESRCH'; }
    }
  } catch {}
  try { return Date.now() - statSync(FLUSH_LOCK).mtimeMs > 10_000; }
  catch { return false; }
}

function releaseFlushLock(): void {
  try { unlinkSync(join(FLUSH_LOCK, 'pid')); } catch {}
  try { rmdirSync(FLUSH_LOCK); } catch {}
}

function claimFlushLock(retried = false): boolean {
  try { mkdirSync(FLUSH_LOCK); }
  catch {
    if (retried || !staleFlushLock()) return false;
    try { mkdirSync(FLUSH_BREAK); } catch { return false; }
    try {
      if (staleFlushLock()) releaseFlushLock();
      return claimFlushLock(true);
    } finally {
      try { rmdirSync(FLUSH_BREAK); } catch {}
    }
  }
  try {
    writeFileSync(join(FLUSH_LOCK, 'pid'), String(process.pid));
    return true;
  } catch {
    releaseFlushLock();
    return false;
  }
}

export async function flushPendingSubmissions(budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  if (budgetMs <= 0 || pendingSessions().length === 0 || !readAuth()) return;
  ensureVibeDir();
  // Nonblocking: another agent is draining the same queue. Its database writes
  // remain short; never hold sessions.lock across a network request.
  if (!claimFlushLock()) return;
  try {
    await flushPendingLocked(deadline);
  } finally {
    releaseFlushLock();
  }
}

async function flushPendingLocked(deadline: number): Promise<void> {
  // Read after claiming the lock, so a waiter never sends an already-drained
  // snapshot. Empty queues do not renew auth or contact the network.
  const pending = pendingSessions().sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const budgetMs = deadline - Date.now();
  if (pending.length === 0 || budgetMs <= 0) return;

  let auth: AuthRecord | null = await currentAuth(budgetMs);
  if (!auth) return;

  let renewedOnce = false;
  for (let i = 0; i < pending.length; i++) {
    // A hook can reopen, correct or delete a queued session while an earlier
    // request is in flight. Send its current settled version, if it still has one.
    const snapshots = getSessions().filter((s) => s.id === pending[i].id);
    const session = pendingSessions(snapshots)[0];
    if (!session) continue;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    const perRequest = Math.min(remaining, 1500);
    try {
      await postSession(session, auth, perRequest);
      await updateSession(session.id, { submittedAt: new Date().toISOString() }, snapshots);
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status === 401) {
          if (auth.refreshToken && !renewedOnce) {
            renewedOnce = true;
            const renewalBudget = deadline - Date.now();
            if (renewalBudget <= 0) return;
            const renewed = await refreshAuth(auth, Math.min(renewalBudget, 3000));
            if (!renewed) return;
            if (renewed.jwt !== auth.jwt) {
              auth = renewed;
              i--;
              continue;
            }
            return;
          }
          markSignedOut();
          return;
        }
        if (e.status === 400) {
          // Settle only the rejected snapshot, never a correction made while
          // it was in flight. The corrected payload may be valid.
          await updateSession(session.id, { submittedAt: new Date().toISOString() }, snapshots);
          continue;
        }
        return; // 403, 429 and 5xx remain pending for the next attempt.
      }
      return; // network or local persistence failure: leave work pending.
    }
  }
}
