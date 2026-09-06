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
//
// The paste block uses bare handles on purpose: these are GitHub handles, and
// an @ in a tweet would tag unrelated Twitter accounts.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const current = process.argv.includes('--current');

const now = new Date();
const dow = now.getUTCDay();
const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (dow === 0 ? 6 : dow - 1)));
const start = current ? monday : new Date(monday.getTime() - 7 * 86400000);
const end = new Date(start.getTime() + 6 * 86400000);
const day = (d) => d.toISOString().slice(0, 10);

const sql = `SELECT u.handle, COUNT(*) AS ships, MIN(s.started_at) AS first_at
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
