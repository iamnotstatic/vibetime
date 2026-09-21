#!/usr/bin/env node

import { Command } from 'commander';
import { getSessions } from './db.js';
import { refreshAndReap } from './rescore.js';
import { readConfig, writeConfig, addTool, removeTool, setInstallOptOut } from './config.js';
import { renderStatus, renderLog, renderLeaderboard, renderUpgradeNotice } from './render.js';
import { recommendedUpgrade } from './remote-config.js';
import { renderTerminalCard, writeHtmlCard } from './share.js';
import { wrapTool } from './wrap.js';
import { initShellHooks, removeShellHooks } from './init.js';
import { isInstalled } from './reconcile.js';
import { installClaudeHooks, removeClaudeHooks } from './claude-hooks.js';
import { installCodexHooks, removeCodexHooks } from './codex-hooks.js';
import { installCursorHooks, removeCursorHooks } from './cursor-hooks.js';
import { handleHook, parseHookTool } from './hook.js';
import { login, logout, readAuth, needsLogin, offerLogin } from './auth.js';
import { fetchLeaderboard } from './leaderboard.js';
import { flushPendingSubmissions, pendingSubmissionCount } from './submit.js';
import { WEB_BASE } from './api.js';
import chalk from 'chalk';
import open from 'open';
import { createRequire } from 'node:module';
import { PURPLE } from './colors.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

const RED = chalk.hex('#EF4444');

process.on('unhandledRejection', (err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\n  ${RED('✗')} vibe: ${message}\n`);
  process.exit(1);
});

const program = new Command();

program
  .name('vibe')
  .description('session analytics for the vibe coding era')
  .version(version)
  .enablePositionalOptions();

async function runInit(): Promise<void> {
  setInstallOptOut({ shell: false, desktop: false });
  initShellHooks();
  // Unconditional, like the shell functions: hooks are inert config until the
  // app exists, so someone who installs Claude Code, Codex, or Cursor months
  // from now is already tracked without remembering to re-run init.
  installClaudeHooks();
  installCodexHooks();
  installCursorHooks();

  // Setup is the only moment we have a new user's attention, so this is where
  // the leaderboard gets offered. It asks, and it no-ops when it can't.
  await offerLogin();
}

async function showStatus(): Promise<void> {
  await refreshAndReap();
  await flushPendingSubmissions(1500).catch(() => {});
  const sessions = getSessions();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  const todaySessions = sessions.filter((s) => {
    const d = new Date(s.startedAt);
    if (d >= today && d < tomorrow) return true;
    // active sessions: only include if last activity was today
    if (s.exitCode === -1) {
      const lastActivity = new Date(s.lastActivityAt || s.startedAt);
      return lastActivity >= today && lastActivity < tomorrow;
    }
    return false;
  });

  console.log(renderStatus(todaySessions, needsLogin(), pendingSubmissionCount()));
  printUpgradeNotice();
}

// Desktop-only users never see an endcard: their sessions run through hooks,
// whose stdout belongs to the editor. These commands are the only surface they
// have, so the nudge rides on all of them rather than the endcard alone.
function printUpgradeNotice(): void {
  const upgrade = recommendedUpgrade();
  if (upgrade) console.log(renderUpgradeNotice(upgrade));
}

// Bare `vibe` is the first thing anyone types after installing, and npm hides
// postinstall output entirely, so this is the earliest moment we can actually
// reach a new user. Set them up rather than printing a help dump they have to
// act on; once set up, show them today.
program
  .action(async () => {
    if (isInstalled()) {
      await showStatus();
      return;
    }
    await runInit();
  });

program
  .command('init')
  .description('set up session tracking: shell wrapper + desktop hooks')
  .action(runInit);

program
  .command('uninstall')
  .description('remove shell hooks and desktop hooks')
  .action(() => {
    // Recorded so the session-start repair doesn't put it all back tomorrow.
    setInstallOptOut({ shell: true, desktop: true });
    removeShellHooks();
    removeClaudeHooks();
    removeCodexHooks();
    removeCursorHooks();
  });

const hooksCmd = program
  .command('hooks')
  .description('track desktop coding sessions via lifecycle hooks');

hooksCmd
  .command('install')
  .description('track Claude Code, Codex, and Cursor Desktop sessions')
  .action(() => {
    setInstallOptOut({ desktop: false });
    installClaudeHooks();
    installCodexHooks();
    installCursorHooks();
  });

hooksCmd
  .command('uninstall')
  .description('stop tracking Claude Code, Codex, and Cursor Desktop sessions')
  .action(() => {
    setInstallOptOut({ desktop: true });
    removeClaudeHooks();
    removeCodexHooks();
    removeCursorHooks();
  });

program
  .command('status')
  .description("today's sessions")
  .action(showStatus);

program
  .command('log')
  .description('full session history')
  .action(async () => {
    await refreshAndReap();
    await flushPendingSubmissions(1500).catch(() => {});
    const sessions = getSessions();
    const recent = sessions.slice(-20).reverse();
    console.log(renderLog(recent, sessions));
    printUpgradeNotice();
  });

program
  .command('share')
  .description("this week's share card")
  .option('--html', 'skip terminal card, open HTML directly')
  .action(async (opts: { html?: boolean }) => {
    await refreshAndReap();
    await flushPendingSubmissions(1500).catch(() => {});
    const sessions = getSessions();

    if (opts.html) {
      const path = writeHtmlCard(sessions);
      console.log(`\n  ${PURPLE('◆')} opening HTML card...\n`);
      await open(path);
      return;
    }

    const card = await renderTerminalCard(sessions);
    console.log(card);

    if (!process.stdin.isTTY) {
      return;
    }

    try {
      process.stdin.setRawMode(true);
    } catch {
      return;
    }
    process.stdin.resume();

    const timeout = setTimeout(cleanup, 5000);

    function cleanup() {
      clearTimeout(timeout);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.exit(0);
    }

    process.stdin.once('data', async (key: Buffer) => {
      const char = key.toString();
      if (char === 'h' || char === 'H') {
        console.log(`  opening HTML card...`);
        const path = writeHtmlCard(sessions);
        await open(path);
        cleanup();
      } else {
        cleanup();
      }
    });
  });

program
  .command('login')
  .description('sign in to the public leaderboard via github')
  .action(async () => {
    await login();
  });

program
  .command('logout')
  .description('sign out of the leaderboard')
  .action(async () => {
    await logout();
  });

program
  .command('leaderboard')
  .description('ships, this week')
  .action(async () => {
    await refreshAndReap();
    await flushPendingSubmissions(1500).catch(() => {});
    try {
      const data = await fetchLeaderboard();
      const auth = readAuth();
      console.log(renderLeaderboard(data.entries, `${WEB_BASE}/leaderboard`, auth?.handle));
      printUpgradeNotice();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown error';
      console.log(`\n  ${RED('✗')} vibe: could not load leaderboard (${msg})\n`);
    }
  });

const configCmd = program
  .command('config')
  .description('manage configuration');

configCmd
  .command('set <key> <value>')
  .description('set a config value')
  .action((key: string, value: string) => {
    const config = readConfig();
    if (key === 'handle') {
      config.handle = value;
    } else if (key === 'thresholdLines' || key === 'thresholdFiles') {
      const num = parseInt(value, 10);
      if (isNaN(num)) {
        console.log(`\n  ${RED('✗')} ${key} must be a number\n`);
        return;
      }
      config[key] = num;
    } else {
      console.log(`\n  unknown config key: ${key}\n`);
      return;
    }
    writeConfig(config);
    console.log(`\n  ${key} updated to ${key === 'handle' ? '@' : ''}${value}\n`);
  });

configCmd
  .command('add-tool <name>')
  .description('track a new AI CLI tool')
  .action(async (name: string) => {
    await addTool(name);
  });

configCmd
  .command('remove-tool <name>')
  .description('stop tracking an AI CLI tool')
  .action((name: string) => {
    removeTool(name);
  });

configCmd
  .command('show')
  .description('show current configuration')
  .action(() => {
    const config = readConfig();
    console.log(`\n  ${PURPLE('◆')} vibe config\n`);
    console.log(`  handle:         ${config.handle || '(not set)'}`);
    console.log(`  thresholdLines: ${config.thresholdLines}`);
    console.log(`  thresholdFiles: ${config.thresholdFiles}`);
    console.log();
  });

program
  .command('__wrap', { hidden: true })
  .argument('<tool>', 'tool to wrap')
  .argument('[args...]', 'arguments to pass')
  .helpOption(false)
  .allowUnknownOption()
  .passThroughOptions()
  .action(async (tool: string, args: string[]) => {
    await wrapTool(tool, args);
  });

// Invoked by Claude Code, Codex, or Cursor hooks with the event payload on
// stdin. Must stay silent on stdout (SessionStart stdout is fed to the model)
// except for the codex Stop response, and always exit the moment the work is
// done — a lingering handle (e.g. a submit's keep-alive socket) must never hold
// the host's hook slot open.
program
  .command('__hook', { hidden: true })
  .argument('<event>', 'session-start | activity | session-end')
  .option('--tool <tool>', 'claude | codex | cursor', 'claude')
  .option('--respond-json', 'write an empty JSON hook response')
  .helpOption(false)
  .action(async (event: string, opts: { tool: string; respondJson?: boolean }) => {
    try {
      await handleHook(event, await readStdin(), parseHookTool(opts.tool));
    } catch {}
    if (opts.respondJson) process.stdout.write('{}\n', () => process.exit(0));
    else process.exit(0);
  });

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
    // never hang a session waiting on stdin
    setTimeout(() => resolve(data), 2000).unref();
  });
}

program.parse();
