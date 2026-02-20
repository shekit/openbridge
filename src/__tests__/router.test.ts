import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Store } from '../store.js';
import { Router, type BackendFactory } from '../router.js';
import type { Backend, BackendOptions, SendResult } from '../types/backend.js';
import type { NormalizedEvent } from '../types/events.js';

/** Create a temp directory for each test and return the db path. */
function makeTempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbridge-router-test-'));
  return path.join(dir, '.openbridge', 'bridge.db');
}

/** Create a mock backend that returns configurable events. */
function createMockBackend(events: NormalizedEvent[] = [], sessionId: string | null = 'mock-session-1'): Backend {
  return {
    sessionId: null,
    async start(_options: BackendOptions) {},
    async send(_text: string): Promise<SendResult> {
      return { events, sessionId };
    },
    getSessionId() {
      return sessionId;
    },
    async stop() {},
  } as any;
}

describe('Router', () => {
  let store: Store;
  let dbPath: string;
  let router: Router;
  let lastBackendName: string;
  let mockBackend: Backend;

  beforeEach(() => {
    dbPath = makeTempDbPath();
    store = new Store(dbPath);
    lastBackendName = '';
    mockBackend = createMockBackend([
      { type: 'assistant_text', text: 'Hello!' },
      { type: 'turn_completed' },
    ]);
    const factory: BackendFactory = (name: string) => {
      lastBackendName = name;
      return mockBackend;
    };
    router = new Router(store, factory);
  });

  afterEach(() => {
    store.close();
    const rootDir = path.dirname(path.dirname(dbPath));
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  describe('P2.10: resolve channel + thread to project and backend', () => {
    it('returns project config and session state for known channel', () => {
      store.createProject('CH1', '/proj1', 'claude');
      const result = router.resolve('CH1', 'T1');
      expect(result).not.toBeNull();
      expect(result!.project.channel_id).toBe('CH1');
      expect(result!.project.project_dir).toBe('/proj1');
      expect(result!.project.backend_name).toBe('claude');
      expect(result!.session.thread_id).toBe('T1');
      expect(result!.session.state).toBe('idle');
    });

    it('returns null for unknown channel_id', () => {
      const result = router.resolve('UNKNOWN', 'T1');
      expect(result).toBeNull();
    });

    it('returns existing session for known thread', () => {
      const project = store.createProject('CH2', '/proj2', 'codex');
      store.createSession('T2', project.id);
      const result = router.resolve('CH2', 'T2');
      expect(result).not.toBeNull();
      expect(result!.session.thread_id).toBe('T2');
    });
  });

  describe('P2.11: create new session for unknown thread in bound channel', () => {
    it('first message in a new thread creates a session row', () => {
      store.createProject('CH3', '/proj3', 'claude');

      // Thread T_NEW doesn't exist yet
      expect(store.getSessionByThreadId('T_NEW')).toBeUndefined();

      const result = router.resolve('CH3', 'T_NEW');
      expect(result).not.toBeNull();
      expect(result!.session.thread_id).toBe('T_NEW');

      // Session should now exist in the database
      const session = store.getSessionByThreadId('T_NEW');
      expect(session).toBeDefined();
    });

    it('session state starts as idle', () => {
      store.createProject('CH4', '/proj4', 'codex');
      const result = router.resolve('CH4', 'T_IDLE');
      expect(result!.session.state).toBe('idle');
    });

    it('returns the new session on subsequent calls', () => {
      store.createProject('CH5', '/proj5', 'claude');
      const first = router.resolve('CH5', 'T_REPEAT');
      const second = router.resolve('CH5', 'T_REPEAT');
      expect(first!.session.id).toBe(second!.session.id);
    });
  });

  describe('P2.12: send message through backend and return normalized events', () => {
    it('calls backend.send() with the message text and returns events', async () => {
      store.createProject('CH_SEND', '/proj', 'claude');
      const result = await router.send('CH_SEND', 'T_SEND', 'Hello world');
      expect(result.events).toHaveLength(2);
      expect(result.events[0]).toEqual({ type: 'assistant_text', text: 'Hello!' });
      expect(result.events[1]).toEqual({ type: 'turn_completed' });
    });

    it('session transitions to running during send, back to idle on completion', async () => {
      store.createProject('CH_STATE', '/proj', 'claude');
      const result = await router.send('CH_STATE', 'T_STATE', 'test');
      // After completion, session should be idle
      expect(result.session.state).toBe('idle');
    });

    it('backend session_id is stored in SQLite for resume', async () => {
      store.createProject('CH_RESUME', '/proj', 'claude');
      await router.send('CH_RESUME', 'T_RESUME', 'test');
      const session = store.getSessionByThreadId('T_RESUME');
      expect(session!.backend_session_id).toBe('mock-session-1');
    });

    it('uses the correct backend name from project config', async () => {
      store.createProject('CH_BACKEND', '/proj', 'codex');
      await router.send('CH_BACKEND', 'T_BACKEND', 'test');
      expect(lastBackendName).toBe('codex');
    });

    it('throws for unbound channel', async () => {
      await expect(router.send('UNKNOWN', 'T1', 'test')).rejects.toThrow(
        'Channel UNKNOWN is not bound to a project'
      );
    });
  });
});
