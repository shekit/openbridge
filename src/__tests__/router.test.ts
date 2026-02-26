import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    setSessionId() {},
    setAllowedTools() {},
    async interrupt() {},
    isAlive() { return false; },
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
        'Channel UNKNOWN is not connected to a project'
      );
    });
  });

  describe('P2.13: detect permission denial and transition to waiting_for_input', () => {
    it('PermissionDenied events cause session to become waiting_for_input', async () => {
      // Reconfigure mock backend to return PermissionDenied
      mockBackend = createMockBackend([
        { type: 'assistant_text', text: 'I need to edit a file.' },
        { type: 'permission_denied', toolName: 'Edit', toolInput: { path: 'foo.js' } },
        { type: 'turn_completed' },
      ]);
      const factory: BackendFactory = () => mockBackend;
      router = new Router(store, factory);

      store.createProject('CH_PERM', '/proj', 'claude');
      const result = await router.send('CH_PERM', 'T_PERM', 'edit foo.js');
      expect(result.session.state).toBe('waiting_for_input');
    });

    it('PermissionDenied events are returned to the caller for rendering', async () => {
      mockBackend = createMockBackend([
        { type: 'permission_denied', toolName: 'Bash', toolInput: { command: 'rm -rf /' } },
        { type: 'turn_completed' },
      ]);
      const factory: BackendFactory = () => mockBackend;
      router = new Router(store, factory);

      store.createProject('CH_PERM2', '/proj', 'claude');
      const result = await router.send('CH_PERM2', 'T_PERM2', 'do stuff');
      const permEvents = result.events.filter((e) => e.type === 'permission_denied');
      expect(permEvents).toHaveLength(1);
      expect(permEvents[0].type).toBe('permission_denied');
    });

    it('no PermissionDenied events keeps session idle', async () => {
      store.createProject('CH_NOPERM', '/proj', 'claude');
      const result = await router.send('CH_NOPERM', 'T_NOPERM', 'hello');
      expect(result.session.state).toBe('idle');
    });
  });

  describe('P2.14: handle user response when waiting_for_input', () => {
    it('when session is waiting_for_input, respond routes as a resume', async () => {
      // First, set up a session in waiting_for_input state
      const permBackend = createMockBackend([
        { type: 'permission_denied', toolName: 'Edit', toolInput: { path: 'foo.js' } },
      ]);
      let callCount = 0;
      const factory: BackendFactory = () => {
        callCount++;
        if (callCount === 1) return permBackend;
        // Second call (resume) returns normal text
        return createMockBackend([
          { type: 'assistant_text', text: 'Done!' },
          { type: 'turn_completed' },
        ]);
      };
      router = new Router(store, factory);

      store.createProject('CH_RESP', '/proj', 'claude');

      // Send initial message — triggers permission denied
      const sendResult = await router.send('CH_RESP', 'T_RESP', 'edit foo.js');
      expect(sendResult.session.state).toBe('waiting_for_input');

      // User responds — should resume
      const respondResult = await router.respond('CH_RESP', 'T_RESP', 'yes, allow it');
      expect(respondResult.session.state).toBe('idle');
      expect(respondResult.events[0]).toEqual({ type: 'assistant_text', text: 'Done!' });
    });

    it('session transitions from waiting_for_input → running → idle', async () => {
      const permBackend = createMockBackend([
        { type: 'permission_denied', toolName: 'Bash', toolInput: { command: 'ls' } },
      ]);
      let callCount = 0;
      const factory: BackendFactory = () => {
        callCount++;
        if (callCount === 1) return permBackend;
        return createMockBackend([{ type: 'turn_completed' }]);
      };
      router = new Router(store, factory);

      store.createProject('CH_TRANS', '/proj', 'claude');
      await router.send('CH_TRANS', 'T_TRANS', 'run ls');
      // Now in waiting_for_input
      const result = await router.respond('CH_TRANS', 'T_TRANS', 'allow');
      expect(result.session.state).toBe('idle');
    });

    it('respond throws if session is not waiting_for_input', async () => {
      store.createProject('CH_ERR', '/proj', 'claude');
      // Session is idle, not waiting_for_input
      router.resolve('CH_ERR', 'T_ERR');
      await expect(router.respond('CH_ERR', 'T_ERR', 'hello')).rejects.toThrow(
        'not waiting for input'
      );
    });
  });

  describe('P2.15: reset session (/new command)', () => {
    it('reset clears backend_session_id in SQLite', async () => {
      store.createProject('CH_RST', '/proj', 'claude');
      // Send a message so backend_session_id gets stored
      await router.send('CH_RST', 'T_RST', 'hello');
      const before = store.getSessionByThreadId('T_RST');
      expect(before!.backend_session_id).toBe('mock-session-1');

      // Reset the session
      const result = router.resetSession('CH_RST', 'T_RST');
      expect(result.backend_session_id).toBeNull();

      // Verify in DB as well
      const after = store.getSessionByThreadId('T_RST');
      expect(after!.backend_session_id).toBeNull();
    });

    it('session state returns to idle after reset', async () => {
      store.createProject('CH_RST2', '/proj', 'claude');
      await router.send('CH_RST2', 'T_RST2', 'hello');
      const result = router.resetSession('CH_RST2', 'T_RST2');
      expect(result.state).toBe('idle');
    });

    it('reset from waiting_for_input state returns to idle', async () => {
      // Set up permission denied to get into waiting_for_input
      const permBackend = createMockBackend([
        { type: 'permission_denied', toolName: 'Edit', toolInput: { path: 'foo.js' } },
      ]);
      const factory: BackendFactory = () => permBackend;
      router = new Router(store, factory);

      store.createProject('CH_RST3', '/proj', 'claude');
      await router.send('CH_RST3', 'T_RST3', 'edit');
      const session = store.getSessionByThreadId('T_RST3');
      expect(session!.state).toBe('waiting_for_input');

      const result = router.resetSession('CH_RST3', 'T_RST3');
      expect(result.state).toBe('idle');
      expect(result.backend_session_id).toBeNull();
    });

    it('next message after reset starts a fresh session (no resume)', async () => {
      store.createProject('CH_RST4', '/proj', 'claude');

      // Send initial message — stores backend_session_id
      await router.send('CH_RST4', 'T_RST4', 'hello');
      expect(store.getSessionByThreadId('T_RST4')!.backend_session_id).toBe('mock-session-1');

      // Reset
      router.resetSession('CH_RST4', 'T_RST4');
      expect(store.getSessionByThreadId('T_RST4')!.backend_session_id).toBeNull();

      // Send again — should not have a backend_session_id set before send
      // The backend factory creates a fresh backend each time
      await router.send('CH_RST4', 'T_RST4', 'fresh start');
      // After send, the new session ID from mock is stored
      expect(store.getSessionByThreadId('T_RST4')!.backend_session_id).toBe('mock-session-1');
    });

    it('throws for unbound channel', () => {
      expect(() => router.resetSession('UNKNOWN', 'T1')).toThrow(
        'Channel UNKNOWN is not connected to a project'
      );
    });
  });

  describe('P12.6: accumulated allowed_tools loaded before send', () => {
    it('sends accumulated tools via setAllowedTools on send()', async () => {
      const setAllowedToolsSpy = vi.fn();
      const backend: Backend = {
        start: vi.fn(async () => {}),
        send: vi.fn(async () => ({
          events: [{ type: 'assistant_text' as const, text: 'ok' }, { type: 'turn_completed' as const }],
          sessionId: 'sess-1',
        })),
        getSessionId: vi.fn(() => null),
        setSessionId: vi.fn(),
        setAllowedTools: setAllowedToolsSpy,
        stop: vi.fn(async () => {}),
      };
      const factory: BackendFactory = () => backend;
      const router = new Router(store, factory);

      const project = store.createProject('CH_AT', '/tmp/at', 'claude');
      store.addAllowedTool(project.id, 'Bash');
      store.addAllowedTool(project.id, 'Write');

      await router.send('CH_AT', 'T_AT', 'hello');

      expect(setAllowedToolsSpy).toHaveBeenCalledWith(['Bash', 'Write']);
    });

    it('does not call setAllowedTools when no accumulated tools', async () => {
      const setAllowedToolsSpy = vi.fn();
      const backend: Backend = {
        start: vi.fn(async () => {}),
        send: vi.fn(async () => ({
          events: [{ type: 'turn_completed' as const }],
          sessionId: 'sess-1',
        })),
        getSessionId: vi.fn(() => null),
        setSessionId: vi.fn(),
        setAllowedTools: setAllowedToolsSpy,
        stop: vi.fn(async () => {}),
      };
      const factory: BackendFactory = () => backend;
      const router = new Router(store, factory);

      store.createProject('CH_NOAT', '/tmp/noat', 'claude');

      await router.send('CH_NOAT', 'T_NOAT', 'hello');

      expect(setAllowedToolsSpy).not.toHaveBeenCalled();
    });

    it('merges one-shot and accumulated tools on respond()', async () => {
      const setAllowedToolsSpy = vi.fn();
      const backend: Backend = {
        start: vi.fn(async () => {}),
        send: vi.fn(async () => ({
          events: [{ type: 'turn_completed' as const }],
          sessionId: 'sess-1',
        })),
        getSessionId: vi.fn(() => null),
        setSessionId: vi.fn(),
        setAllowedTools: setAllowedToolsSpy,
        stop: vi.fn(async () => {}),
      };
      const factory: BackendFactory = () => backend;
      const router = new Router(store, factory);

      const project = store.createProject('CH_MRG', '/tmp/mrg', 'claude');
      store.addAllowedTool(project.id, 'Bash');
      // Create session in waiting_for_input
      const session = store.createSession('T_MRG', project.id);
      store.updateSessionState(session.id, 'running');
      store.updateSessionState(session.id, 'waiting_for_input');
      store.updateBackendSessionId(session.id, 'backend-sess-mrg');

      await router.respond('CH_MRG', 'T_MRG', 'yes', ['Edit']);

      // Should include both one-shot ('Edit') and accumulated ('Bash')
      expect(setAllowedToolsSpy).toHaveBeenCalledWith(
        expect.arrayContaining(['Edit', 'Bash'])
      );
    });
  });

  describe('cancelBackend', () => {
    it('kills a running backend and resets session to idle', async () => {
      const stopSpy = vi.fn(async () => {});
      let sendResolve: (value: SendResult) => void;
      const backend: Backend = {
        start: vi.fn(async () => {}),
        send: vi.fn(() => new Promise<SendResult>((resolve) => { sendResolve = resolve; })),
        getSessionId: vi.fn(() => null),
        setSessionId: vi.fn(),
        setAllowedTools: vi.fn(),
        stop: stopSpy,
      };
      const factory: BackendFactory = () => backend;
      const router = new Router(store, factory);

      store.createProject('CH_CANCEL', '/tmp/cancel', 'claude');

      // Start a send that will block until we resolve it
      const sendPromise = router.send('CH_CANCEL', 'T_CANCEL', 'hello').catch(() => {});

      // Wait for backend.send to be called (backend is now tracked in activeBackends)
      await vi.waitFor(() => expect(backend.send).toHaveBeenCalled());

      // Cancel should kill the backend
      const cancelled = await router.cancelBackend('CH_CANCEL', 'T_CANCEL');
      expect(cancelled).toBe(true);
      expect(stopSpy).toHaveBeenCalled();

      // Session should be back to idle
      const session = store.getSessionByThreadId('T_CANCEL');
      expect(session?.state).toBe('idle');

      // Resolve the dangling send so the promise settles
      sendResolve!({ events: [], sessionId: null });
      await sendPromise;
    });

    it('returns false when no backend is running', async () => {
      const factory: BackendFactory = () => createMockBackend();
      const router = new Router(store, factory);

      store.createProject('CH_CN', '/tmp/cancel-none', 'claude');

      const cancelled = await router.cancelBackend('CH_CN', 'T_NONE');
      expect(cancelled).toBe(false);
    });
  });

  describe('per-thread message queue', () => {
    it('serializes concurrent sends to the same thread', async () => {
      const order: number[] = [];
      let callCount = 0;
      const slowBackend = (): Backend => {
        const idx = ++callCount;
        return {
          async start() {},
          async send(): Promise<SendResult> {
            order.push(idx);
            // Simulate work — second send should not start until first finishes
            await new Promise((r) => setTimeout(r, 50));
            order.push(idx * 10);
            return {
              events: [{ type: 'assistant_text' as const, text: `resp-${idx}` }, { type: 'turn_completed' as const }],
              sessionId: `sess-${idx}`,
            };
          },
          getSessionId() { return null; },
          setSessionId() {},
          setAllowedTools() {},
          async stop() {},
        };
      };
      const factory: BackendFactory = () => slowBackend();
      const r = new Router(store, factory);
      store.createProject('CH_Q', '/tmp/queue', 'claude');

      // Fire two sends concurrently for the same thread
      const [r1, r2] = await Promise.all([
        r.send('CH_Q', 'T_Q', 'first'),
        r.send('CH_Q', 'T_Q', 'second'),
      ]);

      // First send should fully complete (1, 10) before second starts (2, 20)
      expect(order).toEqual([1, 10, 2, 20]);
      expect(r1.events[0]).toEqual({ type: 'assistant_text', text: 'resp-1' });
      expect(r2.events[0]).toEqual({ type: 'assistant_text', text: 'resp-2' });
    });

    it('allows concurrent sends to different threads', async () => {
      const startTimes: Record<string, number> = {};
      const slowBackend = (threadLabel: string): Backend => ({
        async start() {},
        async send(): Promise<SendResult> {
          startTimes[threadLabel] = Date.now();
          await new Promise((r) => setTimeout(r, 50));
          return {
            events: [{ type: 'turn_completed' as const }],
            sessionId: 'sess',
          };
        },
        getSessionId() { return null; },
        setSessionId() {},
        setAllowedTools() {},
        async stop() {},
      });

      let callIdx = 0;
      const factory: BackendFactory = () => {
        callIdx++;
        return slowBackend(callIdx === 1 ? 'A' : 'B');
      };
      const r = new Router(store, factory);
      store.createProject('CH_P', '/tmp/par', 'claude');

      await Promise.all([
        r.send('CH_P', 'T_A', 'first'),
        r.send('CH_P', 'T_B', 'second'),
      ]);

      // Both should have started at roughly the same time (within 30ms)
      const diff = Math.abs(startTimes['A'] - startTimes['B']);
      expect(diff).toBeLessThan(30);
    });
  });

  describe('P10.8: mcpConfigFactory', () => {
    it('passes mcpConfig to backend.start when factory is set', async () => {
      const startSpy = vi.fn(async () => {});
      const backend: Backend = {
        start: startSpy,
        async send() { return { events: [{ type: 'assistant_text' as const, text: 'ok' }], sessionId: null }; },
        getSessionId() { return null; },
        setSessionId() {},
        async stop() {},
      };
      const factory: BackendFactory = () => backend;

      const mcpFactory = vi.fn(() => ({
        command: 'node',
        args: ['entry.js', '--channel', 'CH_MCP', '--thread', 'T_MCP'],
        env: { OPENBRIDGE_IPC_PORT: '9999' },
      }));

      const routerWithMcp = new Router(store, factory, { mcpConfigFactory: mcpFactory });
      store.createProject('CH_MCP', '/tmp/proj', 'claude', 'slack');

      await routerWithMcp.send('CH_MCP', 'T_MCP', 'hello');

      expect(mcpFactory).toHaveBeenCalledWith({
        channelId: 'CH_MCP',
        threadId: 'T_MCP',
        projectDir: '/tmp/proj',
        platform: 'slack',
      });

      expect(startSpy).toHaveBeenCalledWith(expect.objectContaining({
        projectDir: '/tmp/proj',
        mcpConfig: {
          command: 'node',
          args: ['entry.js', '--channel', 'CH_MCP', '--thread', 'T_MCP'],
          env: { OPENBRIDGE_IPC_PORT: '9999' },
        },
        channelId: 'CH_MCP',
        threadId: 'T_MCP',
        platform: 'slack',
      }));
    });

    it('passes undefined mcpConfig when no factory is set', async () => {
      const startSpy = vi.fn(async () => {});
      const backend: Backend = {
        start: startSpy,
        async send() { return { events: [{ type: 'assistant_text' as const, text: 'ok' }], sessionId: null }; },
        getSessionId() { return null; },
        setSessionId() {},
        async stop() {},
      };
      const factory: BackendFactory = () => backend;

      const routerNoMcp = new Router(store, factory);
      store.createProject('CH_NOMCP', '/tmp/proj2', 'claude', 'slack');

      await routerNoMcp.send('CH_NOMCP', 'T_NOMCP', 'hello');

      expect(startSpy).toHaveBeenCalledWith(expect.objectContaining({
        projectDir: '/tmp/proj2',
        mcpConfig: undefined,
      }));
    });
  });

  describe('P13.4: Router augments prompt text and cleans up staging', () => {
    it('augments text with upload info when images have uploadId', async () => {
      let capturedText = '';
      const capturingBackend: Backend = {
        async start() {},
        async send(text: string) {
          capturedText = text;
          return {
            events: [{ type: 'assistant_text' as const, text: 'ok' }, { type: 'turn_completed' as const }],
            sessionId: 'sess-1',
          };
        },
        getSessionId() { return 'sess-1'; },
        setSessionId() {},
        setAllowedTools() {},
        async stop() {},
      };

      const factory: BackendFactory = () => capturingBackend;
      const r = new Router(store, factory);
      store.createProject('CH_AUG', '/tmp/aug', 'claude', 'slack');

      await r.send('CH_AUG', 'T_AUG', 'save this logo', [
        {
          base64: 'abc123',
          mediaType: 'image/png',
          kind: 'image' as const,
          uploadId: 'upload_aabbccddee11',
          filename: 'logo.png',
          stagingPath: '/tmp/fake-staging.png',
        },
      ]);

      expect(capturedText).toContain('save this logo');
      expect(capturedText).toContain('upload_aabbccddee11');
      expect(capturedText).toContain('logo.png');
      expect(capturedText).toContain('save_uploaded_file');
    });

    it('does not augment text when images lack uploadId', async () => {
      let capturedText = '';
      const capturingBackend: Backend = {
        async start() {},
        async send(text: string) {
          capturedText = text;
          return {
            events: [{ type: 'assistant_text' as const, text: 'ok' }, { type: 'turn_completed' as const }],
            sessionId: 'sess-2',
          };
        },
        getSessionId() { return 'sess-2'; },
        setSessionId() {},
        setAllowedTools() {},
        async stop() {},
      };

      const factory: BackendFactory = () => capturingBackend;
      const r = new Router(store, factory);
      store.createProject('CH_NOAUG', '/tmp/noaug', 'claude', 'slack');

      await r.send('CH_NOAUG', 'T_NOAUG', 'what is this?', [
        { base64: 'abc123', mediaType: 'image/png', kind: 'image' as const },
      ]);

      expect(capturedText).toContain('what is this?');
      expect(capturedText).toMatch(/^\[Current time: /);  // Time is prepended
    });

    it.skip('cleans up staging files after successful send', async () => {
      // Create a real temp file to verify cleanup
      const tmpPath = path.join(os.tmpdir(), `staging-cleanup-test-${Date.now()}.png`);
      fs.writeFileSync(tmpPath, 'test');

      const successBackend: Backend = {
        async start() {},
        async send() {
          return {
            events: [{ type: 'turn_completed' as const }],
            sessionId: 'sess-3',
          };
        },
        getSessionId() { return 'sess-3'; },
        setSessionId() {},
        setAllowedTools() {},
        async stop() {},
      };

      const factory: BackendFactory = () => successBackend;
      const r = new Router(store, factory);
      store.createProject('CH_CLN', '/tmp/cln', 'claude', 'slack');

      expect(fs.existsSync(tmpPath)).toBe(true);

      await r.send('CH_CLN', 'T_CLN', 'hello', [
        { base64: 'abc', mediaType: 'image/png', kind: 'image' as const, stagingPath: tmpPath },
      ]);

      expect(fs.existsSync(tmpPath)).toBe(false);
    });

    it.skip('cleans up staging files even if backend fails', async () => {
      const tmpPath = path.join(os.tmpdir(), `staging-fail-test-${Date.now()}.png`);
      fs.writeFileSync(tmpPath, 'test');

      const failBackend: Backend = {
        async start() {},
        async send() {
          throw new Error('backend crashed');
        },
        getSessionId() { return null; },
        setSessionId() {},
        setAllowedTools() {},
        async stop() {},
      };

      const factory: BackendFactory = () => failBackend;
      const r = new Router(store, factory);
      store.createProject('CH_FAIL', '/tmp/fail', 'claude', 'slack');

      expect(fs.existsSync(tmpPath)).toBe(true);

      await expect(
        r.send('CH_FAIL', 'T_FAIL', 'hello', [
          { base64: 'abc', mediaType: 'image/png', kind: 'image' as const, stagingPath: tmpPath },
        ]),
      ).rejects.toThrow('backend crashed');

      expect(fs.existsSync(tmpPath)).toBe(false);
    });
  });
});
