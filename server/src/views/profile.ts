import type { ProfileData, ProfileHeatmapDay } from '../routes/profile.js';

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

function heatmapCells(recent: ProfileHeatmapDay[]): string {
  return recent.map(({ day, n }) => {
    const cls = n === 0 ? 'cell-0' : n === 1 ? 'cell-1' : n <= 3 ? 'cell-2' : 'cell-3';
    const noun = n === 1 ? 'ship' : 'ships';
    return `<span class="cell ${cls}" title="${escapeHtml(day)} · ${n} ${noun}" aria-hidden="true"></span>`;
  }).join('');
}

function statBlock(label: string, ships: number, days: number): string {
  const dayNoun = days === 1 ? 'day' : 'days';
  return `<div class="stat">
    <div class="stat-value">${ships}</div>
    <div class="stat-label">${escapeHtml(label)}</div>
    <div class="stat-sub">${days} ${dayNoun}</div>
  </div>`;
}

const SHARED_STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #0a0a0a; color: #e5e5e5; padding: 32px 16px; }
  main { max-width: 560px; margin: 0 auto; }
  a { color: #a78bfa; text-decoration: none; }
  a:hover { color: #c4b5fd; }
  .back { color: #666; font-size: 12px; display: inline-block; margin-bottom: 20px; }
  .back:hover { color: #a78bfa; }
  header { margin-bottom: 28px; }
  .who { display: flex; align-items: center; gap: 14px; }
  .who img, .avatar-fallback { border-radius: 50%; width: 48px; height: 48px; display: block; }
  .avatar-fallback { background: #1a1a1a; }
  h1 { font-size: 20px; margin: 0; color: #e5e5e5; font-weight: 600; }
  .meta { color: #666; font-size: 12px; margin: 6px 0 0; }
  .meta a { color: #888; }
  .meta a:hover { color: #a78bfa; }
  .rank { color: #a78bfa; font-size: 13px; margin: 14px 0 0; }
  .rank strong { font-weight: 600; }
  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 28px; }
  .stat { background: #111; border: 1px solid #1a1a1a; border-radius: 6px; padding: 14px 12px; }
  .stat-value { color: #a78bfa; font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .stat-label { color: #888; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 4px; }
  .stat-sub { color: #555; font-size: 11px; margin-top: 6px; }
  .section-label { color: #555; font-size: 11px; text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 10px; }
  .heatmap-wrap { display: flex; align-items: center; gap: 10px; margin-bottom: 28px; }
  .heatmap { display: inline-flex; gap: 4px; }
  .cell { display: inline-block; width: 14px; height: 14px; border-radius: 3px; }
  .cell-0 { background: #1a1a1a; }
  .cell-1 { background: #3b2a5d; }
  .cell-2 { background: #6d4ec8; }
  .cell-3 { background: #a78bfa; }
  .legend { color: #555; font-size: 11px; }
  .empty { color: #666; font-size: 14px; margin: 8px 0 28px; }
  footer { color: #444; font-size: 11px; padding-top: 16px; border-top: 1px solid #141414; }
  footer a { color: #666; }
  @media (max-width: 480px) {
    body { padding: 20px 12px; }
    .stats { grid-template-columns: 1fr; }
    .who img, .avatar-fallback { width: 40px; height: 40px; }
  }
`;

export function renderProfile(data: ProfileData, updatedAt: Date): string {
  const handle = escapeHtml(data.handle);
  const avatar = data.avatarUrl
    ? `<img src="${escapeHtml(data.avatarUrl)}" alt="" width="48" height="48" loading="lazy">`
    : `<span class="avatar-fallback" aria-hidden="true"></span>`;
  const lastLine = data.lastShippedAt
    ? `last shipped ${escapeHtml(relativeTime(data.lastShippedAt, updatedAt))}`
    : 'no ships yet';
  const rankLine = data.weekRank != null
    ? `<p class="rank"><strong>#${data.weekRank}</strong> this week · ${data.weekDevCount} developer${data.weekDevCount === 1 ? '' : 's'}</p>`
    : data.weekDevCount > 0
      ? `<p class="rank">unranked this week · ${data.weekDevCount} developer${data.weekDevCount === 1 ? '' : 's'} shipping</p>`
      : '';
  const activity = data.all.ships === 0
    ? `<p class="empty">nothing shipped. yet.</p>`
    : `<div class="section-label">last 7 days</div>
  <div class="heatmap-wrap">
    <span class="heatmap">${heatmapCells(data.recentDays)}</span>
    <span class="legend" aria-hidden="true">less → more</span>
  </div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>@${handle} · vibetime</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>${SHARED_STYLE}</style>
</head>
<body>
<main>
  <a class="back" href="/leaderboard">← leaderboard</a>
  <header>
    <div class="who">
      ${avatar}
      <div>
        <h1>@${handle}</h1>
        <p class="meta"><a href="https://github.com/${handle}" rel="nofollow noopener">github.com/${handle}</a> · ${lastLine}</p>
      </div>
    </div>
    ${rankLine}
  </header>
  <div class="stats">
    ${statBlock('this week', data.week.ships, data.week.days)}
    ${statBlock('this month', data.month.ships, data.month.days)}
    ${statBlock('all time', data.all.ships, data.all.days)}
  </div>
  ${activity}
  <footer>
    <a href="/leaderboard">vibetime · leaderboard</a>
  </footer>
</main>
</body>
</html>`;
}

export function renderProfileNotFound(handle: string): string {
  const safe = escapeHtml(handle);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>@${safe} · vibetime</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>${SHARED_STYLE}
  .missing { margin-top: 40px; }
  .missing h1 { font-size: 18px; color: #a78bfa; margin: 0 0 8px; }
  .missing p { color: #666; font-size: 13px; margin: 0 0 20px; }
</style>
</head>
<body>
<main>
  <a class="back" href="/leaderboard">← leaderboard</a>
  <div class="missing">
    <h1>@${safe}</h1>
    <p>no vibetime profile for this handle.</p>
    <p><a href="/leaderboard">browse the leaderboard</a></p>
  </div>
</main>
</body>
</html>`;
}
