#!/usr/bin/env node
// Weekly top-3 shippers, for the Monday announcement.
//
// The leaderboard's week window resets Monday 00:00 UTC, so by announcement
// time the site can no longer show last week. This queries ship_events for the
// previous completed Mon-Sun week directly (wrangler, run from anywhere in the
// repo), using the same ordering as the leaderboard route so the announcement
// never disagrees with what people saw on Sunday night.
//
//   node tools/weekly-top3.mjs             last completed week
//   node tools/weekly-top3.mjs --current   the running week (preview)
//   node tools/weekly-top3.mjs --html      also open a screenshot-ready card,
//                                          same move as `vibe share` + h
//
// The paste block uses bare handles on purpose: these are GitHub handles, and
// an @ in a tweet would tag unrelated Twitter accounts.
import { execFileSync, spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const current = process.argv.includes('--current');
const wantHtml = process.argv.includes('--html');

const now = new Date();
const dow = now.getUTCDay();
const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (dow === 0 ? 6 : dow - 1)));
const start = current ? monday : new Date(monday.getTime() - 7 * 86400000);
const end = new Date(start.getTime() + 6 * 86400000);
const day = (d) => d.toISOString().slice(0, 10);

const sql = `SELECT u.handle, u.avatar_url, COUNT(*) AS ships, MIN(s.started_at) AS first_at
  FROM ship_events e
  JOIN users u ON u.github_id = e.user_github_id
  JOIN sessions s ON s.id = e.session_id
  WHERE e.day >= '${day(start)}' AND e.day <= '${day(end)}'
  GROUP BY u.github_id
  ORDER BY ships DESC, first_at ASC
  LIMIT 3`;

const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'server');
const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'vibetime', '--remote', '--json', '--command', sql], {
  cwd: serverDir, encoding: 'utf8',
});
const rows = JSON.parse(out)[0].results;

const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const label = (d) => `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
const range = `${label(start)} – ${label(end)}`;
const medals = ['🥇', '🥈', '🥉'];

console.log(`\n  ◆ vibe · top shippers · ${range}${current ? ' (week still running)' : ''}\n`);
if (rows.length === 0) {
  console.log('  nothing shipped this week\n');
  process.exit(0);
}
const pad = Math.max(...rows.map((r) => r.handle.length));
rows.forEach((r, i) => console.log(`  ${medals[i]} @${r.handle.padEnd(pad)}  ${r.ships} ship${r.ships === 1 ? '' : 's'}`));

console.log('\n  ── paste ─────────────────────────────\n');
console.log(`top shippers on vibetime, ${range}\n`);
rows.forEach((r, i) => console.log(`${medals[i]} ${r.handle} · ${r.ships} ship${r.ships === 1 ? '' : 's'}`));
console.log(`\nvibetime.club/leaderboard`);
console.log();

if (wantHtml) {
  // Same visual family as the vibe share card: dark ground, mono, purple.
  const avatar = (r) => r.avatar_url
    ? `<img src="${r.avatar_url}${r.avatar_url.includes('?') ? '&' : '?'}s=96" width="44" height="44" style="border-radius:50%;display:block;">`
    : `<div style="width:44px;height:44px;border-radius:50%;background:#1a1a1a;"></div>`;
  const podiumRows = rows.map((r, i) => `
    <div style="display:flex;align-items:center;gap:14px;background:${i === 0 ? '#161221' : '#111'};border-radius:8px;padding:14px 18px;${i === 0 ? 'border:1px solid #2c2440;' : ''}">
      <div style="font-size:26px;">${medals[i]}</div>
      ${avatar(r)}
      <div style="flex:1;color:#e5e5e5;font-size:${i === 0 ? 20 : 17}px;">${r.handle}</div>
      <div style="color:#a78bfa;font-size:${i === 0 ? 22 : 18}px;font-weight:600;">${r.ships} <span style="color:#666;font-size:13px;font-weight:400;">ship${r.ships === 1 ? '' : 's'}</span></div>
    </div>`).join('');

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>vibe · top shippers</title></head>
<body style="margin:0;background:#0a0a0a;display:flex;justify-content:center;padding:60px 0;">
<div style="width:560px;background:#0d0d0d;border:1px solid #1a1a1a;border-radius:12px;padding:32px;font-family:'SF Mono','Fira Code','Consolas',monospace;">
  <div style="color:#a78bfa;font-size:15px;margin-bottom:4px;">◆ vibe · top shippers</div>
  <div style="color:#666;font-size:13px;margin-bottom:24px;">${range}</div>
  <div style="display:flex;flex-direction:column;gap:10px;">${podiumRows}</div>
  <div style="color:#444;font-size:12px;margin-top:24px;">vibetime.club/leaderboard</div>
</div>
</body></html>`;

  const dir = process.env.VIBE_DIR || join(homedir(), '.vibe');
  mkdirSync(dir, { recursive: true });
  const outPath = join(dir, 'top3-card.html');
  writeFileSync(outPath, html);
  console.log(`  ◆ card: ${outPath}\n`);
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(opener, [outPath], { detached: true, stdio: 'ignore' }).unref();
}
