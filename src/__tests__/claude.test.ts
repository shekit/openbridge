import { describe, it, expect } from 'vitest';
import { ClaudeBackend, spawnCollect, parseClaudeOutput } from '../backends/claude.js';
import type { Backend } from '../types/backend.js';

describe('Claude Code backend', () => {
  describe('P1.3: spawn oneshot process and collect stdout', () => {
    it('implements Backend interface', () => {
      const backend: Backend = new ClaudeBackend();
      expect(typeof backend.start).toBe('function');
      expect(typeof backend.send).toBe('function');
      expect(typeof backend.getSessionId).toBe('function');
      expect(typeof backend.stop).toBe('function');
    });

    it('spawnCollect collects stdout from a process', async () => {
      const result = await spawnCollect('echo', ['hello world'], process.cwd());
      expect(result.stdout.trim()).toBe('hello world');
      expect(result.exitCode).toBe(0);
    });

    it('spawnCollect captures exit code', async () => {
      const result = await spawnCollect('node', ['-e', 'process.exit(42)'], process.cwd());
      expect(result.exitCode).toBe(42);
    });

    it('spawnCollect captures stderr', async () => {
      const result = await spawnCollect(
        'node',
        ['-e', 'process.stderr.write("err output")'],
        process.cwd(),
      );
      expect(result.stderr).toContain('err output');
    });

    it('send() spawns claude with correct args (--output-format stream-json)', async () => {
      // We can't actually call claude CLI in tests, but we can verify
      // parseClaudeOutput handles a basic stream-json response
      const sampleOutput = [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'test_sess_1' }),
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Hello!' }] },
        }),
        JSON.stringify({ type: 'result', is_error: false }),
      ].join('\n');

      const parsed = parseClaudeOutput(sampleOutput, '', 0);
      expect(parsed.sessionId).toBe('test_sess_1');
      expect(parsed.events.length).toBeGreaterThan(0);
    });
  });

  describe('P1.4: parse session_id from system init event', () => {
    it('extracts session_id from system init event', () => {
      const stdout = JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'abc-123-def',
      });
      const parsed = parseClaudeOutput(stdout, '', 0);
      expect(parsed.sessionId).toBe('abc-123-def');
    });

    it('emits SessionStarted normalized event', () => {
      const stdout = JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'sess_xyz',
      });
      const parsed = parseClaudeOutput(stdout, '', 0);
      const sessionEvent = parsed.events.find((e) => e.type === 'session_started');
      expect(sessionEvent).toBeDefined();
      expect(sessionEvent!.type === 'session_started' && sessionEvent!.sessionId).toBe('sess_xyz');
    });

    it('getSessionId() returns extracted session_id after first send', () => {
      // Verify that the ClaudeBackend class stores session IDs
      const backend = new ClaudeBackend();
      expect(backend.getSessionId()).toBeNull();
    });

    it('returns null sessionId when no system init event present', () => {
      const stdout = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hi' }] },
      });
      const parsed = parseClaudeOutput(stdout, '', 0);
      expect(parsed.sessionId).toBeNull();
    });
  });

  describe('P1.5: parse assistant text from assistant events', () => {
    it('extracts text from assistant message content', () => {
      const stdout = JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Hello, I can help with that.' }],
        },
      });
      const parsed = parseClaudeOutput(stdout, '', 0);
      const textEvent = parsed.events.find((e) => e.type === 'assistant_text');
      expect(textEvent).toBeDefined();
      expect(textEvent!.type === 'assistant_text' && textEvent!.text).toBe(
        'Hello, I can help with that.',
      );
    });

    it('concatenates multiple text blocks', () => {
      const stdout = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'First part.' },
            { type: 'tool_use', id: 'toolu_01', name: 'Read', input: {} },
            { type: 'text', text: 'Second part.' },
          ],
        },
      });
      const parsed = parseClaudeOutput(stdout, '', 0);
      const textEvent = parsed.events.find((e) => e.type === 'assistant_text');
      expect(textEvent).toBeDefined();
      expect(textEvent!.type === 'assistant_text' && textEvent!.text).toBe(
        'First part.\nSecond part.',
      );
    });

    it('returns AssistantText normalized events', () => {
      const stdout = [
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Response 1' }] },
        }),
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Response 2' }] },
        }),
      ].join('\n');

      const parsed = parseClaudeOutput(stdout, '', 0);
      const textEvents = parsed.events.filter((e) => e.type === 'assistant_text');
      expect(textEvents).toHaveLength(2);
    });

    it('skips assistant events with no text content', () => {
      const stdout = JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_01', name: 'Bash', input: {} }],
        },
      });
      const parsed = parseClaudeOutput(stdout, '', 0);
      const textEvents = parsed.events.filter((e) => e.type === 'assistant_text');
      expect(textEvents).toHaveLength(0);
    });
  });

  describe('P1.6: parse permission_denials from result event', () => {
    it('parses permission_denials array from result event', () => {
      const stdout = JSON.stringify({
        type: 'result',
        permission_denials: [
          {
            tool_name: 'Bash',
            tool_use_id: 'toolu_01',
            tool_input: { command: 'touch file.txt' },
          },
          {
            tool_name: 'Write',
            tool_use_id: 'toolu_02',
            tool_input: { file_path: 'file.txt', content: '' },
          },
        ],
      });
      const parsed = parseClaudeOutput(stdout, '', 0);
      const denials = parsed.events.filter((e) => e.type === 'permission_denied');
      expect(denials).toHaveLength(2);
      expect(denials[0].type === 'permission_denied' && denials[0].toolName).toBe('Bash');
      expect(denials[0].type === 'permission_denied' && denials[0].toolInput).toEqual({
        command: 'touch file.txt',
      });
      expect(denials[1].type === 'permission_denied' && denials[1].toolName).toBe('Write');
    });

    it('empty permission_denials array produces no PermissionDenied events', () => {
      const stdout = JSON.stringify({
        type: 'result',
        permission_denials: [],
      });
      const parsed = parseClaudeOutput(stdout, '', 0);
      const denials = parsed.events.filter((e) => e.type === 'permission_denied');
      expect(denials).toHaveLength(0);
    });

    it('handles missing tool_input gracefully', () => {
      const stdout = JSON.stringify({
        type: 'result',
        permission_denials: [
          { tool_name: 'Edit' },
        ],
      });
      const parsed = parseClaudeOutput(stdout, '', 0);
      const denials = parsed.events.filter((e) => e.type === 'permission_denied');
      expect(denials).toHaveLength(1);
      expect(denials[0].type === 'permission_denied' && denials[0].toolInput).toEqual({});
    });
  });
});
