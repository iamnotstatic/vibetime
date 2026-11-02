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
//   node tools/weekly-top3.mjs --html      also open a screenshot-ready card
//                                          drawn with the site's podium
//
// The paste block uses bare handles on purpose: these are GitHub handles, and
// an @ in a tweet would tag unrelated Twitter accounts.
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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

const sql = `SELECT u.handle, u.avatar_url, SUM(e.ships) AS ships, COUNT(DISTINCT e.day) AS days, MIN(s.started_at) AS first_at
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

// Same counting as countedShips in server/src/crews.ts: a ship counts in any
// week its author was a member, joining and leaving weeks included, and
// DISTINCT on the ship_events key stops a same-week rejoin counting twice.
// A crew needs two members in the week to be ranked, as on /crews.
const crewSql = `WITH spans AS (
    SELECT m.crew_id, m.user_github_id,
      date(m.joined_at, '-6 days', 'weekday 1') AS from_day,
      CASE WHEN m.left_at IS NULL THEN '9999-12-31' ELSE date(m.left_at, '-6 days', 'weekday 1', '+7 days') END AS to_day
    FROM crew_members m JOIN crews c ON c.id = m.crew_id
    WHERE c.deleted_at IS NULL
  ), counted AS (
    SELECT DISTINCT sp.crew_id, e.user_github_id, e.session_id, e.day, e.ships
    FROM spans sp JOIN ship_events e
      ON e.user_github_id = sp.user_github_id AND e.day >= sp.from_day AND e.day < sp.to_day
     AND e.day >= '${day(start)}' AND e.day <= '${day(end)}'
  )
  SELECT c.slug, c.name,
    (SELECT COUNT(*) FROM spans sp WHERE sp.crew_id = c.id AND sp.from_day <= '${day(end)}' AND sp.to_day > '${day(start)}') AS members,
    (SELECT COALESCE(SUM(ships), 0) FROM counted WHERE crew_id = c.id) AS ships
  FROM crews c WHERE c.deleted_at IS NULL
  ORDER BY ships DESC, c.created_at ASC`;
let topCrew = null;
try {
  const crewOut = execFileSync('npx', ['wrangler', 'd1', 'execute', 'vibetime', '--remote', '--json', '--command', crewSql], {
    cwd: serverDir, encoding: 'utf8',
  });
  topCrew = JSON.parse(crewOut)[0].results.find((c) => c.members >= 2 && c.ships > 0) ?? null;
} catch (e) {
  console.error(`  (top crew skipped: ${e instanceof Error ? e.message.split('\n')[0] : e})`);
}

const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const label = (d) => `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
const range = `${label(start)} – ${label(end)}`;
const medals = ['🥇', '🥈', '🥉'];

console.log(`\n  ◆ vibe · weekly top shippers · ${range}${current ? ' (week still running)' : ''}\n`);
if (rows.length === 0) {
  console.log('  nothing shipped this week\n');
  process.exit(0);
}
const pad = Math.max(...rows.map((r) => r.handle.length));
rows.forEach((r, i) => console.log(`  ${medals[i]} @${r.handle.padEnd(pad)}  ${r.ships} ship${r.ships === 1 ? '' : 's'}`));
if (topCrew) console.log(`\n  top crew: ${topCrew.name} · ${topCrew.ships} ships · ${topCrew.members} members`);

// Every post asks people to update: the ones who never do are the ones whose
// numbers go wrong, and this is a place they reliably look. The version is
// the one the server recommends.
const recommended = /version: '([^']+)'/.exec(readFileSync(join(serverDir, 'src', 'release.ts'), 'utf8'))?.[1];

const lines = [`weekly top shippers on vibetime, ${range}`, ''];
rows.forEach((r, i) => lines.push(`${medals[i]} ${r.handle} · ${r.ships} ship${r.ships === 1 ? '' : 's'}`));
if (topCrew) lines.push('', `top crew: ${topCrew.name} · ${topCrew.ships} ships`);
if (recommended) lines.push('', `update to ${recommended}: npm i -g vibetime-cli`);
lines.push('', 'vibetime.club/leaderboard');
if (topCrew) lines.push('start a crew: vibetime.club/crews');

// X weighs links as 23 and emoji as 2, and won't send past 280.
const weight = (text) => [...text.replace(/vibetime\.club\/\S*/g, 'x'.repeat(23))]
  .reduce((n, ch) => n + (ch.codePointAt(0) <= 4351 || (ch.codePointAt(0) >= 8192 && ch.codePointAt(0) <= 8247) ? 1 : 2), 0);
const post = lines.join('\n');

console.log('\n  ── paste ─────────────────────────────\n');
console.log(post);
console.log(`\n  ── ${weight(post)}/280${weight(post) > 280 ? ', too long for X' : ''} ──\n`);

// While the week is running, the live /crews board must agree with this
// script. A mismatch means the two copies of the counting rule drifted.
if (current && topCrew) {
  try {
    const board = execFileSync('curl', ['-s', `https://vibetime.club/crews?v=${Date.now()}`], { encoding: 'utf8' });
    const live = new RegExp(`href="/crew/${topCrew.slug}"[\\s\\S]*?<td class="ships">(\\d+)<`).exec(board)?.[1];
    if (live !== undefined && Number(live) !== topCrew.ships) {
      console.error(`  ! top crew mismatch: this script says ${topCrew.ships}, vibetime.club/crews says ${live}\n`);
    }
  } catch { /* offline: nothing to compare against */ }
}

if (wantHtml) {
  // The card is drawn with the live site's own stylesheet, so it matches the
  // podium people land on from the post and follows any redesign without
  // anyone touching this script. Everything is embedded because the card
  // opens from file://, and the site's font is not served cross-origin.
  const site = 'https://vibetime.club';
  const get = async (path) => {
    const res = await fetch(`${site}${path}`);
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res;
  };
  let css;
  let gem;
  try {
    const page = await (await get('/leaderboard')).text();
    const cssPath = /<link rel="stylesheet" href="([^"]+)"/.exec(page)?.[1];
    if (!cssPath) throw new Error('no stylesheet on /leaderboard');
    css = await (await get(cssPath)).text();
    for (const [match, path] of [...css.matchAll(/url\((\/[^)]+\.woff2)\)/g)]) {
      const font = Buffer.from(await (await get(path)).arrayBuffer()).toString('base64');
      css = css.replace(match, `url(data:font/woff2;base64,${font})`);
    }
    gem = `data:image/svg+xml;base64,${Buffer.from(await (await get('/favicon.svg')).arrayBuffer()).toString('base64')}`;
  } catch (e) {
    console.error(`  ! card skipped, it needs ${site} for the site's styles: ${e instanceof Error ? e.message : e}\n`);
    process.exit(1);
  }

  const esc = (v) => String(v).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const avatar = (r, size) => r.avatar_url
    ? `<img class="av" src="${esc(r.avatar_url)}${r.avatar_url.includes('?') ? '&amp;' : '?'}s=${size * 2}" width="${size}" height="${size}" alt="">`
    : `<span class="av" style="width:${size}px;height:${size}px"></span>`;
  const step = (r, i) => `<li class="pod pod-${i + 1}"><span class="pod-who">${avatar(r, i === 0 ? 120 : 96)}<span class="nm">${esc(r.handle)}</span></span><span class="pod-n">${r.ships}<small> ship${r.ships === 1 ? '' : 's'}</small></span><span class="pod-d">on ${r.days} day${r.days === 1 ? '' : 's'}</span><div class="pod-block"><span class="pod-r">${i + 1}</span></div></li>`;

  // Sized for X, which shows a 16:9 image uncropped. The overrides only scale
  // the site's podium up from a 620px column to a 1200px image.
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>vibe · top shippers</title>
<style>${css}</style>
<style>
  html, body { margin: 0; background: var(--bg); }
  body { display: block; min-height: 0; }
  .tc-card { box-sizing: border-box; width: 1200px; height: 675px; padding: 48px 64px 40px; display: flex; flex-direction: column; background: radial-gradient(ellipse 60% 45% at 50% 38%, var(--accent-wash) 0%, var(--bg) 70%); }
  .tc-top { display: flex; justify-content: space-between; align-items: center; color: var(--text-3); font-size: 18px; }
  .tc-brand { display: flex; align-items: center; gap: 12px; color: var(--text); font-size: 22px; font-weight: 600; }
  .tc-brand img { width: 30px; height: 30px; }
  .tc-brand span { color: var(--text-3); font-weight: 400; }
  .podium { max-width: 920px; gap: 40px; margin: auto auto 0; }
  .pod { gap: 10px; }
  .pod-who { gap: 14px; }
  .pod-who .nm { font-size: 24px; color: var(--text); }
  .pod-n { font-size: 30px; }
  .pod-n small { font-size: 18px; }
  .pod-d { font-size: 16px; margin-top: -2px; }
  .pod-block { animation: none; margin: 22px 20px 0 0; }
  .pod-block::before { right: -20px; top: -13px; height: 13px; clip-path: polygon(0 100%, 20px 0, 100% 0, calc(100% - 20px) 100%); }
  .pod-block::after { right: -20px; top: -13px; width: 20px; clip-path: polygon(0 13px, 100% 0, 100% calc(100% - 13px), 0 100%); }
  .pod-1 .pod-block { --h: 150px; } .pod-2 .pod-block { --h: 106px; } .pod-3 .pod-block { --h: 78px; }
  .pod-r { font-size: 40px; }
  .tc-foot { display: flex; justify-content: space-between; align-items: center; margin-top: 34px; padding-top: 22px; border-top: 1px solid var(--line); font-size: 18px; color: var(--text-3); }
  .tc-foot b { color: var(--text); font-weight: 500; } .tc-foot em { color: var(--accent); font-style: normal; font-weight: 600; }
</style></head><body>
<div class="tc-card">
  <div class="tc-top"><div class="tc-brand"><img src="${gem}" alt="">vibetime <span>· top shippers</span></div><div>${range}</div></div>
  <ol class="podium">${rows.map(step).join('')}</ol>
  <div class="tc-foot"><div>${topCrew ? `top crew <b>${esc(topCrew.name)}</b> · <em>${topCrew.ships}</em> ships` : ''}</div><div>vibetime.club/leaderboard</div></div>
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
