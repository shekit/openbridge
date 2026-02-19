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

  describe('P1.11: parse thread_id from thread.started event', () => {
    it('extracts thread_id from thread.started event', () => {
      const stdout = JSON.stringify({
        type: 'thread.started',
        thread_id: 'thread_abc123',
      });
      const parsed = parseCodexOutput(stdout, '', 0);
      expect(parsed.sessionId).toBe('thread_abc123');
    });

    it('emits SessionStarted normalized event', () => {
      const stdout = JSON.stringify({
        type: 'thread.started',
        thread_id: 'thread_xyz',
      });
      const parsed = parseCodexOutput(stdout, '', 0);
      const sessionEvent = parsed.events.find((e) => e.type === 'session_started');
      expect(sessionEvent).toBeDefined();
      expect(sessionEvent!.type === 'session_started' && sessionEvent!.sessionId).toBe('thread_xyz');
    });

    it('getSessionId() returns null initially', () => {
      const backend = new CodexBackend();
      expect(backend.getSessionId()).toBeNull();
    });

    it('returns null sessionId when no thread.started event present', () => {
      const stdout = JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'hello' },
      });
      const parsed = parseCodexOutput(stdout, '', 0);
      expect(parsed.sessionId).toBeNull();
    });
  });

  describe('P1.12: parse agent_message text', () => {
    it('extracts text from item.completed agent_message', () => {
      const stdout = JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'I created the file for you.' },
      });
      const parsed = parseCodexOutput(stdout, '', 0);
      const textEvents = parsed.events.filter((e) => e.type === 'assistant_text');
      expect(textEvents).toHaveLength(1);
      expect(textEvents[0].type === 'assistant_text' && textEvents[0].text).toBe(
        'I created the file for you.',
      );
    });

    it('handles multiple agent_message events', () => {
      const stdout = [
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'First response' },
        }),
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'Second response' },
        }),
      ].join('\n');

      const parsed = parseCodexOutput(stdout, '', 0);
      const textEvents = parsed.events.filter((e) => e.type === 'assistant_text');
      expect(textEvents).toHaveLength(2);
    });

    it('ignores reasoning events', () => {
      const stdout = JSON.stringify({
        type: 'item.completed',
        item: { type: 'reasoning', text: 'thinking...' },
      });
      const parsed = parseCodexOutput(stdout, '', 0);
      const textEvents = parsed.events.filter((e) => e.type === 'assistant_text');
      expect(textEvents).toHaveLength(0);
    });
  });

  describe('P1.13: parse command_execution events', () => {
    it('extracts command_execution with exit_code and aggregated_output', () => {
      const stdout = JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          command: 'ls -la',
          exit_code: 0,
          aggregated_output: 'total 8\ndrwxr-xr-x 2 user staff 64 Jan 1 00:00 .',
        },
      });
      const parsed = parseCodexOutput(stdout, '', 0);
      const cmdEvents = parsed.events.filter((e) => e.type === 'command_execution');
      expect(cmdEvents).toHaveLength(1);
      const cmd = cmdEvents[0];
      expect(cmd.type === 'command_execution' && cmd.command).toBe('ls -la');
      expect(cmd.type === 'command_execution' && cmd.exitCode).toBe(0);
      expect(cmd.type === 'command_execution' && cmd.output).toContain('total 8');
    });

    it('handles non-zero exit code', () => {
      const stdout = JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          command: 'cat nonexistent.txt',
          exit_code: 1,
          aggregated_output: 'cat: nonexistent.txt: No such file or directory',
        },
      });
      const parsed = parseCodexOutput(stdout, '', 0);
      const cmdEvents = parsed.events.filter((e) => e.type === 'command_execution');
      expect(cmdEvents).toHaveLength(1);
      expect(cmdEvents[0].type === 'command_execution' && cmdEvents[0].exitCode).toBe(1);
    });

    it('handles missing command and output fields', () => {
      const stdout = JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          exit_code: 0,
        },
      });
      const parsed = parseCodexOutput(stdout, '', 0);
      const cmdEvents = parsed.events.filter((e) => e.type === 'command_execution');
      expect(cmdEvents).toHaveLength(1);
      expect(cmdEvents[0].type === 'command_execution' && cmdEvents[0].command).toBe('');
      expect(cmdEvents[0].type === 'command_execution' && cmdEvents[0].output).toBe('');
    });
  });
});
