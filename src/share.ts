import chalk from 'chalk';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Session } from './db.js';
import { VIBE_DIR, getHandle, readConfig, promptHandle } from './config.js';
import { formatDuration, stripAnsi, pad } from './render.js';
import type { MomentumTier } from './score.js';

const PURPLE = chalk.hex('#7C3AED');
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
    const tier = s.momentum as MomentumTier;
    if (tier in times) times[tier] += s.durationSeconds;
  }
  return times;
}

function getTopProject(sessions: Session[]) {
  const map = new Map<string, number>();
  for (const s of sessions) {
    map.set(s.project, (map.get(s.project) || 0) + s.durationSeconds);
  }
  let top = { name: 'none', seconds: 0 };
  for (const [name, seconds] of map) {
    if (seconds > top.seconds) top = { name, seconds };
  }
  return top;
}

function getStreak(sessions: Session[]) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const dots: boolean[] = [];
  for (let i = 6; i >= 0; i--) {
    const day = new Date(today);
    day.setDate(today.getDate() - i);
    const nextDay = new Date(day);
    nextDay.setDate(day.getDate() + 1);

    const hasShipping = sessions.some((s) => {
      const d = new Date(s.startedAt);
      return d >= day && d < nextDay && (s.momentum === 'shipped' || s.momentum === 'progressed');
    });
    dots.push(hasShipping);
  }

  let count = 0;
  for (let i = dots.length - 1; i >= 0; i--) {
    if (dots[i]) count++;
    else break;
  }

  return { dots, count };
}

export async function renderTerminalCard(sessions: Session[]): Promise<string> {
  const config = readConfig();
  const handle = config.handle ? getHandle() : await promptHandle();

  const week = getWeekRange();
  const weekSessions = getWeekSessions(sessions);
  const totalSeconds = weekSessions.reduce((sum, s) => sum + s.durationSeconds, 0);
  const tierTimes = getTierTimes(weekSessions);
  const topProject = getTopProject(weekSessions);
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

  const topName = topProject.name.length > 20 ? topProject.name.slice(0, 19) + '…' : topProject.name;
  const topLine = `  top project  ${topName}  ${formatDuration(topProject.seconds)}`;
  const topPadded = pad(topLine, WIDTH - 2);

  const streakDots = streak.dots.map(d => d ? PURPLE('◆') : DIM('◇')).join(' ');
  const streakLine = `  streak  ${streakDots}  ${streak.count} days shipping`;
  const streakPadded = pad(streakLine, WIDTH - 2);

  const side = DIM('│');
  const top = DIM('╭' + '─'.repeat(WIDTH - 2) + '╮');
  const bot = DIM('╰' + '─'.repeat(WIDTH - 2) + '╯');
  const empty = `${side}${' '.repeat(WIDTH - 2)}${side}`;

  return [
    '',
    top,
    `${side}${headerPadded}${side}`,
    empty,
    `${side}${mainStatPadded}${side}`,
    empty,
    `${side}${barPadded}${side}`,
    `${side}${legendPadded}${side}`,
    empty,
    `${side}${topPadded}${side}`,
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
  const topProject = getTopProject(weekSessions);
  const streak = getStreak(sessions);

  const totalTime = tierTimes.shipped + tierTimes.progressed + tierTimes.tinkering + tierTimes.exploring + tierTimes.idle + tierTimes.interrupted;
  const pct = (v: number) => totalTime > 0 ? ((v / totalTime) * 100).toFixed(1) : '0';

  const shippedCount = weekSessions.filter(s => s.momentum === 'shipped').length;
  const progressedCount = weekSessions.filter(s => s.momentum === 'progressed').length;
  const tinkeringCount = weekSessions.filter(s => s.momentum === 'tinkering').length;

  const streakDots = streak.dots.map(d =>
    `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${d ? '#7C3AED' : '#1e1e1e'};margin:0 3px;"></span>`
  ).join('');

  const topName = escapeHtml(topProject.name.length > 24 ? topProject.name.slice(0, 23) + '…' : topProject.name);
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
  .top-project { background: #111; border-radius: 8px; padding: 12px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
  .top-label { color: #444; font-size: 11px; }
  .top-name { color: #ccc; font-size: 13px; margin-top: 2px; }
  .top-time { color: #7C3AED; font-size: 14px; font-weight: 500; }
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
  <div class="top-project">
    <div>
      <div class="top-label">top project</div>
      <div class="top-name">${topName}</div>
    </div>
    <div class="top-time">${formatDuration(topProject.seconds)}</div>
  </div>
  <div class="streak">
    <span class="streak-label">shipping streak</span>
    <div class="streak-right">
      ${streakDots}
      <span class="streak-count">${streak.count} days shipping</span>
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
    btn.textContent = 'copy failed';
    setTimeout(() => { btn.textContent = 'copy card'; }, 2000);
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
