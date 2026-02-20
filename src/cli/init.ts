/**
 * openbridge init — Interactive setup wizard.
 *
 * Guides the user through platform selection, token input (with inline
 * setup instructions and verification), and backend detection. Writes
 * config to .openbridge/ and .env.local.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { Store } from '../store.js';
import * as clack from '@clack/prompts';
import { type PromptIO, createPromptIO, promptSelect, promptText, promptConfirm } from './prompt.js';
import { getConfigDir, getEnvPath } from '../utils.js';

export type Platform = 'slack' | 'discord';

export interface InitConfig {
  platforms: Platform[];
  slackBotToken?: string;
  slackAppToken?: string;
  discordBotToken?: string;
  defaultBackend: string;
}

const DISCORD_PERMISSIONS = '397284600912';

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

/** Extract the Application ID from a Discord bot token. */
export function extractDiscordAppId(token: string): string | null {
  try {
    const firstPart = token.split('.')[0];
    const decoded = Buffer.from(firstPart, 'base64').toString();
    if (/^\d+$/.test(decoded)) {
      return decoded;
    }
    return null;
  } catch {
    return null;
  }
}

/** Verify a Slack bot token by calling auth.test. Returns bot name on success, null on failure. */
export async function verifySlackToken(botToken: string): Promise<string | null> {
  try {
    const res = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${botToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
    const data = await res.json() as any;
    if (data.ok) {
      return data.user ?? data.bot_id ?? 'bot';
    }
    return null;
  } catch {
    return null;
  }
}

/** Verify a Discord bot token by calling /users/@me. Returns bot username on success, null on failure. */
export async function verifyDiscordToken(botToken: string): Promise<string | null> {
  try {
    const res = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { 'Authorization': `Bot ${botToken}` },
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    return data.username ?? null;
  } catch {
    return null;
  }
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

/** Step 2: Token input with inline setup instructions and verification (P6.3) */
export async function inputTokens(
  io: PromptIO | null,
  platforms: Platform[],
): Promise<Pick<InitConfig, 'slackBotToken' | 'slackAppToken' | 'discordBotToken'>> {
  const result: Pick<InitConfig, 'slackBotToken' | 'slackAppToken' | 'discordBotToken'> = {};
  const isInteractive = !io;

  if (platforms.includes('slack')) {
    // Phase 1: Show setup instructions (once, before token entry loop)
    const slackCreateSteps = [
      '1. Go to api.slack.com/apps → Create New App → From an app manifest',
      '2. Pick your workspace, switch to the JSON tab',
      '3. Paste the contents of slack-manifest.json from this project',
      '4. Click Create',
      '5. Install to Workspace → copy the Bot Token (xoxb-...)',
      '6. Basic Information → App-Level Tokens → Generate Token',
      '   Give it the connections:write scope → copy the token (xapp-...)',
    ].join('\n');

    if (isInteractive) {
      clack.note(slackCreateSteps, 'Slack Setup');
    } else {
      console.log('\n[init] --- Slack Setup ---');
      console.log(slackCreateSteps);
    }

    // Token entry + verification (retries on failure in interactive mode)
    while (true) {
      result.slackBotToken = await promptText(io, 'Slack Bot Token (xoxb-...)', validateSlackBotToken);
      result.slackAppToken = await promptText(io, 'Slack App Token (xapp-...)', validateSlackAppToken);

      if (isInteractive) {
        const s = clack.spinner();
        s.start('Verifying Slack token...');
        const botName = await verifySlackToken(result.slackBotToken!);
        if (botName) {
          s.stop(`Slack token verified — connected as "${botName}"`);
          break;
        }
        s.stop('Could not verify Slack token — the token may be invalid or the network is down.');
        const retry = await promptConfirm(io, 'Re-enter Slack tokens?', true);
        if (!retry) break;
      } else {
        console.log('[init] verifying Slack token...');
        const botName = await verifySlackToken(result.slackBotToken!);
        if (botName) {
          console.log(`[init] Slack token verified — connected as "${botName}"`);
        } else {
          console.log('[init] could not verify token — continuing');
        }
        break;
      }
    }

    // Phase 2: Tell user to invite the bot
    const slackInviteSteps = [
      'Go to your Slack workspace and invite the bot to a channel:',
      '',
      '  /invite @OpenBridge',
      '',
      'The bot will appear online once the bridge is running.',
    ].join('\n');

    if (isInteractive) {
      clack.note(slackInviteSteps, 'Invite the bot');
    } else {
      console.log('\n[init] --- Invite the bot ---');
      console.log(slackInviteSteps);
    }
  }

  if (platforms.includes('discord')) {
    // Phase 1: Create the bot and get token
    const discordCreateSteps = [
      '1. Go to discord.com/developers/applications → New Application',
      '2. Bot tab → Reset Token → copy it (you\'ll paste it below)',
      '3. Bot tab → Privileged Gateway Intents → Enable Message Content Intent',
    ].join('\n');

    if (isInteractive) {
      clack.note(discordCreateSteps, 'Discord Setup');
    } else {
      console.log('\n[init] --- Discord Setup ---');
      console.log(discordCreateSteps);
    }

    // Token entry + verification (retries on failure in interactive mode)
    while (true) {
      result.discordBotToken = await promptText(io, 'Discord Bot Token', validateDiscordToken);

      if (isInteractive) {
        const s = clack.spinner();
        s.start('Verifying Discord token...');
        const botName = await verifyDiscordToken(result.discordBotToken!);
        if (botName) {
          s.stop(`Discord token verified — bot name: "${botName}"`);
          break;
        }
        s.stop('Could not verify Discord token — the token may be invalid or the network is down.');
        const retry = await promptConfirm(io, 'Re-enter Discord token?', true);
        if (!retry) break;
      } else {
        console.log('[init] verifying Discord token...');
        const botName = await verifyDiscordToken(result.discordBotToken!);
        if (botName) {
          console.log(`[init] Discord token verified — bot name: "${botName}"`);
        } else {
          console.log('[init] could not verify token — continuing');
        }
        break;
      }
    }

    // Phase 2: Show the pre-filled invite URL
    const appId = extractDiscordAppId(result.discordBotToken!);
    if (appId) {
      const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot&permissions=${DISCORD_PERMISSIONS}`;
      const inviteSteps = [
        'Open this URL in your browser to add the bot to your server:',
        '',
        inviteUrl,
        '',
        'Pick your server → Authorize, then come back here.',
      ].join('\n');

      if (isInteractive) {
        clack.note(inviteSteps, 'Add bot to your server');
      } else {
        console.log('\n[init] --- Add bot to your server ---');
        console.log(inviteSteps);
      }
    } else {
      if (isInteractive) {
        clack.log.warn('Could not extract App ID from token. Add the bot manually:');
        clack.log.info('discord.com/developers/applications → OAuth2 → URL Generator');
      } else {
        console.log('[init] Could not extract App ID from token.');
        console.log('[init] Add the bot manually: discord.com/developers/applications → OAuth2 → URL Generator');
      }
    }
  }

  return result;
}

/** Step 3: Backend auto-detection (P6.4) */
export async function detectBackend(io: PromptIO | null): Promise<string> {
  const hasClaude = detectCli('claude');
  const hasCodex = detectCli('codex');

  if (!hasClaude && !hasCodex) {
    if (!io) {
      clack.log.warn('No coding backends found. Install Claude Code or Codex CLI first.');
      clack.log.info('Defaulting to "claude" — you can change this later with /settings.');
    } else {
      console.log('[init] no coding backends found — defaulting to "claude".');
    }
    return 'claude';
  }

  const available: { label: string; value: string }[] = [];
  if (hasClaude) available.push({ label: 'Claude Code', value: 'claude' });
  if (hasCodex) available.push({ label: 'Codex CLI', value: 'codex' });

  if (available.length === 1) {
    if (!io) {
      clack.log.success(`Found ${available[0].label} — using it as default backend.`);
    } else {
      console.log(`[init] using ${available[0].label} as default backend.`);
    }
    return available[0].value;
  }

  const selected = await promptSelect(io, 'Select default backend:', available);
  return selected[0];
}

/** Write tokens to .env.local (P6.6) */
export function writeEnvFile(
  envPath: string,
  tokens: Pick<InitConfig, 'slackBotToken' | 'slackAppToken' | 'discordBotToken'>,
): void {
  const lines: string[] = [
    '# OpenBridge Environment Variables',
    '# Auto-generated by openbridge setup wizard',
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

/** Read existing .env.local, merge new tokens, and write back. */
export function mergeEnvFile(
  envPath: string,
  newTokens: Pick<InitConfig, 'slackBotToken' | 'slackAppToken' | 'discordBotToken'>,
): void {
  const existing: Record<string, string> = {};
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;
      existing[trimmed.substring(0, eqIndex).trim()] = trimmed.substring(eqIndex + 1).trim();
    }
  }

  if (newTokens.slackBotToken) existing.SLACK_BOT_TOKEN = newTokens.slackBotToken;
  if (newTokens.slackAppToken) existing.SLACK_APP_TOKEN = newTokens.slackAppToken;
  if (newTokens.discordBotToken) existing.DISCORD_BOT_TOKEN = newTokens.discordBotToken;

  const lines = ['# OpenBridge Environment Variables', '# Auto-generated by openbridge setup wizard', ''];
  for (const [key, value] of Object.entries(existing)) {
    lines.push(`${key}=${value}`);
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

/** Detect available tunnel tools on PATH. */
export function detectTunnelTools(): { hasCloudflared: boolean; hasNgrok: boolean } {
  return {
    hasCloudflared: detectCli('cloudflared'),
    hasNgrok: detectCli('ngrok'),
  };
}

/** Step: File previews setup (tunnel tool detection) */
export async function setupFilePreviews(io: PromptIO | null): Promise<void> {
  const wantPreviews = await promptConfirm(
    io,
    'Set up file previews? (lets the AI share live previews of web apps it builds)',
    true,
  );

  if (!wantPreviews) {
    if (!io) {
      clack.log.info('You can set this up anytime by running `openbridge start`.');
    } else {
      console.log('[init] skipped file previews — set up later via `openbridge start`.');
    }
    return;
  }

  const { hasCloudflared, hasNgrok } = detectTunnelTools();

  if (hasCloudflared && hasNgrok) {
    const msg = 'cloudflared and ngrok detected — previews will work automatically. Will prefer cloudflared.';
    if (!io) {
      clack.log.success(msg);
    } else {
      console.log(`[init] ${msg}`);
    }
  } else if (hasCloudflared) {
    const msg = 'cloudflared detected — previews will work automatically.';
    if (!io) {
      clack.log.success(msg);
    } else {
      console.log(`[init] ${msg}`);
    }
  } else if (hasNgrok) {
    const msg = 'ngrok detected — previews will work automatically.';
    if (!io) {
      clack.log.success(msg);
    } else {
      console.log(`[init] ${msg}`);
    }
  } else {
    const installSteps = [
      'No tunnel tool found. Install one to enable previews:',
      '',
      '  cloudflared (recommended — free, no account needed):',
      '    brew install cloudflared',
      '',
      '  ngrok:',
      '    brew install ngrok',
    ].join('\n');

    if (!io) {
      clack.note(installSteps, 'Install a tunnel tool');
      clack.log.info('Install one of these before starting the bridge, and previews will work automatically.');
    } else {
      console.log(`[init] ${installSteps}`);
      console.log('[init] install one before starting the bridge.');
    }
  }
}

/** Optional: Set projects root directory */
export async function setProjectsRoot(
  io: PromptIO | null,
  store: Store,
): Promise<void> {
  const wantRoot = await promptConfirm(
    io,
    'Set a projects root folder? (enables /project connect picker)',
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
    if (!io) {
      clack.log.success(`Projects root set to ${path.resolve(rootDir)}`);
    } else {
      console.log(`[init] projects root set to ${path.resolve(rootDir)}`);
    }
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

    // Step 1: Platform selection
    const platforms = await selectPlatforms(prompt);

    // Step 2: Token input with inline setup instructions + verification
    const tokens = await inputTokens(io ? legacyPrompt : prompt as any, platforms);

    // Step 3: Backend detection
    const defaultBackend = await detectBackend(prompt);

    // Step 3b: File previews setup
    await setupFilePreviews(prompt);

    // Step 4: Initialize database
    const dbDir = getConfigDir();
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    const dbPath = path.join(dbDir, 'bridge.db');
    const store = new Store(dbPath);

    // Save settings
    saveConfig(store, platforms, defaultBackend);

    // Step 5: Optional projects root
    await setProjectsRoot(prompt, store);

    // Step 6: Write .env.local
    const envPath = getEnvPath();
    writeEnvFile(envPath, tokens);

    store.close();

    const configDir = getConfigDir();
    if (!io) {
      clack.log.info(`Config saved to ${configDir}/`);
      clack.log.info(`  Database: ${path.join(configDir, 'bridge.db')}`);
      clack.log.info(`  Tokens:   ${envPath}`);
      clack.outro('Setup complete! The bridge will now start.');
    } else {
      console.log(`\n[init] config saved to ${configDir}/`);
      console.log('[init] setup complete!');
    }
  } finally {
    if (!io) {
      legacyPrompt.close();
    }
  }
}
