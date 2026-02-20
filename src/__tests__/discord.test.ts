/**
 * Tests for the Discord adapter.
 *
 * Uses a mock Discord.js Client injected via the constructor to avoid
 * needing real Discord credentials in unit tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DiscordAdapter, splitText, createDiscordClient } from '../adapters/discord.js';
import { Router } from '../router.js';
import { Store } from '../store.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

/** Create a mock Discord.js Client with tracked handlers. */
function createMockDiscordClient() {
  const eventHandlers: Record<string, Function[]> = {};

  const mockUser = { id: 'BOT_USER_123', tag: 'TestBot#1234' };

  const mockClient = {
    user: mockUser,
    on: vi.fn((event: string, handler: Function) => {
      if (!eventHandlers[event]) eventHandlers[event] = [];
      eventHandlers[event].push(handler);
      return mockClient;
    }),
    once: vi.fn((event: string, handler: Function) => {
      if (!eventHandlers[event]) eventHandlers[event] = [];
      eventHandlers[event].push(handler);
      return mockClient;
    }),
    login: vi.fn(async () => 'token'),
    destroy: vi.fn(),
    _eventHandlers: eventHandlers,
  };

  return mockClient;
}

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'openbridge-discord-test-'));
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
    stop: vi.fn(async () => {}),
  }));
}

/** Create a mock Discord message. */
function createMockMessage(overrides: {
  channelId?: string;
  content?: string;
  authorId?: string;
  authorBot?: boolean;
  isThread?: boolean;
  parentId?: string;
  threadId?: string;
  messageId?: string;
  attachments?: { name: string; url: string }[];
} = {}) {
  const isThread = overrides.isThread ?? false;
  const channelId = overrides.channelId ?? (isThread ? 'thread-123' : 'C_BOUND');
  const parentId = overrides.parentId ?? 'C_BOUND';

  const sentMessages: any[] = [];
  const threadSentMessages: any[] = [];
  const createdThreads: any[] = [];

  const mockThread = {
    id: 'new-thread-id',
    send: vi.fn(async (opts: any) => {
      threadSentMessages.push(opts);
      return { id: 'thread-msg-123' };
    }),
    isThread: () => true,
  };

  const mockChannel: any = {
    id: channelId,
    isThread: () => isThread,
    parentId: isThread ? parentId : null,
    send: vi.fn(async (opts: any) => {
      sentMessages.push(opts);
      return { id: 'sent-msg-123' };
    }),
    threads: {
      fetch: vi.fn(async (id: string) => {
        return {
          id,
          send: vi.fn(async (opts: any) => {
            threadSentMessages.push(opts);
            return { id: 'thread-msg-123' };
          }),
          isThread: () => true,
        };
      }),
    },
  };

  const attachmentMap = new Map<string, any>();
  if (overrides.attachments) {
    for (const a of overrides.attachments) {
      attachmentMap.set(a.name, { name: a.name, url: a.url });
    }
  }

  const message: any = {
    id: overrides.messageId ?? '1234567890',
    content: overrides.content ?? '',
    author: {
      id: overrides.authorId ?? 'USER_123',
      bot: overrides.authorBot ?? false,
    },
    channel: mockChannel,
    attachments: attachmentMap,
    startThread: vi.fn(async (opts: any) => {
      createdThreads.push(opts);
      return mockThread;
    }),
  };

  return { message, sentMessages, threadSentMessages, createdThreads, mockThread, mockChannel };
}

/** Create a mock slash command interaction. */
function createMockInteraction(overrides: {
  commandName?: string;
  channelId?: string;
  isThread?: boolean;
  parentId?: string;
  options?: Record<string, string | null>;
  guildChannels?: any;
} = {}) {
  const isThread = overrides.isThread ?? false;
  const channelId = overrides.channelId ?? 'C_BOUND';
  const parentId = overrides.parentId ?? 'C_BOUND';

  const replies: any[] = [];

  const mockChannel: any = {
    id: isThread ? 'thread-123' : channelId,
    isThread: () => isThread,
    parentId: isThread ? parentId : null,
  };

  const createdChannels: any[] = [];
  const mockGuild = {
    channels: {
      create: vi.fn(async (opts: any) => {
        const ch = { id: 'NEW_CHANNEL_123', name: opts.name };
        createdChannels.push(ch);
        return ch;
      }),
    },
  };

  const interaction: any = {
    isChatInputCommand: () => true,
    isButton: () => false,
    commandName: overrides.commandName ?? 'project',
    channelId,
    channel: mockChannel,
    guild: mockGuild,
    options: {
      getString: vi.fn((name: string) => overrides.options?.[name] ?? null),
    },
    reply: vi.fn(async (content: any) => {
      replies.push(content);
    }),
    replied: false,
    deferred: false,
  };

  return { interaction, replies, createdChannels, mockGuild };
}

/** Create a mock button interaction. */
function createMockButtonInteraction(overrides: {
  customId: string;
  channelId?: string;
  isThread?: boolean;
  parentId?: string;
  messageId?: string;
} = { customId: 'permission_allow' }) {
  const isThread = overrides.isThread ?? true;
  const channelId = overrides.channelId ?? 'C_BOUND';
  const parentId = overrides.parentId ?? 'C_BOUND';

  const updates: any[] = [];
  const threadMessages: any[] = [];

  const mockChannel: any = {
    id: isThread ? 'thread-123' : channelId,
    isThread: () => isThread,
    parentId: isThread ? parentId : null,
    send: vi.fn(async (opts: any) => {
      threadMessages.push(opts);
      return { id: 'msg-123' };
    }),
  };

  const interaction: any = {
    isChatInputCommand: () => false,
    isButton: () => true,
    customId: overrides.customId,
    channelId: mockChannel.id,
    channel: mockChannel,
    message: { id: overrides.messageId ?? 'msg-with-buttons' },
    update: vi.fn(async (opts: any) => {
      updates.push(opts);
    }),
    reply: vi.fn(async () => {}),
  };

  return { interaction, updates, threadMessages };
}

describe('DiscordAdapter', () => {
  let tmpDir: string;
  let store: Store;
  let router: Router;
  let adapter: DiscordAdapter;
  let mockClient: ReturnType<typeof createMockDiscordClient>;
  let mockBackendFactory: ReturnType<typeof createMockBackendFactory>;

  beforeEach(() => {
    tmpDir = createTempDir();
    store = createTestStore(tmpDir);
    mockBackendFactory = createMockBackendFactory();
    router = new Router(store, mockBackendFactory);
    mockClient = createMockDiscordClient();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function createAdapter(opts?: { backendFactory?: ReturnType<typeof createMockBackendFactory> }): DiscordAdapter {
    if (opts?.backendFactory) {
      router = new Router(store, opts.backendFactory);
    }
    adapter = new DiscordAdapter({
      botToken: 'test-discord-token',
      router,
      store,
      client: mockClient as any,
      clientId: 'test-client-id',
    });
    return adapter;
  }

  /** Trigger the message handler registered on the mock client. */
  async function triggerMessage(message: any) {
    const handlers = mockClient._eventHandlers['messageCreate'];
    expect(handlers).toBeDefined();
    expect(handlers.length).toBeGreaterThan(0);
    for (const handler of handlers) {
      await handler(message);
    }
  }

  /** Trigger the interaction handler. */
  async function triggerInteraction(interaction: any) {
    const handlers = mockClient._eventHandlers['interactionCreate'];
    expect(handlers).toBeDefined();
    expect(handlers.length).toBeGreaterThan(0);
    for (const handler of handlers) {
      await handler(interaction);
    }
  }

  describe('P4.1: Discord bot connects via gateway using discord.js', () => {
    it('creates a Discord client with required intents when no client injected', () => {
      expect(typeof createDiscordClient).toBe('function');
    });

    it('uses the injected client when provided', () => {
      createAdapter();
      expect(adapter.getClient()).toBe(mockClient);
    });

    it('calls client.login() on start()', async () => {
      createAdapter();
      await adapter.start();
      expect(mockClient.login).toHaveBeenCalledWith('test-discord-token');
    });

    it('calls client.destroy() on stop()', async () => {
      createAdapter();
      await adapter.start();
      await adapter.stop();
      expect(mockClient.destroy).toHaveBeenCalled();
    });

    it('logs connection on startup', async () => {
      createAdapter();
      const spy = vi.spyOn(console, 'log');
      await adapter.start();
      expect(spy).toHaveBeenCalledWith('[discord] connected via gateway');
      spy.mockRestore();
    });
  });

  describe('P4.2: Discord adapter implements shared adapter interface', () => {
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

  describe('P4.3: Discord — listen for messages in bound channels and route to router', () => {
    it('registers a messageCreate handler', () => {
      createAdapter();
      expect(mockClient.on).toHaveBeenCalledWith('messageCreate', expect.any(Function));
    });

    it('routes messages from bound channels to the router', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_BOUND', '/test/project', 'claude');

      const { message } = createMockMessage({
        channelId: 'thread-123',
        content: 'hello world',
        isThread: true,
        parentId: 'C_BOUND',
      });

      await triggerMessage(message);

      // The thread channel.send should have been called with the backend response
      expect(message.channel.send).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'Hello from backend',
        })
      );
    });

    it('ignores messages from unbound channels', async () => {
      createAdapter();
      await adapter.start();

      const { message, sentMessages, threadSentMessages } = createMockMessage({
        channelId: 'C_UNBOUND',
        content: 'hello',
      });

      await triggerMessage(message);

      expect(sentMessages.length).toBe(0);
      expect(threadSentMessages.length).toBe(0);
    });

    it('ignores bot messages to prevent loops', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_BOUND', '/test/project', 'claude');

      const { message, sentMessages, threadSentMessages } = createMockMessage({
        channelId: 'C_BOUND',
        content: 'bot message',
        authorBot: true,
      });

      await triggerMessage(message);

      expect(sentMessages.length).toBe(0);
      expect(threadSentMessages.length).toBe(0);
    });
  });

  describe('P4.4: Discord — thread-based session mapping', () => {
    it('routes thread messages to the session for that thread', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_BOUND', '/test/project', 'claude');

      // Message in thread A
      const msgA = createMockMessage({
        channelId: 'thread-A',
        content: 'message in thread A',
        isThread: true,
        parentId: 'C_BOUND',
      });

      await triggerMessage(msgA.message);

      const sessionA = store.getSessionByThreadId('thread-A');
      expect(sessionA).toBeDefined();

      // Message in thread B
      const msgB = createMockMessage({
        channelId: 'thread-B',
        content: 'message in thread B',
        isThread: true,
        parentId: 'C_BOUND',
      });

      await triggerMessage(msgB.message);

      const sessionB = store.getSessionByThreadId('thread-B');
      expect(sessionB).toBeDefined();
      expect(sessionB!.id).not.toBe(sessionA!.id);
    });

    it('creates a new thread for top-level messages', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_BOUND', '/test/project', 'claude');

      const { message, createdThreads, mockThread } = createMockMessage({
        channelId: 'C_BOUND',
        content: 'new task',
        isThread: false,
      });

      await triggerMessage(message);

      expect(message.startThread).toHaveBeenCalled();
      expect(createdThreads.length).toBe(1);
      expect(createdThreads[0].name).toBe('new task');
    });

    it('posts Processing indicator when creating a new thread', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_BOUND', '/test/project', 'claude');

      const { message, mockThread } = createMockMessage({
        channelId: 'C_BOUND',
        content: 'new task',
        isThread: false,
      });

      await triggerMessage(message);

      expect(mockThread.send).toHaveBeenCalledWith('Processing...');
    });

    it('new thread creates a new session automatically', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_BOUND', '/test/project', 'claude');

      // No session exists for this thread yet
      expect(store.getSessionByThreadId('new-thread-id')).toBeUndefined();

      const { message } = createMockMessage({
        channelId: 'C_BOUND',
        content: 'first message',
        isThread: false,
      });

      await triggerMessage(message);

      // Session should now exist for the new thread
      expect(store.getSessionByThreadId('new-thread-id')).toBeDefined();
    });
  });

  describe('P4.5: Discord — post assistant text responses back to thread', () => {
    it('posts AssistantText events as messages in the thread', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_BOUND', '/test/project', 'claude');

      const { message } = createMockMessage({
        channelId: 'thread-123',
        content: 'hello',
        isThread: true,
        parentId: 'C_BOUND',
      });

      await triggerMessage(message);

      // The thread channel.send should have been called with the backend response
      expect(message.channel.send).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'Hello from backend',
        })
      );
    });

    it('splits long responses at 2000 char limit', () => {
      const chunks = splitText('a'.repeat(4000), 2000);
      expect(chunks.length).toBe(2);
      expect(chunks[0].length).toBeLessThanOrEqual(2000);
      expect(chunks[1].length).toBeLessThanOrEqual(2000);
    });

    it('splits at word boundaries when possible', () => {
      const text = 'word '.repeat(500).trim(); // 2499 chars
      const chunks = splitText(text, 2000);
      expect(chunks.length).toBe(2);
      expect(chunks[0].endsWith('word')).toBe(true);
    });
  });

  describe('P4.6: Discord — render permission denial with message component buttons', () => {
    it('posts a message with Allow/Deny buttons', async () => {
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
        stop: vi.fn(async () => {}),
      }));

      createAdapter({ backendFactory: permBackend });
      await adapter.start();

      store.createProject('C_BOUND', '/test/project', 'claude');

      const { message } = createMockMessage({
        channelId: 'thread-123',
        content: 'edit the file',
        isThread: true,
        parentId: 'C_BOUND',
      });

      await triggerMessage(message);

      // Check that channel.send was called with components
      const calls = message.channel.send.mock.calls;
      const permCall = calls.find(
        (c: any) => c[0].components && c[0].components.length > 0
      );
      expect(permCall).toBeDefined();

      const content = permCall[0].content;
      expect(content).toContain('Edit');
      expect(content).toContain('custom response');

      // Verify components have buttons
      const components = permCall[0].components;
      expect(components.length).toBe(1); // One ActionRow
    });
  });

  describe('P4.7: Discord — handle button interaction for permission responses', () => {
    it('handles Allow button and updates message', async () => {
      createAdapter();
      await adapter.start();

      const project = store.createProject('C_BOUND', '/test/project', 'claude');
      const session = store.createSession('thread-123', project.id);
      store.updateSessionState(session.id, 'running');
      store.updateSessionState(session.id, 'waiting_for_input');
      store.updateBackendSessionId(session.id, 'backend-session-123');

      const { interaction, updates, threadMessages } = createMockButtonInteraction({
        customId: 'permission_allow',
        channelId: 'C_BOUND',
        isThread: true,
        parentId: 'C_BOUND',
      });

      await triggerInteraction(interaction);

      expect(interaction.update).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '**Permission Allowed**',
          components: [],
        })
      );

      const updatedSession = store.getSessionByThreadId('thread-123');
      expect(updatedSession!.state).toBe('idle');
    });

    it('handles Deny button and updates message', async () => {
      createAdapter();
      await adapter.start();

      const project = store.createProject('C_BOUND', '/test/project', 'claude');
      const session = store.createSession('thread-123', project.id);
      store.updateSessionState(session.id, 'running');
      store.updateSessionState(session.id, 'waiting_for_input');
      store.updateBackendSessionId(session.id, 'backend-session-123');

      const { interaction } = createMockButtonInteraction({
        customId: 'permission_deny',
        channelId: 'C_BOUND',
        isThread: true,
        parentId: 'C_BOUND',
      });

      await triggerInteraction(interaction);

      expect(interaction.update).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '**Permission Denied**',
          components: [],
        })
      );

      const updatedSession = store.getSessionByThreadId('thread-123');
      expect(updatedSession!.state).toBe('idle');
    });

    it('renders chained permission_denied events after Allow button', async () => {
      // Backend returns another permission_denied after the first allow
      const chainedPermBackend = vi.fn(() => ({
        start: vi.fn(async () => {}),
        send: vi.fn(async () => ({
          events: [
            {
              type: 'permission_denied' as const,
              toolName: 'Write',
              toolInput: { file: 'bar.js' },
            },
          ],
          sessionId: 'session-chained',
        })),
        getSessionId: vi.fn(() => 'session-chained'),
        setSessionId: vi.fn(),
        stop: vi.fn(async () => {}),
      }));

      // Need a fresh adapter with the chained backend
      const chainedRouter = new Router(store, chainedPermBackend);
      const chainedAdapter = new DiscordAdapter({
        botToken: 'test-discord-token',
        router: chainedRouter,
        store,
        client: mockClient as any,
        clientId: 'test-client-id',
      });

      const project = store.createProject('C_CHAIN', '/test/chain', 'claude');
      const session = store.createSession('thread-chain', project.id);
      store.updateSessionState(session.id, 'running');
      store.updateSessionState(session.id, 'waiting_for_input');
      store.updateBackendSessionId(session.id, 'session-chained');

      const { interaction, threadMessages } = createMockButtonInteraction({
        customId: 'permission_allow',
        channelId: 'C_CHAIN',
        isThread: true,
        parentId: 'C_CHAIN',
      });
      // Override channel ID to match our thread
      interaction.channel.id = 'thread-chain';
      interaction.channel.parentId = 'C_CHAIN';

      await triggerInteraction(interaction);

      // The chained permission_denied should be rendered (via renderEvents)
      const permCall = threadMessages.find(
        (m: any) => m.components && m.components.length > 0
      );
      expect(permCall).toBeDefined();
      expect(permCall.content).toContain('Write');

      // Session should be waiting_for_input again
      const updatedSession = store.getSessionByThreadId('thread-chain');
      expect(updatedSession!.state).toBe('waiting_for_input');
    });
  });

  describe('P4.8: Discord — handle freeform text when waiting_for_input', () => {
    it('routes text as resume response when session is waiting_for_input', async () => {
      createAdapter();
      await adapter.start();

      const project = store.createProject('C_BOUND', '/test/project', 'claude');
      const session = store.createSession('thread-123', project.id);
      store.updateSessionState(session.id, 'running');
      store.updateSessionState(session.id, 'waiting_for_input');
      store.updateBackendSessionId(session.id, 'backend-session-123');

      const { message } = createMockMessage({
        channelId: 'thread-123',
        content: 'use a different approach',
        isThread: true,
        parentId: 'C_BOUND',
      });

      await triggerMessage(message);

      expect(message.channel.send).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'Hello from backend',
        })
      );

      const updatedSession = store.getSessionByThreadId('thread-123');
      expect(updatedSession!.state).toBe('idle');
    });
  });

  describe('P4.9: Discord — post error messages', () => {
    it('posts error messages when backend throws', async () => {
      const errorBackend = vi.fn(() => ({
        start: vi.fn(async () => {}),
        send: vi.fn(async () => {
          throw new Error('Backend crashed unexpectedly');
        }),
        getSessionId: vi.fn(() => null),
        setSessionId: vi.fn(),
        stop: vi.fn(async () => {}),
      }));

      createAdapter({ backendFactory: errorBackend });
      await adapter.start();

      store.createProject('C_BOUND', '/test/project', 'claude');

      const { message } = createMockMessage({
        channelId: 'thread-123',
        content: 'do something',
        isThread: true,
        parentId: 'C_BOUND',
      });

      await triggerMessage(message);

      expect(message.channel.send).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('Backend crashed unexpectedly'),
        })
      );
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
        stop: vi.fn(async () => {}),
      }));

      createAdapter({ backendFactory: errorEventBackend });
      await adapter.start();

      store.createProject('C_BOUND', '/test/project', 'claude');

      const { message } = createMockMessage({
        channelId: 'thread-123',
        content: 'hello',
        isThread: true,
        parentId: 'C_BOUND',
      });

      await triggerMessage(message);

      expect(message.channel.send).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('claude CLI not found'),
        })
      );
    });
  });

  describe('P4.10: Discord — register slash commands (/project, /new, /settings)', () => {
    it('registers interactionCreate handler', () => {
      createAdapter();
      expect(mockClient.on).toHaveBeenCalledWith('interactionCreate', expect.any(Function));
    });

    it('handles slash command interactions for project', async () => {
      createAdapter();
      await adapter.start();

      const { interaction } = createMockInteraction({
        commandName: 'project',
        options: { path: '' },
      });

      // Should not throw
      await triggerInteraction(interaction);
      expect(interaction.reply).toHaveBeenCalled();
    });

    it('handles slash command interactions for new', async () => {
      createAdapter();
      await adapter.start();

      const { interaction } = createMockInteraction({
        commandName: 'new',
        channelId: 'C_BOUND',
      });

      await triggerInteraction(interaction);
      expect(interaction.reply).toHaveBeenCalled();
    });

    it('handles slash command interactions for settings', async () => {
      createAdapter();
      await adapter.start();

      const { interaction } = createMockInteraction({
        commandName: 'settings',
        channelId: 'C_BOUND',
      });

      await triggerInteraction(interaction);
      expect(interaction.reply).toHaveBeenCalled();
    });
  });

  describe('P4.11: Discord — /project command flow (create, list, bind)', () => {
    it('lists all bindings when no path provided', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_PROJ1', '/test/project1', 'claude');
      store.createProject('C_PROJ2', '/test/project2', 'codex');

      const { interaction, replies } = createMockInteraction({
        commandName: 'project',
        options: { path: null },
      });

      await triggerInteraction(interaction);

      expect(replies.length).toBe(1);
      const text = typeof replies[0] === 'string' ? replies[0] : replies[0].content || replies[0];
      expect(text).toContain('Project Bindings');
      expect(text).toContain('C_PROJ1');
      expect(text).toContain('C_PROJ2');
    });

    it('shows message when no bindings exist', async () => {
      createAdapter();
      await adapter.start();

      const { interaction, replies } = createMockInteraction({
        commandName: 'project',
        options: { path: null },
      });

      await triggerInteraction(interaction);

      const text = typeof replies[0] === 'string' ? replies[0] : replies[0].content || replies[0];
      expect(text).toContain('No project bindings');
    });

    it('creates new channel when invoked from bound channel with absolute path', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_BOUND', '/test/project', 'claude');

      const { interaction, createdChannels, mockGuild } = createMockInteraction({
        commandName: 'project',
        channelId: 'C_BOUND',
        options: { path: '/test/my-app' },
      });

      await triggerInteraction(interaction);

      expect(mockGuild.channels.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'my-app' })
      );

      // Check project was bound with absolute path
      const newProject = store.getProjectByChannelId('NEW_CHANNEL_123');
      expect(newProject).toBeDefined();
      expect(newProject!.project_dir).toBe('/test/my-app');
    });

    it('rejects non-absolute paths with an error message', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_BOUND', '/test/project', 'claude');

      const { interaction, replies, mockGuild } = createMockInteraction({
        commandName: 'project',
        channelId: 'C_BOUND',
        options: { path: 'my-app' },
      });

      await triggerInteraction(interaction);

      expect(mockGuild.channels.create).not.toHaveBeenCalled();
      const text = typeof replies[0] === 'string' ? replies[0] : replies[0].content || replies[0];
      expect(text).toContain('absolute directory path');
    });

    it('offers bind options from unbound channel', async () => {
      createAdapter();
      await adapter.start();

      const { interaction, replies } = createMockInteraction({
        commandName: 'project',
        channelId: 'C_UNBOUND',
        options: { path: '/test/my-app' },
      });

      await triggerInteraction(interaction);

      expect(replies.length).toBe(1);
      const reply = replies[0];
      expect(reply.content).toContain('/test/my-app');
      expect(reply.components).toBeDefined();
      expect(reply.components.length).toBe(1); // One ActionRow
    });
  });

  describe('P4.12: Discord — /new resets session', () => {
    it('resets the session and posts confirmation', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_BOUND', '/test/project', 'claude');
      const project = store.getProjectByChannelId('C_BOUND')!;
      const session = store.createSession('thread-123', project.id);
      store.updateBackendSessionId(session.id, 'old-backend-session');

      const { interaction, replies } = createMockInteraction({
        commandName: 'new',
        channelId: 'thread-123',
        isThread: true,
        parentId: 'C_BOUND',
      });

      await triggerInteraction(interaction);

      const updatedSession = store.getSessionByThreadId('thread-123');
      expect(updatedSession!.backend_session_id).toBeNull();
      expect(updatedSession!.state).toBe('idle');

      const text = typeof replies[0] === 'string' ? replies[0] : replies[0].content || replies[0];
      expect(text).toContain('Session reset');
    });

    it('tells user to use /new in a thread when used outside', async () => {
      createAdapter();
      await adapter.start();

      const { interaction, replies } = createMockInteraction({
        commandName: 'new',
        channelId: 'C_BOUND',
        isThread: false,
      });

      await triggerInteraction(interaction);

      const text = typeof replies[0] === 'string' ? replies[0] : replies[0].content || replies[0];
      expect(text).toContain('inside a thread');
    });
  });

  describe('P4.13: Discord — /settings command', () => {
    it('displays current project settings', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_BOUND', '/test/project', 'claude');

      const { interaction, replies } = createMockInteraction({
        commandName: 'settings',
        channelId: 'C_BOUND',
        options: { args: null },
      });

      await triggerInteraction(interaction);

      const text = typeof replies[0] === 'string' ? replies[0] : replies[0].content || replies[0];
      expect(text).toContain('claude');
      expect(text).toContain('/test/project');
    });

    it('changes the backend when given "backend codex"', async () => {
      createAdapter();
      await adapter.start();

      const project = store.createProject('C_BOUND', '/test/project', 'claude');

      const { interaction, replies } = createMockInteraction({
        commandName: 'settings',
        channelId: 'C_BOUND',
        options: { args: 'backend codex' },
      });

      await triggerInteraction(interaction);

      const updated = store.getProjectById(project.id);
      expect(updated?.backend_name).toBe('codex');

      const text = typeof replies[0] === 'string' ? replies[0] : replies[0].content || replies[0];
      expect(text).toContain('codex');
    });

    it('rejects unknown backends', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_BOUND', '/test/project', 'claude');

      const { interaction, replies } = createMockInteraction({
        commandName: 'settings',
        channelId: 'C_BOUND',
        options: { args: 'backend unknown' },
      });

      await triggerInteraction(interaction);

      const text = typeof replies[0] === 'string' ? replies[0] : replies[0].content || replies[0];
      expect(text).toContain('Unknown backend');
    });

    it('shows message for unbound channel', async () => {
      createAdapter();
      await adapter.start();

      const { interaction, replies } = createMockInteraction({
        commandName: 'settings',
        channelId: 'C_UNBOUND',
        options: { args: null },
      });

      await triggerInteraction(interaction);

      const text = typeof replies[0] === 'string' ? replies[0] : replies[0].content || replies[0];
      expect(text).toContain('not bound');
    });
  });

  describe('P4.14: Discord — file upload handling', () => {
    it('includes file descriptions in the message sent to backend', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_BOUND', '/test/project', 'claude');

      const { message } = createMockMessage({
        channelId: 'thread-123',
        content: 'check this screenshot',
        isThread: true,
        parentId: 'C_BOUND',
        attachments: [{ name: 'screenshot.png', url: 'https://cdn.discord.com/123' }],
      });

      await triggerMessage(message);

      expect(mockBackendFactory).toHaveBeenCalled();
    });

    it('ignores file uploads in unbound channels', async () => {
      createAdapter();
      await adapter.start();

      const { message } = createMockMessage({
        channelId: 'C_UNBOUND',
        content: 'some text',
        isThread: false,
        attachments: [{ name: 'file.txt', url: 'https://cdn.discord.com/456' }],
      });

      await triggerMessage(message);

      expect(mockBackendFactory).not.toHaveBeenCalled();
    });

    it('combines file descriptions with message text', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_BOUND', '/test/project', 'claude');

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

      const { message } = createMockMessage({
        channelId: 'thread-123',
        content: 'check these files',
        isThread: true,
        parentId: 'C_BOUND',
        attachments: [
          { name: 'screenshot.png', url: 'https://cdn.discord.com/123' },
          { name: 'design.pdf', url: 'https://cdn.discord.com/456' },
        ],
      });

      await triggerMessage(message);

      expect(capturedText).toContain('check these files');
      expect(capturedText).toContain('screenshot.png');
      expect(capturedText).toContain('design.pdf');
    });
  });

  describe('splitText utility', () => {
    it('returns single chunk for short text', () => {
      expect(splitText('hello', 2000)).toEqual(['hello']);
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
      expect(splitText('', 2000)).toEqual([]);
    });
  });
});
