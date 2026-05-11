import type { LeaderboardEntry } from '../routes/leaderboard.js';

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

function heatmapCells(recent: number[]): string {
  return recent.map((n) => {
    if (n === 0) return `<span class="cell cell-0" aria-hidden="true"></span>`;
    if (n === 1) return `<span class="cell cell-1" aria-hidden="true"></span>`;
    if (n <= 3) return `<span class="cell cell-2" aria-hidden="true"></span>`;
    return `<span class="cell cell-3" aria-hidden="true"></span>`;
  }).join('');
}

function tab(label: string, value: Window, active: Window): string {
  const cls = value === active ? 'tab tab-active' : 'tab';
  return `<a class="${cls}" href="/leaderboard?window=${value}">${escapeHtml(label)}</a>`;
}

const WINDOW_LABEL: Record<Window, string> = {
  week: 'last 7 days',
  month: 'last 30 days',
  all: 'all time',
};

export function renderLeaderboard(entries: LeaderboardEntry[], window: Window, updatedAt: Date): string {
  const tableRows = entries.length === 0
    ? `<tr><td colspan="5" class="empty">no shipped sessions ${escapeHtml(WINDOW_LABEL[window])} yet</td></tr>`
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
          <td class="activity"><span class="heatmap" title="shipped sessions, last 7 days">${heatmapCells(e.recentDays)}</span></td>
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
  .sub { color: #666; font-size: 12px; margin: 4px 0 0; }
  .tabs { display: flex; gap: 4px; margin: 20px 0 16px; border-bottom: 1px solid #1a1a1a; }
  .tab { color: #666; text-decoration: none; padding: 8px 12px; font-size: 13px; border-bottom: 2px solid transparent; margin-bottom: -1px; }
  .tab:hover { color: #a78bfa; }
  .tab-active { color: #e5e5e5; border-bottom-color: #a78bfa; }
  table { width: 100%; border-collapse: collapse; }
  thead th { text-align: left; padding: 8px 8px 12px; color: #555; font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.6px; border-bottom: 1px solid #1a1a1a; }
  thead th.col-rank, thead th.col-shipped { text-align: right; }
  thead th.col-last { text-align: right; }
  tbody td { padding: 12px 8px; border-bottom: 1px solid #141414; font-size: 14px; vertical-align: middle; }
  tbody tr:hover td { background: #111; }
  td.rank { width: 44px; color: #666; text-align: right; font-variant-numeric: tabular-nums; }
  td.rank-top { color: #a78bfa; font-weight: 600; }
  td.shipped { width: 80px; text-align: right; color: #a78bfa; font-variant-numeric: tabular-nums; font-weight: 600; }
  td.activity { width: 110px; }
  td.last { width: 100px; text-align: right; color: #666; font-size: 12px; font-variant-numeric: tabular-nums; }
  td.who a { color: #e5e5e5; text-decoration: none; display: flex; align-items: center; gap: 10px; }
  td.who a:hover { color: #a78bfa; }
  td.who img, .avatar-fallback { border-radius: 50%; display: block; width: 24px; height: 24px; }
  .avatar-fallback { background: #1a1a1a; }
  td.empty { text-align: center; color: #555; padding: 40px 0; }
  .heatmap { display: inline-flex; gap: 3px; }
  .cell { display: inline-block; width: 10px; height: 10px; border-radius: 2px; }
  .cell-0 { background: #1a1a1a; }
  .cell-1 { background: #3b2a5d; }
  .cell-2 { background: #6d4ec8; }
  .cell-3 { background: #a78bfa; }
  footer { color: #444; font-size: 11px; margin-top: 32px; padding-top: 16px; border-top: 1px solid #141414; }
  footer .definition { margin-bottom: 8px; }
  footer .links { text-align: center; }
  footer a { color: #666; }
  @media (max-width: 600px) {
    td.activity, thead th.col-activity { display: none; }
    body { padding: 20px 12px; }
  }
</style>
</head>
<body>
<main>
  <header>
    <h1>◆ vibetime · leaderboard</h1>
    <p class="sub">shipped sessions · updated ${updatedAt.toISOString().slice(0, 16).replace('T', ' ')}Z</p>
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
        <th class="col-activity">activity</th>
        <th class="col-last">last shipped</th>
      </tr>
    </thead>
    <tbody>
      ${tableRows}
    </tbody>
  </table>
  <footer>
    <div class="definition"><strong style="color:#777">shipped</strong> = a session with at least one commit and meaningful changes (≥50 lines or ≥3 files). <strong style="color:#777">activity</strong> shows the last 7 days regardless of the tab selected.</div>
    <div class="links"><a href="https://github.com/iamnotstatic/vibetime">github.com/iamnotstatic/vibetime</a> &nbsp;·&nbsp; <code>npm i -g vibetime-cli</code></div>
  </footer>
</main>
</body>
</html>`;
}
