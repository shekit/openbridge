/**
 * SQLite persistence layer for OpenBridge.
 *
 * All bridge state is stored in a single SQLite database file at
 * .openbridge/bridge.db. Uses WAL mode for atomic writes and crash safety.
 */

import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as fs from 'node:fs';

export interface Project {
  id: number;
  channel_id: string;
  project_dir: string;
  backend_name: string;
  created_at: string;
}

export interface Session {
  id: number;
  thread_id: string;
  project_id: number;
  backend_session_id: string | null;
  state: SessionState;
  created_at: string;
  updated_at: string;
}

export type SessionState = 'idle' | 'running' | 'waiting_for_input' | 'dead';

export interface Setting {
  key: string;
  value: string;
}

/** Valid session state transitions. */
const VALID_TRANSITIONS: Record<SessionState, SessionState[]> = {
  idle: ['running'],
  running: ['idle', 'waiting_for_input', 'dead'],
  waiting_for_input: ['running'],
  dead: ['idle'],
};

/**
 * Validates a session state transition.
 * Throws if the transition is not allowed.
 */
export function validateTransition(from: SessionState, to: SessionState): void {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new Error(`Invalid session state transition: ${from} → ${to}`);
  }
}

/** Schema migrations — each entry is a SQL string applied in order. */
const MIGRATIONS: string[] = [
  // Version 1: initial schema
  `
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL UNIQUE,
    project_dir TEXT NOT NULL,
    backend_name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_channel_id ON projects(channel_id);

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL UNIQUE,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    backend_session_id TEXT,
    state TEXT NOT NULL DEFAULT 'idle',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_thread_id ON sessions(thread_id);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];

export class Store {
  private db: Database.Database;

  constructor(dbPath: string) {
    // Ensure parent directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.runMigrations();
    console.log('[store] database initialized:', dbPath);
  }

  /** Run pending schema migrations. */
  private runMigrations(): void {
    // Create schema_version table if it doesn't exist
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY
      );
    `);

    const row = this.db.prepare('SELECT MAX(version) as v FROM schema_version').get() as
      | { v: number | null }
      | undefined;
    const currentVersion = row?.v ?? 0;

    for (let i = currentVersion; i < MIGRATIONS.length; i++) {
      this.db.exec(MIGRATIONS[i]);
      this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(i + 1);
      console.log(`[store] applied migration ${i + 1}`);
    }
  }

  // --- Projects CRUD ---

  createProject(channelId: string, projectDir: string, backendName: string): Project {
    const stmt = this.db.prepare(
      `INSERT INTO projects (channel_id, project_dir, backend_name) VALUES (?, ?, ?)`
    );
    const info = stmt.run(channelId, projectDir, backendName);
    return this.getProjectById(info.lastInsertRowid as number)!;
  }

  getProjectById(id: number): Project | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined;
  }

  getProjectByChannelId(channelId: string): Project | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE channel_id = ?').get(channelId) as
      | Project
      | undefined;
  }

  listProjects(): Project[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY created_at').all() as Project[];
  }

  deleteProject(id: number): boolean {
    const info = this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    return info.changes > 0;
  }

  updateProjectBackend(id: number, backendName: string): void {
    this.db.prepare('UPDATE projects SET backend_name = ? WHERE id = ?').run(backendName, id);
  }

  // --- Sessions CRUD ---

  createSession(threadId: string, projectId: number): Session {
    const stmt = this.db.prepare(
      `INSERT INTO sessions (thread_id, project_id) VALUES (?, ?)`
    );
    const info = stmt.run(threadId, projectId);
    return this.getSessionById(info.lastInsertRowid as number)!;
  }

  getSessionById(id: number): Session | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Session | undefined;
  }

  getSessionByThreadId(threadId: string): Session | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE thread_id = ?').get(threadId) as
      | Session
      | undefined;
  }

  updateSessionState(id: number, newState: SessionState): void {
    const session = this.getSessionById(id);
    if (!session) {
      throw new Error(`Session ${id} not found`);
    }
    validateTransition(session.state as SessionState, newState);
    this.db.prepare(
      `UPDATE sessions SET state = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(newState, id);
  }

  updateBackendSessionId(id: number, backendSessionId: string | null): void {
    this.db.prepare(
      `UPDATE sessions SET backend_session_id = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(backendSessionId, id);
  }

  deleteSession(id: number): boolean {
    const info = this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return info.changes > 0;
  }

  // --- Settings CRUD ---

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?`
    ).run(key, value, value);
  }

  deleteSetting(key: string): boolean {
    const info = this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    return info.changes > 0;
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }
}
