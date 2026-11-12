#!/usr/bin/env node
// Monthly stats, for the post at the start of each month.
//
//   node tools/monthly-stats.mjs                  last completed month
//   node tools/monthly-stats.mjs --month 2026-10  a given month
//
// Everything here is a total across everyone, built from the same counts the
// leaderboard already publishes. A claim only goes in the paste block when it
// survives two checks: a tool is only named when at least MIN_TOOL_DEVS people
// used it, so a share never describes one person, and a weekday pattern only
// counts when it still holds with the month's top shippers taken out, because
// a single heavy shipper once made Saturday look like the busiest day.
import { d1, xLength } from './lib.mjs';

const MIN_TOOL_DEVS = 3;
const STEADY_DAYS = 20;
const TOP_EXCLUDED = 3;

const arg = process.argv.indexOf('--month');
const now = new Date();
const [year, month] = arg > -1
  ? process.argv[arg + 1].split('-').map(Number)
  : [now.getUTCMonth() === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear(), now.getUTCMonth() === 0 ? 12 : now.getUTCMonth()];
if (!year || !month || month < 1 || month > 12) {
  console.error('usage: node tools/monthly-stats.mjs [--month YYYY-MM]');
  process.exit(2);
}

const day = (d) => d.toISOString().slice(0, 10);
const first = new Date(Date.UTC(year, month - 1, 1));
const last = new Date(Date.UTC(year, month, 0));
const prevFirst = new Date(Date.UTC(year, month - 2, 1));
const prevLast = new Date(Date.UTC(year, month - 1, 0));
const next = new Date(Date.UTC(year, month, 1));
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const TOOL_NAMES = { claude: 'claude code', codex: 'codex', gemini: 'gemini', opencode: 'opencode', cursor: 'cursor', aster: 'aster', zcode: 'zcode' };
const fmt = (n) => n.toLocaleString('en-US');
const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);

const within = (from, to) => `day BETWEEN '${day(from)}' AND '${day(to)}'`;
const [totals] = d1(`SELECT COUNT(DISTINCT user_github_id) AS devs, COALESCE(SUM(ships), 0) AS ships FROM ship_events WHERE ${within(first, last)}`);
const [prev] = d1(`SELECT COUNT(DISTINCT user_github_id) AS devs, COALESCE(SUM(ships), 0) AS ships FROM ship_events WHERE ${within(prevFirst, prevLast)}`);
if (!totals.ships) {
  console.log(`\n  nothing shipped in ${MONTHS[month - 1]} ${year}\n`);
  process.exit(0);
}

// Sessions are dated by when they ended, as on the leaderboard.
const ended = `ended_at >= '${day(first)}' AND ended_at < '${day(next)}'`;
const tools = d1(`SELECT tool, COUNT(*) AS sessions, COUNT(DISTINCT user_github_id) AS devs FROM sessions WHERE ${ended} GROUP BY tool ORDER BY sessions DESC`);
const [mix] = d1(`SELECT COUNT(*) AS sessions, SUM(momentum = 'shipped') AS shipped FROM sessions WHERE ${ended}`);
const [multi] = d1(`SELECT COUNT(*) AS devs, SUM(n > 1) AS multi FROM (SELECT COUNT(DISTINCT tool) AS n FROM sessions WHERE ${ended} GROUP BY user_github_id)`);
const [steady] = d1(`SELECT COUNT(*) AS devs FROM (SELECT user_github_id FROM ship_events WHERE ${within(first, last)} GROUP BY user_github_id HAVING COUNT(DISTINCT day) >= ${STEADY_DAYS})`);

const top = d1(`SELECT user_github_id FROM ship_events WHERE ${within(first, last)} GROUP BY user_github_id ORDER BY SUM(ships) DESC LIMIT ${TOP_EXCLUDED}`).map((r) => r.user_github_id);
const byWeekday = (exclude) => {
  const rows = d1(`SELECT CAST(strftime('%w', day) AS INTEGER) AS dow, SUM(ships) AS ships FROM ship_events
    WHERE ${within(first, last)}${exclude.length ? ` AND user_github_id NOT IN (${exclude.join(',')})` : ''} GROUP BY dow`);
  // A month has four or five of each weekday, so compare per occurrence.
  const count = Array(7).fill(0);
  for (let d = new Date(first); d <= last; d.setUTCDate(d.getUTCDate() + 1)) count[d.getUTCDay()]++;
  const avg = Array(7).fill(0);
  for (const r of rows) avg[r.dow] = r.ships / count[r.dow];
  return avg;
};
const all = byWeekday([]);
const rest = byWeekday(top);
const argMin = (a) => a.indexOf(Math.min(...a));
const argMax = (a) => a.indexOf(Math.max(...a));
const quietest = argMin(all) === argMin(rest) ? argMin(all) : null;
const busiest = argMax(all) === argMax(rest) ? argMax(all) : null;

const named = tools.filter((t) => t.devs >= MIN_TOOL_DEVS && TOOL_NAMES[t.tool]);
const shareLine = named.slice(0, 2).map((t, i) => `${TOOL_NAMES[t.tool]}${i === 0 ? ' ran' : ''} ${pct(t.sessions, mix.sessions)}%${i === 0 ? ' of sessions' : ''}`).join(', ');

console.log(`\n  ◆ vibe · ${MONTHS[month - 1]} ${year}\n`);
console.log(`  shipped     ${totals.devs} devs, ${fmt(totals.ships)} ships   (${MONTHS[prevFirst.getUTCMonth()]}: ${prev.devs} devs, ${fmt(prev.ships)})`);
console.log(`  sessions    ${fmt(mix.sessions)} ended, ${pct(mix.shipped, mix.sessions)}% shipped`);
console.log(`  multi-tool  ${multi.multi} of ${multi.devs} devs`);
console.log(`  steady      ${steady.devs} shipped on ${STEADY_DAYS}+ days`);
console.log('  tools       ' + tools.map((t) => `${t.tool} ${t.sessions}/${t.devs}${t.devs < MIN_TOOL_DEVS ? ' (too few people to name)' : ''}`).join(', '));
console.log(`  weekdays    ships per day, everyone: ${all.map((v, i) => `${DAYS[i].slice(0, 3)} ${Math.round(v)}`).join(' ')}`);
console.log(`              without the top ${TOP_EXCLUDED}:   ${rest.map((v, i) => `${DAYS[i].slice(0, 3)} ${Math.round(v)}`).join(' ')}`);
if (quietest === null) console.log('              quietest day differs without the top shippers, left out');
if (busiest === null) console.log('              busiest day differs without the top shippers, left out');

const lines = [
  `vibetime in ${MONTHS[month - 1]}`,
  '',
  `${totals.devs} devs shipped ${fmt(totals.ships)} times (${MONTHS[prevFirst.getUTCMonth()]}: ${prev.devs} devs, ${fmt(prev.ships)})`,
  `${pct(mix.shipped, mix.sessions)}% of sessions ended in a ship`,
  ...(shareLine ? [shareLine] : []),
  `${pct(multi.multi, multi.devs)}% of devs used more than one agent`,
  `${steady.devs} ${steady.devs === 1 ? 'person' : 'people'} shipped on ${STEADY_DAYS}+ days`,
  ...(busiest !== null ? [`${DAYS[busiest]} is the busiest day`] : []),
  ...(quietest !== null ? [`${DAYS[quietest]} is the quietest day`] : []),
  '',
  'vibetime.club',
];
const post = lines.join('\n');

console.log('\n  ── paste ─────────────────────────────\n');
console.log(post);
console.log(`\n  ── ${xLength(post)}/280${xLength(post) > 280 ? ', too long for X' : ''} ──\n`);
