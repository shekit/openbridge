import { describe, it, expect } from 'vitest';
import type { Backend, SendResult, BackendOptions } from '../types/backend.js';
import type { NormalizedEvent } from '../types/events.js';

describe('Backend interface', () => {
  it('SendResult has events and sessionId fields', () => {
    const result: SendResult = {
      events: [{ type: 'assistant_text', text: 'hello' }],
      sessionId: 'sess_123',
    };
    expect(result.events).toHaveLength(1);
    expect(result.sessionId).toBe('sess_123');
  });

  it('SendResult sessionId can be null', () => {
    const result: SendResult = {
      events: [],
      sessionId: null,
    };
    expect(result.sessionId).toBeNull();
  });

  it('send() returns Promise<SendResult> with events and sessionId', async () => {
    // Mock backend implementing the interface
    const mockBackend: Backend = {
      async start(_options: BackendOptions) {},
      async send(text: string): Promise<SendResult> {
        const events: NormalizedEvent[] = [
          { type: 'session_started', sessionId: 'sess_abc' },
          { type: 'assistant_text', text: `echo: ${text}` },
          { type: 'turn_completed' },
        ];
        return { events, sessionId: 'sess_abc' };
      },
      getSessionId() {
        return 'sess_abc';
      },
      async stop() {},
    };

    const result = await mockBackend.send('hello');
    expect(result.events).toHaveLength(3);
    expect(result.sessionId).toBe('sess_abc');
    expect(result.events[0].type).toBe('session_started');
    expect(mockBackend.getSessionId()).toBe('sess_abc');
  });

  it('Backend interface has all four methods', () => {
    const mockBackend: Backend = {
      start: async () => {},
      send: async () => ({ events: [], sessionId: null }),
      getSessionId: () => null,
      stop: async () => {},
    };

    expect(typeof mockBackend.start).toBe('function');
    expect(typeof mockBackend.send).toBe('function');
    expect(typeof mockBackend.getSessionId).toBe('function');
    expect(typeof mockBackend.stop).toBe('function');
  });
});
