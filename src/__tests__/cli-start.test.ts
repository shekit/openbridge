import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadEnvFile, createBackendFactory, runStart } from '../cli/start.js';
import * as initModule from '../cli/init.js';
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

    it('strips double quotes from values', () => {
      const tmpDir = createTempDir('openbridge-env-');
      const envPath = path.join(tmpDir, '.env.local');
      fs.writeFileSync(envPath, 'KEY="value"\n');

      const vars = loadEnvFile(envPath);
      expect(vars.KEY).toBe('value');

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('strips single quotes from values', () => {
      const tmpDir = createTempDir('openbridge-env-');
      const envPath = path.join(tmpDir, '.env.local');
      fs.writeFileSync(envPath, "KEY='value'\n");

      const vars = loadEnvFile(envPath);
      expect(vars.KEY).toBe('value');

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('leaves unquoted values unchanged', () => {
      const tmpDir = createTempDir('openbridge-env-');
      const envPath = path.join(tmpDir, '.env.local');
      fs.writeFileSync(envPath, 'KEY=value\n');

      const vars = loadEnvFile(envPath);
      expect(vars.KEY).toBe('value');

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('preserves internal equals signs', () => {
      const tmpDir = createTempDir('openbridge-env-');
      const envPath = path.join(tmpDir, '.env.local');
      fs.writeFileSync(envPath, 'KEY=value=with=equals\n');

      const vars = loadEnvFile(envPath);
      expect(vars.KEY).toBe('value=with=equals');

      fs.rmSync(tmpDir, { recursive: true, force: true });
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

    it('auto-runs init if .openbridge/ not found', async () => {
      const tmpDir = createTempDir('openbridge-start-noinit-');
      const dbPath = path.join(tmpDir, '.openbridge', 'bridge.db');
      const envPath = path.join(tmpDir, '.env.local');

      // Mock runInit so it doesn't actually prompt, but creates the db dir
      // so runStart can proceed (it will then fail on missing platforms)
      const initSpy = vi.spyOn(initModule, 'runInit').mockImplementation(async () => {
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      });
      const logSpy = vi.spyOn(console, 'log');
      vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

      await runStart({ dbPath, envPath });

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('first run detected'),
      );
      expect(initSpy).toHaveBeenCalled();

      fs.rmSync(tmpDir, { recursive: true, force: true });
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
