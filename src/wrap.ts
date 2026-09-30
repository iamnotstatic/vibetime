import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { addSession, claimSession, updateSession, deleteSession, INACTIVITY_TIMEOUT_MS, type Session } from './db.js';
import { baselineRepos, describeRepos, getReposDiffStats, getReposFingerprint, type RepoBaseline } from './git.js';
import { refreshAndReap } from './rescore.js';
import { readConfig } from './config.js';
import { scoreSession, trackShipEvents, type ShipEventState } from './score.js';
import { renderEndcard, renderSignedOutNotice, renderUpgradeNotice } from './render.js';
import { needsLogin, commitIdentities } from './auth.js';
import { reconcileInstall } from './reconcile.js';
import { flushPendingSubmissions, submitInProgress, progressSignature } from './submit.js';
import { TUNABLES, refreshTunables, recommendedUpgrade, recommendedUpgradeReason } from './remote-config.js';
import { PURPLE } from './colors.js';

const POLL_INTERVAL_MS = TUNABLES.pollIntervalMs;
const IN_PROGRESS_SUBMIT_INTERVAL_MS = TUNABLES.inProgressSubmitIntervalMs;
// The poller sends in the background and nobody waits on it, so it can afford
// to outlast a slow server instead of mistaking it for a failure.
const IN_PROGRESS_SUBMIT_BUDGET_MS = 5000;

function reportSpawnError(tool: string, err: NodeJS.ErrnoException): void {
  if (err.code === 'ENOENT') {
    process.stderr.write(`${tool}: command not found\n`);
    return;
  }
  console.error(`  vibe: failed to start ${tool}: ${err.message}`);
}

// Two terminals on one branch are one stream of work. Each would otherwise take
// its own baseline and count the same commits, earning the branch a ship event
// once per window. A different branch keeps its own session: that is the
// parallel workflow this measures, not a duplicate. Finalized and reaped
// sessions are left alone, having already been credited for what they did.
// The project name falls back to a directory basename when a repo has no
// remote, so it alone would merge two unrelated repos that happen to share one.
// The checkout paths are what actually identify the working tree.
function sameCheckout(a: RepoBaseline[] | undefined, b: RepoBaseline[]): boolean {
  if (!a || a.length !== b.length) return false;
  const left = a.map((r) => r.path).sort();
  const right = b.map((r) => r.path).sort();
  return left.every((path, i) => path === right[i]);
}

function sameBranch(open: Session, project: string, branch: string, repos: RepoBaseline[]): boolean {
  return open.project === project && open.branch === branch && sameCheckout(open.repos, repos);
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
  let startedAt = new Date().toISOString();
  // The repo this was launched in, or the repos inside the directory it was
  // launched from. Unlike the Desktop hooks, the wrapper still tracks a
  // directory with no repos at all by wall clock — you invoked it deliberately.
  let repos = baselineRepos(cwd);
  const hasGit = repos.length > 0;
  const { project, branch } = hasGit
    ? describeRepos(repos, cwd)
    : { project: cwd.split('/').pop() || 'unknown', branch: 'unknown' };
  const config = readConfig();
  let sessionId: string = randomUUID();
  let lastActivityAt = startedAt;
  let totalGapMs = 0;
  let idleSince = 0;

  // Repair the install before anything else: a new default tool or a newly
  // supported desktop app reaches existing users here, not by them re-running
  // a command they have no reason to know about. Stays ahead of the spawn: it
  // rewrites the hook settings the child reads on its own startup.
  reconcileInstall();

  // Refresh the server tunables in the background; whatever it fetches applies
  // to the next session, never this one mid-flight.
  refreshTunables().catch(() => {});

  let eventState: ShipEventState = {};

  function snapshot(exitCode: number): Pick<Session, 'endedAt' | 'durationSeconds' | 'commits' | 'linesAdded' | 'linesRemoved' | 'filesTouched' | 'momentum' | 'exitCode' | 'lastActivityAt' | 'shipEvents' | 'eventBaseline'> {
    const endedAt = new Date().toISOString();
    const endMs = new Date(endedAt).getTime();
    const startMs = new Date(startedAt).getTime();
    const effectiveGapMs = totalGapMs + (idleSince ? endMs - idleSince : 0);
    const durationSeconds = Math.round(Math.max(endMs - startMs - effectiveGapMs, 0) / 1000);

    let diffStats = { commits: 0, linesAdded: 0, linesRemoved: 0, filesTouched: 0 };
    if (hasGit) {
      diffStats = getReposDiffStats(repos, commitIdentities());
    }
    const momentum = scoreSession({ ...diffStats, exitCode }, config);
    const tracked = trackShipEvents(eventState, diffStats, config, endMs);
    if (tracked) eventState = tracked;
    return { endedAt, durationSeconds, ...diffStats, momentum, exitCode, lastActivityAt, ...eventState };
  }

  // The tool starts now. Everything below the spawn reads git across every
  // checkout the session watches — and re-reads it for every other open
  // session — which on a repo with dozens of worktrees ran for over ten
  // seconds before the tool got its first byte of stdin. None of it is
  // start-anchored: the baseline above is, and it is already taken.
  const child = spawn(tool, args, {
    stdio: 'inherit',
    env: { ...process.env, VIBE_SESSION: '1' },
  });

  let prevCommits = 0;
  let prevLinesAdded = 0;
  let prevLinesRemoved = 0;
  let prevTreeState = '';
  // Refresh before adding this session: a session that just closed on the same
  // repo is still owed the grace-window work, and an open session here would
  // claim it instead. Never rejects — a fast-exiting tool must still find its
  // session to finalize.
  const ready: Promise<Session> = (async () => {
    await refreshAndReap().catch(() => {});
    let initial = snapshot(-1);
    let session: Session = {
      id: sessionId, tool, project, branch, startedAt,
      ...initial,
      startSha: repos.length === 1 ? repos[0].startSha : '',
      repos,
    };
    try {
      if (hasGit) {
        const claimed = await claimSession(session, (open) => sameBranch(open, project, branch, repos));
        if (claimed.id !== sessionId) {
          // Adopt the baseline, not just the id: counting from this process's
          // own start is what let the same commits land twice.
          sessionId = claimed.id;
          startedAt = claimed.startedAt;
          if (claimed.repos?.length) repos = claimed.repos;
          eventState = { shipEvents: claimed.shipEvents, eventBaseline: claimed.eventBaseline };
          // Duration is recomputed from startedAt on every snapshot, so the
          // idle time the earlier process excluded has to carry over.
          totalGapMs = Math.max(Date.now() - new Date(startedAt).getTime() - claimed.durationSeconds * 1000, 0);
          initial = snapshot(-1);
          await updateSession(sessionId, initial);
          session = { ...claimed, ...initial };
        }
      } else {
        await addSession(session);
      }
    } catch (e) {
      console.error(`  vibe: failed to save session — ${e instanceof Error ? e.message : 'unknown error'}`);
    }
    prevCommits = initial.commits;
    prevLinesAdded = initial.linesAdded;
    prevLinesRemoved = initial.linesRemoved;
    prevTreeState = hasGit ? getReposFingerprint(repos) : '';
    return session;
  })();

  // periodic update while the tool runs — track activity for duration accuracy
  let lastInProgressSubmitAt = 0;
  let acceptedSignature = '';
  const poll = setInterval(async () => {
    try {
      const session = await ready;
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
        // Only resubmit when the payload actually changed. An idle open session
        // otherwise reposts an identical row every 5 minutes forever, and a
        // developer running a dozen sessions at once burned the server's rate
        // guard on nothing, losing the submissions that did matter.
        // A failed send leaves the signature unaccepted, so the next window
        // resends it; the throttle alone keeps that from looping.
        const signature = progressSignature(snap);
        const due = lastInProgressSubmitAt === 0 || Date.now() - lastInProgressSubmitAt >= IN_PROGRESS_SUBMIT_INTERVAL_MS;
        if (due && signature !== acceptedSignature) {
          lastInProgressSubmitAt = Date.now();
          submitInProgress({ ...session, ...snap }, IN_PROGRESS_SUBMIT_BUDGET_MS).then(
            (settled) => { if (settled) acceptedSignature = signature; },
            () => {},
          );
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
    const session = await ready;

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
    // Generous budget on purpose: the session is over and the endcard already
    // printed, so waiting a few seconds here is the difference between a ship
    // that counts and one that sits unsubmitted until some later flush gets
    // lucky. (The desktop hook path stays at 1500ms — editors cap it.)
    await flushPendingSubmissions(8000).catch(() => {});
    if (showEndcard) {
      // After the flush, so a renewal that just succeeded doesn't nag.
      if (needsLogin()) console.log(renderSignedOutNotice());
      const upgrade = recommendedUpgrade();
      if (upgrade) console.log(renderUpgradeNotice(upgrade, recommendedUpgradeReason(upgrade)));
    }
    process.exit(exitCode);
  }

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
      await ready;
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
