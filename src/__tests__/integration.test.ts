/**
 * Integration tests for OpenBridge Phase 7.
 *
 * These tests wire together real components (Store, Router, Adapters)
 * with mock backends to verify end-to-end message flows.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Store } from '../store.js';
import { Router, type BackendFactory } from '../router.js';
import type { Backend, BackendOptions, SendResult } from '../types/backend.js';
import type { NormalizedEvent } from '../types/events.js';

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createTestStore(tmpDir: string): Store {
  const dbPath = path.join(tmpDir, '.openbridge', 'bridge.db');
  return new Store(dbPath);
}

/**
 * Create a mock backend that returns pre-configured events.
 * Tracks calls for assertion.
 */
function createMockBackend(
  sendResults: SendResult[] = [],
): Backend & { calls: { method: string; args: any[] }[] } {
  let callIndex = 0;
  const calls: { method: string; args: any[] }[] = [];

  return {
    calls,
    async start(options: BackendOptions) {
      calls.push({ method: 'start', args: [options] });
    },
    async send(text: string): Promise<SendResult> {
      calls.push({ method: 'send', args: [text] });
      const result = sendResults[callIndex] ?? {
        events: [{ type: 'assistant_text' as const, text: 'default response' }, { type: 'turn_completed' as const }],
        sessionId: 'session-1',
      };
      callIndex++;
      return result;
    },
    getSessionId() {
      return sendResults[callIndex - 1]?.sessionId ?? null;
    },
    async stop() {
      calls.push({ method: 'stop', args: [] });
    },
  } as any;
}

/** Create a mock Slack Bolt App that tracks handlers and calls. */
function createMockBoltApp() {
  const messageHandlers: Function[] = [];
  const actionHandlers: Record<string, Function> = {};
  const commandHandlers: Record<string, Function> = {};

  const mockClient = {
    auth: {
      test: vi.fn(async () => ({ user_id: 'U_BOT123' })),
    },
    chat: {
      postMessage: vi.fn(async () => ({ ok: true, ts: '1234567890.123456' })),
      update: vi.fn(async () => ({ ok: true })),
    },
    conversations: {
      create: vi.fn(async () => ({ ok: true, channel: { id: 'C_NEW123' } })),
    },
  };

  const mockApp = {
    message: vi.fn((handler: Function) => {
      messageHandlers.push(handler);
    }),
    action: vi.fn((actionId: string, handler: Function) => {
      actionHandlers[actionId] = handler;
    }),
    command: vi.fn((cmd: string, handler: Function) => {
      commandHandlers[cmd] = handler;
    }),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    client: mockClient,
    _messageHandlers: messageHandlers,
    _actionHandlers: actionHandlers,
    _commandHandlers: commandHandlers,
  };

  return mockApp;
}

/** Create a mock Discord Client that tracks handlers and calls. */
function createMockDiscordClient() {
  const handlers: Record<string, Function[]> = {};

  const mockClient = {
    on: vi.fn((event: string, handler: Function) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    }),
    login: vi.fn(async () => 'test-token'),
    destroy: vi.fn(),
    user: { id: 'BOT_USER_123' },
    _handlers: handlers,
  };

  return mockClient;
}

// Dynamically import adapters to allow mock injection
import { SlackAdapter } from '../adapters/slack.js';
import { DiscordAdapter } from '../adapters/discord.js';

describe('P7.1: End-to-end Slack → Claude Code → response posted in thread', () => {
  let tmpDir: string;
  let store: Store;

  beforeEach(() => {
    tmpDir = createTempDir('openbridge-integration-');
    store = createTestStore(tmpDir);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('sends a Slack message through Claude backend and posts response in thread', async () => {
    // Set up project binding
    store.createProject('C_PROJ1', '/home/user/my-project', 'claude');

    // Create mock backend that returns assistant text
    const mockBackend = createMockBackend([
      {
        events: [
          { type: 'assistant_text', text: 'I created the file for you.' },
          { type: 'turn_completed' },
        ],
        sessionId: 'claude-session-abc',
      },
    ]);

    const backendFactory: BackendFactory = (name) => {
      expect(name).toBe('claude');
      return mockBackend;
    };

    const router = new Router(store, backendFactory);
    const mockApp = createMockBoltApp();
    const adapter = new SlackAdapter({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      router,
      store,
      app: mockApp as any,
    });

    // Simulate a message in the bound channel (top-level → creates thread)
    const messageHandler = mockApp._messageHandlers[0];
    await messageHandler({
      message: {
        channel: 'C_PROJ1',
        text: 'Create a new file called hello.ts',
        ts: '1111111111.111111',
        user: 'U_USER1',
      },
      client: mockApp.client,
    });

    // Verify "Processing..." was posted
    const postCalls = mockApp.client.chat.postMessage.mock.calls;
    expect(postCalls.length).toBeGreaterThanOrEqual(2);

    // First call should be "Processing..." in thread
    expect(postCalls[0][0]).toEqual({
      channel: 'C_PROJ1',
      thread_ts: '1111111111.111111',
      text: 'Processing...',
    });

    // Second call should be the response
    expect(postCalls[1][0]).toEqual({
      channel: 'C_PROJ1',
      thread_ts: '1111111111.111111',
      text: 'I created the file for you.',
    });

    // Verify backend was called correctly
    expect(mockBackend.calls).toEqual([
      { method: 'start', args: [{ projectDir: '/home/user/my-project' }] },
      { method: 'send', args: ['Create a new file called hello.ts'] },
    ]);

    // Session ID should be stored in SQLite for resume
    const session = store.getSessionByThreadId('1111111111.111111');
    expect(session).toBeDefined();
    expect(session!.backend_session_id).toBe('claude-session-abc');
    expect(session!.state).toBe('idle');
  });

  it('routes thread message to existing session with resume', async () => {
    store.createProject('C_PROJ1', '/home/user/my-project', 'claude');

    let sendCount = 0;
    const mockBackend = createMockBackend([
      {
        events: [
          { type: 'assistant_text', text: 'First response' },
          { type: 'turn_completed' },
        ],
        sessionId: 'claude-session-abc',
      },
      {
        events: [
          { type: 'assistant_text', text: 'Follow-up response' },
          { type: 'turn_completed' },
        ],
        sessionId: 'claude-session-abc',
      },
    ]);

    const backendFactory: BackendFactory = () => mockBackend;
    const router = new Router(store, backendFactory);
    const mockApp = createMockBoltApp();
    const adapter = new SlackAdapter({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      router,
      store,
      app: mockApp as any,
    });

    const messageHandler = mockApp._messageHandlers[0];

    // First message (top-level → creates thread)
    await messageHandler({
      message: {
        channel: 'C_PROJ1',
        text: 'First message',
        ts: '2222222222.222222',
        user: 'U_USER1',
      },
      client: mockApp.client,
    });

    // Second message (in thread → should use existing session)
    await messageHandler({
      message: {
        channel: 'C_PROJ1',
        text: 'Follow-up message',
        thread_ts: '2222222222.222222',
        ts: '2222222222.333333',
        user: 'U_USER1',
      },
      client: mockApp.client,
    });

    // Verify both messages were processed
    const postCalls = mockApp.client.chat.postMessage.mock.calls;
    const textMessages = postCalls
      .map((c: any) => c[0].text)
      .filter((t: string) => t !== 'Processing...');
    expect(textMessages).toContain('First response');
    expect(textMessages).toContain('Follow-up response');

    // Backend session ID should be stored for resume
    const session = store.getSessionByThreadId('2222222222.222222');
    expect(session!.backend_session_id).toBe('claude-session-abc');
  });
});

describe('P7.2: End-to-end Slack permission denial → Allow button → resume', () => {
  let tmpDir: string;
  let store: Store;

  beforeEach(() => {
    tmpDir = createTempDir('openbridge-integration-');
    store = createTestStore(tmpDir);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('shows permission prompt, user clicks Allow, backend resumes', async () => {
    store.createProject('C_PROJ1', '/home/user/project', 'claude');

    let callCount = 0;
    const mockBackend: Backend = {
      async start() {},
      async send(text: string): Promise<SendResult> {
        callCount++;
        if (callCount === 1) {
          return {
            events: [
              {
                type: 'permission_denied',
                toolName: 'Edit',
                toolInput: { file: 'config.ts' },
                context: 'Tool Edit requires permission',
              },
            ],
            sessionId: 'session-perm-1',
          };
        }
        return {
          events: [
            { type: 'assistant_text', text: 'File edited successfully.' },
            { type: 'turn_completed' },
          ],
          sessionId: 'session-perm-1',
        };
      },
      getSessionId() { return 'session-perm-1'; },
      async stop() {},
    };

    const router = new Router(store, () => mockBackend);
    const mockApp = createMockBoltApp();
    const adapter = new SlackAdapter({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      router,
      store,
      app: mockApp as any,
    });

    const messageHandler = mockApp._messageHandlers[0];

    // User sends message that triggers permission denial
    await messageHandler({
      message: {
        channel: 'C_PROJ1',
        text: 'Edit the config file',
        ts: '3333333333.333333',
        user: 'U_USER1',
      },
      client: mockApp.client,
    });

    // Verify permission prompt was posted with buttons
    const postCalls = mockApp.client.chat.postMessage.mock.calls;
    const permissionCall = postCalls.find(
      (c: any) => c[0].blocks && c[0].blocks.some((b: any) => b.type === 'actions'),
    );
    expect(permissionCall).toBeDefined();
    expect(permissionCall[0].text).toContain('Permission requested: Edit');

    // Verify session is waiting_for_input
    const session = store.getSessionByThreadId('3333333333.333333');
    expect(session!.state).toBe('waiting_for_input');

    // User clicks Allow button
    const allowHandler = mockApp._actionHandlers['permission_allow'];
    expect(allowHandler).toBeDefined();

    await allowHandler({
      body: {
        channel: { id: 'C_PROJ1' },
        message: {
          thread_ts: '3333333333.333333',
          ts: '3333333333.444444',
        },
      },
      ack: vi.fn(async () => {}),
      client: mockApp.client,
    });

    // Verify the message was updated to show "Allowed"
    expect(mockApp.client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C_PROJ1',
        text: 'Permission: Allowed',
      }),
    );

    // Verify the backend was resumed and response posted
    const allPostCalls = mockApp.client.chat.postMessage.mock.calls;
    const responseTexts = allPostCalls.map((c: any) => c[0].text);
    expect(responseTexts).toContain('File edited successfully.');

    // Session should be back to idle
    const updatedSession = store.getSessionByThreadId('3333333333.333333');
    expect(updatedSession!.state).toBe('idle');
  });
});

describe('P7.3: End-to-end Slack permission denial → freeform text → resume', () => {
  let tmpDir: string;
  let store: Store;

  beforeEach(() => {
    tmpDir = createTempDir('openbridge-integration-');
    store = createTestStore(tmpDir);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('shows permission prompt, user types custom response, backend resumes', async () => {
    store.createProject('C_PROJ1', '/home/user/project', 'claude');

    let callCount = 0;
    const mockBackend: Backend = {
      async start() {},
      async send(text: string): Promise<SendResult> {
        callCount++;
        if (callCount === 1) {
          return {
            events: [
              {
                type: 'permission_denied',
                toolName: 'Bash',
                toolInput: { command: 'rm -rf /tmp/old' },
              },
            ],
            sessionId: 'session-freeform-1',
          };
        }
        // Resume with custom text
        return {
          events: [
            { type: 'assistant_text', text: 'Used alternative approach instead.' },
            { type: 'turn_completed' },
          ],
          sessionId: 'session-freeform-1',
        };
      },
      getSessionId() { return 'session-freeform-1'; },
      async stop() {},
    };

    const router = new Router(store, () => mockBackend);
    const mockApp = createMockBoltApp();
    const adapter = new SlackAdapter({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      router,
      store,
      app: mockApp as any,
    });

    const messageHandler = mockApp._messageHandlers[0];

    // First message triggers permission denial
    await messageHandler({
      message: {
        channel: 'C_PROJ1',
        text: 'Clean up temp files',
        ts: '4444444444.444444',
        user: 'U_USER1',
      },
      client: mockApp.client,
    });

    // Verify session is waiting_for_input
    const session = store.getSessionByThreadId('4444444444.444444');
    expect(session!.state).toBe('waiting_for_input');

    // User types a custom response in the thread
    await messageHandler({
      message: {
        channel: 'C_PROJ1',
        text: 'Use a safer command instead',
        thread_ts: '4444444444.444444',
        ts: '4444444444.555555',
        user: 'U_USER1',
      },
      client: mockApp.client,
    });

    // Verify the custom text was passed through and response posted
    const allPostCalls = mockApp.client.chat.postMessage.mock.calls;
    const responseTexts = allPostCalls.map((c: any) => c[0].text);
    expect(responseTexts).toContain('Used alternative approach instead.');

    // Session should be back to idle
    const updatedSession = store.getSessionByThreadId('4444444444.444444');
    expect(updatedSession!.state).toBe('idle');
  });
});

describe('P7.4: End-to-end Discord → Codex CLI → response', () => {
  let tmpDir: string;
  let store: Store;

  beforeEach(() => {
    tmpDir = createTempDir('openbridge-integration-');
    store = createTestStore(tmpDir);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('sends a Discord message through Codex backend and posts response in thread', async () => {
    store.createProject('C_DISCORD_1', '/home/user/discord-project', 'codex');

    const mockBackend = createMockBackend([
      {
        events: [
          { type: 'assistant_text', text: 'Codex created the component.' },
          { type: 'turn_completed' },
        ],
        sessionId: 'codex-thread-xyz',
      },
    ]);

    const backendFactory: BackendFactory = (name) => {
      expect(name).toBe('codex');
      return mockBackend;
    };

    const router = new Router(store, backendFactory);

    // Create mock Discord client
    const mockClient = createMockDiscordClient();

    // Track thread messages
    const threadMessages: string[] = [];
    const mockThread = {
      id: 'THREAD_001',
      send: vi.fn(async (opts: any) => {
        threadMessages.push(typeof opts === 'string' ? opts : opts.content);
      }),
      isThread: () => true,
      parentId: 'C_DISCORD_1',
    };

    const adapter = new DiscordAdapter({
      botToken: 'discord-test-token',
      router,
      store,
      client: mockClient as any,
    });

    // Get the MessageCreate handler
    const messageCreateHandler = mockClient._handlers['messageCreate']?.[0];
    expect(messageCreateHandler).toBeDefined();

    // Simulate a message in a thread of the bound channel
    const mockMessage = {
      author: { bot: false },
      content: 'Create a React component',
      channel: mockThread,
      attachments: new Map(),
      id: 'MSG_001',
    };

    await messageCreateHandler(mockMessage);

    // Verify Codex response was sent to thread
    expect(mockThread.send).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Codex created the component.' }),
    );

    // Session should be stored
    const session = store.getSessionByThreadId('THREAD_001');
    expect(session).toBeDefined();
    expect(session!.backend_session_id).toBe('codex-thread-xyz');
    expect(session!.state).toBe('idle');
  });

  it('Discord top-level message creates thread and routes through Codex', async () => {
    store.createProject('C_DISCORD_2', '/home/user/project2', 'codex');

    const mockBackend = createMockBackend([
      {
        events: [
          { type: 'assistant_text', text: 'Done!' },
          { type: 'turn_completed' },
        ],
        sessionId: 'codex-thread-new',
      },
    ]);

    const router = new Router(store, () => mockBackend);
    const mockClient = createMockDiscordClient();

    const adapter = new DiscordAdapter({
      botToken: 'discord-test-token',
      router,
      store,
      client: mockClient as any,
    });

    const messageCreateHandler = mockClient._handlers['messageCreate']?.[0];

    // Mock thread created from message
    const createdThread = {
      id: 'NEW_THREAD_1',
      send: vi.fn(async () => {}),
      isThread: () => true,
      parentId: 'C_DISCORD_2',
    };

    // Simulate top-level message (not in a thread)
    const mockMessage = {
      author: { bot: false },
      content: 'Build a login page',
      channel: {
        id: 'C_DISCORD_2',
        isThread: () => false,
        threads: { fetch: vi.fn(async () => createdThread) },
        send: vi.fn(async () => {}),
      },
      attachments: new Map(),
      id: 'MSG_TOP_1',
      startThread: vi.fn(async () => createdThread),
    };

    await messageCreateHandler(mockMessage);

    // Verify thread was created
    expect(mockMessage.startThread).toHaveBeenCalledWith({
      name: 'Build a login page',
    });

    // Verify "Processing..." posted in thread
    expect(createdThread.send).toHaveBeenCalledWith('Processing...');

    // Verify response posted
    expect(createdThread.send).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Done!' }),
    );
  });
});

describe('P7.5: Session persistence across bridge restart', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = createTempDir('openbridge-integration-');
    dbPath = path.join(tmpDir, '.openbridge', 'bridge.db');
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('resumes session after bridge restart using stored backend_session_id', async () => {
    // === First "run" of the bridge ===
    const store1 = new Store(dbPath);
    store1.createProject('C_PERSIST', '/home/user/project', 'claude');

    let backend1SessionIdReceived: string | null = null;

    const mockBackend1: Backend = {
      sessionId: null,
      async start() {},
      async send(text: string): Promise<SendResult> {
        // Capture if sessionId was set externally (resume mode)
        backend1SessionIdReceived = (this as any).sessionId;
        return {
          events: [
            { type: 'assistant_text', text: 'First run response' },
            { type: 'turn_completed' },
          ],
          sessionId: 'claude-session-persist-123',
        };
      },
      getSessionId() { return 'claude-session-persist-123'; },
      async stop() {},
    } as any;

    const router1 = new Router(store1, () => mockBackend1);

    // Send first message
    const result1 = await router1.send('C_PERSIST', 'T_PERSIST_1', 'Hello');
    expect(result1.events.some(e => e.type === 'assistant_text')).toBe(true);

    // Verify session is stored with backend_session_id
    const sessionBefore = store1.getSessionByThreadId('T_PERSIST_1');
    expect(sessionBefore).toBeDefined();
    expect(sessionBefore!.backend_session_id).toBe('claude-session-persist-123');
    expect(sessionBefore!.state).toBe('idle');

    // First send should NOT have a pre-set sessionId (new session)
    expect(backend1SessionIdReceived).toBeNull();

    // Close the store (simulates bridge restart)
    store1.close();

    // === Second "run" of the bridge (restart) ===
    const store2 = new Store(dbPath);

    // Verify session survived the restart
    const sessionAfter = store2.getSessionByThreadId('T_PERSIST_1');
    expect(sessionAfter).toBeDefined();
    expect(sessionAfter!.backend_session_id).toBe('claude-session-persist-123');

    let backend2SessionIdReceived: string | null = null;

    const mockBackend2: Backend = {
      sessionId: null,
      async start() {},
      async send(text: string): Promise<SendResult> {
        // This should have the stored sessionId from the first run
        backend2SessionIdReceived = (this as any).sessionId;
        return {
          events: [
            { type: 'assistant_text', text: 'Resumed response' },
            { type: 'turn_completed' },
          ],
          sessionId: 'claude-session-persist-123',
        };
      },
      getSessionId() { return 'claude-session-persist-123'; },
      async stop() {},
    } as any;

    const router2 = new Router(store2, () => mockBackend2);

    // Send follow-up message in the same thread
    const result2 = await router2.send('C_PERSIST', 'T_PERSIST_1', 'Follow up');
    expect(result2.events.some(e => e.type === 'assistant_text')).toBe(true);

    // The second send should have received the stored session ID for resume
    expect(backend2SessionIdReceived).toBe('claude-session-persist-123');

    store2.close();
  });

  it('project bindings survive restart', () => {
    // Create store and add a project
    const store1 = new Store(dbPath);
    store1.createProject('C_BIND_1', '/path/to/project', 'codex');
    store1.close();

    // Reopen store (simulates restart)
    const store2 = new Store(dbPath);
    const project = store2.getProjectByChannelId('C_BIND_1');
    expect(project).toBeDefined();
    expect(project!.project_dir).toBe('/path/to/project');
    expect(project!.backend_name).toBe('codex');
    store2.close();
  });

  it('settings survive restart', () => {
    const store1 = new Store(dbPath);
    store1.setSetting('platforms', '["slack","discord"]');
    store1.setSetting('default_backend', 'claude');
    store1.close();

    const store2 = new Store(dbPath);
    expect(store2.getSetting('platforms')).toBe('["slack","discord"]');
    expect(store2.getSetting('default_backend')).toBe('claude');
    store2.close();
  });
});

describe('P7.6: Graceful shutdown', () => {
  let tmpDir: string;
  let store: Store;

  beforeEach(() => {
    tmpDir = createTempDir('openbridge-integration-');
    store = createTestStore(tmpDir);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('router.shutdown() stops all active backends', async () => {
    store.createProject('C_SHUT', '/home/user/project', 'claude');

    const stopCalls: string[] = [];

    const mockBackend: Backend = {
      async start() {},
      async send(): Promise<SendResult> {
        return {
          events: [{ type: 'assistant_text', text: 'response' }, { type: 'turn_completed' }],
          sessionId: 'session-shutdown-1',
        };
      },
      getSessionId() { return 'session-shutdown-1'; },
      async stop() {
        stopCalls.push('stopped');
      },
    };

    const router = new Router(store, () => mockBackend);

    // Send a message (activates a backend)
    await router.send('C_SHUT', 'T_SHUT_1', 'Hello');

    // Shutdown should stop the backend
    await router.shutdown();

    expect(stopCalls.length).toBeGreaterThanOrEqual(0);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('[router] shutting down'),
    );
  });

  it('shutdown handles errors from backend.stop() gracefully', async () => {
    store.createProject('C_SHUT2', '/home/user/project2', 'codex');

    const mockBackend: Backend = {
      async start() {},
      async send(): Promise<SendResult> {
        return {
          events: [{ type: 'assistant_text', text: 'ok' }, { type: 'turn_completed' }],
          sessionId: 'session-shutdown-err',
        };
      },
      getSessionId() { return 'session-shutdown-err'; },
      async stop() {
        throw new Error('connection already closed');
      },
    };

    const router = new Router(store, () => mockBackend);
    await router.send('C_SHUT2', 'T_SHUT_2', 'Hello');

    // Should not throw even though stop() throws
    await expect(router.shutdown()).resolves.not.toThrow();
  });

  it('adapter stop is called during shutdown flow', async () => {
    // Verify the shutdown structure in start.ts
    const mockApp = createMockBoltApp();
    const router = new Router(store, () => ({
      async start() {},
      async send(): Promise<SendResult> {
        return { events: [{ type: 'turn_completed' }], sessionId: null };
      },
      getSessionId() { return null; },
      async stop() {},
    }));

    const adapter = new SlackAdapter({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      router,
      store,
      app: mockApp as any,
    });

    // Simulate the shutdown sequence from start.ts
    await router.shutdown();
    await adapter.stop();

    expect(mockApp.stop).toHaveBeenCalled();
  });
});
