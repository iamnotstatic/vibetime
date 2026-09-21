import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Terminal sessions (wrap.ts) and desktop sessions (hook.ts) implement the same
// lifecycle independently, and a capability added to one is only ever carried to
// the other by someone remembering. Twice it wasn't: desktop sessions went two
// months without in-progress submits, and had never once refreshed /config.
// Neither broke a test, because nothing compared the paths.
//
// This compares them. It cannot see logic, only which capabilities each path
// reaches for, which is exactly the level both misses happened at.
const wrap = readFileSync(new URL('../src/wrap.ts', import.meta.url), 'utf-8');
const hook = readFileSync(new URL('../src/hook.ts', import.meta.url), 'utf-8');

// The modules that carry session-lifecycle behaviour. git and db are excluded:
// the paths genuinely read git differently (a poller versus per-event diffs).
const SHARED = ['submit', 'remote-config', 'score', 'reconcile', 'rescore'];

// Divergences that are decisions rather than oversights. Adding an entry is how
// you say "this one really does not apply", with the reason attached.
const ALLOWED = {
  // 'module': { name: 'why it cannot apply to the other path' },
  'remote-config': {
    // The one capability a hook genuinely cannot carry: it prints. Hook stdout
    // belongs to the editor, so a desktop user is reached through `vibe status`,
    // `log` and `leaderboard` instead, which is the whole point of #68.
    recommendedUpgrade: 'the hook path has no stdout a user ever reads',
  },
};

function capabilities(src, mod) {
  const m = src.match(new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*'\\./${mod}\\.js'`, 's'));
  if (!m) return new Set();
  return new Set(
    m[1].split(',').map((s) => s.trim()).filter((s) => s && !s.startsWith('type ')),
  );
}

const excused = (mod, name) => Object.prototype.hasOwnProperty.call(ALLOWED[mod] ?? {}, name);

test('every lifecycle capability reaches both tracking paths', () => {
  for (const mod of SHARED) {
    const inWrap = capabilities(wrap, mod);
    const inHook = capabilities(hook, mod);

    for (const name of inWrap) {
      assert.ok(inHook.has(name) || excused(mod, name),
        `wrap.ts uses ${name} from ${mod} but hook.ts does not. Desktop sessions will silently miss it. `
        + `Add it to hook.ts, or add it to ALLOWED in this file with the reason it cannot apply.`);
    }
    for (const name of inHook) {
      assert.ok(inWrap.has(name) || excused(mod, name),
        `hook.ts uses ${name} from ${mod} but wrap.ts does not. Terminal sessions will silently miss it. `
        + `Add it to wrap.ts, or add it to ALLOWED in this file with the reason it cannot apply.`);
    }
  }
});

test('both paths submit in progress, not only at the end', () => {
  // The specific miss that made a five hour desktop session show nothing and
  // cap a whole day at one ship. Named so the regression is unmistakable.
  for (const [name, src] of [['wrap.ts', wrap], ['hook.ts', hook]]) {
    assert.match(src, /submitInProgress/, `${name} must submit while a session runs`);
  }
});

test('both paths refresh the server tunables', () => {
  // Server-tuned timings are the lever for users who never upgrade, so a path
  // that never refreshes them cannot be tuned at all.
  for (const [name, src] of [['wrap.ts', wrap], ['hook.ts', hook]]) {
    assert.match(src, /refreshTunables/, `${name} must pick up server-tuned timings`);
  }
});
