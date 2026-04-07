import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { PURPLE } from './colors.js';

const HOOK_MARKER = '# vibetime hooks';
export const DEFAULT_TOOLS = ['claude', 'codex', 'gemini'];

function hookLines(tool: string): string {
  const lower = tool.toLowerCase();
  const title = lower.charAt(0).toUpperCase() + lower.slice(1);
  const upper = lower.toUpperCase();
  return [
    `${lower}() { vibe __wrap ${lower} "$@"; }`,
    `${title}() { vibe __wrap ${lower} "$@"; }`,
    `${upper}() { vibe __wrap ${lower} "$@"; }`,
  ].join('\n');
}

export function detectShell(): { shell: string; rcFile: string } {
  const shellEnv = process.env.SHELL || '/bin/zsh';
  if (shellEnv.includes('zsh')) {
    return { shell: 'zsh', rcFile: join(homedir(), '.zshrc') };
  }
  return { shell: 'bash', rcFile: join(homedir(), '.bashrc') };
}

export function appendHook(tool: string, rcFile: string): boolean {
  const lower = tool.toLowerCase();

  if (existsSync(rcFile)) {
    const content = readFileSync(rcFile, 'utf-8');
    if (content.includes(`vibe __wrap ${lower}`)) return false;
  }

  appendFileSync(rcFile, `\n${hookLines(lower)}\n`);
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
    DEFAULT_TOOLS.map(t => hookLines(t)).join('\n') +
    '\n';
  appendFileSync(rcFile, block);

  console.log(`\n  ${PURPLE('◆')} vibetime hooks added to ${rcFile} (${shell})\n`);
  console.log(`  added:`);
  for (const t of DEFAULT_TOOLS) {
    console.log(`    ${t}() { vibe __wrap ${t} "$@"; }`);
  }
  console.log(`\n  restart your shell or run: source ${rcFile}\n`);
}

export function removeShellHooks(): void {
  const { rcFile } = detectShell();

  if (!existsSync(rcFile)) {
    console.log(`\n  ${PURPLE('◆')} nothing to remove — ${rcFile} not found\n`);
    return;
  }

  const content = readFileSync(rcFile, 'utf-8');

  const HOOK_RE = /^[a-zA-Z0-9_-]+\(\) \{ vibe __wrap /;
  const lines = content.split('\n');
  const filtered: string[] = [];
  let inBlock = false;

  for (const line of lines) {
    if (line.trim() === HOOK_MARKER) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      if (HOOK_RE.test(line)) continue;
      if (line.trim() === '') {
        inBlock = false;
        continue;
      }
      inBlock = false;
    }

    // remove standalone hooks added via add-tool
    if (HOOK_RE.test(line)) continue;

    filtered.push(line);
  }

  const cleaned = filtered.join('\n');

  if (cleaned === content) {
    console.log(`\n  ${PURPLE('◆')} no vibetime hooks found in ${rcFile}\n`);
    return;
  }

  writeFileSync(rcFile, cleaned);
  console.log(`\n  ${PURPLE('◆')} vibetime hooks removed from ${rcFile}\n`);
  console.log(`  restart your shell or run: source ${rcFile}\n`);
}
