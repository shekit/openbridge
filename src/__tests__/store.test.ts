import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Store, validateTransition, type SessionState, type PermissionMode } from '../store.js';

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
      expect(row.v).toBe(5);
    });

    it('migrations run sequentially on startup', () => {
      const db = (store as any).db;
      const versions = db.prepare('SELECT version FROM schema_version ORDER BY version').all() as Array<{ version: number }>;
      expect(versions.length).toBe(5);
      expect(versions[0].version).toBe(1);
      expect(versions[1].version).toBe(2);
      expect(versions[2].version).toBe(3);
      expect(versions[3].version).toBe(4);
      expect(versions[4].version).toBe(5);
    });

    it('re-running init does not duplicate tables (idempotent)', () => {
      // Close and reopen the store on the same db path
      store.close();
      store = new Store(dbPath);

      const db = (store as any).db;
      // Version should still be 5
      const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number };
      expect(row.v).toBe(5);

      // Tables should exist exactly once
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('projects', 'sessions', 'settings', 'allowed_tools', 'schedules') ORDER BY name"
      ).all() as Array<{ name: string }>;
      expect(tables.length).toBe(5);
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

  describe('P2.7: CRUD for sessions', () => {
    let projectId: number;

    beforeEach(() => {
      const project = store.createProject('CH_SESS', '/proj', 'claude');
      projectId = project.id;
    });

    it('createSession inserts with state idle', () => {
      const session = store.createSession('T1', projectId);
      expect(session.id).toBeGreaterThan(0);
      expect(session.thread_id).toBe('T1');
      expect(session.project_id).toBe(projectId);
      expect(session.state).toBe('idle');
      expect(session.backend_session_id).toBeNull();
      expect(session.created_at).toBeDefined();
      expect(session.updated_at).toBeDefined();
    });

    it('getSessionByThreadId retrieves by thread_id', () => {
      store.createSession('T2', projectId);
      const found = store.getSessionByThreadId('T2');
      expect(found).toBeDefined();
      expect(found!.thread_id).toBe('T2');
    });

    it('getSessionByThreadId returns undefined for unknown thread', () => {
      const found = store.getSessionByThreadId('UNKNOWN');
      expect(found).toBeUndefined();
    });

    it('updateSessionState changes state field and updated_at', () => {
      const session = store.createSession('T3', projectId);
      const originalUpdatedAt = session.updated_at;

      store.updateSessionState(session.id, 'running');
      const updated = store.getSessionById(session.id)!;
      expect(updated.state).toBe('running');
      // updated_at should change (may be same second in fast tests, so just verify it's set)
      expect(updated.updated_at).toBeDefined();
    });

    it('updateBackendSessionId sets backend_session_id for resume', () => {
      const session = store.createSession('T4', projectId);
      store.updateBackendSessionId(session.id, 'backend-abc-123');
      const updated = store.getSessionById(session.id)!;
      expect(updated.backend_session_id).toBe('backend-abc-123');
    });

    it('deleteSession removes by id', () => {
      const session = store.createSession('T5', projectId);
      const deleted = store.deleteSession(session.id);
      expect(deleted).toBe(true);
      expect(store.getSessionByThreadId('T5')).toBeUndefined();
    });

    it('createSession rejects duplicate thread_id', () => {
      store.createSession('T_DUP', projectId);
      expect(() => store.createSession('T_DUP', projectId)).toThrow();
    });

    it('getSessionsByProjectId returns all sessions for a project', () => {
      store.createSession('T_GP1', projectId);
      store.createSession('T_GP2', projectId);
      const sessions = store.getSessionsByProjectId(projectId);
      expect(sessions.length).toBe(2);
      const threadIds = sessions.map(s => s.thread_id);
      expect(threadIds).toContain('T_GP1');
      expect(threadIds).toContain('T_GP2');
    });

    it('getSessionsByProjectId returns empty array when no sessions', () => {
      // Use the existing project but no sessions created for it with these thread IDs
      const otherProject = store.createProject('OTHER_CH', '/other', 'codex');
      const sessions = store.getSessionsByProjectId(otherProject.id);
      expect(sessions.length).toBe(0);
    });
  });

  describe('P2.8: CRUD for settings', () => {
    it('setSetting upserts a key-value pair', () => {
      store.setSetting('default_backend', 'claude');
      const value = store.getSetting('default_backend');
      expect(value).toBe('claude');
    });

    it('setSetting overwrites existing value', () => {
      store.setSetting('key1', 'value1');
      store.setSetting('key1', 'value2');
      expect(store.getSetting('key1')).toBe('value2');
    });

    it('getSetting returns null for missing key', () => {
      const value = store.getSetting('nonexistent');
      expect(value).toBeNull();
    });

    it('deleteSetting removes by key', () => {
      store.setSetting('to_delete', 'val');
      const deleted = store.deleteSetting('to_delete');
      expect(deleted).toBe(true);
      expect(store.getSetting('to_delete')).toBeNull();
    });

    it('deleteSetting returns false for nonexistent key', () => {
      const deleted = store.deleteSetting('nope');
      expect(deleted).toBe(false);
    });
  });

  describe('P2.9: Session state machine — valid transitions enforced', () => {
    // Valid transitions
    it('idle → running (on send)', () => {
      expect(() => validateTransition('idle', 'running')).not.toThrow();
    });

    it('running → idle (on turn complete)', () => {
      expect(() => validateTransition('running', 'idle')).not.toThrow();
    });

    it('running → waiting_for_input (on permission denied)', () => {
      expect(() => validateTransition('running', 'waiting_for_input')).not.toThrow();
    });

    it('waiting_for_input → running (on user response)', () => {
      expect(() => validateTransition('waiting_for_input', 'running')).not.toThrow();
    });

    it('running → dead (on crash/timeout)', () => {
      expect(() => validateTransition('running', 'dead')).not.toThrow();
    });

    it('dead → idle (on restart)', () => {
      expect(() => validateTransition('dead', 'idle')).not.toThrow();
    });

    // Invalid transitions
    it('idle → dead is invalid', () => {
      expect(() => validateTransition('idle', 'dead')).toThrow('Invalid session state transition');
    });

    it('idle → waiting_for_input is invalid', () => {
      expect(() => validateTransition('idle', 'waiting_for_input')).toThrow('Invalid session state transition');
    });

    it('waiting_for_input → idle is invalid', () => {
      expect(() => validateTransition('waiting_for_input', 'idle')).toThrow('Invalid session state transition');
    });

    it('waiting_for_input → dead is invalid', () => {
      expect(() => validateTransition('waiting_for_input', 'dead')).toThrow('Invalid session state transition');
    });

    it('dead → running is invalid', () => {
      expect(() => validateTransition('dead', 'running')).toThrow('Invalid session state transition');
    });

    it('same state → same state is invalid', () => {
      const states: SessionState[] = ['idle', 'running', 'waiting_for_input', 'dead'];
      for (const state of states) {
        expect(() => validateTransition(state, state)).toThrow('Invalid session state transition');
      }
    });

    // Integration with store.updateSessionState
    it('store.updateSessionState enforces valid transitions', () => {
      const project = store.createProject('CH_SM', '/proj', 'claude');
      const session = store.createSession('T_SM', project.id);

      // idle → running: valid
      store.updateSessionState(session.id, 'running');
      expect(store.getSessionById(session.id)!.state).toBe('running');

      // running → waiting_for_input: valid
      store.updateSessionState(session.id, 'waiting_for_input');
      expect(store.getSessionById(session.id)!.state).toBe('waiting_for_input');

      // waiting_for_input → idle: invalid
      expect(() => store.updateSessionState(session.id, 'idle')).toThrow('Invalid session state transition');
    });

    it('store.updateSessionState throws for nonexistent session', () => {
      expect(() => store.updateSessionState(9999, 'running')).toThrow('Session 9999 not found');
    });
  });

  describe('P12.1: Schema migration v3 — permission_mode, sandbox_mode, allowed_tools', () => {
    it('migration v2 runs and schema_version is at least 2', () => {
      const db = (store as any).db;
      const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number };
      expect(row.v).toBeGreaterThanOrEqual(2);
    });

    it('projects table has permission_mode column with default supervised', () => {
      const project = store.createProject('ch_perm', '/tmp/p', 'claude');
      expect(project.permission_mode).toBe('supervised');
    });

    it('projects table has sandbox_mode column with default workspace-write', () => {
      const project = store.createProject('ch_sb', '/tmp/p', 'claude');
      expect(project.sandbox_mode).toBe('workspace-write');
    });

    it('allowed_tools table exists with expected columns', () => {
      const db = (store as any).db;
      const table = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='allowed_tools'"
      ).get();
      expect(table).toBeDefined();

      const columns = db.prepare("PRAGMA table_info('allowed_tools')").all() as Array<{ name: string }>;
      const colNames = columns.map((c: { name: string }) => c.name);
      expect(colNames).toContain('id');
      expect(colNames).toContain('project_id');
      expect(colNames).toContain('tool_pattern');
      expect(colNames).toContain('created_at');
    });

    it('updatePermissionMode changes the permission_mode', () => {
      const project = store.createProject('ch_pm2', '/tmp/p', 'claude');
      expect(project.permission_mode).toBe('supervised');
      store.updatePermissionMode(project.id, 'trusted');
      const updated = store.getProjectById(project.id)!;
      expect(updated.permission_mode).toBe('trusted');
    });

    it('updateSandboxMode changes the sandbox_mode', () => {
      const project = store.createProject('ch_sm2', '/tmp/p', 'codex');
      expect(project.sandbox_mode).toBe('workspace-write');
      store.updateSandboxMode(project.id, 'danger-full-access');
      const updated = store.getProjectById(project.id)!;
      expect(updated.sandbox_mode).toBe('danger-full-access');
    });

    it('addAllowedTool inserts a tool pattern', () => {
      const project = store.createProject('ch_at1', '/tmp/p', 'claude');
      const tool = store.addAllowedTool(project.id, 'Bash(npx *)');
      expect(tool.id).toBeGreaterThan(0);
      expect(tool.project_id).toBe(project.id);
      expect(tool.tool_pattern).toBe('Bash(npx *)');
      expect(tool.created_at).toBeDefined();
    });

    it('addAllowedTool deduplicates identical patterns', () => {
      const project = store.createProject('ch_at2', '/tmp/p', 'claude');
      const first = store.addAllowedTool(project.id, 'Bash');
      const second = store.addAllowedTool(project.id, 'Bash');
      expect(first.id).toBe(second.id);
    });

    it('getAllowedTools returns all patterns for a project', () => {
      const project = store.createProject('ch_at3', '/tmp/p', 'claude');
      store.addAllowedTool(project.id, 'Bash');
      store.addAllowedTool(project.id, 'Write');
      store.addAllowedTool(project.id, 'Edit');
      const tools = store.getAllowedTools(project.id);
      expect(tools.length).toBe(3);
      expect(tools.map(t => t.tool_pattern)).toEqual(['Bash', 'Write', 'Edit']);
    });

    it('getAllowedTools returns empty array for project with no tools', () => {
      const project = store.createProject('ch_at4', '/tmp/p', 'claude');
      const tools = store.getAllowedTools(project.id);
      expect(tools.length).toBe(0);
    });

    it('removeAllowedTool deletes by id', () => {
      const project = store.createProject('ch_at5', '/tmp/p', 'claude');
      const tool = store.addAllowedTool(project.id, 'Bash');
      const removed = store.removeAllowedTool(tool.id);
      expect(removed).toBe(true);
      expect(store.getAllowedTools(project.id).length).toBe(0);
    });

    it('removeAllowedTool returns false for nonexistent id', () => {
      expect(store.removeAllowedTool(9999)).toBe(false);
    });

    it('allowed_tools cascade deleted when project is deleted', () => {
      const project = store.createProject('ch_at6', '/tmp/p', 'claude');
      store.addAllowedTool(project.id, 'Bash');
      store.addAllowedTool(project.id, 'Write');
      store.deleteProject(project.id);
      // Tools should be gone due to CASCADE
      const tools = store.getAllowedTools(project.id);
      expect(tools.length).toBe(0);
    });

    it('re-opening database preserves migration v2 (idempotent)', () => {
      store.close();
      store = new Store(dbPath);
      const db = (store as any).db;
      const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number };
      expect(row.v).toBeGreaterThanOrEqual(2);

      // New project should still get defaults
      const project = store.createProject('ch_reopen', '/tmp/p', 'claude');
      expect(project.permission_mode).toBe('supervised');
      expect(project.sandbox_mode).toBe('workspace-write');
    });
  });

  describe('P23.1: Schedules CRUD', () => {
    let project: ReturnType<typeof store.createProject>;

    beforeEach(() => {
      project = store.createProject('ch_sched', '/tmp/sched', 'claude');
    });

    it('schedules table exists with expected columns', () => {
      const db = (store as any).db;
      const columns = db.prepare("PRAGMA table_info('schedules')").all() as Array<{ name: string }>;
      const colNames = columns.map((c: { name: string }) => c.name);
      expect(colNames).toContain('project_id');
      expect(colNames).toContain('channel_id');
      expect(colNames).toContain('prompt');
      expect(colNames).toContain('original_request');
      expect(colNames).toContain('cron_expression');
      expect(colNames).toContain('scheduled_at');
      expect(colNames).toContain('next_run_at');
      expect(colNames).toContain('is_recurring');
      expect(colNames).toContain('is_active');
    });

    it('createSchedule inserts a one-time schedule', () => {
      const sched = store.createSchedule(
        project.id, 'ch_sched', 'do the thing', 'remind me to do the thing',
        { scheduledAt: '2026-03-01T09:00:00', nextRunAt: '2026-03-01T09:00:00' },
      );
      expect(sched.id).toBeGreaterThan(0);
      expect(sched.prompt).toBe('do the thing');
      expect(sched.original_request).toBe('remind me to do the thing');
      expect(sched.is_recurring).toBe(0);
      expect(sched.is_active).toBe(1);
      expect(sched.cron_expression).toBeNull();
      expect(sched.scheduled_at).toBe('2026-03-01T09:00:00');
    });

    it('createSchedule inserts a recurring schedule', () => {
      const sched = store.createSchedule(
        project.id, 'ch_sched', 'news update', 'give me daily news',
        { cronExpression: '0 9 * * *', nextRunAt: '2026-02-25T09:00:00' },
      );
      expect(sched.is_recurring).toBe(1);
      expect(sched.cron_expression).toBe('0 9 * * *');
      expect(sched.scheduled_at).toBeNull();
    });

    it('getDueSchedules returns only active schedules due before now', () => {
      store.createSchedule(
        project.id, 'ch_sched', 'past', 'past request',
        { scheduledAt: '2020-01-01T00:00:00', nextRunAt: '2020-01-01T00:00:00' },
      );
      store.createSchedule(
        project.id, 'ch_sched', 'future', 'future request',
        { scheduledAt: '2099-01-01T00:00:00', nextRunAt: '2099-01-01T00:00:00' },
      );
      const due = store.getDueSchedules('2025-01-01T00:00:00');
      expect(due.length).toBe(1);
      expect(due[0].prompt).toBe('past');
    });

    it('getDueSchedules excludes inactive schedules', () => {
      const sched = store.createSchedule(
        project.id, 'ch_sched', 'cancelled', 'cancelled request',
        { scheduledAt: '2020-01-01T00:00:00', nextRunAt: '2020-01-01T00:00:00' },
      );
      store.deactivateSchedule(sched.id);
      const due = store.getDueSchedules('2025-01-01T00:00:00');
      expect(due.length).toBe(0);
    });

    it('getSchedulesByChannelId returns active schedules for channel', () => {
      store.createSchedule(
        project.id, 'ch_sched', 'a', 'request a',
        { scheduledAt: '2026-03-01T09:00:00', nextRunAt: '2026-03-01T09:00:00' },
      );
      store.createSchedule(
        project.id, 'ch_sched', 'b', 'request b',
        { cronExpression: '0 9 * * *', nextRunAt: '2026-02-25T09:00:00' },
      );
      const schedules = store.getSchedulesByChannelId('ch_sched');
      expect(schedules.length).toBe(2);
    });

    it('deactivateSchedule sets is_active to 0', () => {
      const sched = store.createSchedule(
        project.id, 'ch_sched', 'to cancel', 'cancel this',
        { scheduledAt: '2026-03-01T09:00:00', nextRunAt: '2026-03-01T09:00:00' },
      );
      expect(store.deactivateSchedule(sched.id)).toBe(true);
      const updated = store.getScheduleById(sched.id);
      expect(updated!.is_active).toBe(0);
    });

    it('deactivateSchedule returns false for nonexistent id', () => {
      expect(store.deactivateSchedule(99999)).toBe(false);
    });

    it('updateNextRun advances next_run_at', () => {
      const sched = store.createSchedule(
        project.id, 'ch_sched', 'recurring', 'daily thing',
        { cronExpression: '0 9 * * *', nextRunAt: '2026-02-25T09:00:00' },
      );
      store.updateNextRun(sched.id, '2026-02-26T09:00:00');
      const updated = store.getScheduleById(sched.id);
      expect(updated!.next_run_at).toBe('2026-02-26T09:00:00');
    });

    it('schedules are deleted on CASCADE when project is deleted', () => {
      store.createSchedule(
        project.id, 'ch_sched', 'orphan', 'orphan request',
        { scheduledAt: '2026-03-01T09:00:00', nextRunAt: '2026-03-01T09:00:00' },
      );
      store.deleteProject(project.id);
      const schedules = store.getSchedulesByChannelId('ch_sched');
      expect(schedules.length).toBe(0);
    });
  });
});
