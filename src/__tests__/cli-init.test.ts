import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PromptIO } from '../cli/prompt.js';
import {
  selectPlatforms,
  inputTokens,
  detectBackend,
  writeEnvFile,
  mergeEnvFile,
  saveConfig,
  validateSlackBotToken,
  validateSlackAppToken,
  validateDiscordToken,
  extractDiscordAppId,
  detectCli,
  detectTunnelTools,
  setupFilePreviews,
} from '../cli/init.js';
import { Store } from '../store.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/** Create a mock PromptIO that returns predefined answers in sequence. */
function mockIO(answers: string[]): PromptIO {
  let index = 0;
  return {
    question: vi.fn(async () => {
      if (index >= answers.length) {
        throw new Error(`Mock IO: no more answers (asked ${index + 1} questions, had ${answers.length})`);
      }
      return answers[index++];
    }),
    close: vi.fn(),
  };
}

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('CLI init — platform selection (P6.2)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('selects Slack only', async () => {
    const io = mockIO(['1']); // 1 = Slack
    const platforms = await selectPlatforms(io);
    expect(platforms).toEqual(['slack']);
  });

  it('selects Discord only', async () => {
    const io = mockIO(['2']); // 2 = Discord
    const platforms = await selectPlatforms(io);
    expect(platforms).toEqual(['discord']);
  });

  it('selects both platforms', async () => {
    const io = mockIO(['3']); // 3 = Both
    const platforms = await selectPlatforms(io);
    expect(platforms).toEqual(['slack', 'discord']);
  });

  it('stores selection — the selected values are returned for config persistence', async () => {
    const io = mockIO(['1']);
    const platforms = await selectPlatforms(io);
    // The returned value is what gets stored in settings
    expect(platforms).toContain('slack');
    expect(platforms).not.toContain('discord');
  });
});

describe('CLI init — token validation (P6.3)', () => {
  describe('validateSlackBotToken', () => {
    it('accepts valid xoxb- token', () => {
      expect(validateSlackBotToken('xoxb-1234567890-abcdefghijklmnop')).toBeNull();
    });

    it('rejects non-xoxb prefix', () => {
      expect(validateSlackBotToken('xoxp-1234567890-abcdefghijklmnop')).toContain('xoxb-');
    });

    it('rejects short token', () => {
      expect(validateSlackBotToken('xoxb-short')).toContain('too short');
    });
  });

  describe('validateSlackAppToken', () => {
    it('accepts valid xapp- token', () => {
      expect(validateSlackAppToken('xapp-1-A1234567890-1234567890123-abcdef')).toBeNull();
    });

    it('rejects non-xapp prefix', () => {
      expect(validateSlackAppToken('xoxb-1234567890-abcdefghijklmnop')).toContain('xapp-');
    });

    it('rejects short token', () => {
      expect(validateSlackAppToken('xapp-short')).toContain('too short');
    });
  });

  describe('validateDiscordToken', () => {
    it('accepts valid Discord token', () => {
      expect(validateDiscordToken('MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.AAAAAA.abcdefghijklmnopqrstuvwx')).toBeNull();
    });

    it('rejects short token', () => {
      expect(validateDiscordToken('short')).toContain('too short');
    });
  });

  describe('inputTokens', () => {
    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    it('prompts for Slack tokens when Slack selected', async () => {
      const io = mockIO([
        'xoxb-1234567890-abcdefghijklmnop',
        'xapp-1-A1234567890-1234567890123-abcdef',
      ]);
      const result = await inputTokens(io, ['slack']);
      expect(result.slackBotToken).toBe('xoxb-1234567890-abcdefghijklmnop');
      expect(result.slackAppToken).toBe('xapp-1-A1234567890-1234567890123-abcdef');
      expect(result.discordBotToken).toBeUndefined();
    });

    it('prompts for Discord token when Discord selected', async () => {
      const io = mockIO(['MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.AAAAAA.abcdefghijklmnopqrstuvwx']);
      const result = await inputTokens(io, ['discord']);
      expect(result.discordBotToken).toBe('MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.AAAAAA.abcdefghijklmnopqrstuvwx');
      expect(result.slackBotToken).toBeUndefined();
    });

    it('prompts for all tokens when both selected', async () => {
      const io = mockIO([
        'xoxb-1234567890-abcdefghijklmnop',
        'xapp-1-A1234567890-1234567890123-abcdef',
        'MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.AAAAAA.abcdefghijklmnopqrstuvwx',
      ]);
      const result = await inputTokens(io, ['slack', 'discord']);
      expect(result.slackBotToken).toBeDefined();
      expect(result.slackAppToken).toBeDefined();
      expect(result.discordBotToken).toBeDefined();
    });
  });
});

describe('CLI init — backend auto-detection (P6.4)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('detectCli returns true for an existing command', () => {
    // 'node' should be available in the test environment
    expect(detectCli('node')).toBe(true);
  });

  it('detectCli returns false for a non-existing command', () => {
    expect(detectCli('nonexistent-command-openbridge-test')).toBe(false);
  });

  it('reports found backends', async () => {
    const logSpy = vi.spyOn(console, 'log');
    const io = mockIO(['1']); // select first available option
    const result = await detectBackend(io);
    // Should return a valid backend and log something about it
    expect(['claude', 'codex']).toContain(result);
  });

  it('returns a valid backend name', async () => {
    // Provide enough answers in case multiple backends are found and selection is needed
    const io = mockIO(['1']);
    const result = await detectBackend(io);
    expect(typeof result).toBe('string');
    expect(['claude', 'codex']).toContain(result);
  });
});

describe('CLI init — Discord App ID extraction', () => {
  it('extracts app ID from a valid bot token', () => {
    // Base64 encode "1234567890" to simulate a Discord token first segment
    const fakeId = '1234567890';
    const encoded = Buffer.from(fakeId).toString('base64');
    const fakeToken = `${encoded}.AAAAAA.abcdefghijklmnopqrstuvwx`;
    expect(extractDiscordAppId(fakeToken)).toBe(fakeId);
  });

  it('returns null for invalid token format', () => {
    expect(extractDiscordAppId('not-a-token')).toBeNull();
  });

  it('returns null for non-numeric decoded value', () => {
    const encoded = Buffer.from('not-a-number').toString('base64');
    expect(extractDiscordAppId(`${encoded}.AAAAAA.abc`)).toBeNull();
  });
});

describe('CLI init — config writing (P6.6)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  describe('writeEnvFile', () => {
    it('writes Slack tokens to file', () => {
      const tmpDir = createTempDir('openbridge-env-test-');
      const envPath = path.join(tmpDir, '.env.local');

      writeEnvFile(envPath, {
        slackBotToken: 'xoxb-test-token',
        slackAppToken: 'xapp-test-token',
      });

      const content = fs.readFileSync(envPath, 'utf-8');
      expect(content).toContain('SLACK_BOT_TOKEN=xoxb-test-token');
      expect(content).toContain('SLACK_APP_TOKEN=xapp-test-token');
      expect(content).not.toContain('DISCORD_BOT_TOKEN');

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('writes Discord token to file', () => {
      const tmpDir = createTempDir('openbridge-env-test-');
      const envPath = path.join(tmpDir, '.env.local');

      writeEnvFile(envPath, {
        discordBotToken: 'discord-test-token',
      });

      const content = fs.readFileSync(envPath, 'utf-8');
      expect(content).toContain('DISCORD_BOT_TOKEN=discord-test-token');
      expect(content).not.toContain('SLACK_BOT_TOKEN');

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('writes all tokens when both platforms', () => {
      const tmpDir = createTempDir('openbridge-env-test-');
      const envPath = path.join(tmpDir, '.env.local');

      writeEnvFile(envPath, {
        slackBotToken: 'xoxb-test',
        slackAppToken: 'xapp-test',
        discordBotToken: 'discord-test',
      });

      const content = fs.readFileSync(envPath, 'utf-8');
      expect(content).toContain('SLACK_BOT_TOKEN=xoxb-test');
      expect(content).toContain('SLACK_APP_TOKEN=xapp-test');
      expect(content).toContain('DISCORD_BOT_TOKEN=discord-test');

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('mergeEnvFile', () => {
    it('creates file if it does not exist', () => {
      const tmpDir = createTempDir('openbridge-merge-env-');
      const envPath = path.join(tmpDir, '.env.local');

      mergeEnvFile(envPath, { slackBotToken: 'xoxb-new' });

      const content = fs.readFileSync(envPath, 'utf-8');
      expect(content).toContain('SLACK_BOT_TOKEN=xoxb-new');

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('preserves existing tokens when adding new ones', () => {
      const tmpDir = createTempDir('openbridge-merge-env-');
      const envPath = path.join(tmpDir, '.env.local');
      fs.writeFileSync(envPath, 'SLACK_BOT_TOKEN=xoxb-old\nSLACK_APP_TOKEN=xapp-old\n');

      mergeEnvFile(envPath, { discordBotToken: 'discord-new' });

      const content = fs.readFileSync(envPath, 'utf-8');
      expect(content).toContain('SLACK_BOT_TOKEN=xoxb-old');
      expect(content).toContain('SLACK_APP_TOKEN=xapp-old');
      expect(content).toContain('DISCORD_BOT_TOKEN=discord-new');

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('overwrites existing tokens with new values', () => {
      const tmpDir = createTempDir('openbridge-merge-env-');
      const envPath = path.join(tmpDir, '.env.local');
      fs.writeFileSync(envPath, 'SLACK_BOT_TOKEN=xoxb-old\n');

      mergeEnvFile(envPath, { slackBotToken: 'xoxb-updated' });

      const content = fs.readFileSync(envPath, 'utf-8');
      expect(content).toContain('SLACK_BOT_TOKEN=xoxb-updated');
      expect(content).not.toContain('xoxb-old');

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('preserves header comments in output', () => {
      const tmpDir = createTempDir('openbridge-merge-env-');
      const envPath = path.join(tmpDir, '.env.local');

      mergeEnvFile(envPath, { slackBotToken: 'xoxb-test' });

      const content = fs.readFileSync(envPath, 'utf-8');
      expect(content).toContain('# OpenBridge Environment Variables');

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('saveConfig', () => {
    it('persists platforms and backend to store settings', () => {
      const tmpDir = createTempDir('openbridge-config-test-');
      const dbPath = path.join(tmpDir, '.openbridge', 'bridge.db');
      const store = new Store(dbPath);

      saveConfig(store, ['slack', 'discord'], 'claude');

      expect(store.getSetting('platforms')).toBe('["slack","discord"]');
      expect(store.getSetting('default_backend')).toBe('claude');

      store.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('persists single platform', () => {
      const tmpDir = createTempDir('openbridge-config-test-');
      const dbPath = path.join(tmpDir, '.openbridge', 'bridge.db');
      const store = new Store(dbPath);

      saveConfig(store, ['discord'], 'codex');

      expect(store.getSetting('platforms')).toBe('["discord"]');
      expect(store.getSetting('default_backend')).toBe('codex');

      store.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('.openbridge/ directory', () => {
    it('Store creates .openbridge/ directory if missing', () => {
      const tmpDir = createTempDir('openbridge-dir-test-');
      const dbPath = path.join(tmpDir, '.openbridge', 'bridge.db');

      // .openbridge/ does not exist yet
      expect(fs.existsSync(path.dirname(dbPath))).toBe(false);

      const store = new Store(dbPath);

      // Now it should exist
      expect(fs.existsSync(path.dirname(dbPath))).toBe(true);
      expect(fs.existsSync(dbPath)).toBe(true);

      store.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('SQLite database is initialized with tables', () => {
      const tmpDir = createTempDir('openbridge-db-test-');
      const dbPath = path.join(tmpDir, '.openbridge', 'bridge.db');
      const store = new Store(dbPath);

      // Should be able to use projects, sessions, settings tables
      const projects = store.listProjects();
      expect(projects).toEqual([]);

      expect(store.getSetting('test')).toBeNull();

      store.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });
});

describe('CLI init — file previews setup', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  describe('detectTunnelTools', () => {
    it('returns an object with hasCloudflared and hasNgrok booleans', () => {
      const result = detectTunnelTools();
      expect(typeof result.hasCloudflared).toBe('boolean');
      expect(typeof result.hasNgrok).toBe('boolean');
    });

    it('detects tools that exist on PATH', () => {
      // 'node' exists, so detectCli('node') is true — verifying the underlying mechanism
      expect(detectCli('node')).toBe(true);
    });
  });

  describe('setupFilePreviews', () => {
    it('skips setup when user declines', async () => {
      const io = mockIO(['n']); // decline
      const logSpy = vi.spyOn(console, 'log');

      await setupFilePreviews(io);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('skipped file previews'),
      );
    });

    it('shows detection results when user accepts', async () => {
      const io = mockIO(['y']); // accept
      const logSpy = vi.spyOn(console, 'log');

      await setupFilePreviews(io);

      // Should log something about detection (detected or not found)
      const calls = logSpy.mock.calls.map((c) => c.join(' '));
      const hasDetectionMsg = calls.some(
        (c) => c.includes('detected') || c.includes('No tunnel tool found'),
      );
      expect(hasDetectionMsg).toBe(true);
    });
  });
});
