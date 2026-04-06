import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { addSession, updateSession, type Session } from './db.js';
import { isGitRepo, getHeadSha, getBranch, getProjectName, getDiffStats } from './git.js';
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

  function snapshot(exitCode: number): Pick<Session, 'endedAt' | 'durationSeconds' | 'commits' | 'linesAdded' | 'linesRemoved' | 'filesTouched' | 'momentum' | 'exitCode'> {
    const endedAt = new Date().toISOString();
    const durationSeconds = Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000);
    let diffStats = { commits: 0, linesAdded: 0, linesRemoved: 0, filesTouched: 0 };
    if (hasGit) {
      const endSha = getHeadSha(cwd);
      diffStats = getDiffStats(startSha, endSha, cwd);
    }
    const momentum = scoreSession({ ...diffStats, exitCode }, config);
    return { endedAt, durationSeconds, ...diffStats, momentum, exitCode };
  }

  // write session immediately so it survives crashes
  const initial = snapshot(-1);
  const session: Session = {
    id: sessionId, tool, project, branch, startedAt,
    ...initial,
  };
  try { await addSession(session); } catch {}

  // periodic update while the tool runs
  const poll = setInterval(async () => {
    try { await updateSession(sessionId, snapshot(-1)); } catch {}
  }, POLL_INTERVAL_MS);
  poll.unref();

  // single cleanup path for all exit scenarios
  let cleaned = false;
  async function finalize(exitCode: number, showEndcard: boolean): Promise<void> {
    clearInterval(poll);
    if (cleaned) process.exit(exitCode);
    cleaned = true;
    const final = snapshot(exitCode);
    try { await updateSession(sessionId, final); } catch {}
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
