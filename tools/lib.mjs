// Shared by the owner-only post scripts in tools/.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'server');

// Production D1 through wrangler, run from anywhere in the repo. Cloudflare
// answers 7403 now and then for no reason a retry doesn't cure.
export function d1(sql) {
  const run = () => execFileSync('npx', ['wrangler', 'd1', 'execute', 'vibetime', '--remote', '--json', '--command', sql], {
    cwd: serverDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out;
  try {
    out = run();
  } catch (e) {
    if (!String(e.stdout ?? '').includes('7403')) throw e;
    out = run();
  }
  return JSON.parse(out)[0].results;
}

// X weighs any link as 23 and emoji as 2, and won't send past 280.
export function xLength(text) {
  return [...text.replace(/vibetime\.club\S*/g, 'x'.repeat(23))]
    .reduce((n, ch) => n + (ch.codePointAt(0) <= 4351 || (ch.codePointAt(0) >= 8192 && ch.codePointAt(0) <= 8247) ? 1 : 2), 0);
}
