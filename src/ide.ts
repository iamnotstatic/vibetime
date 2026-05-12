import { randomUUID } from 'node:crypto';
import chalk from 'chalk';
import { addSession, getSessions, reapOrphanedSessions, updateSession, type Session } from './db.js';
import { getBranch, getDiffStats, getHeadSha, getProjectName, isGitRepo } from './git.js';
import { readConfig } from './config.js';
import { scoreSession } from './score.js';
import { renderEndcard, renderStatus } from './render.js';
import { flushPendingSubmissions } from './submit.js';
import { PURPLE } from './colors.js';

const RED = chalk.hex('#EF4444');
const VALID_TOOL_RE = /^[a-z][a-z0-9_-]{0,31}$/i;

type SessionSnapshot = Pick<Session, 'endedAt' | 'durationSeconds' | 'commits' | 'linesAdded' | 'linesRemoved' | 'filesTouched' | 'momentum' | 'exitCode' | 'lastActivityAt'>;

function normalizeTool(tool = 'cursor'): string {
  const normalized = tool.trim().toLowerCase();
  if (!VALID_TOOL_RE.test(normalized)) {
    throw new Error('IDE name must be a single word using letters, numbers, "-" or "_"');
  }
  return normalized;
}

function getActiveIdeSessions(tool?: string): Session[] {
  return getSessions().filter((s) =>
    s.sessionKind === 'ide' &&
    s.exitCode === -1 &&
    (!tool || s.tool.toLowerCase() === tool)
  );
}

function findActiveIdeSession(tool?: string, cwd = process.cwd()): Session | undefined {
  const active = getActiveIdeSessions(tool);
  return active.find((s) => s.cwd === cwd) || (active.length === 1 ? active[0] : undefined);
}

function snapshot(session: Session, exitCode: number): SessionSnapshot {
  const endedAt = new Date().toISOString();
  const startMs = new Date(session.startedAt).getTime();
  const endMs = new Date(endedAt).getTime();
  const durationSeconds = Math.round(Math.max(endMs - startMs, 0) / 1000);

  let diffStats = { commits: 0, linesAdded: 0, linesRemoved: 0, filesTouched: 0 };
  if (session.branch !== 'unknown' && session.cwd && session.startSha && isGitRepo(session.cwd)) {
    const endSha = getHeadSha(session.cwd);
    diffStats = getDiffStats(session.startSha, endSha, session.cwd);
  }

  const changed = diffStats.commits !== session.commits ||
    diffStats.linesAdded !== session.linesAdded ||
    diffStats.linesRemoved !== session.linesRemoved ||
    diffStats.filesTouched !== session.filesTouched;
  const lastActivityAt = changed ? endedAt : session.lastActivityAt;
  const momentum = scoreSession({ ...diffStats, exitCode }, readConfig());

  return { endedAt, durationSeconds, ...diffStats, momentum, exitCode, lastActivityAt };
}

async function refreshIdeSession(session: Session): Promise<Session> {
  const updates = snapshot(session, -1);
  await updateSession(session.id, updates);
  return { ...session, ...updates };
}

export async function refreshActiveIdeSessions(): Promise<void> {
  const active = getActiveIdeSessions();
  for (const session of active) {
    await refreshIdeSession(session).catch(() => {});
  }
}

export async function startIdeSession(toolName = 'cursor'): Promise<void> {
  const tool = normalizeTool(toolName);
  await reapOrphanedSessions();

  const cwd = process.cwd();
  const existing = getActiveIdeSessions(tool).find((s) => s.cwd === cwd);
  if (existing) {
    await refreshIdeSession(existing).catch(() => {});
    console.log(`\n  ${PURPLE('◆')} already tracking ${tool} in ${existing.project}\n`);
    console.log(`  stop it with: vibe ide stop ${tool}\n`);
    return;
  }

  const hasGit = isGitRepo(cwd);
  const startedAt = new Date().toISOString();
  const base: Session = {
    id: randomUUID(),
    tool,
    project: hasGit ? getProjectName(cwd) : cwd.split('/').pop() || 'unknown',
    branch: hasGit ? getBranch(cwd) : 'unknown',
    startedAt,
    endedAt: startedAt,
    durationSeconds: 0,
    commits: 0,
    linesAdded: 0,
    linesRemoved: 0,
    filesTouched: 0,
    momentum: 'idle',
    exitCode: -1,
    lastActivityAt: startedAt,
    sessionKind: 'ide',
    cwd,
    startSha: hasGit ? getHeadSha(cwd) : '',
  };

  await addSession(base);
  console.log(`\n  ${PURPLE('◆')} tracking ${tool} in ${base.project}\n`);
  console.log(`  when you're done: vibe ide stop ${tool}\n`);
}

export async function stopIdeSession(toolName = 'cursor'): Promise<void> {
  const tool = normalizeTool(toolName);
  const session = findActiveIdeSession(tool);
  if (!session) {
    console.log(`\n  ${RED('✗')} no active ${tool} IDE session found\n`);
    console.log(`  start one with: vibe ide start ${tool}\n`);
    return;
  }

  const final = snapshot(session, 0);
  await updateSession(session.id, final);
  const completed = { ...session, ...final };
  console.log(renderEndcard(completed));
  await flushPendingSubmissions(1500).catch(() => {});
}

export async function renderIdeStatus(): Promise<string> {
  const active = getActiveIdeSessions();
  if (active.length === 0) {
    return `\n  ${PURPLE('◆')} no active IDE sessions\n\n  start one with: vibe ide start cursor\n`;
  }

  const refreshed: Session[] = [];
  for (const session of active) {
    refreshed.push(await refreshIdeSession(session));
  }

  return renderStatus(refreshed);
}
