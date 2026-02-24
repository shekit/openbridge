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
import { resolveUserQuestion } from '../mcp/ipc-server.js';

vi.mock('../mcp/ipc-server.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    resolvePermission: vi.fn(() => true),
    resolveUserQuestion: vi.fn(() => true),
  };
});

/** Create a mock Discord.js Client with tracked handlers. */
function createMockDiscordClient() {
  const eventHandlers: Record<string, Function[]> = {};

  const mockUser = { id: 'BOT_USER_123', tag: 'TestBot#1234', setPresence: vi.fn() };

  const mockSendableChannel = {
    send: vi.fn(async () => ({ id: 'msg_123', delete: vi.fn(async () => {}), edit: vi.fn(async () => {}) })),
    isThread: () => true,
  };

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
    channels: {
      fetch: vi.fn(async () => mockSendableChannel),
    },
    _eventHandlers: eventHandlers,
    _mockSendableChannel: mockSendableChannel,
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
    setAllowedTools: vi.fn(),
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
  attachments?: { name: string; url: string; contentType?: string }[];
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
      return { id: 'thread-msg-123', delete: vi.fn(async () => {}) };
    }),
    isThread: () => true,
  };

  const mockChannel: any = {
    id: channelId,
    isThread: () => isThread,
    parentId: isThread ? parentId : null,
    send: vi.fn(async (opts: any) => {
      sentMessages.push(opts);
      return { id: 'sent-msg-123', delete: vi.fn(async () => {}) };
    }),
    threads: {
      fetch: vi.fn(async (id: string) => {
        return {
          id,
          send: vi.fn(async (opts: any) => {
            threadSentMessages.push(opts);
            return { id: 'thread-msg-123', delete: vi.fn(async () => {}) };
          }),
          isThread: () => true,
        };
      }),
    },
  };

  const attachmentMap = new Map<string, any>();
  if (overrides.attachments) {
    for (const a of overrides.attachments) {
      attachmentMap.set(a.name, { name: a.name, url: a.url, contentType: a.contentType ?? null });
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
    react: vi.fn(async () => {}),
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
  intOptions?: Record<string, number | null>;
  subcommand?: string;
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
      getInteger: vi.fn((name: string) => overrides.intOptions?.[name] ?? null),
      getSubcommand: vi.fn(() => overrides.subcommand ?? null),
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
} = { customId: 'permission_allow:Edit' }) {
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
      return { id: 'msg-123', delete: vi.fn(async () => {}) };
    }),
  };

  const interaction: any = {
    isChatInputCommand: () => false,
    isButton: () => true,
    customId: overrides.customId,
    channelId: mockChannel.id,
    channel: mockChannel,
    message: { id: overrides.messageId ?? 'msg-with-buttons', content: '', react: vi.fn(async () => {}) },
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

    it('registers a ClientReady handler that sets presence', () => {
      createAdapter();
      // The adapter registers a 'clientReady' handler in registerHandlers()
      const readyHandlers = mockClient._eventHandlers['clientReady'];
      expect(readyHandlers).toBeDefined();
      expect(readyHandlers.length).toBeGreaterThan(0);

      // Trigger the ready handler with a mock readyClient
      readyHandlers[0]({ user: mockClient.user });

      // Should set presence to online with "Listening to messages" activity
      expect(mockClient.user.setPresence).toHaveBeenCalledWith(
        expect.objectContaining({
          status: expect.any(String),
          activities: expect.arrayContaining([
            expect.objectContaining({ name: 'for messages' }),
          ]),
        })
      );
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

    it('reacts with eyes when creating a new thread', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_BOUND', '/test/project', 'claude');

      const { message } = createMockMessage({
        channelId: 'C_BOUND',
        content: 'new task',
        isThread: false,
      });

      await triggerMessage(message);

      expect(message.react).toHaveBeenCalledWith('👀');
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
        setAllowedTools: vi.fn(),
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

      store.createProject('C_BOUND', '/test/trunc', 'claude');

      const { message } = createMockMessage({
        channelId: 'thread-trunc',
        content: 'write a big file',
        isThread: true,
        parentId: 'C_BOUND',
      });

      await triggerMessage(message);

      const calls = message.channel.send.mock.calls;
      const permCall = calls.find(
        (c: any) => c[0].content?.includes('Permission requested')
      );
      expect(permCall).toBeDefined();
      expect(permCall[0].content).toContain('(truncated)');
      expect(permCall[0].content.length).toBeLessThan(1000);
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
        customId: 'permission_allow:Edit',
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
        customId: 'permission_deny:Edit',
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
        setAllowedTools: vi.fn(),
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
        customId: 'permission_allow:Edit',
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
        setAllowedTools: vi.fn(),
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
        setAllowedTools: vi.fn(),
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
        subcommand: 'list',
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

      store.createProject('C_BOUND', '/test/project', 'claude');

      const { interaction } = createMockInteraction({
        commandName: 'settings',
        subcommand: 'view',
        channelId: 'C_BOUND',
      });

      await triggerInteraction(interaction);
      expect(interaction.reply).toHaveBeenCalled();
    });
  });

  describe('P4.11: Discord — /project command flow (create, list, bind)', () => {
    it('lists all bindings with list subcommand', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_PROJ1', '/test/project1', 'claude');
      store.createProject('C_PROJ2', '/test/project2', 'codex');

      const { interaction, replies } = createMockInteraction({
        commandName: 'project',
        subcommand: 'list',
      });

      await triggerInteraction(interaction);

      expect(replies.length).toBe(1);
      const text = typeof replies[0] === 'string' ? replies[0] : replies[0].content || replies[0];
      expect(text).toContain('Connected Projects');
      expect(text).toContain('/test/project1');
      expect(text).toContain('/test/project2');
    });

    it('shows message when no bindings exist', async () => {
      createAdapter();
      await adapter.start();

      const { interaction, replies } = createMockInteraction({
        commandName: 'project',
        subcommand: 'list',
      });

      await triggerInteraction(interaction);

      const text = typeof replies[0] === 'string' ? replies[0] : replies[0].content || replies[0];
      expect(text).toContain('No projects connected');
    });

    it('creates new channel when invoked from bound channel with absolute path', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_BOUND', '/test/project', 'claude');

      const { interaction, createdChannels, mockGuild } = createMockInteraction({
        commandName: 'project',
        channelId: 'C_BOUND',
        subcommand: 'connect',
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
        subcommand: 'connect',
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
        subcommand: 'connect',
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

  describe('Discord — /cancel stops a running task', () => {
    it('tells user to use /cancel in a thread when used outside', async () => {
      createAdapter();
      await adapter.start();

      const { interaction, replies } = createMockInteraction({
        commandName: 'cancel',
        channelId: 'C_BOUND',
        isThread: false,
      });

      await triggerInteraction(interaction);

      const text = typeof replies[0] === 'string' ? replies[0] : replies[0].content || replies[0];
      expect(text).toContain('inside a thread');
    });

    it('reports nothing to cancel when no task is running', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_CANCEL', '/test/cancel', 'claude');

      const { interaction, replies } = createMockInteraction({
        commandName: 'cancel',
        channelId: 'thread-cancel',
        isThread: true,
        parentId: 'C_CANCEL',
      });

      await triggerInteraction(interaction);

      const text = typeof replies[0] === 'string' ? replies[0] : replies[0].content || replies[0];
      expect(text).toContain('Nothing to cancel');
    });
  });

  describe('P4.13: Discord — /settings command', () => {
    it('displays settings with project info', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_BOUND', '/test/project', 'claude');

      const { interaction, replies } = createMockInteraction({
        commandName: 'settings',
        subcommand: 'view',
        channelId: 'C_BOUND',
      });

      await triggerInteraction(interaction);

      const text = typeof replies[0] === 'string' ? replies[0] : replies[0].content || replies[0];
      expect(text).toContain('claude');
      expect(text).toContain('/test/project');
      expect(text).toContain('/project backend');
    });

    it('displays settings even without a connected project', async () => {
      createAdapter();
      await adapter.start();

      const { interaction, replies } = createMockInteraction({
        commandName: 'settings',
        subcommand: 'view',
        channelId: 'C_UNBOUND',
      });

      await triggerInteraction(interaction);

      const text = typeof replies[0] === 'string' ? replies[0] : replies[0].content || replies[0];
      expect(text).toContain('Bridge settings');
      expect(text).toContain('/settings root');
    });
  });

  describe('/project backend changes the AI backend', () => {
    it('changes the backend with subcommand', async () => {
      createAdapter();
      await adapter.start();

      const project = store.createProject('C_BOUND', '/test/project', 'claude');

      const { interaction, replies } = createMockInteraction({
        commandName: 'project',
        subcommand: 'backend',
        channelId: 'C_BOUND',
        options: { name: 'codex' },
      });

      await triggerInteraction(interaction);

      const updated = store.getProjectById(project.id);
      expect(updated?.backend_name).toBe('codex');

      const text = typeof replies[0] === 'string' ? replies[0] : replies[0].content || replies[0];
      expect(text).toContain('codex');
    });
  });

  describe('/project info shows project details', () => {
    it('shows path, backend, and permission mode', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_BOUND', '/test/project', 'claude');

      const { interaction, replies } = createMockInteraction({
        commandName: 'project',
        subcommand: 'info',
        channelId: 'C_BOUND',
      });

      await triggerInteraction(interaction);

      const text = typeof replies[0] === 'string' ? replies[0] : replies[0].content || replies[0];
      expect(text).toContain('/test/project');
      expect(text).toContain('Claude Code');
      expect(text).toContain('supervised');
    });

    it('shows message when no project connected', async () => {
      createAdapter();
      await adapter.start();

      const { interaction, replies } = createMockInteraction({
        commandName: 'project',
        subcommand: 'info',
        channelId: 'C_UNBOUND',
      });

      await triggerInteraction(interaction);

      const text = typeof replies[0] === 'string' ? replies[0] : replies[0].content || replies[0];
      expect(text).toContain('No project connected');
    });
  });

  describe('/schedule list and cancel', () => {
    it('lists active schedules for the channel', async () => {
      createAdapter();
      await adapter.start();

      const project = store.createProject('C_SCHED', '/test/sched', 'claude');
      store.createSchedule(
        project.id, 'C_SCHED', 'news prompt', 'give me daily news',
        { cronExpression: '0 9 * * *', nextRunAt: '2026-02-25T09:00:00' },
      );

      const { interaction, replies } = createMockInteraction({
        commandName: 'schedule',
        subcommand: 'list',
        channelId: 'C_SCHED',
      });

      await triggerInteraction(interaction);

      const text = typeof replies[0] === 'string' ? replies[0] : replies[0].content || replies[0];
      expect(text).toContain('give me daily news');
      expect(text).toContain('cron');
    });

    it('shows empty message when no schedules', async () => {
      createAdapter();
      await adapter.start();

      const { interaction, replies } = createMockInteraction({
        commandName: 'schedule',
        subcommand: 'list',
        channelId: 'C_EMPTY',
      });

      await triggerInteraction(interaction);

      const text = typeof replies[0] === 'string' ? replies[0] : replies[0].content || replies[0];
      expect(text).toContain('No scheduled sessions');
    });

    it('cancels a schedule by ID', async () => {
      createAdapter();
      await adapter.start();

      const project = store.createProject('C_CANCEL', '/test/cancel', 'claude');
      const sched = store.createSchedule(
        project.id, 'C_CANCEL', 'to cancel', 'cancel this task',
        { scheduledAt: '2026-03-01T09:00:00', nextRunAt: '2026-03-01T09:00:00' },
      );

      const { interaction, replies } = createMockInteraction({
        commandName: 'schedule',
        subcommand: 'cancel',
        channelId: 'C_CANCEL',
        intOptions: { id: sched.id },
      });

      await triggerInteraction(interaction);

      const text = typeof replies[0] === 'string' ? replies[0] : replies[0].content || replies[0];
      expect(text).toContain('Cancelled');
      expect(text).toContain('cancel this task');

      const updated = store.getScheduleById(sched.id);
      expect(updated!.is_active).toBe(0);
    });

    it('rejects cancel for nonexistent schedule', async () => {
      createAdapter();
      await adapter.start();

      const { interaction, replies } = createMockInteraction({
        commandName: 'schedule',
        subcommand: 'cancel',
        channelId: 'C_NOEXIST',
        intOptions: { id: 99999 },
      });

      await triggerInteraction(interaction);

      const text = typeof replies[0] === 'string' ? replies[0] : replies[0].content || replies[0];
      expect(text).toContain('No active schedule');
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
        setAllowedTools: vi.fn(),
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

  describe('uploadFile', () => {
    it('calls channel.send with file attachment', async () => {
      createAdapter();
      const tmpFile = path.join(tmpDir, 'test-upload.txt');
      fs.writeFileSync(tmpFile, 'test content');

      await adapter.uploadFile('C_CHAN', 'T_THREAD', tmpFile);

      expect(mockClient.channels.fetch).toHaveBeenCalledWith('T_THREAD');
      expect(mockClient._mockSendableChannel.send).toHaveBeenCalledWith({
        files: [{ attachment: tmpFile, name: 'test-upload.txt' }],
      });
    });
  });

  describe('sendMessage', () => {
    it('calls channel.send with text content', async () => {
      createAdapter();
      mockClient._mockSendableChannel.send.mockClear();
      mockClient.channels.fetch.mockClear();

      await adapter.sendMessage('C_CHAN', 'T_THREAD', 'Hello from MCP');

      expect(mockClient.channels.fetch).toHaveBeenCalledWith('T_THREAD');
      expect(mockClient._mockSendableChannel.send).toHaveBeenCalledWith({
        content: 'Hello from MCP',
      });
    });
  });

  describe('P12.11: Discord adapter image handling', () => {
    it('downloads images from Discord and passes to backend', async () => {
      // Mock global fetch to return fake image data
      const originalFetch = globalThis.fetch;
      const fakeImageData = Buffer.from('fake-discord-img');
      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => fakeImageData.buffer.slice(
          fakeImageData.byteOffset,
          fakeImageData.byteOffset + fakeImageData.byteLength,
        ),
        headers: new Headers({ 'content-type': 'image/jpeg' }),
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
        store.createProject('C_BOUND', '/test/project', 'claude');

        const { message } = createMockMessage({
          channelId: 'thread-img',
          content: 'what is this?',
          isThread: true,
          parentId: 'C_BOUND',
          attachments: [
            { name: 'photo.jpg', url: 'https://cdn.discord.com/photo.jpg', contentType: 'image/jpeg' },
          ],
        });

        await triggerMessage(message);

        expect(capturedImages).toBeDefined();
        expect(capturedImages).toHaveLength(1);
        expect(capturedImages![0].mediaType).toBe('image/jpeg');
        expect(capturedImages![0].base64).toBe(fakeImageData.toString('base64'));
        // P13.3: staging metadata populated
        expect(capturedImages![0].uploadId).toMatch(/^upload_[a-f0-9]{12}$/);
        expect(capturedImages![0].filename).toBe('photo.jpg');
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
        store.createProject('C_BOUND', '/test/project', 'claude');

        const { message } = createMockMessage({
          channelId: 'thread-pdf',
          content: 'review this doc',
          isThread: true,
          parentId: 'C_BOUND',
          attachments: [
            { name: 'report.pdf', url: 'https://cdn.discord.com/report.pdf', contentType: 'application/pdf' },
          ],
        });

        await triggerMessage(message);

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

    it('downloads text files and inlines their content', async () => {
      const originalFetch = globalThis.fetch;
      const fakeJsonData = Buffer.from('{"key": "value"}');
      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => fakeJsonData.buffer.slice(
          fakeJsonData.byteOffset,
          fakeJsonData.byteOffset + fakeJsonData.byteLength,
        ),
        headers: new Headers({ 'content-type': 'application/json' }),
      })) as any;

      try {
        let capturedText = '';
        let capturedFiles: any[] | undefined;
        const jsonBackend = vi.fn(() => ({
          start: vi.fn(async () => {}),
          send: vi.fn(async (text: string, files?: any[]) => {
            capturedText = text;
            capturedFiles = files;
            return {
              events: [{ type: 'assistant_text' as const, text: 'Got it' }],
              sessionId: 'session-json',
            };
          }),
          getSessionId: vi.fn(() => 'session-json'),
          setSessionId: vi.fn(),
          setAllowedTools: vi.fn(),
          stop: vi.fn(async () => {}),
        }));

        createAdapter({ backendFactory: jsonBackend });
        await adapter.start();
        store.createProject('C_BOUND', '/test/project', 'claude');

        const { message } = createMockMessage({
          channelId: 'thread-json',
          content: 'check this config',
          isThread: true,
          parentId: 'C_BOUND',
          attachments: [
            { name: 'config.json', url: 'https://cdn.discord.com/config.json', contentType: 'application/json' },
          ],
        });

        await triggerMessage(message);

        expect(capturedText).toContain('config.json');
        expect(capturedText).toContain('"key": "value"');
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
      store.createProject('C_BOUND', '/test/project', 'claude');

      const { message } = createMockMessage({
        channelId: 'thread-fail',
        content: 'review this doc',
        isThread: true,
        parentId: 'C_BOUND',
        attachments: [
          { name: 'report.pdf', url: 'https://cdn.discord.com/report.pdf', contentType: 'application/pdf' },
        ],
      });

      await triggerMessage(message);

      expect(capturedText).toContain('report.pdf');
      expect(capturedText).toContain('download failed');
      expect(capturedFiles).toBeUndefined();
    });
  });

  describe('P16.4: assistant_text suppression with post_message', () => {
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

      const { message } = createMockMessage({
        channelId: 'thread-multi',
        content: 'do something',
        isThread: true,
        parentId: 'C_MULTI',
      });

      await triggerMessage(message);

      // Should only render the LAST assistant_text
      const sendCalls = (message.channel.send as any).mock.calls
        .filter((c: any) => c[0] !== 'Processing...' && c[0]?.content !== 'Processing...');
      expect(sendCalls).toHaveLength(1);
      expect(sendCalls[0][0].content).toBe('Here is the final result.');
    });

    it('suppresses all assistant_text when post_message WAS used during turn', async () => {
      const { markPostMessageCalled } = await import('../mcp/callbacks.js');

      const pmBackend = vi.fn(() => ({
        start: vi.fn(async () => {}),
        send: vi.fn(async () => {
          // Simulate Claude calling post_message during the turn
          markPostMessageCalled('thread-pm');
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

      const { message } = createMockMessage({
        channelId: 'thread-pm',
        content: 'do something',
        isThread: true,
        parentId: 'C_PM',
      });

      await triggerMessage(message);

      // All assistant_text events should be suppressed
      const sendCalls = (message.channel.send as any).mock.calls
        .filter((c: any) => c[0] !== 'Processing...' && c[0]?.content !== 'Processing...');
      expect(sendCalls).toHaveLength(0);
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

      const { message } = createMockMessage({
        channelId: 'thread-long',
        content: 'do something',
        isThread: true,
        parentId: 'C_LONG',
      });

      await triggerMessage(message);

      const sendCalls = (message.channel.send as any).mock.calls
        .filter((c: any) => c[0] !== 'Processing...' && c[0]?.content !== 'Processing...');
      expect(sendCalls).toHaveLength(1);
      // Should be truncated: starts with "..." and ends with the original ending
      expect(sendCalls[0][0].content).toMatch(/^\.\.\./);
      expect(sendCalls[0][0].content).toContain('THE_END');
      expect(sendCalls[0][0].content.length).toBeLessThanOrEqual(503); // 500 + "..."
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

      const { message } = createMockMessage({
        channelId: 'thread-err',
        content: 'break something',
        isThread: true,
        parentId: 'C_ERR',
      });

      await triggerMessage(message);

      // Error should be rendered + last assistant_text (no post_message)
      const sendCalls = (message.channel.send as any).mock.calls
        .filter((c: any) => c[0] !== 'Processing...' && c[0]?.content !== 'Processing...');
      expect(sendCalls).toHaveLength(2);
      expect(sendCalls[0][0].content).toBe('Trying something...');
      expect(sendCalls[1][0].content).toContain('Something went wrong');
    });
  });

  describe('P18.1: Sandbox upgrade resets session', () => {
    it('sandbox_upgrade button updates sandbox_mode and resets session', async () => {
      createAdapter();
      await adapter.start();

      const project = store.createProject('C_SBU', '/test/sbu', 'codex');
      const session = store.createSession('thread-sbu', project.id);
      store.updateBackendSessionId(session.id, 'codex-session-xyz');
      expect(project.sandbox_mode).toBe('workspace-write');

      const { interaction } = createMockButtonInteraction({
        customId: 'sandbox_upgrade',
        channelId: 'C_SBU',
        isThread: true,
        parentId: 'C_SBU',
      });
      // Override channel.id to match the thread
      interaction.channel.id = 'thread-sbu';

      await triggerInteraction(interaction);

      // Sandbox mode updated
      const updatedProject = store.getProjectById(project.id)!;
      expect(updatedProject.sandbox_mode).toBe('danger-full-access');

      // Session reset — backend_session_id cleared
      const updatedSession = store.getSessionByThreadId('thread-sbu')!;
      expect(updatedSession.backend_session_id).toBeNull();
      expect(updatedSession.state).toBe('idle');

      // Confirmation message mentions session reset
      expect(interaction.update).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('Session reset'),
        })
      );
    });
  });

  describe('P20.2: AskUserQuestion renders dynamic buttons', () => {
    it('postUserQuestion sends message with option buttons', async () => {
      createAdapter();
      await adapter.start();

      const questions = [{
        question: 'Which framework?',
        header: 'Framework',
        options: [
          { label: 'React', description: 'Component-based UI' },
          { label: 'Vue', description: 'Progressive framework' },
          { label: 'Svelte', description: 'Compiled framework' },
        ],
        multiSelect: false,
      }];

      // Use a mock context with a sendable channel
      const threadMessages: any[] = [];
      const mockContext = {
        channel: {
          id: 'thread-123',
          isThread: () => true,
          parentId: 'C_BOUND',
          send: vi.fn(async (opts: any) => {
            threadMessages.push(opts);
            return { id: 'msg-q1', delete: vi.fn(async () => {}) };
          }),
        },
      };

      await adapter.postUserQuestion('C_BOUND', 'thread-123', questions, 'req-uuid-3', mockContext);

      // It should have sent a message via sendToThread
      expect(threadMessages.length).toBeGreaterThan(0);
      const sent = threadMessages[0];
      expect(sent.content).toContain('Which framework?');
      expect(sent.content).toContain('React');
      expect(sent.content).toContain('Vue');
      expect(sent.content).toContain('Svelte');
      expect(sent.components).toBeDefined();
      expect(sent.components.length).toBe(1);
    });

    it('handles question_answer button click and resolves question', async () => {
      createAdapter();
      await adapter.start();

      // First post a question to populate pendingQuestionOptions
      const questions = [{
        question: 'Pick one',
        header: 'Q',
        options: [
          { label: 'Alpha', description: '' },
          { label: 'Beta', description: '' },
        ],
        multiSelect: false,
      }];

      const mockContext = {
        channel: {
          id: 'thread-123',
          isThread: () => true,
          parentId: 'C_BOUND',
          send: vi.fn(async () => ({ id: 'msg-q2', delete: vi.fn(async () => {}) })),
        },
      };

      await adapter.postUserQuestion('C_BOUND', 'thread-123', questions, 'req-uuid-4', mockContext);

      // Simulate clicking the second option button
      const { interaction } = createMockButtonInteraction({
        customId: 'question_answer:1|req-uuid-4',
        channelId: 'C_BOUND',
        isThread: true,
        parentId: 'C_BOUND',
      });

      await triggerInteraction(interaction);

      expect(resolveUserQuestion).toHaveBeenCalledWith('req-uuid-4', 'Beta');

      expect(interaction.update).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('**Answered:** Beta'),
          components: [],
        })
      );
    });
  });

  describe('P20.9: Eyes reaction acknowledgement for all resolution paths', () => {
    it('reacts with eyes on new thread message', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_BOUND', '/test/project', 'claude');

      const { message } = createMockMessage({
        channelId: 'C_BOUND',
        content: 'new task',
        isThread: false,
      });

      await triggerMessage(message);

      expect(message.react).toHaveBeenCalledWith('👀');
    });

    it('reacts with eyes on follow-up messages in threads', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_BOUND', '/test/project', 'claude');

      const { message } = createMockMessage({
        channelId: 'thread-proc',
        content: 'follow up',
        isThread: true,
        parentId: 'C_BOUND',
      });

      await triggerMessage(message);

      expect(message.react).toHaveBeenCalledWith('👀');
    });

    it('reacts with eyes after permission Allow button click (hook-based)', async () => {
      createAdapter();
      await adapter.start();

      store.createProject('C_BOUND', '/test/project', 'claude');

      const { interaction } = createMockButtonInteraction({
        customId: 'permission_allow:Bash|req-perm-proc-1',
        channelId: 'C_BOUND',
        isThread: true,
        parentId: 'C_BOUND',
      });

      await triggerInteraction(interaction);

      expect(interaction.message.react).toHaveBeenCalledWith('👀');
    });

    it('reacts with eyes after AskUserQuestion button click', async () => {
      createAdapter();
      await adapter.start();

      // First post a question to populate pendingQuestionOptions
      const questions = [{
        question: 'Pick one',
        header: 'Q',
        options: [
          { label: 'Yes', description: '' },
          { label: 'No', description: '' },
        ],
        multiSelect: false,
      }];

      const mockContext = {
        channel: {
          id: 'thread-123',
          isThread: () => true,
          parentId: 'C_BOUND',
          send: vi.fn(async () => ({ id: 'msg-q-proc', delete: vi.fn(async () => {}) })),
        },
      };

      await adapter.postUserQuestion('C_BOUND', 'thread-123', questions, 'req-q-proc-1', mockContext);

      const { interaction } = createMockButtonInteraction({
        customId: 'question_answer:0|req-q-proc-1',
        channelId: 'C_BOUND',
        isThread: true,
        parentId: 'C_BOUND',
      });

      await triggerInteraction(interaction);

      expect(interaction.message.react).toHaveBeenCalledWith('👀');
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

      await adapter.renderTodoList('C_BOUND', 'THREAD_TODO', todos);

      const sendCalls = mockClient._mockSendableChannel.send.mock.calls;
      const todoCall = sendCalls.find((c: any) => {
        const content = c[0]?.content ?? c[0];
        return typeof content === 'string' && content.includes('~~Fix bug~~');
      });
      expect(todoCall).toBeDefined();
      const content = todoCall![0]?.content ?? todoCall![0];
      expect(content).toContain('~~Fix bug~~');
      expect(content).toContain('**Writing tests...**');
      expect(content).toContain('Deploy');
    });

    it('updates the same message on subsequent renderTodoList calls', async () => {
      createAdapter();
      await adapter.start();

      const todos1 = [
        { content: 'Fix bug', status: 'in_progress', activeForm: 'Fixing bug' },
      ];
      await adapter.renderTodoList('C_BOUND', 'THREAD_TODO', todos1);

      // First call should send a new message
      const sendCalls = mockClient._mockSendableChannel.send.mock.calls;
      expect(sendCalls.length).toBeGreaterThan(0);

      // Get the returned message object (has edit mock)
      const sentMsg = await mockClient._mockSendableChannel.send.mock.results[
        sendCalls.length - 1
      ].value;

      const todos2 = [
        { content: 'Fix bug', status: 'completed', activeForm: 'Fixing bug' },
      ];
      await adapter.renderTodoList('C_BOUND', 'THREAD_TODO', todos2);

      // Second call should edit the existing message
      expect(sentMsg.edit).toHaveBeenCalled();
      const editArg = sentMsg.edit.mock.calls[0][0];
      expect(editArg.content).toContain('~~Fix bug~~');
    });

    it('formats empty todo list', async () => {
      createAdapter();
      await adapter.start();

      await adapter.renderTodoList('C_BOUND', 'THREAD_EMPTY', []);

      const sendCalls = mockClient._mockSendableChannel.send.mock.calls;
      const todoCall = sendCalls.find((c: any) => {
        const content = c[0]?.content ?? c[0];
        return typeof content === 'string' && content.includes('No tasks');
      });
      expect(todoCall).toBeDefined();
    });
  });
});
