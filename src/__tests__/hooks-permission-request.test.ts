import { describe, it, expect, vi, afterEach } from 'vitest';
import { startIpcServer, resolvePermission, type IpcHandler, type IpcServer } from '../mcp/ipc-server.js';
import { spawnCollect } from '../backends/claude.js';
import * as path from 'node:path';

const HOOK_SCRIPT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../dist/hooks/permission-request.js',
);

/** Run the hook script with JSON input and env vars, return parsed stdout. */
async function runHook(
  input: Record<string, unknown>,
  env: Record<string, string>,
): Promise<Record<string, unknown>> {
  const inputJson = JSON.stringify(input);
  const handle = spawnCollect(
    'node',
    ['-e', `
      const { spawn } = require('child_process');
      const proc = spawn('node', ['${HOOK_SCRIPT}'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...${JSON.stringify(env)} },
      });
      proc.stdin.write(${JSON.stringify(inputJson)});
      proc.stdin.end();
      let stdout = '';
      proc.stdout.on('data', c => stdout += c);
      proc.on('close', () => {
        process.stdout.write(stdout);
      });
    `],
    process.cwd(),
  );
  const result = await handle.result;
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    return { raw: result.stdout };
  }
}

describe('PermissionRequest hook script', () => {
  let handler: IpcHandler;
  let server: IpcServer;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined as any;
    }
  });

  it('sends permission request to IPC and returns allow when resolved', async () => {
    handler = {
      uploadFile: vi.fn().mockResolvedValue(undefined),
      openTunnel: vi.fn().mockResolvedValue(''),
      serveFileBrowser: vi.fn().mockResolvedValue(''),
      postMessage: vi.fn().mockResolvedValue(undefined),
      requestPermission: vi.fn().mockImplementation(
        async (_ch, _th, _tool, _input, _platform, requestId) => {
          // Simulate user clicking Allow after a short delay
          setTimeout(() => resolvePermission(requestId, 'allow'), 200);
        },
      ),
    };
    server = await startIpcServer(handler);

    const output = await runHook(
      { tool_name: 'Bash', tool_input: { command: 'npx serve' } },
      {
        OPENBRIDGE_IPC_PORT: String(server.port),
        OPENBRIDGE_IPC_SECRET: server.secret,
        OPENBRIDGE_CHANNEL_ID: 'C123',
        OPENBRIDGE_THREAD_ID: 'T456',
        OPENBRIDGE_PLATFORM: 'slack',
        OPENBRIDGE_HOOK_TIMEOUT_MS: '10000',
      },
    );

    const decision = (output as any)?.hookSpecificOutput?.decision;
    expect(decision).toBeDefined();
    expect(decision.behavior).toBe('allow');
    expect(handler.requestPermission).toHaveBeenCalled();
  });

  it('returns deny when user denies permission', async () => {
    handler = {
      uploadFile: vi.fn().mockResolvedValue(undefined),
      openTunnel: vi.fn().mockResolvedValue(''),
      serveFileBrowser: vi.fn().mockResolvedValue(''),
      postMessage: vi.fn().mockResolvedValue(undefined),
      requestPermission: vi.fn().mockImplementation(
        async (_ch, _th, _tool, _input, _platform, requestId) => {
          setTimeout(() => resolvePermission(requestId, 'deny'), 200);
        },
      ),
    };
    server = await startIpcServer(handler);

    const output = await runHook(
      { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } },
      {
        OPENBRIDGE_IPC_PORT: String(server.port),
        OPENBRIDGE_IPC_SECRET: server.secret,
        OPENBRIDGE_CHANNEL_ID: 'C123',
        OPENBRIDGE_THREAD_ID: 'T456',
        OPENBRIDGE_PLATFORM: 'slack',
        OPENBRIDGE_HOOK_TIMEOUT_MS: '10000',
      },
    );

    const decision = (output as any)?.hookSpecificOutput?.decision;
    expect(decision.behavior).toBe('deny');
    expect(decision.message).toBe('User denied permission');
  });

  it('denies when env vars are missing', async () => {
    const output = await runHook(
      { tool_name: 'Bash', tool_input: {} },
      {}, // no env vars
    );

    const decision = (output as any)?.hookSpecificOutput?.decision;
    expect(decision.behavior).toBe('deny');
    expect(decision.message).toContain('not configured');
  });

  it('denies on invalid JSON input', async () => {
    const handle = spawnCollect(
      'node',
      ['-e', `
        const { spawn } = require('child_process');
        const proc = spawn('node', ['${HOOK_SCRIPT}'], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: process.env,
        });
        proc.stdin.write('not json');
        proc.stdin.end();
        let stdout = '';
        proc.stdout.on('data', c => stdout += c);
        proc.on('close', () => { process.stdout.write(stdout); });
      `],
      process.cwd(),
    );
    const result = await handle.result;
    const output = JSON.parse(result.stdout.trim());
    expect(output.hookSpecificOutput.decision.behavior).toBe('deny');
  });
});
