import { join, resolve } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { mkdirSync, chmodSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import chalk from 'chalk';
import { DEFAULT_TOOLS, detectShell, appendHook, removeHook } from './init.js';
import { PURPLE } from './colors.js';

const RED = chalk.hex('#EF4444');

export interface VibeConfig {
  handle?: string;
  thresholdLines: number;
  thresholdFiles: number;
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

  const { rcFile } = detectShell();

  if (!existsSync(rcFile)) {
    console.log(`\n  ${RED('✗')} run vibe init first to set up Vibetime.\n`);
    return;
  }

  // A default tool is only "already added by vibe init" while its hooks are
  // actually in the rc file — after a remove-tool it can be re-added.
  const added = appendHook(name, rcFile);
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

  const { rcFile } = detectShell();

  if (!existsSync(rcFile)) {
    console.log(`\n  ${PURPLE('◆')} nothing to remove — ${rcFile} not found\n`);
    return;
  }

  const removed = removeHook(name, rcFile);
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
