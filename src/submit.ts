import { createHash } from 'node:crypto';
import { getSessions, updateSession, type Session } from './db.js';
import { readAuth, clearAuth, refreshAuth, jwtExpiresAtMs, type AuthRecord } from './auth.js';
import { request, ApiError } from './api.js';

// Renew ahead of expiry so submissions rarely meet a 401. Two days of slack on
// a seven-day token means one successful flush a week keeps auth alive forever.
const RENEW_BEFORE_MS = 48 * 60 * 60 * 1000;

function projectHash(project: string): string {
  return createHash('sha256').update(project).digest('hex').slice(0, 16);
}

function buildPayload(s: Session): Record<string, unknown> {
  return {
    id: s.id,
    tool: s.tool.split('/').pop() || s.tool,
    projectHash: projectHash(s.project),
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    durationSeconds: s.durationSeconds,
    commits: s.commits,
    linesAdded: s.linesAdded,
    linesRemoved: s.linesRemoved,
    filesTouched: s.filesTouched,
    momentum: s.momentum,
    // Absent on sessions recorded by a pre-0.8 CLI; the server derives a
    // single end-day event from momentum for those.
    ...(s.shipEvents?.length ? { shipEvents: s.shipEvents } : {}),
  };
}

export async function submitInProgress(session: Session, budgetMs = 1500): Promise<void> {
  const auth = readAuth();
  if (!auth) return;
  if (session.durationSeconds < 60) return;
  try {
    await request<{ ok: true; submittedAt: string }>('/sessions', {
      method: 'POST',
      body: buildPayload(session),
      headers: { authorization: `Bearer ${auth.jwt}` },
      timeoutMs: budgetMs,
    });
  } catch (e) {
    // A stale access token gets renewed by the next flush; only a legacy
    // record with no refresh token is dropped here, so a fresh login retries.
    if (e instanceof ApiError && e.status === 401 && !auth.refreshToken) clearAuth();
  }
}

export async function flushPendingSubmissions(budgetMs: number): Promise<void> {
  let auth: AuthRecord | null = readAuth();
  if (!auth) return;

  const deadline = Date.now() + budgetMs;

  // Proactive renewal when the access token is close to expiry. A failed
  // renewal falls through with the current jwt, which may still be valid.
  const exp = jwtExpiresAtMs(auth.jwt);
  if (auth.refreshToken && exp !== null && exp - Date.now() < RENEW_BEFORE_MS) {
    auth = await refreshAuth(auth, Math.min(budgetMs, 3000));
    if (!auth) return; // refresh rejected: local auth already cleared
  }

  const pending = getSessions()
    .filter((s) => !s.submittedAt && s.exitCode !== -1 && s.durationSeconds >= 60)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  let renewedOnce = false;
  for (let i = 0; i < pending.length; i++) {
    const session = pending[i];
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    const perRequest = Math.min(remaining, 1500);
    try {
      await request<{ ok: true; submittedAt: string }>('/sessions', {
        method: 'POST',
        body: buildPayload(session),
        headers: { authorization: `Bearer ${auth.jwt}` },
        timeoutMs: perRequest,
      });
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
          clearAuth();
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
