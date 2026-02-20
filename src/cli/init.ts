/**
 * openbridge init — Interactive setup wizard.
 *
 * Guides the user through platform selection, token input, backend detection,
 * and first project creation. Writes config to .openbridge/ and .env.local.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { Store } from '../store.js';
import * as clack from '@clack/prompts';
import { type PromptIO, createPromptIO, promptSelect, promptText, promptConfirm } from './prompt.js';

export type Platform = 'slack' | 'discord';

export interface InitConfig {
  platforms: Platform[];
  slackBotToken?: string;
  slackAppToken?: string;
  discordBotToken?: string;
  defaultBackend: string;
  projectName: string;
  projectDir: string;
}

/** Validate a Slack bot token format. */
export function validateSlackBotToken(token: string): string | null {
  if (!token.startsWith('xoxb-')) {
    return 'Slack bot token must start with "xoxb-"';
  }
  if (token.length < 20) {
    return 'Token seems too short — check that you copied the full token.';
  }
  return null;
}

/** Validate a Slack app token format. */
export function validateSlackAppToken(token: string): string | null {
  if (!token.startsWith('xapp-')) {
    return 'Slack app token must start with "xapp-"';
  }
  if (token.length < 20) {
    return 'Token seems too short — check that you copied the full token.';
  }
  return null;
}

/** Validate a Discord bot token format. */
export function validateDiscordToken(token: string): string | null {
  // Discord tokens are base64-encoded, typically 59+ chars
  if (token.length < 30) {
    return 'Token seems too short — check that you copied the full token.';
  }
  return null;
}

/** Check if a CLI tool is available on PATH. */
export function detectCli(name: string): boolean {
  try {
    execSync(`which ${name}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** Step 1: Platform selection (P6.2) */
export async function selectPlatforms(io: PromptIO | null): Promise<Platform[]> {
  const selected = await promptSelect(
    io,
    'Which messaging platform(s) do you want to use?',
    [
      { label: 'Slack', value: 'slack' },
      { label: 'Discord', value: 'discord' },
      { label: 'Both', value: 'both' },
    ],
  );

  if (selected.includes('both')) {
    return ['slack', 'discord'];
  }
  return selected as Platform[];
}

/** Step 2: Token input (P6.3) */
export async function inputTokens(
  io: PromptIO | null,
  platforms: Platform[],
): Promise<Pick<InitConfig, 'slackBotToken' | 'slackAppToken' | 'discordBotToken'>> {
  const result: Pick<InitConfig, 'slackBotToken' | 'slackAppToken' | 'discordBotToken'> = {};

  if (platforms.includes('slack')) {
    console.log('\n[init] --- Slack Setup ---');
    console.log('[init] You need a Slack app with Socket Mode enabled.');
    console.log('[init] Create one at: https://api.slack.com/apps');
    result.slackBotToken = await promptText(io, 'Slack Bot Token (xoxb-...)', validateSlackBotToken);
    result.slackAppToken = await promptText(io, 'Slack App Token (xapp-...)', validateSlackAppToken);
  }

  if (platforms.includes('discord')) {
    console.log('\n[init] --- Discord Setup ---');
    console.log('[init] You need a Discord bot application.');
    console.log('[init] Create one at: https://discord.com/developers/applications');
    result.discordBotToken = await promptText(io, 'Discord Bot Token', validateDiscordToken);
  }

  return result;
}

/** Step 3: Backend auto-detection (P6.4) */
export async function detectBackend(io: PromptIO | null): Promise<string> {
  console.log('\n[init] --- Backend Detection ---');

  const hasClaude = detectCli('claude');
  const hasCodex = detectCli('codex');

  if (hasClaude) console.log('[init] found: claude CLI');
  if (hasCodex) console.log('[init] found: codex CLI');
  if (!hasClaude && !hasCodex) {
    console.log('[init] no coding backends found. Install Claude Code or Codex CLI first.');
    console.log('[init] defaulting to "claude" — you can change this later with /settings.');
    return 'claude';
  }

  const available: { label: string; value: string }[] = [];
  if (hasClaude) available.push({ label: 'Claude Code', value: 'claude' });
  if (hasCodex) available.push({ label: 'Codex CLI', value: 'codex' });

  if (available.length === 1) {
    console.log(`[init] using ${available[0].label} as default backend.`);
    return available[0].value;
  }

  const selected = await promptSelect(io, 'Select default backend:', available);
  return selected[0];
}

/** Step 4: First project creation (P6.5) */
export async function createFirstProject(
  io: PromptIO,
  store: Store,
  defaultBackend: string,
): Promise<{ name: string; dir: string }> {
  console.log('\n[init] --- First Project ---');

  const name = await promptText(io, 'Project name');
  const dirInput = await promptText(io, 'Project directory (absolute path)', (input) => {
    const resolved = path.resolve(input);
    if (!fs.existsSync(resolved)) {
      return `Directory does not exist: ${resolved}`;
    }
    return null;
  });

  const dir = path.resolve(dirInput);

  // Create a placeholder channel_id — the actual channel binding happens via /project
  const channelId = `pending:${name}`;
  store.createProject(channelId, dir, defaultBackend);
  console.log(`[init] project "${name}" created → ${dir} (backend: ${defaultBackend})`);

  return { name, dir };
}

/** Step 5: Write tokens to .env.local (P6.6) */
export function writeEnvFile(
  envPath: string,
  tokens: Pick<InitConfig, 'slackBotToken' | 'slackAppToken' | 'discordBotToken'>,
): void {
  const lines: string[] = [
    '# OpenBridge Environment Variables',
    '# Generated by openbridge init',
    '',
  ];

  if (tokens.slackBotToken) {
    lines.push(`SLACK_BOT_TOKEN=${tokens.slackBotToken}`);
  }
  if (tokens.slackAppToken) {
    lines.push(`SLACK_APP_TOKEN=${tokens.slackAppToken}`);
  }
  if (tokens.discordBotToken) {
    lines.push(`DISCORD_BOT_TOKEN=${tokens.discordBotToken}`);
  }

  lines.push('');
  fs.writeFileSync(envPath, lines.join('\n'));
}

/** Save platform and backend config to the store (P6.6) */
export function saveConfig(
  store: Store,
  platforms: Platform[],
  defaultBackend: string,
): void {
  store.setSetting('platforms', JSON.stringify(platforms));
  store.setSetting('default_backend', defaultBackend);
}

/** Step 5 (optional): Set projects root directory */
export async function setProjectsRoot(
  io: PromptIO | null,
  store: Store,
): Promise<void> {
  const wantRoot = await promptConfirm(
    io,
    'Set a projects root folder? (Makes /project connect show a picker)',
    false,
  );

  if (wantRoot) {
    const rootDir = await promptText(io, 'Projects root directory (absolute path)', (input) => {
      const resolved = path.resolve(input);
      if (!fs.existsSync(resolved)) {
        return `Directory does not exist: ${resolved}`;
      }
      return null;
    });
    store.setSetting('projects_root', path.resolve(rootDir));
    console.log(`[init] projects root set to ${path.resolve(rootDir)}`);
  }
}

/**
 * Run the full init wizard.
 * Accepts optional PromptIO for testing (defaults to interactive @clack/prompts).
 */
export async function runInit(io?: PromptIO): Promise<void> {
  // When no IO is injected, use null to signal @clack/prompts mode
  const prompt: PromptIO | null = io ?? null;
  const legacyPrompt = io ?? createPromptIO();

  try {
    if (!io) {
      clack.intro('OpenBridge Setup');
    } else {
      console.log('\n[init] OpenBridge Setup Wizard\n[init] ======================\n');
    }

    // Step 1: Platform selection (P6.2)
    const platforms = await selectPlatforms(prompt);
    console.log(`[init] selected: ${platforms.join(', ')}`);

    // Step 2: Token input (P6.3)
    // Token input always uses legacy prompt (clack text works too but tokens need specific prompts)
    const tokens = await inputTokens(io ? legacyPrompt : prompt as any, platforms);

    // Step 3: Backend detection (P6.4)
    const defaultBackend = await detectBackend(prompt);

    // Step 4: Initialize .openbridge/ and database (P6.6)
    const dbDir = path.resolve('.openbridge');
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    const dbPath = path.join(dbDir, 'bridge.db');
    const store = new Store(dbPath);

    // Save settings (P6.6)
    saveConfig(store, platforms, defaultBackend);

    // Step 5: First project creation (P6.5)
    await createFirstProject(prompt as any ?? legacyPrompt, store, defaultBackend);

    // Step 6: Optional projects root
    await setProjectsRoot(prompt, store);

    // Step 7: Write .env.local (P6.6)
    const envPath = path.resolve('.env.local');
    writeEnvFile(envPath, tokens);
    console.log(`\n[init] tokens saved to ${envPath}`);

    store.close();

    if (!io) {
      clack.outro('Setup complete! Run "openbridge start" to launch the bridge.');
    } else {
      console.log('\n[init] setup complete! Run "openbridge start" to launch the bridge.');
    }
  } finally {
    if (io) {
      // Only close if we created a legacy prompt
    } else {
      legacyPrompt.close();
    }
  }
}
