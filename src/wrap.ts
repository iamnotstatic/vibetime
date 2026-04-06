import { spawn } from 'node:child_process';
import { v4 as uuidv4 } from 'uuid';
import { addSession, type Session } from './db.js';
import { isGitRepo, getHeadSha, getBranch, getProjectName, getDiffStats } from './git.js';
import { readConfig } from './config.js';
import { scoreSession } from './score.js';
import { renderEndcard } from './render.js';

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

  // let the child handle signals; parent waits for close
  let interrupted = false;
  const trapSignal = () => { interrupted = true; };
  process.on('SIGINT', trapSignal);
  process.on('SIGTERM', trapSignal);

  const child = spawn(tool, args, {
    stdio: 'inherit',
    env: { ...process.env, VIBE_SESSION: '1' },
  });

  child.on('error', (err) => {
    console.error(`  vibe: failed to start ${tool}: ${err.message}`);
    process.exit(127);
  });

  child.on('close', async (code) => {
    process.removeListener('SIGINT', trapSignal);
    process.removeListener('SIGTERM', trapSignal);

    const exitCode = interrupted ? (code ?? 130) : (code ?? 1);
    const endedAt = new Date().toISOString();
    const durationSeconds = Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000);

    let diffStats = { commits: 0, linesAdded: 0, linesRemoved: 0, filesTouched: 0 };
    if (hasGit) {
      const endSha = getHeadSha(cwd);
      diffStats = getDiffStats(startSha, endSha, cwd);
    }

    const momentum = scoreSession({ ...diffStats, exitCode }, readConfig());

    const session: Session = {
      id: uuidv4(),
      tool, project, branch,
      startedAt, endedAt, durationSeconds,
      ...diffStats,
      momentum, exitCode,
    };

    try { await addSession(session); } catch {}

    console.log(renderEndcard(session));
    process.exit(exitCode);
  });
}
