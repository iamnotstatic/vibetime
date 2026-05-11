import { createHash } from 'node:crypto';
import { getSessions, updateSession, type Session } from './db.js';
import { readAuth, clearAuth } from './auth.js';
import { request, ApiError } from './api.js';

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
  };
}

export async function flushPendingSubmissions(budgetMs: number): Promise<void> {
  const auth = readAuth();
  if (!auth) return;

  const deadline = Date.now() + budgetMs;
  const pending = getSessions()
    .filter((s) => !s.submittedAt && s.exitCode !== -1 && s.durationSeconds >= 60)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  for (const session of pending) {
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
          // auth is bad: drop the token, leave sessions unsubmitted so a fresh login retries them
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
