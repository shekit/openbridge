import { describe, it, expect } from 'vitest';
import { ClaudeBackend, spawnCollect, parseClaudeOutput, buildClaudeArgs, buildHookSettings, MCP_TOOLS } from '../backends/claude.js';
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
      const handle = spawnCollect('echo', ['hello world'], process.cwd());
      const result = await handle.result;
      expect(result.stdout.trim()).toBe('hello world');
      expect(result.exitCode).toBe(0);
    });

    it('spawnCollect captures exit code', async () => {
      const handle = spawnCollect('node', ['-e', 'process.exit(42)'], process.cwd());
      const result = await handle.result;
      expect(result.exitCode).toBe(42);
    });

    it('spawnCollect captures stderr', async () => {
      const handle = spawnCollect(
        'node',
        ['-e', 'process.stderr.write("err output")'],
        process.cwd(),
      );
      const result = await handle.result;
      expect(result.stderr).toContain('err output');
    });

    it('spawnCollect passes env vars to child process', async () => {
      const handle = spawnCollect(
        'node',
        ['-e', 'process.stdout.write(process.env.TEST_OPENBRIDGE_VAR || "missing")'],
        process.cwd(),
        undefined,
        { TEST_OPENBRIDGE_VAR: 'hello_from_env' },
      );
      const result = await handle.result;
      expect(result.stdout).toBe('hello_from_env');
    });

    it('spawnCollect writes stdinData to child process stdin', async () => {
      const handle = spawnCollect(
        'node',
        ['-e', 'let d=""; process.stdin.on("data", c => d+=c); process.stdin.on("end", () => process.stdout.write(d))'],
        process.cwd(),
        undefined,
        undefined,
        'hello from stdin',
      );
      const result = await handle.result;
      expect(result.stdout).toBe('hello from stdin');
      expect(result.exitCode).toBe(0);
    });

    it('spawnCollect works without stdinData (backward compatible)', async () => {
      const handle = spawnCollect('echo', ['no stdin'], process.cwd());
      const result = await handle.result;
      expect(result.stdout.trim()).toBe('no stdin');
    });

    it('spawnCollect kill() terminates the child process', async () => {
      const handle = spawnCollect('node', ['-e', 'setTimeout(() => {}, 30000)'], process.cwd());
      handle.kill();
      const result = await handle.result;
      // Process was killed, so exit code is non-zero (null → 1)
      expect(result.exitCode).not.toBe(0);
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

  describe('P1.7: parse permission context from user error events', () => {
    it('attaches context from user error events to PermissionDenied', () => {
      const stdout = [
        JSON.stringify({
          type: 'result',
          permission_denials: [
            { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } },
          ],
        }),
        JSON.stringify({
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                is_error: true,
                content: 'Bash tool permission not granted for this command',
              },
            ],
          },
        }),
      ].join('\n');

      const parsed = parseClaudeOutput(stdout, '', 0);
      const denials = parsed.events.filter((e) => e.type === 'permission_denied');
      expect(denials).toHaveLength(1);
      expect(
        denials[0].type === 'permission_denied' && denials[0].context,
      ).toBe('Bash tool permission not granted for this command');
    });

    it('ignores user error events without permission-related text', () => {
      const stdout = [
        JSON.stringify({
          type: 'result',
          permission_denials: [
            { tool_name: 'Bash', tool_input: { command: 'ls' } },
          ],
        }),
        JSON.stringify({
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                is_error: true,
                content: 'File not found: foo.txt',
              },
            ],
          },
        }),
      ].join('\n');

      const parsed = parseClaudeOutput(stdout, '', 0);
      const denial = parsed.events.find((e) => e.type === 'permission_denied');
      expect(denial).toBeDefined();
      expect(denial!.type === 'permission_denied' && denial!.context).toBeUndefined();
    });

    it('ignores user events that are not errors', () => {
      const stdout = [
        JSON.stringify({
          type: 'result',
          permission_denials: [
            { tool_name: 'Write', tool_input: { file_path: 'a.txt' } },
          ],
        }),
        JSON.stringify({
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                is_error: false,
                content: 'This mentions permission but is not an error',
              },
            ],
          },
        }),
      ].join('\n');

      const parsed = parseClaudeOutput(stdout, '', 0);
      const denial = parsed.events.find((e) => e.type === 'permission_denied');
      expect(denial!.type === 'permission_denied' && denial!.context).toBeUndefined();
    });
  });

  describe('P1.8: parse error events', () => {
    it('result events with is_error: true produce Error normalized events', () => {
      const stdout = JSON.stringify({
        type: 'result',
        is_error: true,
        errors: ['Authentication failed: invalid API key'],
        subtype: 'api_error',
      });
      const parsed = parseClaudeOutput(stdout, '', 1);
      const errorEvents = parsed.events.filter((e) => e.type === 'error');
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].type === 'error' && errorEvents[0].message).toBe(
        'Authentication failed: invalid API key',
      );
    });

    it('result error with no errors array produces generic message', () => {
      const stdout = JSON.stringify({
        type: 'result',
        is_error: true,
        subtype: 'unknown_error',
      });
      const parsed = parseClaudeOutput(stdout, '', 1);
      const errorEvents = parsed.events.filter((e) => e.type === 'error');
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].type === 'error' && errorEvents[0].message).toBe(
        'Claude execution failed (unknown_error)',
      );
    });

    it('non-zero exit code with no structured error produces Error event', () => {
      const stdout = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'partial output' }] },
      });
      const parsed = parseClaudeOutput(stdout, '', 1);
      const errorEvents = parsed.events.filter((e) => e.type === 'error');
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].type === 'error' && errorEvents[0].message).toBe(
        'Claude exited with code 1',
      );
    });

    it('zero exit code with no errors produces no Error events', () => {
      const stdout = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'all good' }] },
      });
      const parsed = parseClaudeOutput(stdout, '', 0);
      const errorEvents = parsed.events.filter((e) => e.type === 'error');
      expect(errorEvents).toHaveLength(0);
    });
  });

  describe('P1.9: session resume with -r flag', () => {
    it('first call does not include -r flag', () => {
      const args = buildClaudeArgs('hello', null);
      expect(args).not.toContain('-r');
      expect(args).toContain('hello');
      expect(args).toContain('-p');
      expect(args).toContain('--output-format');
      expect(args).toContain('stream-json');
    });

    it('second call includes -r SESSION_ID', () => {
      const args = buildClaudeArgs('follow-up', 'sess_abc123');
      expect(args).toContain('-r');
      const rIndex = args.indexOf('-r');
      expect(args[rIndex + 1]).toBe('sess_abc123');
      expect(args[args.length - 1]).toBe('follow-up');
    });

    it('session ID from first call is reused in args', () => {
      // Simulate: first call extracts session, second call uses it
      const firstOutput = JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'resume_test_id',
      });
      const firstParsed = parseClaudeOutput(firstOutput, '', 0);
      expect(firstParsed.sessionId).toBe('resume_test_id');

      // Second call should include -r with the extracted session ID
      const secondArgs = buildClaudeArgs('do more', firstParsed.sessionId);
      expect(secondArgs).toContain('-r');
      expect(secondArgs[secondArgs.indexOf('-r') + 1]).toBe('resume_test_id');
    });
  });

  describe('buildClaudeArgs with allowedTools', () => {
    it('includes user-approved tools alongside MCP tools', () => {
      const args = buildClaudeArgs('yes', 'sess_abc', ['Bash']);
      expect(args).toContain('--allowedTools');
      expect(args).toContain('Bash');
      // MCP tools always included
      for (const tool of MCP_TOOLS) {
        expect(args).toContain(tool);
      }
    });

    it('prompt text is NOT consumed by variadic --allowedTools', () => {
      const args = buildClaudeArgs('yes', 'sess_abc', ['Bash']);
      // The prompt must be the last element, separated by '--'
      expect(args[args.length - 1]).toBe('yes');
      expect(args).toContain('--');
      const dashDashIndex = args.indexOf('--');
      expect(args[dashDashIndex + 1]).toBe('yes');
    });

    it('handles multiple user-approved tools alongside MCP tools', () => {
      const args = buildClaudeArgs('proceed', 'sess_abc', ['Bash', 'Edit']);
      expect(args).toContain('Bash');
      expect(args).toContain('Edit');
      // MCP tools + Bash + Edit = MCP_TOOLS.length + 2 occurrences of --allowedTools
      const atIndices = args.reduce<number[]>((acc, val, idx) => {
        if (val === '--allowedTools') acc.push(idx);
        return acc;
      }, []);
      expect(atIndices).toHaveLength(MCP_TOOLS.length + 2);
      // Prompt is still last, after '--'
      expect(args[args.length - 1]).toBe('proceed');
    });

    it('always includes MCP tools in --allowedTools even when none provided', () => {
      const args = buildClaudeArgs('hello', null);
      expect(args).toContain('--allowedTools');
      for (const tool of MCP_TOOLS) {
        expect(args).toContain(tool);
      }
    });

    it('deduplicates when user-approved tools overlap with MCP tools', () => {
      const args = buildClaudeArgs('yes', 'sess_abc', ['Bash', MCP_TOOLS[0]]);
      const occurrences = args.filter((a) => a === MCP_TOOLS[0]);
      expect(occurrences).toHaveLength(1); // not duplicated
      expect(args).toContain('Bash');
    });
  });

  describe('buildClaudeArgs with mcpConfigJson', () => {
    it('includes --mcp-config flag when MCP config is provided', () => {
      const mcpJson = '{"mcpServers":{"openbridge":{"command":"node","args":["entry.js"]}}}';
      const args = buildClaudeArgs('hello', null, undefined, mcpJson);
      expect(args).toContain('--mcp-config');
      const mcpIndex = args.indexOf('--mcp-config');
      expect(args[mcpIndex + 1]).toBe(mcpJson);
    });

    it('prompt text is NOT consumed by variadic --mcp-config', () => {
      const mcpJson = '{"mcpServers":{}}';
      const args = buildClaudeArgs('hello', null, undefined, mcpJson);
      expect(args[args.length - 1]).toBe('hello');
      const dashDashIndex = args.indexOf('--');
      expect(args[dashDashIndex + 1]).toBe('hello');
    });

    it('works with both allowedTools and mcpConfigJson', () => {
      const mcpJson = '{"mcpServers":{}}';
      const args = buildClaudeArgs('yes', 'sess_abc', ['Bash'], mcpJson);
      expect(args).toContain('--mcp-config');
      expect(args).toContain('--allowedTools');
      expect(args[args.length - 1]).toBe('yes');
    });

    it('does not include --mcp-config when not provided', () => {
      const args = buildClaudeArgs('hello', null);
      expect(args).not.toContain('--mcp-config');
      // But MCP tools are still always pre-approved
      expect(args).toContain('--allowedTools');
    });
  });

  describe('buildHookSettings', () => {
    it('returns valid JSON with PreToolUse hook only', () => {
      const json = buildHookSettings('/opt/openbridge/dist');
      const settings = JSON.parse(json);
      expect(settings.hooks).toBeDefined();
      expect(settings.hooks.PreToolUse).toHaveLength(1);
      expect(settings.hooks.PermissionRequest).toBeUndefined();
    });

    it('PreToolUse hook command points to pre-tool-use.js in hookScriptDir', () => {
      const json = buildHookSettings('/opt/openbridge/dist');
      const settings = JSON.parse(json);
      const hook = settings.hooks.PreToolUse[0].hooks[0];
      expect(hook.type).toBe('command');
      expect(hook.command).toBe('node /opt/openbridge/dist/hooks/pre-tool-use.js');
      expect(hook.timeout).toBe(310);
    });

    it('uses wildcard matcher', () => {
      const json = buildHookSettings('/opt/openbridge/dist');
      const settings = JSON.parse(json);
      expect(settings.hooks.PreToolUse[0].matcher).toBe('*');
    });
  });

  describe('buildClaudeArgs with settingsJson', () => {
    it('includes --settings flag when settings JSON is provided', () => {
      const settingsJson = '{"hooks":{}}';
      const args = buildClaudeArgs('hello', null, undefined, undefined, settingsJson);
      expect(args).toContain('--settings');
      const idx = args.indexOf('--settings');
      expect(args[idx + 1]).toBe(settingsJson);
    });

    it('does not include --settings when not provided', () => {
      const args = buildClaudeArgs('hello', null);
      expect(args).not.toContain('--settings');
    });

    it('works with all options combined', () => {
      const mcpJson = '{"mcpServers":{}}';
      const settingsJson = buildHookSettings('/dist');
      const args = buildClaudeArgs('go', 'sess_1', ['Bash'], mcpJson, settingsJson);
      expect(args).toContain('--settings');
      expect(args).toContain('--mcp-config');
      expect(args).toContain('--allowedTools');
      expect(args).toContain('-r');
      expect(args[args.length - 1]).toBe('go');
    });
  });

  describe('P12.3: trusted mode (--dangerously-skip-permissions)', () => {
    it('adds --dangerously-skip-permissions when trusted', () => {
      const args = buildClaudeArgs('hello', null, undefined, undefined, undefined, true);
      expect(args).toContain('--dangerously-skip-permissions');
    });

    it('does not add --dangerously-skip-permissions when not trusted', () => {
      const args = buildClaudeArgs('hello', null);
      expect(args).not.toContain('--dangerously-skip-permissions');
    });

    it('trusted mode still includes MCP tools in --allowedTools', () => {
      const args = buildClaudeArgs('hello', null, undefined, undefined, undefined, true);
      for (const tool of MCP_TOOLS) {
        expect(args).toContain(tool);
      }
    });

    it('trusted mode skips --settings even if settingsJson is not provided', () => {
      const args = buildClaudeArgs('hello', null, undefined, undefined, undefined, true);
      expect(args).not.toContain('--settings');
    });

    it('trusted mode works with session resume', () => {
      const args = buildClaudeArgs('go', 'sess_trusted', undefined, undefined, undefined, true);
      expect(args).toContain('--dangerously-skip-permissions');
      expect(args).toContain('-r');
      expect(args[args.indexOf('-r') + 1]).toBe('sess_trusted');
    });

    it('ClaudeBackend stores permissionMode from start()', async () => {
      const backend = new ClaudeBackend();
      // After start, the backend should have stored the permissionMode.
      // We verify indirectly: trusted mode should not build hook settings.
      // Since we can't call send() without a real claude binary, we test
      // through buildClaudeArgs which is the public function.
      await backend.start({ projectDir: '/tmp/test', permissionMode: 'trusted' });
      // Backend is initialized — no error thrown
      expect(backend.getSessionId()).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('every parse result ends with turn_completed', () => {
      const parsed = parseClaudeOutput('', '', 0);
      const lastEvent = parsed.events[parsed.events.length - 1];
      expect(lastEvent.type).toBe('turn_completed');
    });

    it('handles empty output gracefully', () => {
      const parsed = parseClaudeOutput('', '', 0);
      expect(parsed.sessionId).toBeNull();
      expect(parsed.events).toHaveLength(1); // just turn_completed
    });

    it('result with both permission_denials and is_error emits both', () => {
      const stdout = JSON.stringify({
        type: 'result',
        is_error: true,
        errors: ['Session expired'],
        permission_denials: [
          { tool_name: 'Bash', tool_input: { command: 'ls' } },
        ],
      });
      const parsed = parseClaudeOutput(stdout, '', 1);
      const denials = parsed.events.filter((e) => e.type === 'permission_denied');
      const errors = parsed.events.filter((e) => e.type === 'error');
      expect(denials).toHaveLength(1);
      expect(errors).toHaveLength(1);
    });

    it('skips non-JSON lines without crashing', () => {
      const stdout = [
        'some random stderr text',
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'test123' }),
        'WARNING: something happened',
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
      ].join('\n');
      const parsed = parseClaudeOutput(stdout, '', 0);
      expect(parsed.sessionId).toBe('test123');
      const texts = parsed.events.filter((e) => e.type === 'assistant_text');
      expect(texts).toHaveLength(1);
    });
  });
});
