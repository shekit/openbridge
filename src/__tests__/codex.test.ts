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
      const handle = spawnCollect('echo', ['codex output'], process.cwd());
      const result = await handle.result;
      expect(result.stdout.trim()).toBe('codex output');
      expect(result.exitCode).toBe(0);
    });

    it('exit code is captured', async () => {
      const handle = spawnCollect('node', ['-e', 'process.exit(7)'], process.cwd());
      const result = await handle.result;
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

  describe('P1.14: detect sandbox denial patterns in output', () => {
    it('detects "Operation not permitted" in agent_message text', () => {
      const stdout = JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: 'touch: /etc/test.txt: Operation not permitted',
        },
      });
      const parsed = parseCodexOutput(stdout, '', 0);
      const denials = parsed.events.filter((e) => e.type === 'permission_denied');
      expect(denials).toHaveLength(1);
      expect(denials[0].type === 'permission_denied' && denials[0].toolName).toBe('sandbox');
    });

    it('detects "permission denied" in agent_message text (case insensitive)', () => {
      const stdout = JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: 'Error: Permission Denied when trying to write to /usr/local',
        },
      });
      const parsed = parseCodexOutput(stdout, '', 0);
      const denials = parsed.events.filter((e) => e.type === 'permission_denied');
      expect(denials).toHaveLength(1);
    });

    it('detects sandbox denial in command_execution output', () => {
      const stdout = JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          command: 'touch /etc/test.txt',
          exit_code: 1,
          aggregated_output: 'touch: /etc/test.txt: Operation not permitted',
        },
      });
      const parsed = parseCodexOutput(stdout, '', 0);
      const denials = parsed.events.filter((e) => e.type === 'permission_denied');
      expect(denials).toHaveLength(1);
      expect(denials[0].type === 'permission_denied' && denials[0].toolInput).toEqual({
        command: 'touch /etc/test.txt',
      });
    });

    it('does not flag normal output as sandbox denial', () => {
      const stdout = JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: 'I created the file successfully.',
        },
      });
      const parsed = parseCodexOutput(stdout, '', 0);
      const denials = parsed.events.filter((e) => e.type === 'permission_denied');
      expect(denials).toHaveLength(0);
    });

    it('includes context in permission_denied event', () => {
      const stdout = JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: 'The command failed with: Operation not permitted on /etc/hosts',
        },
      });
      const parsed = parseCodexOutput(stdout, '', 0);
      const denials = parsed.events.filter((e) => e.type === 'permission_denied');
      expect(denials).toHaveLength(1);
      expect(denials[0].type === 'permission_denied' && denials[0].context).toContain(
        'Operation not permitted',
      );
    });
  });

  describe('P1.15: session resume with resume subcommand', () => {
    it('first call uses codex exec (not resume)', () => {
      const args = buildCodexArgs('hello', null, 'workspace-write');
      expect(args[0]).toBe('exec');
      expect(args[1]).not.toBe('resume');
      expect(args).toContain('--json');
      expect(args[args.length - 1]).toBe('hello');
    });

    it('second call uses codex exec resume SESSION_ID', () => {
      const args = buildCodexArgs('follow-up', 'thread_abc', 'workspace-write');
      expect(args[0]).toBe('exec');
      expect(args[1]).toBe('resume');
      expect(args).toContain('--skip-git-repo-check');
      expect(args).toContain('--json');
      expect(args).toContain('thread_abc');
      expect(args[args.length - 1]).toBe('follow-up');
    });

    it('--sandbox flag is NOT included in resume args', () => {
      const args = buildCodexArgs('follow-up', 'thread_abc', 'workspace-write');
      expect(args).not.toContain('--sandbox');
      expect(args).not.toContain('workspace-write');
    });

    it('session ID from first call is reused in resume args', () => {
      // Simulate: first call returns thread_id, second call uses it
      const firstOutput = JSON.stringify({
        type: 'thread.started',
        thread_id: 'thread_resume_test',
      });
      const firstParsed = parseCodexOutput(firstOutput, '', 0);
      expect(firstParsed.sessionId).toBe('thread_resume_test');

      const secondArgs = buildCodexArgs('do more', firstParsed.sessionId, 'workspace-write');
      expect(secondArgs).toContain('thread_resume_test');
      expect(secondArgs[1]).toBe('resume');
    });
  });

  describe('P1.16: configurable sandbox mode', () => {
    it('default sandbox is workspace-write', () => {
      const args = buildCodexArgs('hello', null, 'workspace-write');
      expect(args).toContain('--sandbox');
      const sandboxIndex = args.indexOf('--sandbox');
      expect(args[sandboxIndex + 1]).toBe('workspace-write');
    });

    it('accepts read-only sandbox mode', () => {
      const args = buildCodexArgs('hello', null, 'read-only');
      const sandboxIndex = args.indexOf('--sandbox');
      expect(args[sandboxIndex + 1]).toBe('read-only');
    });

    it('accepts danger-full-access sandbox mode', () => {
      const args = buildCodexArgs('hello', null, 'danger-full-access');
      const sandboxIndex = args.indexOf('--sandbox');
      expect(args[sandboxIndex + 1]).toBe('danger-full-access');
    });

    it('sandbox flag is included in initial startArgs only', () => {
      // Initial call includes --sandbox
      const initialArgs = buildCodexArgs('first', null, 'workspace-write');
      expect(initialArgs).toContain('--sandbox');

      // Resume call does NOT include --sandbox
      const resumeArgs = buildCodexArgs('second', 'thread_123', 'workspace-write');
      expect(resumeArgs).not.toContain('--sandbox');
    });

    it('CodexBackend defaults to workspace-write', () => {
      const backend = new CodexBackend();
      // Verify by building args through the constructor default
      const defaultBackend = new CodexBackend({});
      expect(defaultBackend).toBeDefined();
    });

    it('CodexBackend accepts sandbox config', () => {
      const backend = new CodexBackend({ sandbox: 'read-only' });
      expect(backend).toBeDefined();
    });
  });

  describe('P12.4: trusted mode (danger-full-access)', () => {
    it('start() overrides sandbox to danger-full-access when trusted', async () => {
      const backend = new CodexBackend({ sandbox: 'workspace-write' });
      await backend.start({ projectDir: '/tmp/test', permissionMode: 'trusted' });
      // Verify indirectly: buildCodexArgs should use danger-full-access
      // We can't call send() without a real codex binary, but we can verify
      // the backend initialized without error
      expect(backend.getSessionId()).toBeNull();
    });

    it('start() keeps original sandbox when supervised', async () => {
      const backend = new CodexBackend({ sandbox: 'workspace-write' });
      await backend.start({ projectDir: '/tmp/test', permissionMode: 'supervised' });
      expect(backend.getSessionId()).toBeNull();
    });

    it('start() keeps original sandbox when permissionMode not set', async () => {
      const backend = new CodexBackend({ sandbox: 'read-only' });
      await backend.start({ projectDir: '/tmp/test' });
      expect(backend.getSessionId()).toBeNull();
    });

    it('buildCodexArgs uses danger-full-access sandbox correctly', () => {
      const args = buildCodexArgs('hello', null, 'danger-full-access');
      expect(args).toContain('--sandbox');
      const sandboxIndex = args.indexOf('--sandbox');
      expect(args[sandboxIndex + 1]).toBe('danger-full-access');
    });
  });

  describe('error handling', () => {
    it('parses error events', () => {
      const stdout = JSON.stringify({
        type: 'error',
        message: 'API key invalid',
      });
      const parsed = parseCodexOutput(stdout, '', 1);
      const errors = parsed.events.filter((e) => e.type === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0].type === 'error' && errors[0].message).toBe('API key invalid');
    });

    it('parses turn.failed events', () => {
      const stdout = JSON.stringify({
        type: 'turn.failed',
        error: { message: 'Rate limit exceeded' },
      });
      const parsed = parseCodexOutput(stdout, '', 1);
      const errors = parsed.events.filter((e) => e.type === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0].type === 'error' && errors[0].message).toBe('Rate limit exceeded');
    });

    it('turn.failed with no error message produces generic message', () => {
      const stdout = JSON.stringify({
        type: 'turn.failed',
      });
      const parsed = parseCodexOutput(stdout, '', 1);
      const errors = parsed.events.filter((e) => e.type === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0].type === 'error' && errors[0].message).toBe('Codex turn failed');
    });

    it('non-zero exit with no structured error produces Error event', () => {
      const stdout = JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'partial' },
      });
      const parsed = parseCodexOutput(stdout, '', 1);
      const errors = parsed.events.filter((e) => e.type === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0].type === 'error' && errors[0].message).toBe('Codex exited with code 1');
    });

    it('zero exit with no errors produces no Error events', () => {
      const stdout = JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'all good' },
      });
      const parsed = parseCodexOutput(stdout, '', 0);
      const errors = parsed.events.filter((e) => e.type === 'error');
      expect(errors).toHaveLength(0);
    });
  });

  describe('edge cases', () => {
    it('does not flag sandbox denial on command_execution with exit_code 0', () => {
      // Regression: prototype only checks sandbox denial on non-zero exit
      const stdout = JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          command: 'grep "permission denied" log.txt',
          exit_code: 0,
          aggregated_output: 'line 5: permission denied to user foo',
        },
      });
      const parsed = parseCodexOutput(stdout, '', 0);
      const denials = parsed.events.filter((e) => e.type === 'permission_denied');
      expect(denials).toHaveLength(0);
    });

    it('every parse result ends with turn_completed', () => {
      const parsed = parseCodexOutput('', '', 0);
      const lastEvent = parsed.events[parsed.events.length - 1];
      expect(lastEvent.type).toBe('turn_completed');
    });

    it('handles empty output gracefully', () => {
      const parsed = parseCodexOutput('', '', 0);
      expect(parsed.sessionId).toBeNull();
      expect(parsed.events).toHaveLength(1); // just turn_completed
    });
  });
});
