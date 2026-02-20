/**
 * Tests for MCP entry point (src/mcp/entry.ts) and updated getMcpConfig.
 *
 * The entry script is a CLI process, so we test:
 * 1. getMcpConfig generates correct args/env (unit)
 * 2. The entry script wires callbacks to the IPC server (integration)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getMcpConfig } from '../mcp/server.js';
import { startIpcServer, type IpcHandler, type IpcServer } from '../mcp/ipc-server.js';

describe('getMcpConfig (updated)', () => {
  it('includes --platform arg and IPC env vars', () => {
    const config = getMcpConfig(
      '/path/to/entry.js',
      { channelId: 'C123', threadId: 'T456', projectDir: '/proj', platform: 'slack' },
      { port: 12345, secret: 'test-secret' },
    );
    expect(config).toEqual({
      command: 'node',
      args: [
        '/path/to/entry.js',
        '--channel', 'C123',
        '--thread', 'T456',
        '--project-dir', '/proj',
        '--platform', 'slack',
      ],
      env: {
        OPENBRIDGE_IPC_PORT: '12345',
        OPENBRIDGE_IPC_SECRET: 'test-secret',
      },
    });
  });

  it('works with discord platform', () => {
    const config = getMcpConfig(
      '/entry.js',
      { channelId: 'D789', threadId: 'M012', projectDir: '/app', platform: 'discord' },
      { port: 9999, secret: 'sec' },
    );
    const args = config.args as string[];
    expect(args).toContain('--platform');
    expect(args[args.indexOf('--platform') + 1]).toBe('discord');
  });
});

describe('MCP entry → IPC integration', () => {
  let handler: IpcHandler;
  let server: IpcServer;

  beforeEach(async () => {
    handler = {
      uploadFile: vi.fn().mockResolvedValue(undefined),
      openTunnel: vi.fn().mockResolvedValue('https://tunnel.test'),
      serveFileBrowser: vi.fn().mockResolvedValue('https://browser.test'),
      postMessage: vi.fn().mockResolvedValue(undefined),
    };
    server = await startIpcServer(handler);
  });

  afterEach(async () => {
    await server.close();
  });

  /**
   * Simulate what the entry script does: POST to IPC server via fetch.
   * This validates the contract between entry.ts callbacks and ipc-server.ts routes.
   */
  async function ipcPost(path: string, body: Record<string, unknown>) {
    const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-openbridge-secret': server.secret,
      },
      body: JSON.stringify(body),
    });
    return res.json() as Promise<Record<string, unknown>>;
  }

  it('uploadFile callback routes through IPC', async () => {
    await ipcPost('/upload-file', {
      channelId: 'C1',
      threadId: 'T1',
      filePath: '/tmp/screenshot.png',
      platform: 'slack',
    });
    expect(handler.uploadFile).toHaveBeenCalledWith('C1', 'T1', '/tmp/screenshot.png', 'slack');
  });

  it('openTunnel callback routes through IPC and returns URL', async () => {
    const result = await ipcPost('/open-tunnel', { port: 3000, ttl: 600 });
    expect(result.url).toBe('https://tunnel.test');
    expect(handler.openTunnel).toHaveBeenCalledWith(3000, 600);
  });

  it('serveFileBrowser callback routes through IPC and returns URL', async () => {
    const result = await ipcPost('/serve-file-browser', { directory: '/proj/dist' });
    expect(result.url).toBe('https://browser.test');
    expect(handler.serveFileBrowser).toHaveBeenCalledWith('/proj/dist');
  });

  it('postMessage callback routes through IPC', async () => {
    await ipcPost('/post-message', {
      channelId: 'C2',
      threadId: 'T2',
      text: 'Tunnel opened: https://tunnel.test',
      platform: 'discord',
    });
    expect(handler.postMessage).toHaveBeenCalledWith(
      'C2', 'T2', 'Tunnel opened: https://tunnel.test', 'discord',
    );
  });
});
