import type { HeatmapDay, LeaderboardData } from '../routes/leaderboard.js';

type Window = 'week' | 'month' | 'all';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function relativeTime(iso: string, now: Date): string {
  const diffMs = now.getTime() - Date.parse(iso);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return iso.slice(0, 10);
}

function heatmapCells(recent: HeatmapDay[]): string {
  return recent.map(({ day, n }) => {
    const cls = n === 0 ? 'cell-0' : n === 1 ? 'cell-1' : n <= 3 ? 'cell-2' : 'cell-3';
    const noun = n === 1 ? 'ship' : 'ships';
    return `<span class="cell ${cls}" title="${escapeHtml(day)} · ${n} ${noun}" aria-hidden="true"></span>`;
  }).join('');
}

function tab(label: string, value: Window, active: Window): string {
  const cls = value === active ? 'tab tab-active' : 'tab';
  return `<a class="${cls}" href="/leaderboard?window=${value}">${escapeHtml(label)}</a>`;
}

const SCALE_WINDOW_LABEL: Record<Window, string> = {
  week: 'this week',
  month: 'this month',
  all: 'all-time',
};

// The calendar week can straddle a month boundary (a Monday start in the old
// month), which makes "this week" occasionally show more developers than "this
// month". Spelling out the window's dates keeps that from reading as a bug.
function windowRange(start: Date, now: Date): string {
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const from = `${months[start.getUTCMonth()]} ${start.getUTCDate()}`;
  const to = start.getUTCMonth() === now.getUTCMonth()
    ? `${now.getUTCDate()}`
    : `${months[now.getUTCMonth()]} ${now.getUTCDate()}`;
  return `${from} – ${to}`;
}

export function renderLeaderboard(data: LeaderboardData, window: Window, updatedAt: Date, windowStart?: Date | null): string {
  const { entries, devCount, sessionCount } = data;
  const devNoun = devCount === 1 ? 'developer' : 'developers';
  const sessionNoun = sessionCount === 1 ? 'ship' : 'ships';
  const rangeLabel = windowStart ? ` <span class="range">· ${windowRange(windowStart, updatedAt)}</span>` : '';
  const scaleLine = entries.length === 0
    ? ''
    : `<p class="scale"><strong>${devCount}</strong> ${devNoun} · <strong>${sessionCount}</strong> ${sessionNoun} ${escapeHtml(SCALE_WINDOW_LABEL[window])}${rangeLabel}</p>`;
  const tableRows = entries.length === 0
    ? `<tr><td colspan="5" class="empty">
        <div class="empty-msg">nothing shipped. yet.</div>
        <pre class="empty-cmd">npm i -g vibetime-cli
vibe init
vibe login</pre>
      </td></tr>`
    : entries.map((e) => {
        const handle = escapeHtml(e.handle);
        const avatar = e.avatarUrl
          ? `<img src="${escapeHtml(e.avatarUrl)}" alt="" width="24" height="24" loading="lazy">`
          : `<span class="avatar-fallback" aria-hidden="true"></span>`;
        const rankClass = e.rank <= 3 ? `rank rank-top` : `rank`;
        return `<tr>
          <td class="${rankClass}">${e.rank}</td>
          <td class="who"><a href="https://github.com/${handle}" rel="nofollow noopener">${avatar}<span>${handle}</span></a></td>
          <td class="shipped">${e.shippedCount}</td>
          <td class="activity"><span class="heatmap">${heatmapCells(e.recentDays)}</span></td>
          <td class="last">${escapeHtml(relativeTime(e.lastShippedAt, updatedAt))}</td>
        </tr>`;
      }).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>vibetime leaderboard</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #0a0a0a; color: #e5e5e5; padding: 32px 16px; }
  main { max-width: 760px; margin: 0 auto; }
  header { margin-bottom: 24px; }
  h1 { font-size: 18px; margin: 0; color: #a78bfa; font-weight: 600; letter-spacing: 0.5px; }
  .tagline { color: #999; font-size: 13px; margin: 6px 0 0; }
  .scale { color: #888; font-size: 12px; margin: 6px 0 0; }
  .scale strong { color: #c4b5fd; font-weight: 600; font-variant-numeric: tabular-nums; }
  .scale .range { color: #555; }
  .sub { color: #666; font-size: 12px; margin: 4px 0 0; }
  .tabs { display: flex; gap: 4px; margin: 20px 0 16px; border-bottom: 1px solid #1a1a1a; }
  .tab { color: #666; text-decoration: none; padding: 8px 12px; font-size: 13px; border-bottom: 2px solid transparent; margin-bottom: -1px; }
  .tab:hover { color: #a78bfa; }
  .tab-active { color: #e5e5e5; border-bottom-color: #a78bfa; }
  table { width: 100%; border-collapse: collapse; }
  thead th { text-align: left; padding: 8px 8px 12px; color: #555; font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.6px; white-space: nowrap; border-bottom: 1px solid #1a1a1a; }
  thead th.col-rank, thead th.col-shipped { text-align: right; }
  thead th.col-last { text-align: right; }
  tbody td { padding: 12px 8px; border-bottom: 1px solid #141414; font-size: 14px; vertical-align: middle; }
  tbody tr:hover td { background: #111; }
  td.rank { width: 44px; color: #666; text-align: right; font-variant-numeric: tabular-nums; }
  td.rank-top { color: #a78bfa; font-weight: 600; }
  td.shipped { width: 80px; text-align: right; color: #a78bfa; font-variant-numeric: tabular-nums; font-weight: 600; font-size: 16px; }
  td.activity { width: 110px; }
  td.last { width: 100px; text-align: right; color: #666; font-size: 12px; font-variant-numeric: tabular-nums; }
  td.who a { color: #e5e5e5; text-decoration: none; display: flex; align-items: center; gap: 10px; }
  td.who a:hover { color: #a78bfa; }
  td.who img, .avatar-fallback { border-radius: 50%; display: block; width: 24px; height: 24px; }
  .avatar-fallback { background: #1a1a1a; }
  td.empty { text-align: center; color: #666; padding: 40px 16px; }
  .empty-msg { margin-bottom: 16px; }
  .empty-cmd { color: #a78bfa; background: #111; padding: 10px 14px; border-radius: 4px; display: inline-block; margin: 0; font-family: inherit; font-size: 13px; text-align: left; }
  .legend { display: flex; align-items: center; justify-content: flex-end; gap: 4px; margin: 12px 0 0; color: #555; font-size: 11px; }
  .legend .cell { width: 8px; height: 8px; }
  .heatmap { display: inline-flex; gap: 3px; }
  .cell { display: inline-block; width: 10px; height: 10px; border-radius: 2px; }
  .cell-0 { background: #1a1a1a; }
  .cell-1 { background: #3b2a5d; }
  .cell-2 { background: #6d4ec8; }
  .cell-3 { background: #a78bfa; }
  footer { color: #444; font-size: 11px; margin-top: 20px; padding-top: 16px; border-top: 1px solid #141414; }
  footer .definition { margin-bottom: 8px; }
  footer a { color: #666; }
  .links a, .links code { white-space: nowrap; }
  @media (max-width: 600px) {
    body { padding: 20px 12px; }
    tbody td, thead th { padding: 12px 4px; }
    td.last, thead th.col-last { display: none; }
    td.shipped, thead th.col-shipped { width: 60px; }
    td.shipped { font-size: 14px; }
    td.activity, thead th.col-activity { width: 80px; }
    .heatmap { gap: 2px; }
    .heatmap .cell { width: 8px; height: 8px; }
    td.who a span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  }
</style>
</head>
<body>
<main>
  <header>
    <h1>◆ vibetime · leaderboard</h1>
    <p class="tagline">ranked by what you ship</p>
    ${scaleLine}
    <p class="sub">updated ${updatedAt.toISOString().slice(0, 16).replace('T', ' ')}Z</p>
  </header>
  <nav class="tabs">
    ${tab('this week', 'week', window)}
    ${tab('this month', 'month', window)}
    ${tab('all time', 'all', window)}
  </nav>
  <table>
    <thead>
      <tr>
        <th class="col-rank">#</th>
        <th class="col-developer">developer</th>
        <th class="col-shipped">shipped</th>
        <th class="col-activity">last 7 days</th>
        <th class="col-last">last shipped</th>
      </tr>
    </thead>
    <tbody>
      ${tableRows}
    </tbody>
  </table>
  <div class="legend" aria-hidden="true">
    last 7 days: less
    <span class="cell cell-0"></span>
    <span class="cell cell-1"></span>
    <span class="cell cell-2"></span>
    <span class="cell cell-3"></span>
    more
  </div>
  <footer>
    <div class="definition"><strong style="color:#777">shipped</strong> = a day a session landed at least one commit with meaningful changes (≥50 lines or ≥3 files). A session that ships across several days counts each day.</div>
    <div class="links"><a href="https://github.com/iamnotstatic/vibetime">github.com/iamnotstatic/vibetime</a> · <code>npm i -g vibetime-cli</code></div>
  </footer>
</main>
</body>
</html>`;
}
