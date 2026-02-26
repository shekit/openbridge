import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageQueue, mapSdkMessage, ClaudeSdkBackend } from '../backends/claude-sdk.js';
import type { NormalizedEvent } from '../types/events.js';

describe('MessageQueue', () => {
  it('push then pop returns the message', async () => {
    const queue = new MessageQueue();
    const msg = {
      type: 'user' as const,
      message: { role: 'user' as const, content: 'hello' },
      parent_tool_use_id: null,
      session_id: '',
    };
    queue.push(msg);
    const result = await queue.pop();
    expect(result).toEqual(msg);
  });

  it('pop waits for push', async () => {
    const queue = new MessageQueue();
    const msg = {
      type: 'user' as const,
      message: { role: 'user' as const, content: 'delayed' },
      parent_tool_use_id: null,
      session_id: '',
    };

    // Pop first (will wait), then push
    const popPromise = queue.pop();
    setTimeout(() => queue.push(msg), 10);
    const result = await popPromise;
    expect(result).toEqual(msg);
  });

  it('close() returns null from pop', async () => {
    const queue = new MessageQueue();
    const popPromise = queue.pop();
    queue.close();
    const result = await popPromise;
    expect(result).toBeNull();
  });

  it('push after close is ignored', async () => {
    const queue = new MessageQueue();
    queue.close();
    queue.push({
      type: 'user',
      message: { role: 'user', content: 'ignored' },
      parent_tool_use_id: null,
      session_id: '',
    } as any);
    const result = await queue.pop();
    expect(result).toBeNull();
  });

  it('handles multiple messages in order', async () => {
    const queue = new MessageQueue();
    const makeMsg = (text: string) => ({
      type: 'user' as const,
      message: { role: 'user' as const, content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    queue.push(makeMsg('first'));
    queue.push(makeMsg('second'));
    queue.push(makeMsg('third'));
    expect(await queue.pop()).toEqual(makeMsg('first'));
    expect(await queue.pop()).toEqual(makeMsg('second'));
    expect(await queue.pop()).toEqual(makeMsg('third'));
  });
});

describe('mapSdkMessage', () => {
  it('maps system init to session_started', () => {
    const events = mapSdkMessage({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-123',
      uuid: '00000000-0000-0000-0000-000000000000' as any,
      tools: [],
      mcp_servers: [],
      model: 'claude-sonnet-4-6',
      permissionMode: 'default',
      slash_commands: [],
      output_style: 'default',
      skills: [],
      plugins: [],
      apiKeySource: 'user',
      claude_code_version: '2.0.0',
      cwd: '/tmp',
    } as any);
    expect(events).toEqual([{ type: 'session_started', sessionId: 'sess-123' }]);
  });

  it('maps assistant message to assistant_text', () => {
    const events = mapSdkMessage({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Hello world' },
          { type: 'tool_use', id: 'tu1', name: 'Bash', input: {} },
        ],
      },
      parent_tool_use_id: null,
      uuid: '00000000-0000-0000-0000-000000000000' as any,
      session_id: 'sess-1',
    } as any);
    expect(events).toEqual([{ type: 'assistant_text', text: 'Hello world' }]);
  });

  it('maps assistant message with multiple text blocks', () => {
    const events = mapSdkMessage({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Part 1' },
          { type: 'text', text: 'Part 2' },
        ],
      },
      parent_tool_use_id: null,
      uuid: '00000000-0000-0000-0000-000000000000' as any,
      session_id: 'sess-1',
    } as any);
    expect(events).toEqual([{ type: 'assistant_text', text: 'Part 1\nPart 2' }]);
  });

  it('maps result success to turn_completed', () => {
    const events = mapSdkMessage({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      permission_denials: [],
      uuid: '00000000-0000-0000-0000-000000000000' as any,
      session_id: 'sess-1',
      duration_ms: 100,
      duration_api_ms: 80,
      num_turns: 1,
      total_cost_usd: 0.01,
      usage: {} as any,
      modelUsage: {},
    } as any);
    expect(events).toEqual([{ type: 'turn_completed' }]);
  });

  it('maps result error to error + turn_completed', () => {
    const events = mapSdkMessage({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['Something went wrong'],
      permission_denials: [],
      uuid: '00000000-0000-0000-0000-000000000000' as any,
      session_id: 'sess-1',
      duration_ms: 50,
      duration_api_ms: 30,
      num_turns: 1,
      total_cost_usd: 0.005,
      usage: {} as any,
      modelUsage: {},
    } as any);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'error', message: 'Something went wrong' });
    expect(events[1]).toEqual({ type: 'turn_completed' });
  });

  it('maps permission denials from result', () => {
    const events = mapSdkMessage({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      permission_denials: [
        { tool_name: 'Bash', tool_use_id: 'tu1', tool_input: { command: 'rm -rf /' } },
      ],
      uuid: '00000000-0000-0000-0000-000000000000' as any,
      session_id: 'sess-1',
      duration_ms: 100,
      duration_api_ms: 80,
      num_turns: 1,
      total_cost_usd: 0.01,
      usage: {} as any,
      modelUsage: {},
    } as any);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: 'permission_denied',
      toolName: 'Bash',
      toolInput: { command: 'rm -rf /' },
    });
    expect(events[1]).toEqual({ type: 'turn_completed' });
  });

  it('ignores user messages', () => {
    const events = mapSdkMessage({
      type: 'user',
      message: { role: 'user', content: 'test' },
      parent_tool_use_id: null,
      session_id: 'sess-1',
    } as any);
    expect(events).toEqual([]);
  });

  it('ignores compact boundary messages', () => {
    const events = mapSdkMessage({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'auto', pre_tokens: 5000 },
      uuid: '00000000-0000-0000-0000-000000000000' as any,
      session_id: 'sess-1',
    } as any);
    expect(events).toEqual([]);
  });
});

// Mock the SDK query function for backend integration tests
vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  return {
    query: vi.fn(),
  };
});

describe('ClaudeSdkBackend', () => {
  let mockQuery: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    mockQuery = sdk.query as any;
    mockQuery.mockReset();
  });

  it('start() creates a query and send() returns normalized events', async () => {
    // Set up mock query that consumes messages and emits SDK events
    mockQuery.mockImplementation(({ prompt }: any) => {
      const events: any[] = [];
      let onMessage: ((msg: any) => void) | null = null;

      // Async generator that yields SDK messages when the input generator produces messages
      const gen = (async function* () {
        // Emit system init
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'sdk-sess-1',
          uuid: '00000000-0000-0000-0000-000000000000',
          tools: [],
          mcp_servers: [],
          model: 'claude-sonnet-4-6',
          permissionMode: 'default',
          slash_commands: [],
          output_style: 'default',
          skills: [],
          plugins: [],
          apiKeySource: 'user',
          claude_code_version: '2.0.0',
          cwd: '/tmp',
        };

        // Consume the first message from the input stream
        const iter = prompt[Symbol.asyncIterator]();
        const { value } = await iter.next();

        // Emit assistant response
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'SDK response!' }] },
          parent_tool_use_id: null,
          uuid: '11111111-1111-1111-1111-111111111111',
          session_id: 'sdk-sess-1',
        };

        // Emit result
        yield {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'SDK response!',
          permission_denials: [],
          uuid: '22222222-2222-2222-2222-222222222222',
          session_id: 'sdk-sess-1',
          duration_ms: 100,
          duration_api_ms: 80,
          num_turns: 1,
          total_cost_usd: 0.01,
          usage: {},
          modelUsage: {},
        };
      })();

      // Add control methods to the generator
      (gen as any).interrupt = vi.fn(async () => {});
      (gen as any).close = vi.fn(() => {});
      return gen;
    });

    const backend = new ClaudeSdkBackend();
    await backend.start({ projectDir: '/tmp/test' });

    const result = await backend.send('Hello SDK');

    expect(result.sessionId).toBe('sdk-sess-1');
    expect(result.events).toContainEqual({ type: 'session_started', sessionId: 'sdk-sess-1' });
    expect(result.events).toContainEqual({ type: 'assistant_text', text: 'SDK response!' });
    expect(result.events).toContainEqual({ type: 'turn_completed' });

    await backend.stop();
  });

  it('isAlive() returns true after start, false after stop', async () => {
    let abortResolve: () => void;
    const abortPromise = new Promise<void>((resolve) => { abortResolve = resolve; });

    mockQuery.mockImplementation(({ options }: any) => {
      const gen = (async function* () {
        // Block until abort signal fires
        await abortPromise;
      })();
      (gen as any).interrupt = vi.fn(async () => {});
      (gen as any).close = vi.fn(() => { abortResolve!(); });
      return gen;
    });

    const backend = new ClaudeSdkBackend();
    expect(backend.isAlive()).toBe(false);

    await backend.start({ projectDir: '/tmp/test' });
    expect(backend.isAlive()).toBe(true);

    await backend.stop();
    expect(backend.isAlive()).toBe(false);
  });

  it('passes session resume option when sessionId is set', async () => {
    mockQuery.mockImplementation(({ options }: any) => {
      expect(options.resume).toBe('existing-session-id');
      const gen = (async function* () {
        yield {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '',
          permission_denials: [],
          uuid: '00000000-0000-0000-0000-000000000000',
          session_id: 'existing-session-id',
          duration_ms: 10,
          duration_api_ms: 5,
          num_turns: 1,
          total_cost_usd: 0,
          usage: {},
          modelUsage: {},
        };
      })();
      (gen as any).interrupt = vi.fn(async () => {});
      (gen as any).close = vi.fn(() => {});
      return gen;
    });

    const backend = new ClaudeSdkBackend();
    backend.setSessionId('existing-session-id');
    await backend.start({ projectDir: '/tmp/test' });

    // Let the query complete
    const result = await backend.send('continue');
    expect(result.sessionId).toBe('existing-session-id');

    await backend.stop();
  });

  it('passes bypassPermissions for trusted mode', async () => {
    mockQuery.mockImplementation(({ options }: any) => {
      expect(options.permissionMode).toBe('bypassPermissions');
      expect(options.allowDangerouslySkipPermissions).toBe(true);
      const gen = (async function* () {
        yield {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '',
          permission_denials: [],
          uuid: '00000000-0000-0000-0000-000000000000',
          session_id: 'sess-trusted',
          duration_ms: 10,
          duration_api_ms: 5,
          num_turns: 1,
          total_cost_usd: 0,
          usage: {},
          modelUsage: {},
        };
      })();
      (gen as any).interrupt = vi.fn(async () => {});
      (gen as any).close = vi.fn(() => {});
      return gen;
    });

    const backend = new ClaudeSdkBackend();
    await backend.start({ projectDir: '/tmp/test', permissionMode: 'trusted' });
    const result = await backend.send('test');
    await backend.stop();
  });
});
