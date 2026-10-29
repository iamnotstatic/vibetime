// Preloaded into every test file by `npm test`. Any test that opens a hook
// session runs the install repair, which writes the desktop apps' configs
// under HOME: without this, a test run in a worktree repoints the developer's
// real Claude, Codex, Cursor and ZCode hooks at that worktree, and a run that
// races the app's own write leaves the file unparseable. Files that set HOME
// themselves still can; this is only the floor.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'vibe-test-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.CODEX_HOME = join(home, '.codex');
