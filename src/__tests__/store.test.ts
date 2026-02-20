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
      const db = (store as any).db;
      const result = db.pragma('journal_mode');
      expect(result[0].journal_mode).toBe('wal');
    });
  });

  describe('P2.2: projects table schema', () => {
    it('projects table is created on init', () => {
      const db = (store as any).db;
      const table = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='projects'"
      ).get();
      expect(table).toBeDefined();
      expect(table.name).toBe('projects');
    });

    it('channel_id has a unique index', () => {
      const db = (store as any).db;
      const index = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_projects_channel_id'"
      ).get();
      expect(index).toBeDefined();
    });

    it('projects table has expected columns', () => {
      const db = (store as any).db;
      const columns = db.prepare("PRAGMA table_info('projects')").all() as Array<{ name: string }>;
      const colNames = columns.map((c) => c.name);
      expect(colNames).toContain('id');
      expect(colNames).toContain('channel_id');
      expect(colNames).toContain('project_dir');
      expect(colNames).toContain('backend_name');
      expect(colNames).toContain('created_at');
    });
  });

  describe('P2.3: sessions table schema', () => {
    it('sessions table is created on init', () => {
      const db = (store as any).db;
      const table = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'"
      ).get();
      expect(table).toBeDefined();
      expect(table.name).toBe('sessions');
    });

    it('thread_id has a unique index', () => {
      const db = (store as any).db;
      const index = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sessions_thread_id'"
      ).get();
      expect(index).toBeDefined();
    });

    it('sessions table has expected columns', () => {
      const db = (store as any).db;
      const columns = db.prepare("PRAGMA table_info('sessions')").all() as Array<{ name: string }>;
      const colNames = columns.map((c) => c.name);
      expect(colNames).toContain('id');
      expect(colNames).toContain('thread_id');
      expect(colNames).toContain('project_id');
      expect(colNames).toContain('backend_session_id');
      expect(colNames).toContain('state');
      expect(colNames).toContain('created_at');
      expect(colNames).toContain('updated_at');
    });

    it('state defaults to idle', () => {
      // Create a project first (needed for FK), then a session
      store.createProject('ch1', '/tmp/proj', 'claude');
      const project = store.getProjectByChannelId('ch1')!;
      const session = store.createSession('thread1', project.id);
      expect(session.state).toBe('idle');
    });
  });
});
