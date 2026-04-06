import { join } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

export interface VibeConfig {
  handle?: string;
  thresholdLines: number;
  thresholdFiles: number;
}

export const VIBE_DIR = join(homedir(), '.vibe');
const CONFIG_PATH = join(VIBE_DIR, 'config.json');

const DEFAULTS: VibeConfig = {
  thresholdLines: 50,
  thresholdFiles: 3,
};

export function ensureVibeDir(): void {
  mkdirSync(VIBE_DIR, { recursive: true });
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
