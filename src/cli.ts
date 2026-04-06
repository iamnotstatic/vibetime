#!/usr/bin/env node

import { Command } from 'commander';
import { getSessions } from './db.js';
import { readConfig, writeConfig, addTool } from './config.js';
import { renderStatus, renderLog } from './render.js';
import { renderTerminalCard, writeHtmlCard } from './share.js';
import { wrapTool } from './wrap.js';
import { initShellHooks } from './init.js';
import chalk from 'chalk';
import open from 'open';

const PURPLE = chalk.hex('#7C3AED');

const program = new Command();

program
  .name('vibe')
  .description('session analytics for the vibe coding era')
  .version('0.1.1')
  .enablePositionalOptions();

program
  .command('init')
  .description('set up shell hooks for session tracking')
  .action(initShellHooks);

program
  .command('status')
  .description("today's sessions")
  .action(async () => {
    const sessions = await getSessions();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    const todaySessions = sessions.filter((s) => {
      const d = new Date(s.startedAt);
      return d >= today && d < tomorrow;
    });

    console.log(renderStatus(todaySessions));
  });

program
  .command('log')
  .description('full session history')
  .action(async () => {
    const sessions = await getSessions();
    const recent = sessions.slice(-20).reverse();
    console.log(renderLog(recent));
  });

program
  .command('share')
  .description("this week's share card")
  .option('--html', 'skip terminal card, open HTML directly')
  .action(async (opts: { html?: boolean }) => {
    const sessions = await getSessions();

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

    process.stdin.setRawMode(true);
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
    } else if (key === 'thresholdLines') {
      config.thresholdLines = parseInt(value, 10);
    } else if (key === 'thresholdFiles') {
      config.thresholdFiles = parseInt(value, 10);
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
