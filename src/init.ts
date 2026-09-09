import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { PURPLE } from './colors.js';

const HOOK_MARKER = '# vibetime hooks';
export const DEFAULT_TOOLS = ['claude', 'codex', 'gemini', 'aster'];
export type Shell = 'bash' | 'zsh' | 'fish';

function hookLines(tool: string, shell: Shell = 'bash'): string {
  const lower = tool.toLowerCase();
  const title = lower.charAt(0).toUpperCase() + lower.slice(1);
  const upper = lower.toUpperCase();
  if (shell === 'fish') {
    return [lower, title, upper]
      .map(name => `function ${name}; vibe __wrap ${lower} $argv; end`)
      .join('\n');
  }
  return [
    `${lower}() { vibe __wrap ${lower} "$@"; }`,
    `${title}() { vibe __wrap ${lower} "$@"; }`,
    `${upper}() { vibe __wrap ${lower} "$@"; }`,
  ].join('\n');
}

// Every rc file vibe may have written hooks into across shell switches. A
// user who ran init under bash and later moved to zsh still has hooks in
// .bashrc, so removal sweeps all candidates, not just the current shell's
// file (#4). The removal regexes match bash and fish syntax in one pass.
export function candidateRcFiles(): string[] {
  return [
    join(homedir(), '.bashrc'),
    join(homedir(), '.zshrc'),
    join(homedir(), '.config', 'fish', 'config.fish'),
  ];
}

export function detectShell(): { shell: Shell; rcFile: string } {
  // Match on the binary name only: a path like /Users/fisher/bin/zsh must not
  // read as fish, or a zsh user gets fish syntax in a config.fish they never
  // load and their real hooks are never installed.
  const shellEnv = basename(process.env.SHELL || '/bin/zsh');
  if (shellEnv.includes('fish')) {
    return { shell: 'fish', rcFile: join(homedir(), '.config', 'fish', 'config.fish') };
  }
  if (shellEnv.includes('zsh')) {
    return { shell: 'zsh', rcFile: join(homedir(), '.zshrc') };
  }
  return { shell: 'bash', rcFile: join(homedir(), '.bashrc') };
}

export function appendHook(tool: string, rcFile: string, shell: Shell = 'bash'): boolean {
  const lower = tool.toLowerCase();

  if (existsSync(rcFile)) {
    const content = readFileSync(rcFile, 'utf-8');
    // Trailing space so `claude` doesn't match a `claudex` hook.
    if (content.includes(`vibe __wrap ${lower} `)) return false;
  }

  mkdirSync(dirname(rcFile), { recursive: true });
  appendFileSync(rcFile, `\n${hookLines(lower, shell)}\n`);
  return true;
}

export function removeHook(tool: string, rcFile: string): boolean {
  const lower = tool.toLowerCase();
  if (!existsSync(rcFile)) return false;

  const content = readFileSync(rcFile, 'utf-8');
  // Only hook definitions for this tool — a line that merely mentions the
  // wrap command (a comment, an alias) is the user's, not ours.
  const HOOK_RE = new RegExp(
    `^(?:[a-zA-Z0-9_-]+\\(\\) \\{ vibe __wrap ${lower} |function [a-zA-Z0-9_-]+; vibe __wrap ${lower} \\$argv; end$)`,
  );
  const filtered = content.split('\n').filter((line) => !HOOK_RE.test(line));

  const cleaned = filtered.join('\n');
  if (cleaned === content) return false;

  writeFileSync(rcFile, cleaned);
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
    DEFAULT_TOOLS.map(t => hookLines(t, shell)).join('\n') +
    '\n';
  mkdirSync(dirname(rcFile), { recursive: true });
  appendFileSync(rcFile, block);

  console.log(`\n  ${PURPLE('◆')} vibetime hooks added to ${rcFile} (${shell})\n`);
  console.log(`  added:`);
  for (const t of DEFAULT_TOOLS) {
    console.log(shell === 'fish'
      ? `    function ${t}; vibe __wrap ${t} $argv; end`
      : `    ${t}() { vibe __wrap ${t} "$@"; }`);
  }
  console.log(`\n  restart your shell or run: source ${rcFile}\n`);
}

function stripHooksFromFile(rcFile: string): boolean {
  const content = readFileSync(rcFile, 'utf-8');

  const HOOK_RE = /^(?:[a-zA-Z0-9_-]+\(\) \{ vibe __wrap |function [a-zA-Z0-9_-]+; vibe __wrap .* \$argv; end$)/;
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
  if (cleaned === content) return false;

  writeFileSync(rcFile, cleaned);
  return true;
}

export function removeShellHooks(): void {
  let removedAny = false;
  for (const rcFile of candidateRcFiles()) {
    if (!existsSync(rcFile)) continue;
    if (stripHooksFromFile(rcFile)) {
      removedAny = true;
      console.log(`\n  ${PURPLE('◆')} vibetime hooks removed from ${rcFile}`);
    }
  }

  if (!removedAny) {
    console.log(`\n  ${PURPLE('◆')} no vibetime hooks found\n`);
    return;
  }
  console.log(`\n  restart your shell to finish\n`);
}
