import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { addSession, updateSession, reapOrphanedSessions, INACTIVITY_TIMEOUT_MS, type Session } from './db.js';
import { isGitRepo, getHeadSha, getBranch, getProjectName, getDiffStats, getWorkingTreeFingerprint } from './git.js';
import { readConfig } from './config.js';
import { scoreSession } from './score.js';
import { renderEndcard } from './render.js';

const POLL_INTERVAL_MS = 30_000;

export async function wrapTool(tool: string, args: string[]): Promise<void> {
  if (process.env.VIBE_SESSION === '1') {
    const child = spawn(tool, args, { stdio: 'inherit' });
    child.on('error', (err) => {
      console.error(`  vibe: failed to start ${tool}: ${err.message}`);
      process.exit(127);
    });
    child.on('close', (code) => process.exit(code ?? 0));
    return;
  }

  const cwd = process.cwd();
  const startedAt = new Date().toISOString();
  const hasGit = isGitRepo(cwd);
  const startSha = hasGit ? getHeadSha(cwd) : '';
  const branch = hasGit ? getBranch(cwd) : 'unknown';
  const project = hasGit ? getProjectName(cwd) : cwd.split('/').pop() || 'unknown';
  const config = readConfig();
  const sessionId = randomUUID();
  let lastActivityAt = startedAt;
  let totalGapMs = 0;
  let idleSince = 0;

  await reapOrphanedSessions();

  function snapshot(exitCode: number): Pick<Session, 'endedAt' | 'durationSeconds' | 'commits' | 'linesAdded' | 'linesRemoved' | 'filesTouched' | 'momentum' | 'exitCode' | 'lastActivityAt'> {
    const endedAt = new Date().toISOString();
    const endMs = new Date(endedAt).getTime();
    const startMs = new Date(startedAt).getTime();
    const effectiveGapMs = totalGapMs + (idleSince ? endMs - idleSince : 0);
    const durationSeconds = Math.round(Math.max(endMs - startMs - effectiveGapMs, 0) / 1000);

    let diffStats = { commits: 0, linesAdded: 0, linesRemoved: 0, filesTouched: 0 };
    if (hasGit) {
      const endSha = getHeadSha(cwd);
      diffStats = getDiffStats(startSha, endSha, cwd);
    }
    const momentum = scoreSession({ ...diffStats, exitCode }, config);
    return { endedAt, durationSeconds, ...diffStats, momentum, exitCode, lastActivityAt };
  }

  // write session immediately so it survives crashes
  const initial = snapshot(-1);
  const session: Session = {
    id: sessionId, tool, project, branch, startedAt,
    ...initial,
  };
  try { await addSession(session); } catch (e) {
    console.error(`  vibe: failed to save session — ${e instanceof Error ? e.message : 'unknown error'}`);
  }

  // periodic update while the tool runs — track activity for duration accuracy
  let prevCommits = initial.commits;
  let prevLinesAdded = initial.linesAdded;
  let prevLinesRemoved = initial.linesRemoved;
  let prevTreeState = hasGit ? getWorkingTreeFingerprint(cwd) : '';
  const poll = setInterval(async () => {
    try {
      const now = Date.now();
      const lastMs = new Date(lastActivityAt).getTime();

      // detect idle period — only when git provides activity signals
      if (hasGit && !idleSince && now - lastMs > INACTIVITY_TIMEOUT_MS) {
        idleSince = lastMs + INACTIVITY_TIMEOUT_MS;
      }

      const snap = snapshot(-1);
      const treeState = hasGit ? getWorkingTreeFingerprint(cwd) : '';
      const treeChanged = treeState !== prevTreeState;
      const hasNewActivity = snap.commits > prevCommits || snap.linesAdded > prevLinesAdded || snap.linesRemoved > prevLinesRemoved || treeChanged;
      if (hasNewActivity) {
        // activity resumed — accumulate any idle gap
        if (idleSince) {
          totalGapMs += now - idleSince;
          idleSince = 0;
        }
        lastActivityAt = new Date().toISOString();
        snap.lastActivityAt = lastActivityAt;
        prevCommits = snap.commits;
        prevLinesAdded = snap.linesAdded;
        prevLinesRemoved = snap.linesRemoved;
        prevTreeState = treeState;
      }
      await updateSession(sessionId, snap);
    } catch {}
  }, POLL_INTERVAL_MS);
  poll.unref();

  // single cleanup path for all exit scenarios
  let cleaned = false;
  async function finalize(exitCode: number, showEndcard: boolean): Promise<void> {
    clearInterval(poll);
    if (cleaned) process.exit(exitCode);
    cleaned = true;

    // accumulate any trailing idle gap (only when git provides activity signals)
    const now = Date.now();
    const lastMs = new Date(lastActivityAt).getTime();
    if (hasGit && !idleSince && now - lastMs > INACTIVITY_TIMEOUT_MS) {
      idleSince = lastMs + INACTIVITY_TIMEOUT_MS;
    }
    if (idleSince) {
      totalGapMs += now - idleSince;
      idleSince = 0;
    }

    const final = snapshot(exitCode);
    try { await updateSession(sessionId, final); } catch (e) {
      console.error(`  vibe: failed to save session — ${e instanceof Error ? e.message : 'unknown error'}`);
    }
    if (showEndcard) console.log(renderEndcard({ ...session, ...final }));
    process.exit(exitCode);
  }

  const child = spawn(tool, args, {
    stdio: 'inherit',
    env: { ...process.env, VIBE_SESSION: '1' },
  });

  // signal handling — registered after spawn so child is defined
  let interrupted = false;
  const forwardSignal = (signal: NodeJS.Signals) => {
    interrupted = true;
    child.kill(signal);
  };
  process.on('SIGINT', forwardSignal);
  process.on('SIGTERM', forwardSignal);
  process.on('SIGHUP', () => finalize(1, false));

  child.on('error', (err) => {
    console.error(`  vibe: failed to start ${tool}: ${err.message}`);
    finalize(127, false);
  });

  child.on('close', (code) => {
    process.removeListener('SIGINT', forwardSignal);
    process.removeListener('SIGTERM', forwardSignal);
    const exitCode = interrupted ? (code ?? 130) : (code ?? 1);
    finalize(exitCode, true);
  });
}
