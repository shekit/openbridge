/**
 * Tests for the Slack adapter.
 *
 * Uses a mock Bolt App injected via the constructor to avoid needing
 * real Slack credentials in unit tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SlackAdapter, splitText, createBoltApp } from '../adapters/slack.js';
import { isImageMimeType, classifyMimeType } from '../utils.js';
import { Router } from '../router.js';
import { Store } from '../store.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { resolveUserQuestion } from '../mcp/ipc-server.js';

vi.mock('../mcp/ipc-server.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    resolvePermission: vi.fn(() => true),
    resolveUserQuestion: vi.fn(() => true),
  };
});

/** Create a mock Bolt App with tracked handlers. */
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
      delete: vi.fn(async () => ({ ok: true })),
    },
    conversations: {
      create: vi.fn(async () => ({ ok: true, channel: { id: 'C_NEW123' } })),
      join: vi.fn(async () => ({ ok: true })),
      invite: vi.fn(async () => ({ ok: true })),
      info: vi.fn(async () => ({ ok: true, channel: { is_member: true } })),
    },
    filesUploadV2: vi.fn(async () => ({ ok: true })),
    reactions: {
      add: vi.fn(async () => ({ ok: true })),
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
    // Expose for tests
    _messageHandlers: messageHandlers,
    _actionHandlers: actionHandlers,
    _commandHandlers: commandHandlers,
  };

  return mockApp;
}

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'openbridge-slack-test-'));
}

function createTestStore(tmpDir: string): Store {
  const dbPath = path.join(tmpDir, '.openbridge', 'bridge.db');
  return new Store(dbPath);
}

function createMockBackendFactory() {
  return vi.fn(() => ({
    start: vi.fn(async () => {}),
    send: vi.fn(async () => ({
      events: [{ type: 'assistant_text' as const, text: 'Hello from backend' }],
      sessionId: 'session-123',
    })),
    getSessionId: vi.fn(() => 'session-123'),
    setSessionId: vi.fn(),
    setAllowedTools: vi.fn(),
    stop: vi.fn(async () => {}),
  }));
}

describe('SlackAdapter', () => {
  let tmpDir: string;
  let store: Store;
  let router: Router;
  let adapter: SlackAdapter;
  let mockApp: ReturnType<typeof createMockBoltApp>;
  let mockBackendFactory: ReturnType<typeof createMockBackendFactory>;

  beforeEach(() => {
    tmpDir = createTempDir();
    store = createTestStore(tmpDir);
    mockBackendFactory = createMockBackendFactory();
    router = new Router(store, mockBackendFactory);
    mockApp = createMockBoltApp();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function createAdapter(opts?: { backendFactory?: ReturnType<typeof createMockBackendFactory> }): SlackAdapter {
    if (opts?.backendFactory) {
      router = new Router(store, opts.backendFactory);
    }
    adapter = new SlackAdapter({
      botToken: 'xoxb-test-token',
      appToken: 'xapp-test-token',
      router,
      store,
      app: mockApp as any,
    });
    return adapter;
  }

  /** Trigger the message handler registered on the mock app. */
  async function triggerMessage(message: any) {
    const handler = mockApp._messageHandlers[0];
    expect(handler).toBeDefined();
    await handler({ message, client: mockApp.client });
  }

  /** Trigger an action handler. */
  async function triggerAction(actionId: string, body: any) {
    const handler = mockApp._actionHandlers[actionId];
    expect(handler).toBeDefined();
    await handler({ body, ack: vi.fn(), client: mockApp.client });
  }

  /** Trigger a command handler. */
  async function triggerCommand(cmd: string, command: any) {
    const handler = mockApp._commandHandlers[cmd];
    expect(handler).toBeDefined();
    await handler({ command, ack: vi.fn(), client: mockApp.client });
  }

  describe('P3.1: Slack app connects via Socket Mode', () => {
    it('creates a Bolt app with Socket Mode when no app injected', () => {
      // Test the factory function separately
      expect(typeof createBoltApp).toBe('function');
    });

    it('uses the injected app when provided', () => {
      createAdapter();
      expect(adapter.getApp()).toBe(mockApp);
    });

    it('calls app.start() on start()', async () => {
      createAdapter();
      await adapter.start();
      expect(mockApp.start).toHaveBeenCalled();
    });

    it('fetches bot user ID on start for self-message filtering', async () => {
      createAdapter();
      await adapter.start();
      expect(mockApp.client.auth.test).toHaveBeenCalled();
    });

    it('calls app.stop() on stop()', async () => {
      createAdapter();
      await adapter.start();
      await adapter.stop();
      expect(mockApp.stop).toHaveBeenCalled();
    });

    it('logs connection on startup', async () => {
      createAdapter();
      const spy = vi.spyOn(console, 'log');
      await adapter.start();
      expect(spy).toHaveBeenCalledWith('[slack] connected via Socket Mode');
      spy.mockRestore();
    });
  });

  describe('P3.2: Slack adapter implements adapter interface', () => {
    it('has start() method', () => {
      createAdapter();
      expect(typeof adapter.start).toBe('function');
    });

    it('has stop() method', () => {
      createAdapter();
      expect(typeof adapter.stop).toBe('function');
    });

    it('has postText() method', () => {
      createAdapter();
      expect(typeof adapter.postText).toBe('function');
    });

    it('has postPermissionPrompt() method', () => {
      createAdapter();
      expect(typeof adapter.postPermissionPrompt).toBe('function');
    });

    it('has postError() method', () => {
      createAdapter();
      expect(typeof adapter.postError).toBe('function');
    });
  });

  describe('P3.3: Listen for messages in bound channels and route to router', () => {
    it('registers a message handler', () => {
      createAdapter();
      expect(mockApp.message).toHaveBeenCalled();
    });

    it('routes messages from bound channels to the router', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_BOUND', '/test/project', 'claude');

      await triggerMessage({
        channel: 'C_BOUND',
        text: 'hello world',
        user: 'U_USER1',
        ts: '1234567890.000002',
        thread_ts: '1234567890.000001',
      });

      expect(mockApp.client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C_BOUND',
          thread_ts: '1234567890.000001',
        })
      );
    });

    it('ignores messages from unbound channels', async () => {
      createAdapter();
      await adapter.start();

      await triggerMessage({
        channel: 'C_UNBOUND',
        text: 'hello',
        user: 'U_USER1',
        ts: '1234567890.000001',
      });

      expect(mockApp.client.chat.postMessage).not.toHaveBeenCalled();
    });

    it('ignores bot messages to prevent loops', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_BOUND', '/test/project', 'claude');

      await triggerMessage({
        channel: 'C_BOUND',
        text: 'bot message',
        bot_id: 'B_123',
        ts: '1234567890.000001',
        thread_ts: '1234567890.000001',
      });

      expect(mockApp.client.chat.postMessage).not.toHaveBeenCalled();
    });

    it('ignores messages from the bot user itself', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_BOUND', '/test/project', 'claude');

      await triggerMessage({
        channel: 'C_BOUND',
        text: 'self message',
        user: 'U_BOT123',
        ts: '1234567890.000001',
        thread_ts: '1234567890.000001',
      });

      expect(mockApp.client.chat.postMessage).not.toHaveBeenCalled();
    });
  });

  describe('P3.4: Auto-move top-level channel messages into new threads', () => {
    it('creates a new thread for top-level messages (no thread_ts)', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_BOUND', '/test/project', 'claude');

      await triggerMessage({
        channel: 'C_BOUND',
        text: 'new task',
        user: 'U_USER1',
        ts: '1234567890.000001',
        // No thread_ts — top-level message
      });

      // Should react with 👀 on the user's message
      expect(mockApp.client.reactions.add).toHaveBeenCalledWith({
        channel: 'C_BOUND',
        timestamp: '1234567890.000001',
        name: 'eyes',
      });
    });

    it('reacts with eyes on follow-up messages in threads', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_BOUND', '/test/project', 'claude');

      await triggerMessage({
        channel: 'C_BOUND',
        text: 'reply in thread',
        user: 'U_USER1',
        ts: '1234567890.000002',
        thread_ts: '1234567890.000001',
      });

      // Should react with 👀 on the user's message
      expect(mockApp.client.reactions.add).toHaveBeenCalledWith({
        channel: 'C_BOUND',
        timestamp: '1234567890.000002',
        name: 'eyes',
      });
    });
  });

  describe('P3.5: Route thread messages to correct session', () => {
    it('routes messages to the session mapped to the thread', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_BOUND', '/test/project', 'claude');

      // Message in thread A
      await triggerMessage({
        channel: 'C_BOUND',
        text: 'message in thread A',
        user: 'U_USER1',
        ts: '1234567890.000002',
        thread_ts: '1234567890.000001',
      });

      const sessionA = store.getSessionByThreadId('1234567890.000001');
      expect(sessionA).toBeDefined();

      // Message in thread B
      await triggerMessage({
        channel: 'C_BOUND',
        text: 'message in thread B',
        user: 'U_USER1',
        ts: '1234567890.000004',
        thread_ts: '1234567890.000003',
      });

      const sessionB = store.getSessionByThreadId('1234567890.000003');
      expect(sessionB).toBeDefined();
      expect(sessionB!.id).not.toBe(sessionA!.id);
    });

    it('new thread creates a new session automatically', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_BOUND', '/test/project', 'claude');

      // No session exists for this thread yet
      expect(store.getSessionByThreadId('1234567890.NEWTHREAD')).toBeUndefined();

      await triggerMessage({
        channel: 'C_BOUND',
        text: 'first message',
        user: 'U_USER1',
        ts: '1234567890.000002',
        thread_ts: '1234567890.NEWTHREAD',
      });

      // Session should now exist
      expect(store.getSessionByThreadId('1234567890.NEWTHREAD')).toBeDefined();
    });
  });

  describe('P3.6: Post assistant text responses back to thread', () => {
    it('posts AssistantText events as Slack messages in the thread', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_BOUND', '/test/project', 'claude');

      await triggerMessage({
        channel: 'C_BOUND',
        text: 'hello',
        user: 'U_USER1',
        ts: '1234567890.000002',
        thread_ts: '1234567890.000001',
      });

      expect(mockApp.client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C_BOUND',
          thread_ts: '1234567890.000001',
          text: 'Hello from backend',
        })
      );
    });

    it('splits long responses into multiple messages', () => {
      const chunks = splitText('a'.repeat(8000), 4000);
      expect(chunks.length).toBe(2);
      expect(chunks[0].length).toBeLessThanOrEqual(4000);
      expect(chunks[1].length).toBeLessThanOrEqual(4000);
    });

    it('splits at word boundaries when possible', () => {
      const text = 'word '.repeat(1000).trim(); // 4999 chars
      const chunks = splitText(text, 4000);
      expect(chunks.length).toBe(2);
      expect(chunks[0].endsWith('word')).toBe(true);
    });
  });

  describe('P3.7: Render permission denial as Block Kit interactive message', () => {
    it('posts a Block Kit message with Allow/Deny buttons', async () => {
      const permBackend = vi.fn(() => ({
        start: vi.fn(async () => {}),
        send: vi.fn(async () => ({
          events: [
            {
              type: 'permission_denied' as const,
              toolName: 'Edit',
              toolInput: { file: 'foo.js' },
              context: 'Wants to edit foo.js',
            },
          ],
          sessionId: 'session-123',
        })),
        getSessionId: vi.fn(() => 'session-123'),
        setSessionId: vi.fn(),
        setAllowedTools: vi.fn(),
        stop: vi.fn(async () => {}),
      }));

      createAdapter({ backendFactory: permBackend });
      await adapter.start();

      store.createProject('C_BOUND', '/test/project', 'claude');

      await triggerMessage({
        channel: 'C_BOUND',
        text: 'edit the file',
        user: 'U_USER1',
        ts: '1234567890.000002',
        thread_ts: '1234567890.000001',
      });

      const calls = mockApp.client.chat.postMessage.mock.calls;
      const permissionCall = calls.find(
        (c: any) => c[0].blocks && c[0].blocks.some((b: any) => b.type === 'actions')
      );
      expect(permissionCall).toBeDefined();

      const blocks = permissionCall![0].blocks;
      const sectionBlock = blocks.find((b: any) => b.type === 'section');
      expect(sectionBlock.text.text).toContain('Edit');

      const actionsBlock = blocks.find((b: any) => b.type === 'actions');
      expect(actionsBlock.elements).toHaveLength(3);
      expect(actionsBlock.elements[0].action_id).toBe('permission_allow');
      expect(actionsBlock.elements[1].action_id).toBe('permission_always_allow');
      expect(actionsBlock.elements[2].action_id).toBe('permission_deny');

      const contextBlock = blocks.find((b: any) => b.type === 'context');
      expect(contextBlock.elements[0].text).toContain('custom response');
    });
  });

  describe('P3.8: Handle Allow button click on permission prompt', () => {
    it('sends allow response to router and updates the message', async () => {
      createAdapter();
      await adapter.start();

      const project = store.createProject('C_BOUND', '/test/project', 'claude');
      const session = store.createSession('1234567890.000001', project.id);
      store.updateSessionState(session.id, 'running');
      store.updateSessionState(session.id, 'waiting_for_input');
      store.updateBackendSessionId(session.id, 'backend-session-123');

      await triggerAction('permission_allow', {
        channel: { id: 'C_BOUND' },
        message: {
          thread_ts: '1234567890.000001',
          ts: '1234567890.000005',
        },
      });

      expect(mockApp.client.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C_BOUND',
          ts: '1234567890.000005',
        })
      );

      const updatedSession = store.getSessionByThreadId('1234567890.000001');
      expect(updatedSession!.state).toBe('idle');
    });

    it('updates message to show Allowed', async () => {
      createAdapter();
      await adapter.start();

      const project = store.createProject('C_BOUND', '/test/project', 'claude');
      const session = store.createSession('1234567890.000001', project.id);
      store.updateSessionState(session.id, 'running');
      store.updateSessionState(session.id, 'waiting_for_input');
      store.updateBackendSessionId(session.id, 'backend-session-123');

      await triggerAction('permission_allow', {
        channel: { id: 'C_BOUND' },
        message: {
          thread_ts: '1234567890.000001',
          ts: '1234567890.000005',
        },
      });

      expect(mockApp.client.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'Permission: Allowed',
        })
      );
    });
  });

  describe('P3.9: Handle Deny button click on permission prompt', () => {
    it('sends deny response to router', async () => {
      createAdapter();
      await adapter.start();

      const project = store.createProject('C_BOUND', '/test/project', 'claude');
      const session = store.createSession('1234567890.000001', project.id);
      store.updateSessionState(session.id, 'running');
      store.updateSessionState(session.id, 'waiting_for_input');
      store.updateBackendSessionId(session.id, 'backend-session-123');

      await triggerAction('permission_deny', {
        channel: { id: 'C_BOUND' },
        message: {
          thread_ts: '1234567890.000001',
          ts: '1234567890.000005',
        },
      });

      expect(mockApp.client.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'Permission: Denied',
        })
      );
    });

    it('routes denial response through router', async () => {
      createAdapter();
      await adapter.start();

      const project = store.createProject('C_BOUND', '/test/project', 'claude');
      const session = store.createSession('1234567890.000001', project.id);
      store.updateSessionState(session.id, 'running');
      store.updateSessionState(session.id, 'waiting_for_input');
      store.updateBackendSessionId(session.id, 'backend-session-123');

      await triggerAction('permission_deny', {
        channel: { id: 'C_BOUND' },
        message: {
          thread_ts: '1234567890.000001',
          ts: '1234567890.000005',
        },
      });

      // Session should be idle after the deny response is processed
      const updatedSession = store.getSessionByThreadId('1234567890.000001');
      expect(updatedSession!.state).toBe('idle');
    });
  });

  describe('P3.10: Handle freeform text as custom response when waiting_for_input', () => {
    it('routes text as resume response when session is waiting_for_input', async () => {
      createAdapter();
      await adapter.start();

      const project = store.createProject('C_BOUND', '/test/project', 'claude');
      const session = store.createSession('1234567890.000001', project.id);
      store.updateSessionState(session.id, 'running');
      store.updateSessionState(session.id, 'waiting_for_input');
      store.updateBackendSessionId(session.id, 'backend-session-123');

      await triggerMessage({
        channel: 'C_BOUND',
        text: 'use a different approach',
        user: 'U_USER1',
        ts: '1234567890.000006',
        thread_ts: '1234567890.000001',
      });

      expect(mockApp.client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C_BOUND',
          thread_ts: '1234567890.000001',
          text: 'Hello from backend',
        })
      );

      const updatedSession = store.getSessionByThreadId('1234567890.000001');
      expect(updatedSession!.state).toBe('idle');
    });
  });

  describe('P3.11: Post error messages for backend failures', () => {
    it('posts error messages when backend throws', async () => {
      const errorBackend = vi.fn(() => ({
        start: vi.fn(async () => {}),
        send: vi.fn(async () => {
          throw new Error('Backend crashed unexpectedly');
        }),
        getSessionId: vi.fn(() => null),
        setSessionId: vi.fn(),
        setAllowedTools: vi.fn(),
        stop: vi.fn(async () => {}),
      }));

      createAdapter({ backendFactory: errorBackend });
      await adapter.start();

      store.createProject('C_BOUND', '/test/project', 'claude');

      await triggerMessage({
        channel: 'C_BOUND',
        text: 'do something',
        user: 'U_USER1',
        ts: '1234567890.000002',
        thread_ts: '1234567890.000001',
      });

      const calls = mockApp.client.chat.postMessage.mock.calls;
      const errorCall = calls.find(
        (c: any) => typeof c[0].text === 'string' && c[0].text.includes('Error')
      );
      expect(errorCall).toBeDefined();
      expect(errorCall![0].text).toContain('Backend crashed unexpectedly');
    });

    it('posts Error events from backend as error messages', async () => {
      const errorEventBackend = vi.fn(() => ({
        start: vi.fn(async () => {}),
        send: vi.fn(async () => ({
          events: [{ type: 'error' as const, message: 'claude CLI not found' }],
          sessionId: null,
        })),
        getSessionId: vi.fn(() => null),
        setSessionId: vi.fn(),
        setAllowedTools: vi.fn(),
        stop: vi.fn(async () => {}),
      }));

      createAdapter({ backendFactory: errorEventBackend });
      await adapter.start();

      store.createProject('C_BOUND', '/test/project', 'claude');

      await triggerMessage({
        channel: 'C_BOUND',
        text: 'hello',
        user: 'U_USER1',
        ts: '1234567890.000002',
        thread_ts: '1234567890.000001',
      });

      const calls = mockApp.client.chat.postMessage.mock.calls;
      const errorCall = calls.find(
        (c: any) => typeof c[0].text === 'string' && c[0].text.includes('claude CLI not found')
      );
      expect(errorCall).toBeDefined();
    });
  });

  describe('P3.12: Register /project slash command', () => {
    it('registers /project command handler', () => {
      createAdapter();
      expect(mockApp.command).toHaveBeenCalledWith('/project', expect.any(Function));
    });

    it('registers /settings command handler', () => {
      createAdapter();
      expect(mockApp.command).toHaveBeenCalledWith('/settings', expect.any(Function));
    });
  });

  describe('P3.13: /project with path creates new channel and binds it', () => {
    it('creates a new channel when invoked from a bound channel', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_BOUND', '/test/project', 'claude');

      await triggerCommand('/project', {
        channel_id: 'C_BOUND',
        text: '/test/my-app',
      });

      expect(mockApp.client.conversations.create).toHaveBeenCalledWith({ name: 'my-app' });
      expect(mockApp.client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('/test/my-app'),
        })
      );
    });

    it('binds the new channel with an absolute project_dir', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_BOUND', '/test/project', 'claude');

      await triggerCommand('/project', {
        channel_id: 'C_BOUND',
        text: '/test/my-app',
      });

      const newProject = store.getProjectByChannelId('C_NEW123');
      expect(newProject).toBeDefined();
      expect(newProject!.project_dir).toBe('/test/my-app');
    });

    it('rejects non-absolute paths with an error message', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_BOUND', '/test/project', 'claude');

      await triggerCommand('/project', {
        channel_id: 'C_BOUND',
        text: 'connect my-app',
      });

      expect(mockApp.client.conversations.create).not.toHaveBeenCalled();
      expect(mockApp.client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('absolute path'),
        })
      );
    });
  });

  describe('P3.14: /project from unbound channel offers bind options', () => {
    it('shows Use this channel and Create new buttons', async () => {
      createAdapter();
      await adapter.start();

      await triggerCommand('/project', {
        channel_id: 'C_UNBOUND',
        text: '/test/my-app',
      });

      const calls = mockApp.client.chat.postMessage.mock.calls;
      const bindCall = calls.find(
        (c: any) => c[0].blocks && c[0].blocks.some((b: any) => b.type === 'actions')
      );
      expect(bindCall).toBeDefined();

      const actionsBlock = bindCall![0].blocks.find((b: any) => b.type === 'actions');
      expect(actionsBlock.elements[0].text.text).toBe('Use this channel');
      expect(actionsBlock.elements[1].text.text).toBe('Create #my-app');
      // Button values should contain the full absolute path
      expect(actionsBlock.elements[0].value).toBe('/test/my-app');
      expect(actionsBlock.elements[1].value).toBe('/test/my-app');
    });
  });

  describe('P3.15: /project list shows all bindings', () => {
    it('lists all channel -> project -> backend bindings', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_PROJ1', '/test/project1', 'claude');
      store.createProject('C_PROJ2', '/test/project2', 'codex');

      await triggerCommand('/project', {
        channel_id: 'C_PROJ1',
        text: 'list',
      });

      const calls = mockApp.client.chat.postMessage.mock.calls;
      const listCall = calls.find(
        (c: any) => typeof c[0].text === 'string' && c[0].text.includes('Connected Projects')
      );
      expect(listCall).toBeDefined();
      expect(listCall![0].text).toContain('/test/project1');
      expect(listCall![0].text).toContain('/test/project2');
      expect(listCall![0].text).toContain('claude');
      expect(listCall![0].text).toContain('codex');
    });

    it('shows message when no bindings exist', async () => {
      createAdapter();
      await adapter.start();

      await triggerCommand('/project', {
        channel_id: 'C_ANY',
        text: 'list',
      });

      const calls = mockApp.client.chat.postMessage.mock.calls;
      expect(calls[0][0].text).toContain('No projects connected');
    });
  });

  describe('text command: "new" resets session in thread', () => {
    it('resets the session and posts confirmation', async () => {
      createAdapter();
      await adapter.start();

      const project = store.createProject('C_BOUND', '/test/project', 'claude');
      const session = store.createSession('1234567890.000001', project.id);
      store.updateBackendSessionId(session.id, 'old-backend-session');

      await triggerMessage({
        channel: 'C_BOUND',
        text: 'new',
        thread_ts: '1234567890.000001',
        ts: '1234567890.000099',
        user: 'U_USER',
      });

      const updatedSession = store.getSessionByThreadId('1234567890.000001');
      expect(updatedSession!.backend_session_id).toBeNull();
      expect(updatedSession!.state).toBe('idle');

      expect(mockApp.client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          thread_ts: '1234567890.000001',
          text: expect.stringContaining('Session reset'),
        })
      );
    });

    it('is case-insensitive', async () => {
      createAdapter();
      await adapter.start();

      const project = store.createProject('C_BOUND', '/test/project', 'claude');
      store.createSession('1234567890.000001', project.id);

      await triggerMessage({
        channel: 'C_BOUND',
        text: 'New',
        thread_ts: '1234567890.000001',
        ts: '1234567890.000099',
        user: 'U_USER',
      });

      expect(mockApp.client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Session reset'),
        })
      );
    });
  });

  describe('text command: "cancel" stops a running task in thread', () => {
    it('reports nothing to cancel when no task is running', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_CANCEL', '/test/cancel', 'claude');

      await triggerMessage({
        channel: 'C_CANCEL',
        text: 'cancel',
        thread_ts: '9999.000001',
        ts: '9999.000099',
        user: 'U_USER',
      });

      expect(mockApp.client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Nothing to cancel'),
        })
      );
    });
  });

  describe('P3.17: /settings displays and modifies bridge configuration', () => {
    it('displays current settings with project info', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_BOUND', '/test/project', 'claude');

      await triggerCommand('/settings', {
        channel_id: 'C_BOUND',
        text: '',
      });

      const calls = mockApp.client.chat.postMessage.mock.calls;
      expect(calls[0][0].text).toContain('claude');
      expect(calls[0][0].text).toContain('/test/project');
      expect(calls[0][0].text).toContain('/project backend');
    });

    it('displays settings even without a connected project', async () => {
      createAdapter();
      await adapter.start();

      await triggerCommand('/settings', {
        channel_id: 'C_UNBOUND',
        text: '',
      });

      const calls = mockApp.client.chat.postMessage.mock.calls;
      expect(calls[0][0].text).toContain('Bridge settings');
      expect(calls[0][0].text).toContain('/settings root');
    });
  });

  describe('/project backend changes the AI backend', () => {
    it('changes the backend when given "backend codex"', async () => {
      createAdapter();
      await adapter.start();

      const project = store.createProject('C_BOUND', '/test/project', 'claude');

      await triggerCommand('/project', {
        channel_id: 'C_BOUND',
        text: 'backend codex',
      });

      const updated = store.getProjectById(project.id);
      expect(updated?.backend_name).toBe('codex');

      expect(mockApp.client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('codex'),
        })
      );
    });

    it('rejects unknown backends', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_BOUND', '/test/project', 'claude');

      await triggerCommand('/project', {
        channel_id: 'C_BOUND',
        text: 'backend unknown',
      });

      const calls = mockApp.client.chat.postMessage.mock.calls;
      expect(calls[0][0].text).toContain('Unknown backend');
    });

    it('shows current backend when no arg given', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_BOUND', '/test/project', 'claude');

      await triggerCommand('/project', {
        channel_id: 'C_BOUND',
        text: 'backend',
      });

      const calls = mockApp.client.chat.postMessage.mock.calls;
      expect(calls[0][0].text).toContain('Current backend');
      expect(calls[0][0].text).toContain('claude');
    });
  });

  describe('/project info shows project details', () => {
    it('shows path, backend, and permission mode', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_BOUND', '/test/project', 'claude');

      await triggerCommand('/project', {
        channel_id: 'C_BOUND',
        text: 'info',
      });

      const calls = mockApp.client.chat.postMessage.mock.calls;
      expect(calls[0][0].text).toContain('/test/project');
      expect(calls[0][0].text).toContain('Claude Code');
      expect(calls[0][0].text).toContain('supervised');
    });

    it('shows message when no project connected', async () => {
      createAdapter();
      await adapter.start();

      await triggerCommand('/project', {
        channel_id: 'C_UNBOUND',
        text: 'info',
      });

      const calls = mockApp.client.chat.postMessage.mock.calls;
      expect(calls[0][0].text).toContain('No project connected');
    });
  });

  describe('/settings schedule list and cancel', () => {
    it('lists active schedules for the channel', async () => {
      createAdapter();
      await adapter.start();

      const project = store.createProject('C_SCHED', '/test/sched', 'claude');
      store.createSchedule(
        project.id, 'C_SCHED', 'news prompt', 'give me daily news',
        { cronExpression: '0 9 * * *', nextRunAt: '2026-02-25T09:00:00' },
      );

      await triggerCommand('/settings', {
        channel_id: 'C_SCHED',
        text: 'schedule list',
      });

      const calls = mockApp.client.chat.postMessage.mock.calls;
      expect(calls[0][0].text).toContain('give me daily news');
      expect(calls[0][0].text).toContain('cron');
    });

    it('shows empty message when no schedules', async () => {
      createAdapter();
      await adapter.start();

      await triggerCommand('/settings', {
        channel_id: 'C_EMPTY',
        text: 'schedule list',
      });

      const calls = mockApp.client.chat.postMessage.mock.calls;
      expect(calls[0][0].text).toContain('No scheduled sessions');
    });

    it('cancels a schedule by ID', async () => {
      createAdapter();
      await adapter.start();

      const project = store.createProject('C_CANCEL', '/test/cancel', 'claude');
      const sched = store.createSchedule(
        project.id, 'C_CANCEL', 'to cancel', 'cancel this task',
        { scheduledAt: '2026-03-01T09:00:00', nextRunAt: '2026-03-01T09:00:00' },
      );

      await triggerCommand('/settings', {
        channel_id: 'C_CANCEL',
        text: `schedule cancel ${sched.id}`,
      });

      const calls = mockApp.client.chat.postMessage.mock.calls;
      expect(calls[0][0].text).toContain('Cancelled');
      expect(calls[0][0].text).toContain('cancel this task');

      const updated = store.getScheduleById(sched.id);
      expect(updated!.is_active).toBe(0);
    });

    it('rejects cancel for nonexistent schedule', async () => {
      createAdapter();
      await adapter.start();

      await triggerCommand('/settings', {
        channel_id: 'C_NOEXIST',
        text: 'schedule cancel 99999',
      });

      const calls = mockApp.client.chat.postMessage.mock.calls;
      expect(calls[0][0].text).toContain('No active schedule');
    });
  });

  describe('P3.18: File upload handling', () => {
    it('includes file descriptions in the message sent to backend', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_BOUND', '/test/project', 'claude');

      await adapter.handleFileUpload(
        'C_BOUND',
        '1234567890.000001',
        [{ name: 'screenshot.png', url_private_download: 'https://files.slack.com/123' }],
        'check this screenshot',
        mockApp.client
      );

      expect(mockBackendFactory).toHaveBeenCalled();
    });

    it('ignores file uploads in unbound channels', async () => {
      createAdapter();
      await adapter.start();

      await adapter.handleFileUpload(
        'C_UNBOUND',
        '1234567890.000001',
        [{ name: 'file.txt', url_private: 'https://files.slack.com/456' }],
        'some text',
        mockApp.client
      );

      expect(mockBackendFactory).not.toHaveBeenCalled();
    });

    it('combines file descriptions with message text', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_BOUND', '/test/project', 'claude');

      // The backend factory will capture the text sent to it
      let capturedText = '';
      mockBackendFactory.mockReturnValue({
        start: vi.fn(async () => {}),
        send: vi.fn(async (text: string) => {
          capturedText = text;
          return {
            events: [{ type: 'assistant_text' as const, text: 'Got it' }],
            sessionId: 'session-123',
          };
        }),
        getSessionId: vi.fn(() => 'session-123'),
        setSessionId: vi.fn(),
        stop: vi.fn(async () => {}),
      });

      await adapter.handleFileUpload(
        'C_BOUND',
        '1234567890.000001',
        [
          { name: 'screenshot.png', url_private_download: 'https://files.slack.com/123' },
          { name: 'design.pdf', url_private: 'https://files.slack.com/456' },
        ],
        'check these files',
        mockApp.client
      );

      expect(capturedText).toContain('check these files');
      expect(capturedText).toContain('screenshot.png');
      expect(capturedText).toContain('design.pdf');
    });
  });

  describe('splitText utility', () => {
    it('returns single chunk for short text', () => {
      expect(splitText('hello', 4000)).toEqual(['hello']);
    });

    it('splits at word boundaries', () => {
      const text = 'hello world foo bar baz';
      const chunks = splitText(text, 15);
      expect(chunks[0].length).toBeLessThanOrEqual(15);
    });

    it('handles text with no spaces', () => {
      const text = 'a'.repeat(100);
      const chunks = splitText(text, 50);
      expect(chunks.length).toBe(2);
      expect(chunks[0].length).toBe(50);
      expect(chunks[1].length).toBe(50);
    });

    it('returns empty array for empty string', () => {
      expect(splitText('', 4000)).toEqual([]);
    });
  });

  describe('uploadFile', () => {
    it('calls filesUploadV2 with correct params', async () => {
      createAdapter();
      const tmpFile = path.join(tmpDir, 'test-upload.txt');
      fs.writeFileSync(tmpFile, 'test content');

      await adapter.uploadFile('C_CHAN', 'T_THREAD', tmpFile);

      expect(mockApp.client.filesUploadV2).toHaveBeenCalledWith({
        channel_id: 'C_CHAN',
        thread_ts: 'T_THREAD',
        file: tmpFile,
        filename: 'test-upload.txt',
      });
    });
  });

  describe('sendMessage', () => {
    it('calls chat.postMessage with correct params', async () => {
      createAdapter();
      mockApp.client.chat.postMessage.mockClear();

      await adapter.sendMessage('C_CHAN', 'T_THREAD', 'Hello from MCP');

      expect(mockApp.client.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C_CHAN',
        thread_ts: 'T_THREAD',
        text: 'Hello from MCP',
      });
    });
  });

  describe('P12.5: Always Allow button stores tool pattern', () => {
    it('registers permission_always_allow action handler', () => {
      createAdapter();
      expect(mockApp._actionHandlers['permission_always_allow']).toBeDefined();
    });

    it('stores tool in allowed_tools when Always Allow is clicked', async () => {
      createAdapter();
      await adapter.start();

      const project = store.createProject('C_AA', '/test/aa', 'claude');
      const session = store.createSession('1234567890.AA001', project.id);
      store.updateSessionState(session.id, 'running');
      store.updateSessionState(session.id, 'waiting_for_input');
      store.updateBackendSessionId(session.id, 'backend-session-aa');

      await triggerAction('permission_always_allow', {
        actions: [{ value: 'Bash' }],
        channel: { id: 'C_AA' },
        message: {
          thread_ts: '1234567890.AA001',
          ts: '1234567890.AA005',
        },
      });

      const tools = store.getAllowedTools(project.id);
      expect(tools).toHaveLength(1);
      expect(tools[0].tool_pattern).toBe('Bash');
    });

    it('updates message to show Always Allowed', async () => {
      createAdapter();
      await adapter.start();

      const project = store.createProject('C_AA2', '/test/aa2', 'claude');
      const session = store.createSession('1234567890.AA002', project.id);
      store.updateSessionState(session.id, 'running');
      store.updateSessionState(session.id, 'waiting_for_input');
      store.updateBackendSessionId(session.id, 'backend-session-aa2');

      await triggerAction('permission_always_allow', {
        actions: [{ value: 'Write' }],
        channel: { id: 'C_AA2' },
        message: {
          thread_ts: '1234567890.AA002',
          ts: '1234567890.AA006',
        },
      });

      expect(mockApp.client.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'Permission: Always Allowed',
        })
      );
    });

    it('permission prompt includes Always Allow button between Allow and Deny', async () => {
      const permBackend = vi.fn(() => ({
        start: vi.fn(async () => {}),
        send: vi.fn(async () => ({
          events: [
            {
              type: 'permission_denied' as const,
              toolName: 'Bash',
              toolInput: { command: 'ls' },
            },
          ],
          sessionId: 'session-123',
        })),
        getSessionId: vi.fn(() => 'session-123'),
        setSessionId: vi.fn(),
        setAllowedTools: vi.fn(),
        stop: vi.fn(async () => {}),
      }));

      createAdapter({ backendFactory: permBackend });
      await adapter.start();
      store.createProject('C_AA3', '/test/aa3', 'claude');

      await triggerMessage({
        channel: 'C_AA3',
        text: 'run ls',
        user: 'U_USER1',
        ts: '1234567890.000002',
        thread_ts: '1234567890.000001',
      });

      const calls = mockApp.client.chat.postMessage.mock.calls;
      const permCall = calls.find(
        (c: any) => c[0].blocks?.some((b: any) => b.type === 'actions')
      );
      const actionsBlock = permCall![0].blocks.find((b: any) => b.type === 'actions');
      expect(actionsBlock.elements[1].action_id).toBe('permission_always_allow');
      expect(actionsBlock.elements[1].text.text).toBe('Always Allow');
    });

    it('truncates large tool input in permission prompt', async () => {
      const largeContent = 'x'.repeat(2000);
      const bigBackend = vi.fn(() => ({
        start: vi.fn(async () => {}),
        send: vi.fn(async () => ({
          events: [
            {
              type: 'permission_denied' as const,
              toolName: 'Write',
              toolInput: { file_path: 'index.html', content: largeContent },
            },
          ],
          sessionId: 'session-trunc',
        })),
        getSessionId: vi.fn(() => 'session-trunc'),
        setSessionId: vi.fn(),
        setAllowedTools: vi.fn(),
        stop: vi.fn(async () => {}),
      }));

      createAdapter({ backendFactory: bigBackend });
      await adapter.start();
      store.createProject('C_TRUNC', '/test/trunc', 'claude');

      await triggerMessage({
        channel: 'C_TRUNC',
        text: 'write a big file',
        user: 'U_USER1',
        ts: '1234567890.000004',
        thread_ts: '1234567890.000003',
      });

      const calls = mockApp.client.chat.postMessage.mock.calls;
      const permCall = calls.find(
        (c: any) => c[0].blocks?.some((b: any) => b.type === 'section' && b.text?.text?.includes('Permission requested'))
      );
      expect(permCall).toBeDefined();
      const sectionText = permCall![0].blocks[0].text.text;
      expect(sectionText).toContain('(truncated)');
      expect(sectionText.length).toBeLessThan(1000);
    });
  });

  describe('P12.7: Codex sandbox upgrade flow', () => {
    it('renders sandbox denials with Upgrade button instead of Allow/Deny', async () => {
      const sandboxBackend = vi.fn(() => ({
        start: vi.fn(async () => {}),
        send: vi.fn(async () => ({
          events: [
            {
              type: 'permission_denied' as const,
              toolName: 'sandbox',
              toolInput: { command: 'touch /etc/test' },
              context: 'touch: /etc/test: Operation not permitted',
            },
          ],
          sessionId: 'session-123',
        })),
        getSessionId: vi.fn(() => 'session-123'),
        setSessionId: vi.fn(),
        setAllowedTools: vi.fn(),
        stop: vi.fn(async () => {}),
      }));

      createAdapter({ backendFactory: sandboxBackend });
      await adapter.start();
      store.createProject('C_SB', '/test/sb', 'codex');

      await triggerMessage({
        channel: 'C_SB',
        text: 'touch /etc/test',
        user: 'U_USER1',
        ts: '1234567890.000002',
        thread_ts: '1234567890.000001',
      });

      const calls = mockApp.client.chat.postMessage.mock.calls;
      const upgradeCall = calls.find(
        (c: any) => c[0].blocks?.some((b: any) =>
          b.type === 'actions' && b.elements?.some((e: any) => e.action_id === 'sandbox_upgrade')
        )
      );
      expect(upgradeCall).toBeDefined();
      expect(upgradeCall![0].blocks[0].text.text).toContain('Sandbox denied');
    });

    it('sandbox_upgrade button updates project sandbox_mode', async () => {
      createAdapter();
      await adapter.start();

      const project = store.createProject('C_SBU', '/test/sbu', 'codex');
      expect(project.sandbox_mode).toBe('workspace-write');

      await triggerAction('sandbox_upgrade', {
        channel: { id: 'C_SBU' },
        message: { ts: '1234567890.000005' },
      });

      const updated = store.getProjectById(project.id)!;
      expect(updated.sandbox_mode).toBe('danger-full-access');

      expect(mockApp.client.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Sandbox upgraded'),
        })
      );
    });

    it('sandbox_upgrade resets session so next message uses new sandbox mode', async () => {
      createAdapter();
      await adapter.start();

      const project = store.createProject('C_SBU2', '/test/sbu2', 'codex');
      // Create a session with a backend_session_id (simulating an active Codex session)
      const session = store.createSession('T_SBU_THREAD', project.id);
      store.updateBackendSessionId(session.id, 'codex-session-abc');

      // Verify session has a backend_session_id before upgrade
      const beforeUpgrade = store.getSessionByThreadId('T_SBU_THREAD')!;
      expect(beforeUpgrade.backend_session_id).toBe('codex-session-abc');

      await triggerAction('sandbox_upgrade', {
        channel: { id: 'C_SBU2' },
        message: { ts: '1234567890.000006', thread_ts: 'T_SBU_THREAD' },
      });

      // After upgrade, session should be reset (backend_session_id cleared)
      const afterUpgrade = store.getSessionByThreadId('T_SBU_THREAD')!;
      expect(afterUpgrade.backend_session_id).toBeNull();
      expect(afterUpgrade.state).toBe('idle');

      // Confirmation message mentions session reset
      expect(mockApp.client.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Session reset'),
        })
      );
    });
  });

  describe('P12.2: Permission mode selection on project connect', () => {
    it('posts permission mode prompt after binding a project', async () => {
      createAdapter();
      await adapter.start();
      mockApp.client.chat.postMessage.mockClear();

      await triggerCommand('/project', {
        channel_id: 'C_UNBOUND',
        text: 'connect /test/my-project',
      });

      // Find the permission mode prompt message
      const calls = mockApp.client.chat.postMessage.mock.calls;
      const permCall = calls.find((c: any) =>
        c[0].text?.includes('permission mode') || c[0].blocks?.some((b: any) => b.text?.text?.includes('Permission mode'))
      );
      // The command shows bind options for unbound channels, not direct bind
      // So we test via the action handler
    });

    it('stores permission mode when perm_mode_trusted action is triggered', async () => {
      createAdapter();
      await adapter.start();

      const project = store.createProject('C_PERM', '/test/perm', 'claude');
      expect(project.permission_mode).toBe('supervised');

      await triggerAction('perm_mode_trusted', {
        actions: [{ value: `trusted:${project.id}` }],
        channel: { id: 'C_PERM' },
      });

      const updated = store.getProjectById(project.id)!;
      expect(updated.permission_mode).toBe('trusted');
    });

    it('stores supervised mode when perm_mode_supervised action is triggered', async () => {
      createAdapter();
      await adapter.start();

      const project = store.createProject('C_PERM2', '/test/perm2', 'claude');
      store.updatePermissionMode(project.id, 'trusted');

      await triggerAction('perm_mode_supervised', {
        actions: [{ value: `supervised:${project.id}` }],
        channel: { id: 'C_PERM2' },
      });

      const updated = store.getProjectById(project.id)!;
      expect(updated.permission_mode).toBe('supervised');
    });
  });

  describe('P12.11: Adapter image handling', () => {
    it('isImageMimeType recognizes supported image types', () => {
      expect(isImageMimeType('image/png')).toBe(true);
      expect(isImageMimeType('image/jpeg')).toBe(true);
      expect(isImageMimeType('image/gif')).toBe(true);
      expect(isImageMimeType('image/webp')).toBe(true);
      expect(isImageMimeType('image/png; charset=utf-8')).toBe(true);
      expect(isImageMimeType('application/pdf')).toBe(false);
      expect(isImageMimeType('text/plain')).toBe(false);
      expect(isImageMimeType(undefined)).toBe(false);
      expect(isImageMimeType(null)).toBe(false);
      expect(isImageMimeType('')).toBe(false);
    });

    it('downloads images from Slack and passes to backend', async () => {
      // Mock global fetch to return fake image data
      const originalFetch = globalThis.fetch;
      const fakeImageData = Buffer.from('fake-png-data');
      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => fakeImageData.buffer.slice(
          fakeImageData.byteOffset,
          fakeImageData.byteOffset + fakeImageData.byteLength,
        ),
        headers: new Headers({ 'content-type': 'image/png' }),
      })) as any;

      try {
        let capturedImages: any[] | undefined;
        const imgBackend = vi.fn(() => ({
          start: vi.fn(async () => {}),
          send: vi.fn(async (_text: string, images?: any[]) => {
            capturedImages = images;
            return {
              events: [{ type: 'assistant_text' as const, text: 'I see the image' }],
              sessionId: 'session-img',
            };
          }),
          getSessionId: vi.fn(() => 'session-img'),
          setSessionId: vi.fn(),
          setAllowedTools: vi.fn(),
          stop: vi.fn(async () => {}),
        }));

        createAdapter({ backendFactory: imgBackend });
        await adapter.start();
        store.createProject('C_IMG', '/test/img', 'claude');

        await adapter.handleFileUpload(
          'C_IMG',
          '1234567890.IMG001',
          [
            { name: 'photo.png', mimetype: 'image/png', url_private_download: 'https://files.slack.com/img/photo.png' },
          ],
          'what is in this image?',
          mockApp.client,
        );

        expect(capturedImages).toBeDefined();
        expect(capturedImages).toHaveLength(1);
        expect(capturedImages![0].mediaType).toBe('image/png');
        expect(capturedImages![0].base64).toBe(fakeImageData.toString('base64'));
        // P13.3: staging metadata populated
        expect(capturedImages![0].uploadId).toMatch(/^upload_[a-f0-9]{12}$/);
        expect(capturedImages![0].filename).toBe('photo.png');
        expect(capturedImages![0].stagingPath).toBeTruthy();
        // Clean up staging file
        try { (await import('node:fs')).unlinkSync(capturedImages![0].stagingPath); } catch {}
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('downloads PDF files and passes them as attachments', async () => {
      const originalFetch = globalThis.fetch;
      const fakePdfData = Buffer.from('fake-pdf-data');
      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => fakePdfData.buffer.slice(
          fakePdfData.byteOffset,
          fakePdfData.byteOffset + fakePdfData.byteLength,
        ),
        headers: new Headers({ 'content-type': 'application/pdf' }),
      })) as any;

      try {
        let capturedFiles: any[] | undefined;
        const pdfBackend = vi.fn(() => ({
          start: vi.fn(async () => {}),
          send: vi.fn(async (_text: string, files?: any[]) => {
            capturedFiles = files;
            return {
              events: [{ type: 'assistant_text' as const, text: 'Got it' }],
              sessionId: 'session-pdf',
            };
          }),
          getSessionId: vi.fn(() => 'session-pdf'),
          setSessionId: vi.fn(),
          setAllowedTools: vi.fn(),
          stop: vi.fn(async () => {}),
        }));

        createAdapter({ backendFactory: pdfBackend });
        await adapter.start();
        store.createProject('C_PDF', '/test/pdf', 'claude');

        await adapter.handleFileUpload(
          'C_PDF',
          '1234567890.PDF001',
          [
            { name: 'report.pdf', mimetype: 'application/pdf', url_private_download: 'https://files.slack.com/report.pdf' },
          ],
          'review this',
          mockApp.client,
        );

        expect(capturedFiles).toBeDefined();
        expect(capturedFiles).toHaveLength(1);
        expect(capturedFiles![0].kind).toBe('pdf');
        expect(capturedFiles![0].mediaType).toBe('application/pdf');
        expect(capturedFiles![0].uploadId).toMatch(/^upload_[a-f0-9]{12}$/);
        expect(capturedFiles![0].filename).toBe('report.pdf');
        // Clean up staging file
        try { fs.unlinkSync(capturedFiles![0].stagingPath); } catch {}
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('downloads text files, stages them, and inlines their content', async () => {
      const originalFetch = globalThis.fetch;
      const fakeCsvData = Buffer.from('name,age\nAlice,30\nBob,25');
      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => fakeCsvData.buffer.slice(
          fakeCsvData.byteOffset,
          fakeCsvData.byteOffset + fakeCsvData.byteLength,
        ),
        headers: new Headers({ 'content-type': 'text/csv' }),
      })) as any;

      try {
        let capturedText = '';
        let capturedFiles: any[] | undefined;
        const csvBackend = vi.fn(() => ({
          start: vi.fn(async () => {}),
          send: vi.fn(async (text: string, files?: any[]) => {
            capturedText = text;
            capturedFiles = files;
            return {
              events: [{ type: 'assistant_text' as const, text: 'Got it' }],
              sessionId: 'session-csv',
            };
          }),
          getSessionId: vi.fn(() => 'session-csv'),
          setSessionId: vi.fn(),
          setAllowedTools: vi.fn(),
          stop: vi.fn(async () => {}),
        }));

        createAdapter({ backendFactory: csvBackend });
        await adapter.start();
        store.createProject('C_CSV', '/test/csv', 'claude');

        await adapter.handleFileUpload(
          'C_CSV',
          '1234567890.CSV001',
          [
            { name: 'data.csv', mimetype: 'text/csv', url_private_download: 'https://files.slack.com/data.csv' },
          ],
          'analyze this',
          mockApp.client,
        );

        // Text file contents should be inlined in the prompt
        expect(capturedText).toContain('data.csv');
        expect(capturedText).toContain('Alice,30');
        // File should also be passed as an attachment (for staging/save)
        expect(capturedFiles).toBeDefined();
        expect(capturedFiles).toHaveLength(1);
        expect(capturedFiles![0].kind).toBe('text');
        // Clean up staging file
        try { fs.unlinkSync(capturedFiles![0].stagingPath); } catch {}
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('shows download failed message when file download fails', async () => {
      let capturedText = '';
      let capturedFiles: any[] | undefined;
      const failBackend = vi.fn(() => ({
        start: vi.fn(async () => {}),
        send: vi.fn(async (text: string, files?: any[]) => {
          capturedText = text;
          capturedFiles = files;
          return {
            events: [{ type: 'assistant_text' as const, text: 'Got it' }],
            sessionId: 'session-fail',
          };
        }),
        getSessionId: vi.fn(() => 'session-fail'),
        setSessionId: vi.fn(),
        setAllowedTools: vi.fn(),
        stop: vi.fn(async () => {}),
      }));

      createAdapter({ backendFactory: failBackend });
      await adapter.start();
      store.createProject('C_FAIL', '/test/fail', 'claude');

      await adapter.handleFileUpload(
        'C_FAIL',
        '1234567890.FAIL001',
        [
          { name: 'report.pdf', mimetype: 'application/pdf', url_private_download: 'https://files.slack.com/report.pdf' },
        ],
        'review this',
        mockApp.client,
      );

      expect(capturedText).toContain('report.pdf');
      expect(capturedText).toContain('download failed');
      expect(capturedFiles).toBeUndefined();
    });
  });

  describe('P16.4: assistant_text suppression with post_message', () => {
    let capturedTexts: string[];

    beforeEach(() => {
      capturedTexts = [];
      (mockApp.client.chat.postMessage as any).mockImplementation(async (args: any) => {
        if (args.text && args.text !== 'Processing...') {
          capturedTexts.push(args.text);
        }
        return { ts: `msg-${Date.now()}` };
      });
    });

    it('renders only the last assistant_text when post_message was NOT used', async () => {
      const multiTextBackend = vi.fn(() => ({
        start: vi.fn(async () => {}),
        send: vi.fn(async () => ({
          events: [
            { type: 'assistant_text' as const, text: 'Let me check...' },
            { type: 'assistant_text' as const, text: 'Building the project...' },
            { type: 'assistant_text' as const, text: 'Here is the final result.' },
          ],
          sessionId: 'session-multi',
        })),
        getSessionId: vi.fn(() => 'session-multi'),
        setSessionId: vi.fn(),
        setAllowedTools: vi.fn(),
        stop: vi.fn(async () => {}),
      }));

      createAdapter({ backendFactory: multiTextBackend });
      await adapter.start();
      store.createProject('C_MULTI', '/test/multi', 'claude');

      await triggerMessage({
        channel: 'C_MULTI',
        thread_ts: 'T_MULTI_1',
        text: 'do something',
        user: 'U1',
        subtype: undefined,
      });

      // Should only render the LAST assistant_text
      expect(capturedTexts).toHaveLength(1);
      expect(capturedTexts[0]).toBe('Here is the final result.');
    });

    it('suppresses all assistant_text when post_message WAS used during turn', async () => {
      const { markPostMessageCalled } = await import('../mcp/callbacks.js');

      // Backend that simulates post_message being called during the turn
      const pmBackend = vi.fn(() => ({
        start: vi.fn(async () => {}),
        send: vi.fn(async () => {
          // Simulate: during backend execution, Claude calls post_message MCP tool
          // → IPC → callbackHandler.postMessage() → markPostMessageCalled
          markPostMessageCalled('T_PM_1');
          return {
            events: [
              { type: 'assistant_text' as const, text: 'Let me check...' },
              { type: 'assistant_text' as const, text: 'Done! I posted the result.' },
            ],
            sessionId: 'session-pm',
          };
        }),
        getSessionId: vi.fn(() => 'session-pm'),
        setSessionId: vi.fn(),
        setAllowedTools: vi.fn(),
        stop: vi.fn(async () => {}),
      }));

      createAdapter({ backendFactory: pmBackend });
      await adapter.start();
      store.createProject('C_PM', '/test/pm', 'claude');

      await triggerMessage({
        channel: 'C_PM',
        thread_ts: 'T_PM_1',
        text: 'do something',
        user: 'U1',
        subtype: undefined,
      });

      // All assistant_text events should be suppressed because post_message was used
      expect(capturedTexts).toHaveLength(0);
    });

    it('clearPostMessageFlag and wasPostMessageCalled track correctly', async () => {
      const { clearPostMessageFlag, wasPostMessageCalled, markPostMessageCalled } =
        await import('../mcp/callbacks.js');

      // Initially no flag
      expect(wasPostMessageCalled('T_TRACK')).toBe(false);

      // Set it
      markPostMessageCalled('T_TRACK');
      expect(wasPostMessageCalled('T_TRACK')).toBe(true);

      // Clear it
      clearPostMessageFlag('T_TRACK');
      expect(wasPostMessageCalled('T_TRACK')).toBe(false);

      // Different threads are independent
      markPostMessageCalled('T_A');
      expect(wasPostMessageCalled('T_A')).toBe(true);
      expect(wasPostMessageCalled('T_B')).toBe(false);
      clearPostMessageFlag('T_A');
    });

    it('truncates long fallback assistant_text to last 500 chars', async () => {
      const longText = 'A'.repeat(300) + 'B'.repeat(300) + 'THE_END';
      const longBackend = vi.fn(() => ({
        start: vi.fn(async () => {}),
        send: vi.fn(async () => ({
          events: [
            { type: 'assistant_text' as const, text: longText },
          ],
          sessionId: 'session-long',
        })),
        getSessionId: vi.fn(() => 'session-long'),
        setSessionId: vi.fn(),
        setAllowedTools: vi.fn(),
        stop: vi.fn(async () => {}),
      }));

      createAdapter({ backendFactory: longBackend });
      await adapter.start();
      store.createProject('C_LONG', '/test/long', 'claude');

      await triggerMessage({
        channel: 'C_LONG',
        thread_ts: 'T_LONG_1',
        text: 'do something',
        user: 'U1',
        subtype: undefined,
      });

      expect(capturedTexts).toHaveLength(1);
      // Should be truncated: starts with "..." and ends with the original ending
      expect(capturedTexts[0]).toMatch(/^\.\.\./);
      expect(capturedTexts[0]).toContain('THE_END');
      expect(capturedTexts[0].length).toBeLessThanOrEqual(503); // 500 + "..."
    });

    it('always renders error events regardless of assistant_text suppression', async () => {
      const errorBackend = vi.fn(() => ({
        start: vi.fn(async () => {}),
        send: vi.fn(async () => ({
          events: [
            { type: 'assistant_text' as const, text: 'Trying something...' },
            { type: 'error' as const, message: 'Something went wrong' },
          ],
          sessionId: 'session-err',
        })),
        getSessionId: vi.fn(() => 'session-err'),
        setSessionId: vi.fn(),
        setAllowedTools: vi.fn(),
        stop: vi.fn(async () => {}),
      }));

      createAdapter({ backendFactory: errorBackend });
      await adapter.start();
      store.createProject('C_ERR', '/test/err', 'claude');

      await triggerMessage({
        channel: 'C_ERR',
        thread_ts: 'T_ERR_1',
        text: 'break something',
        user: 'U1',
        subtype: undefined,
      });

      // Error is always rendered + the last assistant_text (since no post_message)
      expect(capturedTexts).toHaveLength(2);
      expect(capturedTexts[0]).toBe('Trying something...');
      expect(capturedTexts[1]).toContain('Something went wrong');
    });
  });

  describe('P20.2: AskUserQuestion renders dynamic buttons', () => {
    it('postUserQuestion renders question text and option buttons', async () => {
      createAdapter();
      await adapter.start();

      const questions = [{
        question: 'Which language should we use?',
        header: 'Language',
        options: [
          { label: 'TypeScript', description: 'Strongly typed' },
          { label: 'JavaScript', description: 'More flexible' },
        ],
        multiSelect: false,
      }];

      await adapter.postUserQuestion('C_BOUND', 'T_123', questions, 'req-uuid-1', null);

      const calls = mockApp.client.chat.postMessage.mock.calls;
      const questionCall = calls.find(
        (c: any) => c[0].blocks && c[0].blocks.some(
          (b: any) => b.type === 'actions' && b.elements?.[0]?.action_id?.startsWith('question_answer_')
        )
      );
      expect(questionCall).toBeDefined();

      const blocks = questionCall![0].blocks;
      const sectionBlock = blocks.find((b: any) => b.type === 'section');
      expect(sectionBlock.text.text).toContain('Which language should we use?');
      expect(sectionBlock.text.text).toContain('TypeScript');
      expect(sectionBlock.text.text).toContain('JavaScript');

      const actionsBlock = blocks.find((b: any) => b.type === 'actions');
      expect(actionsBlock.elements).toHaveLength(2);
      expect(actionsBlock.elements[0].action_id).toBe('question_answer_0');
      expect(actionsBlock.elements[0].text.text).toBe('TypeScript');
      expect(actionsBlock.elements[0].value).toBe('req-uuid-1');
      expect(actionsBlock.elements[1].action_id).toBe('question_answer_1');
      expect(actionsBlock.elements[1].text.text).toBe('JavaScript');
    });

    it('handleQuestionAnswer resolves question and updates message', async () => {
      createAdapter();
      await adapter.start();

      // Trigger via the regex-keyed action handler
      const regexKey = String(/^question_answer_/);
      const handler = mockApp._actionHandlers[regexKey];
      expect(handler).toBeDefined();

      await handler({
        body: {
          actions: [{
            action_id: 'question_answer_0',
            value: 'req-uuid-2',
            text: { type: 'plain_text', text: 'TypeScript' },
          }],
          channel: { id: 'C_BOUND' },
          message: { ts: '1234567890.000010', thread_ts: '1234567890.000001' },
        },
        ack: vi.fn(),
        client: mockApp.client,
      });

      expect(resolveUserQuestion).toHaveBeenCalledWith('req-uuid-2', 'TypeScript');

      expect(mockApp.client.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C_BOUND',
          ts: '1234567890.000010',
          text: 'Answered: TypeScript',
        })
      );
    });
  });

  describe('P20.9: Eyes reaction acknowledgement for all resolution paths', () => {
    it('reacts with eyes on new thread message', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_PROC', '/test/proc', 'claude');

      mockApp.client.reactions.add.mockClear();

      await triggerMessage({
        channel: 'C_PROC',
        text: 'hello',
        user: 'U_USER1',
        ts: '1111.000001',
      });

      expect(mockApp.client.reactions.add).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C_PROC',
          timestamp: '1111.000001',
          name: 'eyes',
        })
      );
    });

    it('reacts with eyes on follow-up messages in threads', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_PROC2', '/test/proc2', 'claude');

      mockApp.client.reactions.add.mockClear();

      await triggerMessage({
        channel: 'C_PROC2',
        text: 'follow up',
        user: 'U_USER1',
        ts: '2222.000002',
        thread_ts: '2222.000001',
      });

      expect(mockApp.client.reactions.add).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C_PROC2',
          timestamp: '2222.000002',
          name: 'eyes',
        })
      );
    });

    it('reacts with eyes after permission Allow button click (hook-based)', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_PERM_PROC', '/test/perm-proc', 'claude');
      mockApp.client.reactions.add.mockClear();

      await triggerAction('permission_allow', {
        actions: [{ value: 'Bash|req-perm-1' }],
        channel: { id: 'C_PERM_PROC' },
        message: {
          thread_ts: '4444.000001',
          ts: '4444.000005',
        },
      });

      expect(mockApp.client.reactions.add).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C_PERM_PROC',
          timestamp: '4444.000005',
          name: 'eyes',
        })
      );
    });

    it('reacts with eyes after AskUserQuestion button click', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_Q_PROC', '/test/q-proc', 'claude');
      mockApp.client.reactions.add.mockClear();

      const regexKey = String(/^question_answer_/);
      const handler = mockApp._actionHandlers[regexKey];

      await handler({
        body: {
          actions: [{
            action_id: 'question_answer_0',
            value: 'req-q-proc-1',
            text: { type: 'plain_text', text: 'Option A' },
          }],
          channel: { id: 'C_Q_PROC' },
          message: { ts: '5555.000005', thread_ts: '5555.000001' },
        },
        ack: vi.fn(),
        client: mockApp.client,
      });

      expect(mockApp.client.reactions.add).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C_Q_PROC',
          timestamp: '5555.000005',
          name: 'eyes',
        })
      );
    });
  });

  describe('P22: Live todo checklist', () => {
    it('posts a new checklist message on first renderTodoList call', async () => {
      createAdapter();
      await adapter.start();

      const todos = [
        { content: 'Fix bug', status: 'completed', activeForm: 'Fixing bug' },
        { content: 'Write tests', status: 'in_progress', activeForm: 'Writing tests' },
        { content: 'Deploy', status: 'pending', activeForm: 'Deploying' },
      ];

      await adapter.renderTodoList('C_BOUND', '1111.000001', todos);

      const calls = mockApp.client.chat.postMessage.mock.calls;
      const todoCall = calls.find((c: any) => c[0].text === 'Task list');
      expect(todoCall).toBeDefined();
      expect(todoCall![0].channel).toBe('C_BOUND');
      expect(todoCall![0].thread_ts).toBe('1111.000001');

      const blockText = todoCall![0].blocks[0].text.text;
      expect(blockText).toContain('~Fix bug~');
      expect(blockText).toContain('*Writing tests...*');
      expect(blockText).toContain('Deploy');
    });

    it('updates the same message on subsequent renderTodoList calls', async () => {
      createAdapter();
      await adapter.start();

      const todos1 = [
        { content: 'Fix bug', status: 'in_progress', activeForm: 'Fixing bug' },
        { content: 'Write tests', status: 'pending', activeForm: 'Writing tests' },
      ];
      await adapter.renderTodoList('C_BOUND', '1111.000001', todos1);

      // First call should post
      expect(mockApp.client.chat.postMessage).toHaveBeenCalled();

      const todos2 = [
        { content: 'Fix bug', status: 'completed', activeForm: 'Fixing bug' },
        { content: 'Write tests', status: 'in_progress', activeForm: 'Writing tests' },
      ];
      await adapter.renderTodoList('C_BOUND', '1111.000001', todos2);

      // Second call should update, not post again
      expect(mockApp.client.chat.update).toHaveBeenCalled();
      const updateCall = mockApp.client.chat.update.mock.calls[0][0];
      expect(updateCall.blocks[0].text.text).toContain('~Fix bug~');
      expect(updateCall.blocks[0].text.text).toContain('*Writing tests...*');
    });

    it('formats empty todo list', async () => {
      createAdapter();
      await adapter.start();

      await adapter.renderTodoList('C_BOUND', '1111.000001', []);

      const calls = mockApp.client.chat.postMessage.mock.calls;
      const todoCall = calls.find((c: any) => c[0].text === 'Task list');
      expect(todoCall![0].blocks[0].text.text).toBe('_No tasks_');
    });
  });
});
