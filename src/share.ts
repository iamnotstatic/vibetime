import chalk from 'chalk';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Session } from './db.js';
import { VIBE_DIR, getHandle, readConfig, promptHandle } from './config.js';
import { formatDuration, pad, truncateProject } from './render.js';
import { PURPLE } from './colors.js';

const PURPLE_MED = chalk.hex('#6D28D9');
const PURPLE_DARK = chalk.hex('#4C1D95');
const DIM = chalk.hex('#444444');
const DARK = chalk.hex('#222222');
const WIDTH = 52;

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getWeekRange() {
  const now = new Date();
  const day = now.getDay();
  const diff = day === 0 ? 6 : day - 1;
  const monday = new Date(now);
  monday.setDate(now.getDate() - diff);
  monday.setHours(0, 0, 0, 0);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);

  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const label = `week of ${monday.getDate()} ${months[monday.getMonth()]}`;

  return { start: monday, end: sunday, label };
}

function getWeekSessions(sessions: Session[]) {
  const { start, end } = getWeekRange();
  return sessions.filter((s) => {
    const d = new Date(s.startedAt);
    return d >= start && d <= end;
  });
}

interface TierTime {
  shipped: number;
  progressed: number;
  tinkering: number;
  exploring: number;
  idle: number;
  interrupted: number;
}

function getTierTimes(sessions: Session[]) {
  const times: TierTime = { shipped: 0, progressed: 0, tinkering: 0, exploring: 0, idle: 0, interrupted: 0 };
  for (const s of sessions) {
    const tier = s.momentum;
    if (tier in times) times[tier] += s.durationSeconds;
  }
  return times;
}

function getTopProjects(sessions: Session[]): { project: string; totalSeconds: number; hasShipped: boolean }[] {
  const timeMap = new Map<string, number>();
  const shippedMap = new Map<string, boolean>();
  for (const s of sessions) {
    timeMap.set(s.project, (timeMap.get(s.project) || 0) + s.durationSeconds);
    if (s.momentum === 'shipped') shippedMap.set(s.project, true);
  }
  return Array.from(timeMap.entries())
    .map(([project, totalSeconds]) => ({ project, totalSeconds, hasShipped: shippedMap.get(project) || false }))
    .sort((a, b) => b.totalSeconds - a.totalSeconds || a.project.localeCompare(b.project));
}

function getActivityDate(s: Session): string {
  if (s.lastActivityAt) return s.lastActivityAt;
  return s.exitCode !== -1 ? s.endedAt : s.startedAt;
}

function getStreak(sessions: Session[]) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const dots: ('shipped' | 'missed' | 'today')[] = [];
  for (let i = 6; i >= 0; i--) {
    const day = new Date(today);
    day.setDate(today.getDate() - i);
    const nextDay = new Date(day);
    nextDay.setDate(day.getDate() + 1);

    // completed sessions — credit by startedAt
    const hasCompleted = sessions.some((s) => {
      if (s.exitCode === -1) return false;
      const d = new Date(s.startedAt);
      return d >= day && d < nextDay && (s.momentum === 'shipped' || s.momentum === 'progressed');
    });

    // active sessions — credit by lastActivityAt
    const hasActive = !hasCompleted && sessions.some((s) => {
      if (s.exitCode !== -1) return false;
      const d = new Date(getActivityDate(s));
      return d >= day && d < nextDay;
    });

    if (hasCompleted || hasActive) {
      dots.push('shipped');
    } else if (i === 0) {
      dots.push('today');
    } else {
      dots.push('missed');
    }
  }

  const shippedToday = dots[6] === 'shipped';
  const shippedYesterday = dots[5] === 'shipped';
  const shippedDays = dots.filter(d => d === 'shipped').length;

  let count = 0;
  for (let i = dots.length - 1; i >= 0; i--) {
    if (dots[i] === 'shipped') count++;
    else break;
  }

  return { dots, count, shippedToday, shippedYesterday, shippedDays };
}

export async function renderTerminalCard(sessions: Session[]): Promise<string> {
  const config = readConfig();
  const handle = config.handle ? getHandle() : process.stdin.isTTY ? await promptHandle() : getHandle();

  const week = getWeekRange();
  const weekSessions = getWeekSessions(sessions);
  const totalSeconds = weekSessions.reduce((sum, s) => sum + s.durationSeconds, 0);
  const tierTimes = getTierTimes(weekSessions);
  const topProjects = getTopProjects(weekSessions);
  const streak = getStreak(sessions);

  const displayHandle = handle.length > 13 ? handle.slice(0, 12) + '…' : handle;
  const headerContent = `  ${PURPLE('◆')} vibetime  ·  @${displayHandle}  ·  ${week.label}`;
  const headerPadded = pad(headerContent, WIDTH - 2);

  const mainStat = `  ${formatDuration(totalSeconds)}  across  ${weekSessions.length} sessions`;
  const mainStatPadded = pad(mainStat, WIDTH - 2);

  const totalTime = tierTimes.shipped + tierTimes.progressed + tierTimes.tinkering + tierTimes.exploring + tierTimes.idle + tierTimes.interrupted;
  const barTotal = 32;
  let segments = [0, 0, 0, 0];
  if (totalTime > 0) {
    const raw = [
      tierTimes.shipped,
      tierTimes.progressed,
      tierTimes.tinkering,
      tierTimes.idle + tierTimes.exploring + tierTimes.interrupted,
    ].map(t => (t / totalTime) * barTotal);
    segments = raw.map(v => Math.floor(v));
    let remainder = barTotal - segments.reduce((a, b) => a + b, 0);
    const fractional = raw.map((v, i) => ({ i, f: v - segments[i] })).sort((a, b) => b.f - a.f);
    for (let j = 0; j < remainder; j++) segments[fractional[j].i]++;
  }
  const [shippedBlocks, progressedBlocks, tinkeringBlocks, darkBlocks] = segments;
  const emptyBlocks = barTotal - shippedBlocks - progressedBlocks - tinkeringBlocks - darkBlocks;

  const bar = PURPLE('█'.repeat(shippedBlocks)) +
    PURPLE_MED('█'.repeat(progressedBlocks)) +
    PURPLE_DARK('█'.repeat(tinkeringBlocks)) +
    DARK('█'.repeat(darkBlocks)) +
    DIM('░'.repeat(Math.max(0, emptyBlocks)));
  const barLine = `  ${bar}`;
  const barPadded = pad(barLine, WIDTH - 2);

  const shippedCount = weekSessions.filter(s => s.momentum === 'shipped').length;
  const progressedCount = weekSessions.filter(s => s.momentum === 'progressed').length;
  const tinkeringCount = weekSessions.filter(s => s.momentum === 'tinkering').length;
  const legendLine = `  shipped ×${shippedCount}   progressed ×${progressedCount}   tinkering ×${tinkeringCount}`;
  const legendPadded = pad(legendLine, WIDTH - 2);

  const side = DIM('│');
  const top = DIM('╭' + '─'.repeat(WIDTH - 2) + '╮');
  const bot = DIM('╰' + '─'.repeat(WIDTH - 2) + '╯');
  const empty = `${side}${' '.repeat(WIDTH - 2)}${side}`;

  const topSection: string[] = [];
  if (topProjects.length > 0) {
    const topLabel = `  ${DIM('top projects')}`;
    topSection.push(`${side}${pad(topLabel, WIDTH - 2)}${side}`);
    const shown = topProjects.slice(0, 3);
    const timeCol = 36;
    for (const p of shown) {
      const name = truncateProject(p.project, 16);
      const time = formatDuration(p.totalSeconds);
      const shipped = p.hasShipped ? `  ${PURPLE('✦')}` : '';
      const gap = ' '.repeat(Math.max(1, timeCol - 4 - name.length - time.length));
      const row = `    ${name}${gap}${time}${shipped}`;
      topSection.push(`${side}${pad(row, WIDTH - 2)}${side}`);
    }
    const moreCount = topProjects.length - 3;
    if (moreCount > 0) {
      const moreLine = `    ${DIM(`+${moreCount} more`)}`;
      topSection.push(`${side}${pad(moreLine, WIDTH - 2)}${side}`);
    }
  }

  const streakDots = streak.dots.map(d => {
    if (d === 'shipped') return PURPLE('◆');
    if (d === 'today') return PURPLE_DARK('◉');
    return DIM('◇');
  }).join(' ');
  let streakLabel: string;
  if (streak.count === 7) {
    streakLabel = `perfect week ${PURPLE('✦')}`;
  } else if (streak.shippedYesterday && !streak.shippedToday) {
    streakLabel = '⏳';
  } else if (streak.count > 0) {
    const dayLabel = streak.count === 1 ? 'day' : 'days';
    streakLabel = `${streak.count} ${dayLabel} shipping`;
  } else if (streak.shippedDays > 0) {
    const dayLabel = streak.shippedDays === 1 ? 'day' : 'days';
    streakLabel = `${streak.shippedDays} ${dayLabel} shipped this week`;
  } else {
    streakLabel = '0 days shipping';
  }
  const streakLine = `  streak  ${streakDots}  ${streakLabel}`;
  const streakPadded = pad(streakLine, WIDTH - 2);

  return [
    '',
    top,
    `${side}${headerPadded}${side}`,
    empty,
    `${side}${mainStatPadded}${side}`,
    empty,
    `${side}${barPadded}${side}`,
    `${side}${legendPadded}${side}`,
    ...(topSection.length > 0 ? [empty, ...topSection] : []),
    empty,
    `${side}${streakPadded}${side}`,
    empty,
    bot,
    '',
    `  ${DIM('[ h ]')} open HTML card   ${DIM('[ enter ]')} done`,
    '',
  ].join('\n');
}

export function generateHtmlCard(sessions: Session[]): string {
  const config = readConfig();
  const handle = config.handle || getHandle();
  const week = getWeekRange();
  const weekSessions = getWeekSessions(sessions);
  const totalSeconds = weekSessions.reduce((sum, s) => sum + s.durationSeconds, 0);
  const tierTimes = getTierTimes(weekSessions);
  const topProjects = getTopProjects(weekSessions);
  const streak = getStreak(sessions);

  const totalTime = tierTimes.shipped + tierTimes.progressed + tierTimes.tinkering + tierTimes.exploring + tierTimes.idle + tierTimes.interrupted;
  const pct = (v: number) => totalTime > 0 ? ((v / totalTime) * 100).toFixed(1) : '0';

  const shippedCount = weekSessions.filter(s => s.momentum === 'shipped').length;
  const progressedCount = weekSessions.filter(s => s.momentum === 'progressed').length;
  const tinkeringCount = weekSessions.filter(s => s.momentum === 'tinkering').length;

  const streakDots = streak.dots.map(d => {
    const color = d === 'shipped' ? '#7C3AED' : d === 'today' ? '#4C1D95' : '#1e1e1e';
    return `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin:0 3px;"></span>`;
  }).join('');

  let streakLabel: string;
  if (streak.count === 7) {
    streakLabel = 'perfect week ✦';
  } else if (streak.shippedYesterday && !streak.shippedToday) {
    streakLabel = '⏳';
  } else if (streak.count > 0) {
    const dayLabel = streak.count === 1 ? 'day' : 'days';
    streakLabel = `${streak.count} ${dayLabel} shipping`;
  } else if (streak.shippedDays > 0) {
    const dayLabel = streak.shippedDays === 1 ? 'day' : 'days';
    streakLabel = `${streak.shippedDays} ${dayLabel} shipped this week`;
  } else {
    streakLabel = '0 days shipping';
  }

  let topProjectsHtml = '';
  if (topProjects.length > 0) {
    const shown = topProjects.slice(0, 3);
    const moreCount = topProjects.length - 3;
    const projectRows = shown.map((p, i) => {
      const name = escapeHtml(truncateProject(p.project, 24));
      const timeColor = p.hasShipped ? '#7C3AED' : '#fff';
      const shipped = p.hasShipped ? ' <span style="color:#7C3AED;">✦</span>' : '';
      const borderTop = i > 0 ? 'border-top: 0.5px solid #1e1e1e; padding-top: 8px; margin-top: 8px;' : '';
      return `      <div style="display:flex;justify-content:space-between;align-items:center;${borderTop}">
        <span style="color:#ccc;font-size:13px;">${name}</span>
        <span style="color:${timeColor};font-size:14px;font-weight:500;">${formatDuration(p.totalSeconds)}${shipped}</span>
      </div>`;
    }).join('\n');
    const moreRow = moreCount > 0
      ? `\n      <div style="border-top:0.5px solid #1e1e1e;padding-top:8px;margin-top:8px;color:#444;font-size:11px;">+${moreCount} more</div>`
      : '';
    topProjectsHtml = `  <div class="top-projects">
    <div class="top-projects-label">top projects</div>
${projectRows}${moreRow}
  </div>`;
  }
  const safeHandle = escapeHtml(handle);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>vibetime - @${safeHandle}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #111;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  }
  .card {
    width: 380px;
    background: #0d0d0d;
    border-radius: 16px;
    padding: 28px;
    border: 0.5px solid #222;
  }
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 24px;
  }
  .header-left { display: flex; align-items: center; gap: 6px; }
  .diamond { color: #7C3AED; font-size: 14px; }
  .brand { color: #999; font-size: 14px; }
  .handle { color: #444; font-size: 13px; }
  .main-label { color: #444; font-size: 11px; text-transform: uppercase; margin-bottom: 4px; }
  .main-value { color: #fff; font-size: 48px; font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace; line-height: 1.1; }
  .main-sub { color: #444; font-size: 12px; margin-top: 4px; margin-bottom: 20px; }
  .bar-container { height: 6px; border-radius: 3px; overflow: hidden; display: flex; margin-bottom: 8px; }
  .bar-segment { height: 100%; }
  .legend { display: flex; gap: 12px; margin-bottom: 20px; }
  .legend-item { display: flex; align-items: center; gap: 4px; color: #555; font-size: 11px; }
  .legend-dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; }
  .stats { display: grid; grid-template-columns: 1fr 1fr 1fr; border: 0.5px solid #1e1e1e; border-radius: 8px; margin-bottom: 16px; }
  .stat-cell { padding: 12px; text-align: center; }
  .stat-cell:not(:last-child) { border-right: 0.5px solid #1e1e1e; }
  .stat-value { font-size: 20px; margin-bottom: 2px; }
  .stat-label { color: #444; font-size: 10px; text-transform: uppercase; }
  .top-projects { background: #111; border-radius: 8px; padding: 12px; margin-bottom: 16px; }
  .top-projects-label { color: #444; font-size: 11px; text-transform: uppercase; margin-bottom: 8px; }
  .streak { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0; }
  .streak-label { color: #444; font-size: 11px; }
  .streak-right { display: flex; align-items: center; gap: 8px; }
  .streak-count { color: #7C3AED; font-size: 11px; }
  .copy-btn {
    display: block;
    margin: 20px auto 0;
    background: #1a1a1a;
    border: 0.5px solid #333;
    border-radius: 8px;
    padding: 10px 24px;
    font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
    font-size: 13px;
    color: #999;
    cursor: pointer;
    transition: background 0.2s;
  }
  .copy-btn:hover { background: #222; }
  .footer {
    border-top: 0.5px solid #1a1a1a;
    padding-top: 16px;
    margin-top: 20px;
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    color: #333;
  }
</style>
</head>
<body>
<div class="card" id="card">
  <div class="header">
    <div class="header-left">
      <span class="diamond">◆</span>
      <span class="brand">vibetime</span>
    </div>
    <span class="handle">@${safeHandle}</span>
  </div>
  <div class="main-label">this week</div>
  <div class="main-value">${formatDuration(totalSeconds)}</div>
  <div class="main-sub">across ${weekSessions.length} sessions</div>
  <div class="bar-container">
    <div class="bar-segment" style="width:${pct(tierTimes.shipped)}%;background:#7C3AED;"></div>
    <div class="bar-segment" style="width:${pct(tierTimes.progressed)}%;background:#9F67F5;"></div>
    <div class="bar-segment" style="width:${pct(tierTimes.tinkering)}%;background:#C4A8F8;"></div>
    <div class="bar-segment" style="width:${pct(tierTimes.idle + tierTimes.exploring + tierTimes.interrupted)}%;background:#2a2a2a;"></div>
  </div>
  <div class="legend">
    <div class="legend-item"><span class="legend-dot" style="background:#7C3AED;"></span>shipped</div>
    <div class="legend-item"><span class="legend-dot" style="background:#9F67F5;"></span>progressed</div>
    <div class="legend-item"><span class="legend-dot" style="background:#C4A8F8;"></span>tinkering</div>
    <div class="legend-item"><span class="legend-dot" style="background:#2a2a2a;"></span>idle</div>
  </div>
  <div class="stats">
    <div class="stat-cell">
      <div class="stat-value" style="color:#7C3AED;">${shippedCount}</div>
      <div class="stat-label">shipped</div>
    </div>
    <div class="stat-cell">
      <div class="stat-value" style="color:#fff;">${progressedCount}</div>
      <div class="stat-label">progressed</div>
    </div>
    <div class="stat-cell">
      <div class="stat-value" style="color:#fff;">${tinkeringCount}</div>
      <div class="stat-label">tinkering</div>
    </div>
  </div>
${topProjectsHtml}
  <div class="streak">
    <span class="streak-label">shipping streak</span>
    <div class="streak-right">
      ${streakDots}
      <span class="streak-count">${streakLabel}</span>
    </div>
  </div>
  <div class="footer">
    <span>◆ vibetime.sh</span>
    <span>vibetime.sh/@${safeHandle}</span>
  </div>
</div>
<button class="copy-btn" id="copyBtn" onclick="copyCard()">copy card</button>
<script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"><\/script>
<script>
async function copyCard() {
  const btn = document.getElementById('copyBtn');
  btn.textContent = 'copying...';
  try {
    const canvas = await html2canvas(document.getElementById('card'), {
      backgroundColor: '#0d0d0d',
      scale: 2,
    });
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    btn.textContent = 'copied ✓';
    setTimeout(() => { btn.textContent = 'copy card'; }, 2000);
  } catch (e) {
    btn.textContent = 'right-click the card and save as image';
    setTimeout(() => { btn.textContent = 'copy card'; }, 4000);
  }
}
<\/script>
</body>
</html>`;
}

export function writeHtmlCard(sessions: Session[]): string {
  const html = generateHtmlCard(sessions);
  const outPath = join(VIBE_DIR, 'share-card.html');
  writeFileSync(outPath, html);
  return outPath;
}
