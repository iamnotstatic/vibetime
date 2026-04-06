import chalk from 'chalk';
import type { Session } from './db.js';
import { TIER_FILLED, type MomentumTier } from './score.js';
import { PURPLE } from './colors.js';

const DIM = chalk.hex('#444444');
const WIDTH = 47;

export function stripAnsi(str: string): string {
  return str.replace(/\u001B\[[0-9;]*m/g, '');
}

export function pad(str: string, len: number): string {
  return str + ' '.repeat(Math.max(0, len - stripAnsi(str).length));
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h 0m`;
  return `${m}m`;
}

export function truncateProject(name: string, max = 16): string {
  const display = name.includes('/') ? name.split('/').pop()! : name;
  return display.length <= max ? display : display.slice(0, max - 1) + '…';
}

function momentumBar(tier: MomentumTier) {
  const filled = TIER_FILLED[tier];
  return PURPLE('█'.repeat(filled)) + DIM('░'.repeat(10 - filled));
}

function tierLabel(tier: MomentumTier) {
  const icon = tier === 'interrupted' ? '  ⚠' : tier === 'shipped' ? PURPLE('  ✦') : '';
  return `${tier}${icon}`;
}

export function renderEndcard(session: Session): string {
  const project = truncateProject(session.project);
  const duration = formatDuration(session.durationSeconds);
  const tier = session.momentum;

  const headerContent = `  ${PURPLE('◆')} vibe  ·  ${project}  ·  ${duration}`;
  const headerPadded = pad(headerContent, WIDTH - 2);

  const statsContent = session.branch === 'unknown'
    ? `  ${DIM('no git')}`
    : `  ${session.commits} commits  ·  +${session.linesAdded} −${session.linesRemoved}  ·  ${session.filesTouched} files`;
  const statsPadded = pad(statsContent, WIDTH - 2);

  const bar = momentumBar(tier);
  const label = tierLabel(tier);
  const barContent = `  ${bar}  ${label}`;
  const barPadded = pad(barContent, WIDTH - 2);

  const top = DIM('╭' + '─'.repeat(WIDTH - 2) + '╮');
  const sep = DIM('├' + '─'.repeat(WIDTH - 2) + '┤');
  const bot = DIM('╰' + '─'.repeat(WIDTH - 2) + '╯');
  const side = DIM('│');
  const empty = `${side}${' '.repeat(WIDTH - 2)}${side}`;

  return [
    '',
    top,
    `${side}${headerPadded}${side}`,
    sep,
    empty,
    `${side}${statsPadded}${side}`,
    empty,
    `${side}${barPadded}${side}`,
    empty,
    bot,
    '',
  ].join('\n');
}

export function renderStatus(sessions: Session[]): string {
  const now = new Date();
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const dayName = days[now.getDay()];
  const dateStr = `${dayName} ${now.getDate()} ${months[now.getMonth()]}`;

  const header = `${PURPLE('◆')} vibe  ·  today  ·  ${dateStr}`;

  if (sessions.length === 0) {
    return `\n${header}\n\n  no sessions today. start a vibe coding session to begin tracking.\n`;
  }

  const maxProjectLen = Math.max(...sessions.map(s => truncateProject(s.project).length));
  const maxDurationLen = Math.max(...sessions.map(s => formatDuration(s.durationSeconds).length));

  const rows = sessions.map((s) => {
    const project = truncateProject(s.project).padEnd(maxProjectLen);
    const duration = formatDuration(s.durationSeconds).padStart(maxDurationLen);
    const tier = s.momentum;
    const icon = tier === 'interrupted' ? '  ⚠' : tier === 'shipped' ? PURPLE('  ✦') : '';
    return `  ${project}  ${DIM(duration)}   ${s.momentum}${icon}`;
  });

  const totalSeconds = sessions.reduce((sum, s) => sum + s.durationSeconds, 0);
  const shipped = sessions.filter(s => s.momentum === 'shipped').length;
  const total = formatDuration(totalSeconds);
  const summary = `  ${total} total  ·  ${shipped} of ${sessions.length} sessions shipped`;

  return [
    '',
    header,
    '',
    ...rows,
    '',
    `  ${DIM('─'.repeat(37))}`,
    summary,
    '',
  ].join('\n');
}

export function renderLog(sessions: Session[]): string {
  if (sessions.length === 0) {
    return '\n  no sessions recorded yet.\n';
  }

  const lines = sessions.map((s) => {
    const date = new Date(s.startedAt);
    const dateStr = date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }).toLowerCase();
    const project = truncateProject(s.project, 20).padEnd(20);
    const duration = formatDuration(s.durationSeconds).padStart(7);
    const tier = s.momentum;
    return `  ${DIM(dateStr)}  ${project}  ${duration}   ${tier}`;
  });

  return ['\n', ...lines, ''].join('\n');
}
