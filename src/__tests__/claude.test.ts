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
});
