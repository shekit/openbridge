import { describe, it, expect, afterEach } from 'vitest';
import { spawnCollect } from '../backends/claude.js';
import { startIpcServer, resolvePermission, type IpcHandler } from '../mcp/ipc-server.js';
import * as path from 'node:path';

const HOOK_SCRIPT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../dist/hooks/pre-tool-use.js',
);

/** Run the hook script with JSON input on stdin and optional env vars. */
async function runHook(
  input: Record<string, unknown>,
  env?: Record<string, string>,
): Promise<{ output: Record<string, unknown> | null; exitCode: number; stderr: string }> {
  const inputJson = JSON.stringify(input);
  const envStr = env ? JSON.stringify(env) : '{}';
  const handle = spawnCollect(
    'node',
    ['-e', `
      const { spawn } = require('child_process');
      const env = { ...process.env, ...${envStr} };
      const proc = spawn('node', ['${HOOK_SCRIPT}'], { stdio: ['pipe', 'pipe', 'pipe'], env });
      proc.stdin.write(${JSON.stringify(inputJson)});
      proc.stdin.end();
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', c => stdout += c);
      proc.stderr.on('data', c => stderr += c);
      proc.on('close', (code) => {
        process.stdout.write(JSON.stringify({ exitCode: code, stdout, stderr }));
      });
    `],
    process.cwd(),
  );
  const result = await handle.result;
  const parsed = JSON.parse(result.stdout.trim());
  let output: Record<string, unknown> | null = null;
  const trimmedStdout = parsed.stdout?.trim();
  if (trimmedStdout) {
    try {
      output = JSON.parse(trimmedStdout);
    } catch { /* empty */ }
  }
  return { output, exitCode: parsed.exitCode, stderr: parsed.stderr ?? '' };
}

describe('PreToolUse hook script', () => {
  it('auto-approves mcp__openbridge__ tools', async () => {
    const { output } = await runHook({
      tool_name: 'mcp__openbridge__preview_server',
      tool_input: { directory: '.' },
    });
    expect(output).not.toBeNull();
    const decision = (output as any)?.hookSpecificOutput;
    expect(decision.hookEventName).toBe('PreToolUse');
    expect(decision.permissionDecision).toBe('allow');
  });

  it('auto-approves mcp__openbridge__serve_file_browser', async () => {
    const { output } = await runHook({
      tool_name: 'mcp__openbridge__serve_file_browser',
      tool_input: { directory: '.' },
    });
    expect(output).not.toBeNull();
    expect((output as any)?.hookSpecificOutput?.hookEventName).toBe('PreToolUse');
    expect((output as any)?.hookSpecificOutput?.permissionDecision).toBe('allow');
  });

  it('defers to default for Bash when no IPC configured', async () => {
    const { output, exitCode } = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'npx serve' },
    });
    // No IPC env vars → exit 0 with no output
    expect(output).toBeNull();
    expect(exitCode).toBe(0);
  });

  it('defers to default for non-permission tools (Read, Glob, etc.)', async () => {
    const { output, exitCode } = await runHook({
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/file.txt' },
    });
    expect(output).toBeNull();
    expect(exitCode).toBe(0);
  });

  it('handles invalid JSON input gracefully', async () => {
    const handle = spawnCollect(
      'node',
      ['-e', `
        const { spawn } = require('child_process');
        const proc = spawn('node', ['${HOOK_SCRIPT}'], { stdio: ['pipe', 'pipe', 'pipe'] });
        proc.stdin.write('not valid json');
        proc.stdin.end();
        let stdout = '';
        proc.stdout.on('data', c => stdout += c);
        proc.on('close', (code) => {
          process.stdout.write(JSON.stringify({ exitCode: code, stdout }));
        });
      `],
      process.cwd(),
    );
    const result = await handle.result;
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.exitCode).toBe(0);
  });

  // --- Integration test with real IPC server ---

  describe('with IPC server', () => {
    let server: { port: number; secret: string; close: () => Promise<void> };

    afterEach(async () => {
      if (server) await server.close();
    });

    it('sends permission request to IPC and returns allow when user approves', async () => {
      // Start a real IPC server
      const handler: IpcHandler = {
        uploadFile: async () => {},
        openTunnel: async () => 'https://t.example.com',
        serveFileBrowser: async () => 'https://b.example.com',
        postMessage: async () => {},
        requestPermission: async (_ch, _th, _tool, _input, _plat, requestId) => {
          // Simulate user clicking Allow after a short delay
          setTimeout(() => resolvePermission(requestId, 'allow'), 200);
        },
      };
      server = await startIpcServer(handler);

      const { output, exitCode, stderr } = await runHook(
        { tool_name: 'Bash', tool_input: { command: 'npx serve -p 3000' } },
        {
          OPENBRIDGE_IPC_PORT: String(server.port),
          OPENBRIDGE_IPC_SECRET: server.secret,
          OPENBRIDGE_CHANNEL_ID: 'C123',
          OPENBRIDGE_THREAD_ID: 'T456',
          OPENBRIDGE_PLATFORM: 'slack',
        },
      );

      expect(exitCode).toBe(0);
      expect(output).not.toBeNull();
      expect((output as any)?.hookSpecificOutput?.hookEventName).toBe('PreToolUse');
      expect((output as any)?.hookSpecificOutput?.permissionDecision).toBe('allow');
      expect(stderr).toContain('waiting for decision');
      expect(stderr).toContain('decision: allow');
    }, 15000);

    it('returns deny when user denies permission', async () => {
      const handler: IpcHandler = {
        uploadFile: async () => {},
        openTunnel: async () => 'https://t.example.com',
        serveFileBrowser: async () => 'https://b.example.com',
        postMessage: async () => {},
        requestPermission: async (_ch, _th, _tool, _input, _plat, requestId) => {
          setTimeout(() => resolvePermission(requestId, 'deny'), 200);
        },
      };
      server = await startIpcServer(handler);

      const { output, exitCode } = await runHook(
        { tool_name: 'Write', tool_input: { file_path: '/tmp/x.txt' } },
        {
          OPENBRIDGE_IPC_PORT: String(server.port),
          OPENBRIDGE_IPC_SECRET: server.secret,
          OPENBRIDGE_CHANNEL_ID: 'C123',
          OPENBRIDGE_THREAD_ID: 'T456',
          OPENBRIDGE_PLATFORM: 'discord',
        },
      );

      expect(exitCode).toBe(0);
      expect(output).not.toBeNull();
      expect((output as any)?.hookSpecificOutput?.hookEventName).toBe('PreToolUse');
      expect((output as any)?.hookSpecificOutput?.permissionDecision).toBe('deny');
    }, 15000);
  });
});
