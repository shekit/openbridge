import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadEnvFile, createBackendFactory, runStart } from '../cli/start.js';
import { Store } from '../store.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('CLI start (P6.7)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('loadEnvFile', () => {
    it('loads key=value pairs from file', () => {
      const tmpDir = createTempDir('openbridge-env-');
      const envPath = path.join(tmpDir, '.env.local');
      fs.writeFileSync(envPath, 'FOO=bar\nBAZ=qux\n');

      const vars = loadEnvFile(envPath);
      expect(vars.FOO).toBe('bar');
      expect(vars.BAZ).toBe('qux');

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('skips comments and empty lines', () => {
      const tmpDir = createTempDir('openbridge-env-');
      const envPath = path.join(tmpDir, '.env.local');
      fs.writeFileSync(envPath, '# comment\n\nKEY=value\n');

      const vars = loadEnvFile(envPath);
      expect(vars.KEY).toBe('value');
      expect(Object.keys(vars).length).toBe(1);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns empty object for missing file', () => {
      const vars = loadEnvFile('/nonexistent/path/.env.local');
      expect(vars).toEqual({});
    });

    it('sets values in process.env', () => {
      const tmpDir = createTempDir('openbridge-env-');
      const envPath = path.join(tmpDir, '.env.local');
      fs.writeFileSync(envPath, 'OPENBRIDGE_TEST_VAR=hello\n');

      loadEnvFile(envPath);
      expect(process.env.OPENBRIDGE_TEST_VAR).toBe('hello');

      delete process.env.OPENBRIDGE_TEST_VAR;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('createBackendFactory', () => {
    it('creates claude backend', () => {
      const factory = createBackendFactory();
      const backend = factory('claude');
      expect(backend).toBeDefined();
      expect(backend.send).toBeTypeOf('function');
    });

    it('creates codex backend', () => {
      const factory = createBackendFactory();
      const backend = factory('codex');
      expect(backend).toBeDefined();
      expect(backend.send).toBeTypeOf('function');
    });

    it('throws for unknown backend', () => {
      const factory = createBackendFactory();
      expect(() => factory('unknown')).toThrow('Unknown backend: unknown');
    });
  });

  describe('runStart', () => {
    it('logs startup with configured platforms (dry run)', async () => {
      const tmpDir = createTempDir('openbridge-start-');
      const dbPath = path.join(tmpDir, '.openbridge', 'bridge.db');
      const envPath = path.join(tmpDir, '.env.local');

      // Write a minimal .env.local
      fs.writeFileSync(envPath, 'SLACK_BOT_TOKEN=xoxb-test\nSLACK_APP_TOKEN=xapp-test\n');

      // Create store and set config
      const store = new Store(dbPath);
      store.setSetting('platforms', '["slack"]');
      store.setSetting('default_backend', 'claude');
      store.close();

      const logSpy = vi.spyOn(console, 'log');

      await runStart({ dbPath, envPath, dryRun: true });

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[start] platforms: slack'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[start] default backend: claude'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('dry run'));

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('logs both platforms when both configured', async () => {
      const tmpDir = createTempDir('openbridge-start-');
      const dbPath = path.join(tmpDir, '.openbridge', 'bridge.db');
      const envPath = path.join(tmpDir, '.env.local');

      fs.writeFileSync(
        envPath,
        'SLACK_BOT_TOKEN=xoxb-test\nSLACK_APP_TOKEN=xapp-test\nDISCORD_BOT_TOKEN=discord-test\n',
      );

      const store = new Store(dbPath);
      store.setSetting('platforms', '["slack","discord"]');
      store.setSetting('default_backend', 'codex');
      store.close();

      const logSpy = vi.spyOn(console, 'log');

      await runStart({ dbPath, envPath, dryRun: true });

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('slack, discord'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('codex'));

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('exits with error if .openbridge/ not found', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      const errorSpy = vi.spyOn(console, 'error');

      await runStart({
        dbPath: '/nonexistent/path/.openbridge/bridge.db',
        envPath: '/nonexistent/.env.local',
      });

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Run "openbridge init" first'),
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('exits with error if no platforms configured', async () => {
      const tmpDir = createTempDir('openbridge-start-');
      const dbPath = path.join(tmpDir, '.openbridge', 'bridge.db');
      const envPath = path.join(tmpDir, '.env.local');
      fs.writeFileSync(envPath, '');

      // Create store but don't set platforms
      const store = new Store(dbPath);
      store.close();

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      const errorSpy = vi.spyOn(console, 'error');

      await runStart({ dbPath, envPath });

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('no platforms configured'),
      );
      expect(exitSpy).toHaveBeenCalledWith(1);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('reads config from store settings', async () => {
      const tmpDir = createTempDir('openbridge-start-');
      const dbPath = path.join(tmpDir, '.openbridge', 'bridge.db');
      const envPath = path.join(tmpDir, '.env.local');
      fs.writeFileSync(envPath, 'DISCORD_BOT_TOKEN=test-discord\n');

      const store = new Store(dbPath);
      store.setSetting('platforms', '["discord"]');
      store.setSetting('default_backend', 'claude');
      store.close();

      const logSpy = vi.spyOn(console, 'log');

      await runStart({ dbPath, envPath, dryRun: true });

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('discord'));

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });
});
