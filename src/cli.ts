#!/usr/bin/env node

/**
 * OpenBridge CLI entry point.
 *
 * Usage: openbridge-ai start
 */

import { runStart, runConfigure } from './cli/start.js';

const USAGE = `
openbridge-ai — Remote control for coding agents via Slack/Discord

Usage:
  openbridge-ai start       Launch the bridge (runs setup wizard on first use)
  openbridge-ai configure   Change settings (platforms, tokens, backend, etc.)
  openbridge-ai --help      Show this help message
`.trim();

export function parseArgs(argv: string[]): { command: string | null; args: string[] } {
  // argv[0] = node, argv[1] = script path, argv[2..] = user args
  const userArgs = argv.slice(2);

  if (userArgs.length === 0) {
    return { command: null, args: [] };
  }

  const first = userArgs[0];

  if (first === '--help' || first === '-h') {
    return { command: 'help', args: [] };
  }

  if (first === '--version' || first === '-v') {
    return { command: 'version', args: [] };
  }

  return { command: first, args: userArgs.slice(1) };
}

export async function cli(argv: string[]): Promise<void> {
  const { command } = parseArgs(argv);

  switch (command) {
    case null:
    case 'help':
      console.log(USAGE);
      break;

    case 'version':
      console.log('openbridge-ai 0.1.0');
      break;

    case 'start':
      await runStart();
      break;

    case 'configure':
      await runConfigure();
      break;

    default:
      console.error(`[cli] unknown command: ${command}`);
      console.error('[cli] run "openbridge-ai --help" for usage.');
      process.exit(1);
  }
}

// Run when invoked directly
cli(process.argv).catch((err) => {
  console.error('[openbridge] fatal error:', err);
  process.exit(1);
});
