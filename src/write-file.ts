import { readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

// For files other programs own and write too: editor settings, hook configs,
// shell rc files. A plain write truncates and then writes, so two writers at
// once leave one's bytes over the other's tail, and an app that finds its
// settings file unparseable drops all of it, not just our hooks. A rename
// lands whole or not at all.
//
// The rename goes to the real file behind a symlink, so a dotfiles link stays
// a link, and the file keeps its mode. Identical content is never rewritten:
// the session-start repair runs this on every session, and a write that
// changes nothing is still a write that can race.
export function writeFileAtomic(path: string, content: string): void {
  let target = path;
  let mode: number | undefined;
  try {
    target = realpathSync(path);
    if (readFileSync(target, 'utf-8') === content) return;
    mode = statSync(target).mode & 0o777;
  } catch {}

  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, content, mode === undefined ? undefined : { mode });
    renameSync(tmp, target);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    // Windows refuses to rename over a file another process holds open. A
    // plain write there is what this replaced, and better than no install.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EBUSY') throw err;
    writeFileSync(target, content);
  }
}
