import { Resvg, initWasm } from '@resvg/resvg-wasm';
import RESVG_WASM from '@resvg/resvg-wasm/index_bg.wasm';
import OG_PNG from '../../assets/og.png';
import FONT_REGULAR from '../../assets/geist-mono-regular.ttf';
import FONT_SEMIBOLD from '../../assets/geist-mono-semibold.ttf';
import type { ProfileData } from '../routes/profile.js';
import { escapeHtml, formatCount } from './layout.js';
import { heatLevel } from './leaderboard.js';
import { GEM_PATHS } from './style.js';

export function ogImageResponse(): Response {
  return new Response(OG_PNG, {
    headers: {
      'content-type': 'image/png',
      'cache-control': 'public, max-age=86400',
    },
  });
}

// A link preview is shown on other sites, so like the badge it cannot read the
// page's tokens: these are the dark theme's values, written out.
const C = {
  bg: '#0B0A0F', wash: '#1A1430', line: '#24212E', text: '#EEECF4', text3: '#8C87A0', accent: '#A78BFA',
  avatar: '#262330', heat: ['#1D1B26', '#3A2C66', '#5B45B3', '#8B6CF0', '#C4B5FD'],
  gem: ['#C4B5FD', '#A78BFA', '#7C3AED', '#5B21B6'],
};
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const dayLabel = (day: string) => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`;

// Geist Mono advances every character by 0.6em, so widths are exact.
const ADVANCE = 0.6;
function fitSize(text: string, width: number, max: number, min: number): number {
  return Math.max(min, Math.min(max, Math.floor(width / (text.length * ADVANCE))));
}
function clip(text: string, width: number, size: number): string {
  const fits = Math.floor(width / (size * ADVANCE));
  return text.length <= fits ? text : `${text.slice(0, Math.max(1, fits - 1))}…`;
}
// The font has no emoji, and a missing glyph renders as an empty box.
const withoutEmoji = (text: string) => text.replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}‍️]/gu, '').replace(/\s+/g, ' ').trim();

export interface ProfileCard {
  data: ProfileData;
  // The avatar as a data URI. Without one the card draws a plain circle.
  avatar: string | null;
  topCrew: { name: string; rank: number } | null;
  origin: string;
}

export function renderProfileCard({ data, avatar, topCrew, origin }: ProfileCard): string {
  const { days } = data;
  const t = (x: number, y: number, size: number, fill: string, body: string, extra = '') =>
    `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}"${extra}>${body}</text>`;

  const handle = data.handle;
  const handleSize = fitSize(handle, 330, 40, 22);
  const shownHandle = escapeHtml(clip(handle, 330, handleSize));
  const rank = data.weekRank != null
    ? `#${data.weekRank} this week of ${formatCount(data.weekDevCount)}`
    : 'nothing shipped this week';

  const total = formatCount(data.all.ships);
  const totalSize = fitSize(`${total} ships`, 420, 96, 40);
  const shipsX = 64 + total.length * totalSize * ADVANCE + 12;

  // Same geometry as the profile page's grid, scaled up.
  const step = 20, size = 16, left = 28, top = 14;
  const cells = days.map((d, i) =>
    `<rect x="${left + Math.floor(i / 7) * step}" y="${top + (i % 7) * step}" width="${size}" height="${size}" rx="3" fill="${C.heat[heatLevel(d.n)]}"/>`);
  const rowLabels = ([['mon', 0], ['wed', 2], ['fri', 4], ['sun', 6]] as const)
    .map(([name, r]) => t(0, top + r * step + 12, 8, C.text3, name));
  const monthLabels = days.flatMap((d, i) =>
    i % 7 === 0 && (i === 0 || d.day.slice(5, 7) !== days[i - 7].day.slice(5, 7))
      ? [t(left + (i / 7) * step, 9, 8, C.text3, MONTHS[Number(d.day.slice(5, 7)) - 1])]
      : []);
  const range = days.length ? `last 12 weeks · ${dayLabel(days[0].day)} – ${dayLabel(days[days.length - 1].day)}` : 'last 12 weeks';

  // X lays the page title over the bottom-left corner, so that corner holds
  // the URL, which X shows under the card anyway, and the crew sits right.
  const link = `${new URL(origin).host}/@${handle}`;
  const crewName = topCrew ? withoutEmoji(topCrew.name) : '';
  const crewTail = topCrew ? ` · #${topCrew.rank} this week` : '';
  const crewRoom = 1072 - link.length * 18 * ADVANCE - 40 - ('crew '.length + crewTail.length) * 18 * ADVANCE;
  const crewLine = topCrew && crewName
    ? `<text x="1136" y="581" font-size="18" fill="${C.text3}" text-anchor="end">crew <tspan fill="${C.text}">${escapeHtml(clip(crewName, crewRoom, 18))}</tspan> · <tspan fill="${C.text}" font-weight="600">#${topCrew.rank}</tspan> this week</text>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="630" viewBox="0 0 1200 630" font-family="Geist Mono">
<defs>
  <radialGradient id="glow" cx="0.8" cy="0.45" r="0.6"><stop offset="0" stop-color="${C.wash}"/><stop offset="1" stop-color="${C.bg}"/></radialGradient>
  <clipPath id="face"><circle cx="108" cy="215" r="44"/></clipPath>
</defs>
<rect width="1200" height="630" fill="url(#glow)"/>
<g transform="translate(64 57) scale(0.46875)">${GEM_PATHS.replace(/class="f(\d)"/g, (_, n) => `fill="${C.gem[Number(n) - 1]}"`)}</g>
${t(106, 79, 22, C.text, 'vibetime', ' font-weight="600"')}
${t(1136, 79, 20, C.text3, range, ' text-anchor="end"')}
<circle cx="108" cy="215" r="44" fill="${C.avatar}"/>
${avatar ? `<image x="64" y="171" width="88" height="88" clip-path="url(#face)" preserveAspectRatio="xMidYMid slice" xlink:href="${avatar}"/>` : ''}
${t(172, 222, handleSize, C.text, shownHandle, ' font-weight="600"')}
${t(172, 250, 18, C.text3, rank)}
${t(64, 385, totalSize, C.accent, total, ' font-weight="600"')}
${t(shipsX, 385, 24, C.text3, `ship${data.all.ships === 1 ? '' : 's'}`)}
<text x="64" y="420" font-size="18" fill="${C.text3}">on <tspan fill="${C.text}" font-weight="600">${formatCount(data.all.days)}</tspan> day${data.all.days === 1 ? '' : 's'} · <tspan fill="${C.text}" font-weight="600">${formatCount(data.month.ships)}</tspan> this month</text>
<g transform="translate(516 124) scale(2.35)">${monthLabels.join('')}${rowLabels.join('')}${cells.join('')}</g>
<rect x="64" y="543" width="1072" height="1" fill="${C.line}"/>
${t(64, 581, 18, C.text3, escapeHtml(link))}
${crewLine}
</svg>`;
}

let ready: Promise<void> | null = null;

export async function renderPng(svg: string): Promise<Uint8Array> {
  ready ??= initWasm(RESVG_WASM).catch((e) => { ready = null; throw e; });
  await ready;
  const resvg = new Resvg(svg, {
    font: {
      fontBuffers: [new Uint8Array(FONT_REGULAR), new Uint8Array(FONT_SEMIBOLD)],
      defaultFontFamily: 'Geist Mono',
    },
  });
  try {
    const image = resvg.render();
    try {
      return image.asPng();
    } finally {
      image.free();
    }
  } finally {
    resvg.free();
  }
}
