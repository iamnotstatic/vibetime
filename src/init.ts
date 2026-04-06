import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import chalk from 'chalk';

const PURPLE = chalk.hex('#7C3AED');

const HOOK_MARKER = '# vibetime hooks';
export const DEFAULT_TOOLS = ['claude', 'codex', 'gemini'];

export function detectShell(): { shell: string; rcFile: string } {
  const shellEnv = process.env.SHELL || '/bin/zsh';
  if (shellEnv.includes('zsh')) {
    return { shell: 'zsh', rcFile: join(homedir(), '.zshrc') };
  }
  return { shell: 'bash', rcFile: join(homedir(), '.bashrc') };
}

export function appendHook(tool: string, rcFile: string): boolean {
  const hookLine = `${tool}() { vibe __wrap ${tool} "$@"; }`;

  if (existsSync(rcFile)) {
    const content = readFileSync(rcFile, 'utf-8');
    if (content.includes(`vibe __wrap ${tool}`)) return false;
  }

  appendFileSync(rcFile, `\n${hookLine}\n`);
  return true;
}

export function initShellHooks(): void {
  const { shell, rcFile } = detectShell();

  if (existsSync(rcFile)) {
    const content = readFileSync(rcFile, 'utf-8');
    if (content.includes(HOOK_MARKER)) {
      console.log(`\n  ${PURPLE('◆')} vibetime hooks already in ${rcFile}\n`);
      console.log(`  restart your shell or run: source ${rcFile}\n`);
      return;
    }
  }

  const block = `\n${HOOK_MARKER}\n` +
    DEFAULT_TOOLS.map(t => `${t}() { vibe __wrap ${t} "$@"; }`).join('\n') +
    '\n';
  appendFileSync(rcFile, block);

  console.log(`\n  ${PURPLE('◆')} vibetime hooks added to ${rcFile} (${shell})\n`);
  console.log(`  added:`);
  for (const t of DEFAULT_TOOLS) {
    console.log(`    ${t}() { vibe __wrap ${t} "$@"; }`);
  }
  console.log(`\n  restart your shell or run: source ${rcFile}\n`);
}
