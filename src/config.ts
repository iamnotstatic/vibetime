import { join, resolve } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { mkdirSync, chmodSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import chalk from 'chalk';
import { DEFAULT_TOOLS, detectShell, appendHook, removeHook, candidateRcFiles } from './init.js';
import { PURPLE } from './colors.js';

const RED = chalk.hex('#EF4444');

export interface VibeConfig {
  handle?: string;
  thresholdLines: number;
  thresholdFiles: number;
  // Deliberate removals. Reconcile repairs an install on every session start,
  // so without a record of what the user took away it would put it straight
  // back and `vibe uninstall` would be a no-op that reinstalls itself.
  removedTools?: string[];
  shellHooksOptOut?: boolean;
  desktopHooksOptOut?: boolean;
  // Opt-in forge verification (see forge.ts): the forge host whose repos get
  // their commits checked. Unset means no commit ids are ever sent.
  forge?: string;
}

// Overridable so tests can run the full session flow against a scratch dir
// instead of the real ~/.vibe. Resolved to absolute so a relative value can't
// scatter one database per working directory.
export const VIBE_DIR = process.env.VIBE_DIR ? resolve(process.env.VIBE_DIR) : join(homedir(), '.vibe');
const CONFIG_PATH = join(VIBE_DIR, 'config.json');

export const DEFAULTS: VibeConfig = {
  thresholdLines: 50,
  thresholdFiles: 3,
};

export function ensureVibeDir(): void {
  mkdirSync(VIBE_DIR, { recursive: true });
  // Always, not just on create: sessions and auth are private, and an
  // overridden VIBE_DIR may point at a dir that already exists more open.
  chmodSync(VIBE_DIR, 0o700);
}

export function readConfig(): VibeConfig {
  ensureVibeDir();
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2) + '\n');
    return { ...DEFAULTS };
  }
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeConfig(config: VibeConfig): void {
  ensureVibeDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

export function getHandle(): string {
  const config = readConfig();
  return config.handle || userInfo().username;
}

export function addTool(name: string): void {
  if (/\s/.test(name)) {
    console.log(`\n  ${RED('✗')} tool name must be a single word\n`);
    return;
  }

  const { shell, rcFile } = detectShell();

  if (!existsSync(rcFile)) {
    console.log(`\n  ${RED('✗')} run vibe init first to set up Vibetime.\n`);
    return;
  }

  // Adding it back is the user reversing a removal, so drop the opt-out.
  const config = readConfig();
  const lower = name.toLowerCase();
  if ((config.removedTools ?? []).includes(lower)) {
    config.removedTools = config.removedTools!.filter((t) => t !== lower);
    writeConfig(config);
  }

  // A default tool is only "already added by vibe init" while its hooks are
  // actually in the rc file — after a remove-tool it can be re-added.
  const added = appendHook(name, rcFile, shell);
  if (added) {
    console.log(`\n  ${PURPLE('◆')} ${name} added. restart your terminal to start tracking.\n`);
  } else if (DEFAULT_TOOLS.includes(name.toLowerCase())) {
    console.log(`\n  ${PURPLE('◆')} ${name} is already added by vibe init\n`);
  } else {
    console.log(`\n  ${PURPLE('◆')} ${name} is already being tracked.\n`);
  }
}

export function removeTool(name: string): void {
  if (/\s/.test(name)) {
    console.log(`\n  ${RED('✗')} tool name must be a single word\n`);
    return;
  }

  // Sweep every rc file, not just the current shell's: hooks can live in a
  // previous shell's rc after a switch (#4).
  let removed = false;
  for (const rcFile of candidateRcFiles()) {
    if (!existsSync(rcFile)) continue;
    if (removeHook(name, rcFile)) removed = true;
  }

  // Remember it even when no hook line was found: the user has stated intent,
  // and reconcile must not add this tool back on the next session.
  const config = readConfig();
  const lower = name.toLowerCase();
  if (!(config.removedTools ?? []).includes(lower)) {
    config.removedTools = [...(config.removedTools ?? []), lower];
    writeConfig(config);
  }

  if (removed) {
    console.log(`\n  ${PURPLE('◆')} ${name} removed. restart your terminal to stop tracking.\n`);
    if (DEFAULT_TOOLS.includes(name.toLowerCase())) {
      console.log(`  bring it back anytime: vibe config add-tool ${name}\n`);
    }
  } else {
    console.log(`\n  ${PURPLE('◆')} ${name} is not being tracked.\n`);
  }
}

export async function promptHandle(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question('  your handle (for the share card): ', (answer) => {
      rl.close();
      const handle = answer.trim() || userInfo().username;
      const config = readConfig();
      config.handle = handle;
      writeConfig(config);
      resolve(handle);
    });
  });
}

// Records that a removal (or a re-install) was deliberate, so the session-start
// repair in reconcile.ts respects it instead of undoing the user's choice.
export function setInstallOptOut(opts: { shell?: boolean; desktop?: boolean }): void {
  const config = readConfig();
  if (opts.shell !== undefined) config.shellHooksOptOut = opts.shell;
  if (opts.desktop !== undefined) config.desktopHooksOptOut = opts.desktop;
  writeConfig(config);
}
