import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { addSession, updateSession, deleteSession, INACTIVITY_TIMEOUT_MS, type Session } from './db.js';
import { baselineRepos, describeRepos, getReposDiffStats, getReposFingerprint } from './git.js';
import { refreshAndReap } from './rescore.js';
import { readConfig } from './config.js';
import { scoreSession, trackShipEvents, type ShipEventState } from './score.js';
import { renderEndcard } from './render.js';
import { flushPendingSubmissions, submitInProgress } from './submit.js';
import { getRecommendedVersion } from './api.js';
import { TUNABLES, refreshTunables } from './remote-config.js';
import { PURPLE } from './colors.js';

const POLL_INTERVAL_MS = TUNABLES.pollIntervalMs;
const IN_PROGRESS_SUBMIT_INTERVAL_MS = TUNABLES.inProgressSubmitIntervalMs;

function reportSpawnError(tool: string, err: NodeJS.ErrnoException): void {
  if (err.code === 'ENOENT') {
    process.stderr.write(`${tool}: command not found\n`);
    return;
  }
  console.error(`  vibe: failed to start ${tool}: ${err.message}`);
}

export async function wrapTool(tool: string, args: string[]): Promise<void> {
  if (process.env.VIBE_SESSION === '1') {
    const child = spawn(tool, args, { stdio: 'inherit' });
    child.on('error', (err: NodeJS.ErrnoException) => {
      reportSpawnError(tool, err);
      process.exit(127);
    });
    child.on('close', (code) => process.exit(code ?? 0));
    return;
  }

  const cwd = process.cwd();
  const startedAt = new Date().toISOString();
  // The repo this was launched in, or the repos inside the directory it was
  // launched from. Unlike the Desktop hooks, the wrapper still tracks a
  // directory with no repos at all by wall clock — you invoked it deliberately.
  const repos = baselineRepos(cwd);
  const hasGit = repos.length > 0;
  const { project, branch } = hasGit
    ? describeRepos(repos, cwd)
    : { project: cwd.split('/').pop() || 'unknown', branch: 'unknown' };
  const config = readConfig();
  const sessionId = randomUUID();
  let lastActivityAt = startedAt;
  let totalGapMs = 0;
  let idleSince = 0;

  // Refresh the server tunables in the background; whatever it fetches applies
  // to the next session, never this one mid-flight.
  refreshTunables().catch(() => {});

  await refreshAndReap();

  let eventState: ShipEventState = {};

  function snapshot(exitCode: number): Pick<Session, 'endedAt' | 'durationSeconds' | 'commits' | 'linesAdded' | 'linesRemoved' | 'filesTouched' | 'momentum' | 'exitCode' | 'lastActivityAt' | 'shipEvents' | 'eventBaseline'> {
    const endedAt = new Date().toISOString();
    const endMs = new Date(endedAt).getTime();
    const startMs = new Date(startedAt).getTime();
    const effectiveGapMs = totalGapMs + (idleSince ? endMs - idleSince : 0);
    const durationSeconds = Math.round(Math.max(endMs - startMs - effectiveGapMs, 0) / 1000);

    let diffStats = { commits: 0, linesAdded: 0, linesRemoved: 0, filesTouched: 0 };
    if (hasGit) {
      diffStats = getReposDiffStats(repos);
    }
    const momentum = scoreSession({ ...diffStats, exitCode }, config);
    const tracked = trackShipEvents(eventState, diffStats, config, endMs);
    if (tracked) eventState = tracked;
    return { endedAt, durationSeconds, ...diffStats, momentum, exitCode, lastActivityAt, ...eventState };
  }

  // write session immediately so it survives crashes
  const initial = snapshot(-1);
  const session: Session = {
    id: sessionId, tool, project, branch, startedAt,
    ...initial,
    startSha: repos.length === 1 ? repos[0].startSha : '',
    repos,
  };
  try { await addSession(session); } catch (e) {
    console.error(`  vibe: failed to save session — ${e instanceof Error ? e.message : 'unknown error'}`);
  }

  // periodic update while the tool runs — track activity for duration accuracy
  let prevCommits = initial.commits;
  let prevLinesAdded = initial.linesAdded;
  let prevLinesRemoved = initial.linesRemoved;
  let prevTreeState = hasGit ? getReposFingerprint(repos) : '';
  let lastInProgressSubmitAt = 0;
  const poll = setInterval(async () => {
    try {
      const now = Date.now();
      const lastMs = new Date(lastActivityAt).getTime();

      // detect idle period — only when git provides activity signals
      if (hasGit && !idleSince && now - lastMs > INACTIVITY_TIMEOUT_MS) {
        idleSince = lastMs + INACTIVITY_TIMEOUT_MS;
      }

      const snap = snapshot(-1);
      const treeState = hasGit ? getReposFingerprint(repos) : '';
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

      if (snap.momentum === 'shipped') {
        const sinceLast = Date.now() - lastInProgressSubmitAt;
        if (lastInProgressSubmitAt === 0 || sinceLast >= IN_PROGRESS_SUBMIT_INTERVAL_MS) {
          lastInProgressSubmitAt = Date.now();
          submitInProgress({ ...session, ...snap }).catch(() => {});
        }
      }
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
    await flushPendingSubmissions(1500).catch(() => {});
    if (showEndcard) {
      const recommended = getRecommendedVersion();
      if (recommended) {
        console.log(`  ${PURPLE('◆')} vibe ${recommended} available · run: npm i -g vibetime-cli\n`);
      }
    }
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

  child.on('error', async (err: NodeJS.ErrnoException) => {
    reportSpawnError(tool, err);
    if (err.code === 'ENOENT') {
      try { await deleteSession(sessionId); } catch {}
    }
    finalize(127, false);
  });

  child.on('close', (code) => {
    process.removeListener('SIGINT', forwardSignal);
    process.removeListener('SIGTERM', forwardSignal);
    const exitCode = interrupted ? (code ?? 130) : (code ?? 1);
    finalize(exitCode, true);
  });
}
