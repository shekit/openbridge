/**
 * openbridge start — Launch the bridge process.
 *
 * Reads config from .openbridge/, loads tokens from environment,
 * creates the router and messaging adapters, and starts listening.
 * On subsequent interactive runs, shows a settings menu before starting.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as clack from '@clack/prompts';
import { Store } from '../store.js';
import { Router, type BackendFactory } from '../router.js';
import { ClaudeBackend } from '../backends/claude.js';
import { CodexBackend } from '../backends/codex.js';
import { SlackAdapter } from '../adapters/slack.js';
import { DiscordAdapter } from '../adapters/discord.js';
import {
  type Platform,
  runInit,
  inputTokens,
  detectBackend,
  mergeEnvFile,
} from './init.js';

export interface StartDeps {
  /** Override the database path (for testing). */
  dbPath?: string;
  /** Override the env file path (for testing). */
  envPath?: string;
  /** Skip actually starting adapters (for testing). */
  dryRun?: boolean;
}

/** Load .env.local file into process.env (simple key=value parser). */
export function loadEnvFile(envPath: string): Record<string, string> {
  const vars: Record<string, string> = {};
  if (!fs.existsSync(envPath)) {
    return vars;
  }

  const content = fs.readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.substring(0, eqIndex).trim();
    let value = trimmed.substring(eqIndex + 1).trim();
    // Strip surrounding quotes (double or single)
    if (
      value.length >= 2 &&
      ((value[0] === '"' && value[value.length - 1] === '"') ||
       (value[0] === "'" && value[value.length - 1] === "'"))
    ) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
    process.env[key] = value;
  }
  return vars;
}

/** Create a backend factory that produces the right backend based on name. */
export function createBackendFactory(): BackendFactory {
  return (backendName: string) => {
    switch (backendName) {
      case 'claude':
        return new ClaudeBackend();
      case 'codex':
        return new CodexBackend();
      default:
        throw new Error(`Unknown backend: ${backendName}`);
    }
  };
}

type StartMenuAction = 'start' | 'add_platform' | 'update_tokens' | 'change_backend' | 'rerun_setup';

/**
 * Show the settings menu on subsequent interactive runs.
 * Handles the chosen action (add platform, update tokens, etc.)
 * then returns so the bridge can start normally.
 */
async function handleStartMenu(dbPath: string, envPath: string): Promise<void> {
  const store = new Store(dbPath);

  try {
    const platformsJson = store.getSetting('platforms');
    const platforms: Platform[] = platformsJson ? JSON.parse(platformsJson) : [];
    const defaultBackend = store.getSetting('default_backend') ?? 'claude';

    clack.intro('OpenBridge');

    const options: { label: string; value: StartMenuAction; hint?: string }[] = [
      { label: 'Start the bridge', value: 'start', hint: 'default' },
    ];

    const allPlatforms: Platform[] = ['slack', 'discord'];
    const unconfigured = allPlatforms.filter((p) => !platforms.includes(p));

    if (unconfigured.length > 0) {
      const names = unconfigured.map((p) => p.charAt(0).toUpperCase() + p.slice(1));
      options.push({
        label: 'Add a platform',
        value: 'add_platform',
        hint: names.join(', '),
      });
    }

    if (platforms.length > 0) {
      const names = platforms.map((p) => p.charAt(0).toUpperCase() + p.slice(1));
      options.push({
        label: 'Update tokens',
        value: 'update_tokens',
        hint: names.join(', '),
      });
    }

    options.push({
      label: 'Change default backend',
      value: 'change_backend',
      hint: `current: ${defaultBackend}`,
    });

    options.push({ label: 'Re-run full setup', value: 'rerun_setup' });

    const action = await clack.select({
      message: 'What would you like to do?',
      options,
      initialValue: 'start' as StartMenuAction,
    });

    if (clack.isCancel(action)) {
      clack.cancel('Cancelled.');
      process.exit(0);
    }

    switch (action) {
      case 'start':
        return;

      case 'add_platform': {
        let platformToAdd: Platform;
        if (unconfigured.length === 1) {
          platformToAdd = unconfigured[0];
          clack.log.info(`Adding ${platformToAdd.charAt(0).toUpperCase() + platformToAdd.slice(1)}...`);
        } else {
          const selected = await clack.select({
            message: 'Which platform do you want to add?',
            options: unconfigured.map((p) => ({
              label: p.charAt(0).toUpperCase() + p.slice(1),
              value: p,
            })),
          });
          if (clack.isCancel(selected)) {
            clack.cancel('Cancelled.');
            process.exit(0);
          }
          platformToAdd = selected as Platform;
        }

        const tokens = await inputTokens(null, [platformToAdd]);
        mergeEnvFile(envPath, tokens);

        platforms.push(platformToAdd);
        store.setSetting('platforms', JSON.stringify(platforms));
        clack.log.success(
          `${platformToAdd.charAt(0).toUpperCase() + platformToAdd.slice(1)} added. Starting the bridge...`,
        );
        return;
      }

      case 'update_tokens': {
        let platformsToUpdate: Platform[];
        if (platforms.length === 1) {
          platformsToUpdate = [platforms[0]];
        } else {
          const selected = await clack.select({
            message: 'Which platform tokens do you want to update?',
            options: [
              ...platforms.map((p) => ({
                label: p.charAt(0).toUpperCase() + p.slice(1),
                value: p as string,
              })),
              { label: 'Both', value: 'both' },
            ],
          });
          if (clack.isCancel(selected)) {
            clack.cancel('Cancelled.');
            process.exit(0);
          }
          platformsToUpdate =
            selected === 'both' ? [...platforms] : [selected as Platform];
        }

        const tokens = await inputTokens(null, platformsToUpdate);
        mergeEnvFile(envPath, tokens);
        clack.log.success('Tokens updated. Starting the bridge...');
        return;
      }

      case 'change_backend': {
        const newBackend = await detectBackend(null);
        store.setSetting('default_backend', newBackend);
        clack.log.success(`Default backend changed to ${newBackend}. Starting the bridge...`);
        return;
      }

      case 'rerun_setup': {
        store.close();
        const dbDir = path.dirname(dbPath);
        fs.rmSync(dbDir, { recursive: true, force: true });
        if (fs.existsSync(envPath)) fs.rmSync(envPath);
        await runInit();
        return;
      }
    }
  } finally {
    try {
      store.close();
    } catch {
      // Already closed (e.g. rerun_setup closes it before wiping)
    }
  }
}

/**
 * Launch the bridge process.
 */
export async function runStart(deps?: StartDeps): Promise<void> {
  const dbPath = deps?.dbPath ?? path.resolve('.openbridge', 'bridge.db');
  const envPath = deps?.envPath ?? path.resolve('.env.local');
  const dryRun = deps?.dryRun ?? false;

  // Auto-run init if .openbridge/ doesn't exist yet (first run)
  if (!fs.existsSync(path.dirname(dbPath))) {
    console.log('[start] first run detected — running setup wizard...\n');
    await runInit();
  } else if (process.stdin.isTTY && !dryRun) {
    // Subsequent interactive runs: show the settings menu
    await handleStartMenu(dbPath, envPath);
  }

  // Load environment variables
  const env = loadEnvFile(envPath);
  console.log('[start] loaded environment from', envPath);

  // Open the database
  const store = new Store(dbPath);

  // Read config from settings
  const platformsJson = store.getSetting('platforms');
  if (!platformsJson) {
    console.error('[start] no platforms configured. Run "openbridge start" to set up.');
    store.close();
    process.exit(1);
    return;
  }

  const platforms: Platform[] = JSON.parse(platformsJson);
  const defaultBackend = store.getSetting('default_backend') ?? 'claude';

  console.log(`[start] platforms: ${platforms.join(', ')}`);
  console.log(`[start] default backend: ${defaultBackend}`);

  // Create the router
  const backendFactory = createBackendFactory();
  const router = new Router(store, backendFactory);

  if (dryRun) {
    console.log('[start] dry run — skipping adapter startup');
    store.close();
    return;
  }

  const adapters: { name: string; start: () => Promise<void>; stop: () => Promise<void> }[] = [];

  // Set up Slack adapter if configured
  if (platforms.includes('slack')) {
    const botToken = env.SLACK_BOT_TOKEN ?? process.env.SLACK_BOT_TOKEN;
    const appToken = env.SLACK_APP_TOKEN ?? process.env.SLACK_APP_TOKEN;

    if (!botToken || !appToken) {
      console.error('[start] Slack tokens not found. Check .env.local or environment variables.');
      store.close();
      process.exit(1);
      return;
    }

    const slack = new SlackAdapter({
      botToken,
      appToken,
      router,
      store,
    });
    adapters.push({ name: 'slack', start: () => slack.start(), stop: () => slack.stop() });
  }

  // Set up Discord adapter if configured
  if (platforms.includes('discord')) {
    const botToken = env.DISCORD_BOT_TOKEN ?? process.env.DISCORD_BOT_TOKEN;

    if (!botToken) {
      console.error('[start] Discord token not found. Check .env.local or environment variables.');
      store.close();
      process.exit(1);
      return;
    }

    const discord = new DiscordAdapter({
      botToken,
      router,
      store,
    });
    adapters.push({ name: 'discord', start: () => discord.start(), stop: () => discord.stop() });
  }

  // Start all adapters
  for (const adapter of adapters) {
    try {
      await adapter.start();
      console.log(`[start] ${adapter.name} adapter started`);
    } catch (err) {
      console.error(`[start] failed to start ${adapter.name}:`, err);
    }
  }

  console.log(`[start] bridge is running — listening on ${adapters.map((a) => a.name).join(', ')}`);

  // Handle graceful shutdown
  const shutdown = async () => {
    console.log('[start] shutting down...');
    // Stop all active backend sessions
    await router.shutdown();
    // Disconnect all messaging platform adapters
    for (const adapter of adapters) {
      try {
        await adapter.stop();
        console.log(`[start] ${adapter.name} adapter stopped`);
      } catch {
        // ignore errors during shutdown
      }
    }
    store.close();
    console.log('[start] shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
