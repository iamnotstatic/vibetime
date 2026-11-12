import type { Theme, Viewer } from '../web-session.js';
import { CLI_RECOMMENDED } from '../release.js';
import { COPY_SCRIPT_URL, FONT_URL, SITE_CSS_URL, gem, icon } from './style.js';

// A crew keeps the same shade everywhere it appears, so it reads as one thing
// across the board, its page, the invite and a profile. Eight hues at one
// lightness, so neighbours differ and dark initials read on every one.
const CREW_SHADES = ['#A78BFA', '#8DA2FB', '#7DC4F0', '#5FD4C0', '#A8D672', '#F2C46D', '#F49A8A', '#E29BEB'];
export function crewShade(slug: string): string {
  let n = 0;
  for (const c of slug) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return CREW_SHADES[n % CREW_SHADES.length];
}

// By grapheme: slicing the joined string cut an emoji in half ("M��").
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function crewInitials(name: string): string {
  return name.split(/\s+/).filter(Boolean)
    .map((w) => graphemes.segment(w)[Symbol.iterator]().next().value?.segment ?? '')
    .slice(0, 2).join('').toUpperCase();
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

export type NavPlace = 'leaderboard' | 'crews' | 'stats' | null;

export interface NavContext {
  viewer: Viewer | null;
  signInEnabled: boolean;
  // Where sign-in and sign-out return to: the page the bar is on.
  path: string;
  // Link previews only resolve absolute URLs.
  origin: string;
  theme: Theme;
}

export function renderMeta(nav: NavContext, title: string, description: string, image = '/og.png'): string {
  const url = `${nav.origin}${nav.path.split('?')[0]}`;
  const tags: [string, string, string][] = [
    ['name', 'description', description],
    ['property', 'og:type', 'website'],
    ['property', 'og:site_name', 'vibetime'],
    ['property', 'og:title', title],
    ['property', 'og:description', description],
    ['property', 'og:url', url],
    ['property', 'og:image', `${nav.origin}${image}`],
    ['property', 'og:image:width', '1200'],
    ['property', 'og:image:height', '630'],
    ['property', 'og:image:alt', image === '/og.png' ? 'vibetime: track what you actually ship with AI.' : description],
    ['name', 'twitter:card', 'summary_large_image'],
  ];
  return tags.map(([k, n, v]) => `<meta ${k}="${n}" content="${escapeHtml(v)}">`).join('\n');
}

export interface BackLink {
  href: string;
  label: string;
}

// Pages people reach by clicking through get a way back to where they were.
// Only this site's own pages count; anything else falls back to the fallback.
export function backFrom(request: Request, fallback: BackLink): BackLink {
  const referer = request.headers.get('referer');
  if (!referer) return fallback;
  let from: URL;
  try { from = new URL(referer); } catch { return fallback; }
  const here = new URL(request.url);
  if (from.origin !== here.origin || from.pathname === here.pathname) return fallback;
  const href = `${from.pathname}${from.search}`;
  if (!/^[\x21-\x7e]+$/.test(href) || href.length > 300) return fallback;
  if (from.pathname === '/leaderboard') return { href, label: 'leaderboard' };
  if (from.pathname === '/crews') return { href, label: 'crews' };
  if (from.pathname === '/stats') return { href, label: 'stats' };
  if (/^\/crew\/[a-z0-9-]+$/.test(from.pathname)) return { href, label: 'back to the crew' };
  const handle = /^\/@([A-Za-z0-9-]+)$/.exec(from.pathname);
  if (handle) return { href, label: `@${handle[1]}` };
  return fallback;
}

export function renderBack(back: BackLink): string {
  return `<a class="back" href="${escapeHtml(back.href)}">${icon('arrow-left')}${escapeHtml(back.label)}</a>`;
}

export function avatar(url: string | null, size: number): string {
  return url
    ? `<img class="av" src="${escapeHtml(url)}" alt="" width="${size}" height="${size}" loading="lazy">`
    : `<span class="av" style="width:${size}px;height:${size}px" aria-hidden="true"></span>`;
}

// An install line people copy. The prompt is drawn but never copied, and left
// off for text that is not a shell command.
export function command(lines: string[], prompt = true): string {
  const shown = lines.map((l) => `${prompt ? '<span class="ps">$ </span>' : ''}${escapeHtml(l)}`).join('\n');
  return `<div class="cmd"><pre><code>${shown}</code></pre><button class="btn btn-ghost btn-sm btn-icon" type="button" data-copy="${escapeHtml(lines.join('\n'))}" aria-label="copy">${icon('copy', 'copy-idle')}${icon('check', 'copy-done')}</button></div>`;
}

export function renderNav(place: NavPlace, ctx: NavContext): string {
  const place_ = (label: string, href: string, key: NavPlace, glyph: 'trophy' | 'users' | 'chart'): string =>
    `<a href="${href}"${place === key ? ' class="on" aria-current="page"' : ''}>${icon(glyph)}<span>${label}</span></a>`;
  let account = '';
  if (ctx.viewer) {
    const handle = escapeHtml(ctx.viewer.handle);
    account = `<details class="menu">
      <summary aria-label="your account">${avatar(ctx.viewer.avatarUrl, 28)}<span class="me">${handle}</span>${icon('chevron-down', 'chev')}</summary>
      <div class="menu-pop">
        <p class="menu-who">signed in as <b>@${handle}</b></p>
        <a href="/@${handle}">${icon('user')}your profile</a>
        <form method="post" action="/auth/signout"><input type="hidden" name="next" value="${escapeHtml(ctx.path)}"><button type="submit">${icon('log-out')}sign out</button></form>
      </div>
    </details>`;
  } else if (ctx.signInEnabled) {
    account = `<a class="btn btn-sm" href="/auth/github/start?next=${encodeURIComponent(ctx.path)}">${icon('github')}sign in</a>`;
  }
  const other = ctx.theme === 'light' ? 'dark' : 'light';
  // Both icons ship; the stylesheet shows the one for the current theme, so the
  // site script can switch themes without a page load.
  const theme = `<form method="post" action="/theme"><input type="hidden" name="next" value="${escapeHtml(ctx.path)}"><button class="btn btn-ghost btn-sm btn-icon" type="submit" name="theme" value="${other}" aria-label="switch to ${other}">${icon('sun', 'i-sun')}${icon('moon', 'i-moon')}</button></form>`;
  return `<nav class="nav" aria-label="vibetime"><div class="wrap nav-in">
    <a class="brand" href="/" aria-label="vibetime home">${gem(22)}<span>vibetime</span></a>
    <div class="places">${place_('leaderboard', '/leaderboard', 'leaderboard', 'trophy')}${place_('crews', '/crews', 'crews', 'users')}${place_('stats', '/stats', 'stats', 'chart')}</div>
    <div class="account">${theme}${account}</div>
  </div></nav>`;
}

const WHATS_NEW_DAYS = 14;

// Shown to every visitor, signed in or not: most people who run the CLI never
// sign in on the site. It starts hidden and the site script reveals it unless
// this version was dismissed in this browser, so without the script it stays
// out of the way, and a cached page needs no cookie to vary on.
function whatsNew(now = new Date()): string {
  const { version, reason, releasedAt } = CLI_RECOMMENDED;
  if (now.getTime() - Date.parse(releasedAt) > WHATS_NEW_DAYS * 86400e3) return '';
  const v = escapeHtml(version);
  return `<aside class="whats-new" id="whats-new" data-version="${v}" aria-label="vibe ${v} is out" hidden>
  <div class="wn-h"><b>vibe ${v} is out</b><button class="btn btn-ghost btn-sm btn-icon" type="button" data-dismiss aria-label="dismiss">${icon('x')}</button></div>
  <p>${escapeHtml(reason)}.</p>
  ${command(['npm i -g vibetime-cli'])}
  <a class="wn-notes" href="https://github.com/iamnotstatic/vibetime/releases/tag/v${v}">release notes</a>
</aside>`;
}

const FOOTER = `<footer class="foot"><div class="wrap foot-in">
  <span class="foot-brand">${gem(14)}vibetime · open source, MIT</span>
  <span class="foot-links"><a href="https://github.com/iamnotstatic/vibetime">${icon('github')}github</a><code>npm i -g vibetime-cli</code></span>
</div></footer>`;

export interface PageOptions {
  title: string;
  place: NavPlace;
  nav: NavContext;
  body: string;
  // Link preview tags, for pages people share.
  preview?: { title: string; description: string; image?: string };
}

// Every page is this shell: one cached stylesheet, the font, the site script,
// the top bar and the footer. Pages only bring their body.
export function renderPage({ title, place, nav, body, preview }: PageOptions): string {
  return `<!doctype html>
<html lang="en" data-theme="${nav.theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="preload" href="${FONT_URL}" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${SITE_CSS_URL}">
${preview ? renderMeta(nav, preview.title, preview.description, preview.image) : ''}
<script src="${COPY_SCRIPT_URL}" defer></script>
</head>
<body>
${renderNav(place, nav)}
<main class="wrap">
${body}
</main>
${FOOTER}
${whatsNew()}
</body>
</html>`;
}

export function renderNotice(title: string, body: string, action?: { href: string; label: string }): string {
  return renderPage({
    title: `${title} · vibetime`,
    place: null,
    nav: { viewer: null, signInEnabled: false, path: '/leaderboard', origin: '', theme: 'dark' },
    body: `<div class="notice">
    ${gem(56)}
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(body)}</p>
    <div class="actions">${action ? `<a class="btn btn-primary" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a>` : ''}<a class="btn" href="/leaderboard">back to the leaderboard</a></div>
  </div>`,
  });
}
