/**
 * openbridge start — Launch the bridge process.
 *
 * Reads config from .openbridge/, loads tokens from environment,
 * creates the router and messaging adapters, and starts listening.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { Store } from '../store.js';
import { Router, type BackendFactory } from '../router.js';
import { ClaudeBackend } from '../backends/claude.js';
import { CodexBackend } from '../backends/codex.js';
import { SlackAdapter } from '../adapters/slack.js';
import { DiscordAdapter } from '../adapters/discord.js';
import type { Platform } from './init.js';
import { runInit } from './init.js';

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
    const value = trimmed.substring(eqIndex + 1).trim();
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

/**
 * Launch the bridge process.
 */
export async function runStart(deps?: StartDeps): Promise<void> {
  const dbPath = deps?.dbPath ?? path.resolve('.openbridge', 'bridge.db');
  const envPath = deps?.envPath ?? path.resolve('.env.local');
  const dryRun = deps?.dryRun ?? false;

  // Auto-run init if .openbridge/ doesn't exist yet
  if (!fs.existsSync(path.dirname(dbPath))) {
    console.log('[start] first run detected — running setup wizard...\n');
    await runInit();
  }

  // Load environment variables
  const env = loadEnvFile(envPath);
  console.log('[start] loaded environment from', envPath);

  // Open the database
  const store = new Store(dbPath);

  // Read config from settings
  const platformsJson = store.getSetting('platforms');
  if (!platformsJson) {
    console.error('[start] no platforms configured. Run "openbridge init" first.');
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
