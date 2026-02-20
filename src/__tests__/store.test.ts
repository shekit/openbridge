import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Store } from '../store.js';

/** Create a temp directory for each test and return the db path. */
function makeTempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbridge-test-'));
  return path.join(dir, '.openbridge', 'bridge.db');
}

describe('Store', () => {
  let store: Store;
  let dbPath: string;

  beforeEach(() => {
    dbPath = makeTempDbPath();
    store = new Store(dbPath);
  });

  afterEach(() => {
    store.close();
    // Clean up temp directory
    const rootDir = path.dirname(path.dirname(dbPath));
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  describe('P2.1: initialize database with WAL mode', () => {
    it('creates the database file in the .openbridge/ directory', () => {
      expect(fs.existsSync(dbPath)).toBe(true);
    });

    it('creates the parent directory if it does not exist', () => {
      const dir = path.dirname(dbPath);
      expect(fs.existsSync(dir)).toBe(true);
    });

    it('uses WAL journal mode', () => {
      // WAL mode creates -wal file on first write, but we can check pragma
      const db = (store as any).db;
      const result = db.pragma('journal_mode');
      expect(result[0].journal_mode).toBe('wal');
    });
  });
});
