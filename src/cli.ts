#!/usr/bin/env node

import { Command } from 'commander';
import { getSessions, reapOrphanedSessions } from './db.js';
import { readConfig, writeConfig, addTool } from './config.js';
import { renderStatus, renderLog, renderLeaderboard } from './render.js';
import { renderTerminalCard, writeHtmlCard } from './share.js';
import { wrapTool } from './wrap.js';
import { initShellHooks, removeShellHooks } from './init.js';
import { login, logout, readAuth } from './auth.js';
import { fetchLeaderboard } from './leaderboard.js';
import { flushPendingSubmissions } from './submit.js';
import { refreshActiveIdeSessions, renderIdeStatus, startIdeSession, stopIdeSession } from './ide.js';
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

program
  .command('init')
  .description('set up shell hooks for session tracking')
  .action(initShellHooks);

program
  .command('uninstall')
  .description('remove shell hooks')
  .action(removeShellHooks);

program
  .command('status')
  .description("today's sessions")
  .action(async () => {
    await reapOrphanedSessions();
    await refreshActiveIdeSessions();
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

    console.log(renderStatus(todaySessions));
  });

program
  .command('log')
  .description('full session history')
  .action(async () => {
    await reapOrphanedSessions();
    await refreshActiveIdeSessions();
    const sessions = getSessions();
    const recent = sessions.slice(-20).reverse();
    console.log(renderLog(recent));
  });

program
  .command('share')
  .description("this week's share card")
  .option('--html', 'skip terminal card, open HTML directly')
  .action(async (opts: { html?: boolean }) => {
    await reapOrphanedSessions();
    await refreshActiveIdeSessions();
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
  .action(() => {
    logout();
  });

program
  .command('leaderboard')
  .description('shipped sessions, last 7 days')
  .action(async () => {
    await flushPendingSubmissions(1500).catch(() => {});
    try {
      const data = await fetchLeaderboard();
      const auth = readAuth();
      console.log(renderLeaderboard(data.entries, `${WEB_BASE}/leaderboard`, auth?.handle));
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown error';
      console.log(`\n  ${RED('✗')} vibe: could not load leaderboard (${msg})\n`);
    }
  });

const ideCmd = program
  .command('ide')
  .description('track IDE sessions like cursor');

ideCmd
  .command('start [tool]')
  .description('start tracking an IDE session')
  .action(async (tool?: string) => {
    await startIdeSession(tool);
  });

ideCmd
  .command('stop [tool]')
  .description('stop tracking an IDE session')
  .action(async (tool?: string) => {
    await stopIdeSession(tool);
  });

ideCmd
  .command('status')
  .description('active IDE sessions')
  .action(async () => {
    console.log(await renderIdeStatus());
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

program.parse();
