import { describe, it, expect } from 'vitest';
import { CodexBackend, parseCodexOutput, buildCodexArgs } from '../backends/codex.js';
import { spawnCollect } from '../backends/claude.js';
import type { Backend } from '../types/backend.js';

describe('Codex CLI backend', () => {
  describe('P1.10: spawn oneshot process and collect stdout', () => {
    it('implements Backend interface', () => {
      const backend: Backend = new CodexBackend();
      expect(typeof backend.start).toBe('function');
      expect(typeof backend.send).toBe('function');
      expect(typeof backend.getSessionId).toBe('function');
      expect(typeof backend.stop).toBe('function');
    });

    it('send() uses codex exec --skip-git-repo-check --json', () => {
      const args = buildCodexArgs('hello', null, 'workspace-write');
      expect(args[0]).toBe('exec');
      expect(args).toContain('--skip-git-repo-check');
      expect(args).toContain('--json');
      expect(args[args.length - 1]).toBe('hello');
    });

    it('spawnCollect collects stdout from a process', async () => {
      const result = await spawnCollect('echo', ['codex output'], process.cwd());
      expect(result.stdout.trim()).toBe('codex output');
      expect(result.exitCode).toBe(0);
    });

    it('exit code is captured', async () => {
      const result = await spawnCollect('node', ['-e', 'process.exit(7)'], process.cwd());
      expect(result.exitCode).toBe(7);
    });

    it('parseCodexOutput handles a basic response', () => {
      const sampleOutput = [
        JSON.stringify({ type: 'thread.started', thread_id: 'thread_001' }),
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'I can help!' },
        }),
      ].join('\n');

      const parsed = parseCodexOutput(sampleOutput, '', 0);
      expect(parsed.sessionId).toBe('thread_001');
      expect(parsed.events.length).toBeGreaterThan(0);
    });
  });
});
