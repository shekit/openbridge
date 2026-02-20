import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the start module before importing cli
vi.mock('../cli/start.js', () => ({
  runStart: vi.fn(async () => { console.log('[start] mock start'); }),
}));

import { parseArgs, cli } from '../cli.js';

describe('CLI entry point (P6.1)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('parseArgs', () => {
    it('returns null command for no args', () => {
      const result = parseArgs(['node', 'cli.js']);
      expect(result.command).toBe(null);
      expect(result.args).toEqual([]);
    });

    it('parses start command', () => {
      const result = parseArgs(['node', 'cli.js', 'start']);
      expect(result.command).toBe('start');
      expect(result.args).toEqual([]);
    });

    it('parses --help flag', () => {
      const result = parseArgs(['node', 'cli.js', '--help']);
      expect(result.command).toBe('help');
    });

    it('parses -h flag', () => {
      const result = parseArgs(['node', 'cli.js', '-h']);
      expect(result.command).toBe('help');
    });

    it('parses --version flag', () => {
      const result = parseArgs(['node', 'cli.js', '--version']);
      expect(result.command).toBe('version');
    });

    it('parses -v flag', () => {
      const result = parseArgs(['node', 'cli.js', '-v']);
      expect(result.command).toBe('version');
    });

    it('passes extra args through', () => {
      const result = parseArgs(['node', 'cli.js', 'start', '--dry-run']);
      expect(result.command).toBe('start');
      expect(result.args).toEqual(['--dry-run']);
    });

    it('returns unknown commands as-is', () => {
      const result = parseArgs(['node', 'cli.js', 'unknown']);
      expect(result.command).toBe('unknown');
    });
  });

  describe('cli', () => {
    it('shows usage for no args', async () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await cli(['node', 'cli.js']);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('openbridge'));
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('start'));
    });

    it('shows usage for --help', async () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await cli(['node', 'cli.js', '--help']);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('openbridge'));
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('start'));
    });

    it('shows version for --version', async () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await cli(['node', 'cli.js', '--version']);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('0.1.0'));
    });

    it('exits with error for unknown command', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      await cli(['node', 'cli.js', 'foobar']);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('unknown command: foobar'));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('calls runStart for start command', async () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await cli(['node', 'cli.js', 'start']);
      // runStart prints a log message
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('[start]'));
    });
  });
});
