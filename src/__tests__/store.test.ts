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

  describe('P2.4: settings table schema', () => {
    it('settings table is created on init', () => {
      const db = (store as any).db;
      const table = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='settings'"
      ).get();
      expect(table).toBeDefined();
      expect(table.name).toBe('settings');
    });

    it('key is the primary key', () => {
      const db = (store as any).db;
      const columns = db.prepare("PRAGMA table_info('settings')").all() as Array<{
        name: string;
        pk: number;
      }>;
      const keyCol = columns.find((c) => c.name === 'key');
      expect(keyCol).toBeDefined();
      expect(keyCol!.pk).toBe(1);
    });
  });

  describe('P2.5: schema migrations via version table', () => {
    it('schema_version table tracks current version', () => {
      const db = (store as any).db;
      const table = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
      ).get();
      expect(table).toBeDefined();

      const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number };
      expect(row.v).toBe(1);
    });

    it('migrations run sequentially on startup', () => {
      const db = (store as any).db;
      const versions = db.prepare('SELECT version FROM schema_version ORDER BY version').all() as Array<{ version: number }>;
      expect(versions.length).toBe(1);
      expect(versions[0].version).toBe(1);
    });

    it('re-running init does not duplicate tables (idempotent)', () => {
      // Close and reopen the store on the same db path
      store.close();
      store = new Store(dbPath);

      const db = (store as any).db;
      // Version should still be 1, not 2
      const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number };
      expect(row.v).toBe(1);

      // Tables should exist exactly once
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('projects', 'sessions', 'settings') ORDER BY name"
      ).all() as Array<{ name: string }>;
      expect(tables.length).toBe(3);
    });
  });

  describe('P2.6: CRUD for projects', () => {
    it('createProject inserts a row and returns it', () => {
      const project = store.createProject('C123', '/home/user/myapp', 'claude');
      expect(project.id).toBeGreaterThan(0);
      expect(project.channel_id).toBe('C123');
      expect(project.project_dir).toBe('/home/user/myapp');
      expect(project.backend_name).toBe('claude');
      expect(project.created_at).toBeDefined();
    });

    it('getProjectByChannelId retrieves by channel_id', () => {
      store.createProject('C456', '/home/user/proj', 'codex');
      const found = store.getProjectByChannelId('C456');
      expect(found).toBeDefined();
      expect(found!.channel_id).toBe('C456');
      expect(found!.backend_name).toBe('codex');
    });

    it('getProjectByChannelId returns undefined for unknown channel', () => {
      const found = store.getProjectByChannelId('UNKNOWN');
      expect(found).toBeUndefined();
    });

    it('listProjects returns all projects', () => {
      store.createProject('C1', '/p1', 'claude');
      store.createProject('C2', '/p2', 'codex');
      store.createProject('C3', '/p3', 'claude');
      const projects = store.listProjects();
      expect(projects.length).toBe(3);
    });

    it('deleteProject removes by id', () => {
      const project = store.createProject('C789', '/p', 'claude');
      const deleted = store.deleteProject(project.id);
      expect(deleted).toBe(true);
      expect(store.getProjectByChannelId('C789')).toBeUndefined();
    });

    it('deleteProject returns false for nonexistent id', () => {
      const deleted = store.deleteProject(9999);
      expect(deleted).toBe(false);
    });

    it('createProject rejects duplicate channel_id', () => {
      store.createProject('C_DUP', '/p1', 'claude');
      expect(() => store.createProject('C_DUP', '/p2', 'codex')).toThrow();
    });
  });
});
