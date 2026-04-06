import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import chalk from 'chalk';

const PURPLE = chalk.hex('#7C3AED');

const HOOK_MARKER = '# vibetime hooks';
const HOOKS = `
${HOOK_MARKER}
claude() { vibe __wrap claude "$@"; }
codex()  { vibe __wrap codex  "$@"; }
gemini() { vibe __wrap gemini "$@"; }
`;

function detectShell() {
  const shellEnv = process.env.SHELL || '/bin/zsh';
  if (shellEnv.includes('zsh')) {
    return { shell: 'zsh', rcFile: join(homedir(), '.zshrc') };
  }
  return { shell: 'bash', rcFile: join(homedir(), '.bashrc') };
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

  appendFileSync(rcFile, HOOKS);

  console.log(`\n  ${PURPLE('◆')} vibetime hooks added to ${rcFile} (${shell})\n`);
  console.log(`  added:`);
  console.log(`    claude() { vibe __wrap claude "$@"; }`);
  console.log(`    codex()  { vibe __wrap codex  "$@"; }`);
  console.log(`    gemini() { vibe __wrap gemini "$@"; }\n`);
  console.log(`  restart your shell or run: source ${rcFile}\n`);
}
