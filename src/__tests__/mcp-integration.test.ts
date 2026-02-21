/**
 * Integration test: full IPC → callback handler → adapter flow.
 *
 * Simulates the complete path: MCP entry script POSTs to IPC server,
 * callback handler routes to the correct adapter method.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startIpcServer, type IpcServer } from '../mcp/ipc-server.js';
import { createCallbackHandler } from '../mcp/callbacks.js';
import type { Adapter } from '../types/adapter.js';

// Mock tunnel and file-browser to avoid spawning real processes
vi.mock('../mcp/tunnel.js', () => ({
  openTunnel: vi.fn(async () => ({
    url: 'https://mock-tunnel.example.com',
    close: vi.fn(),
  })),
  closeAllTunnels: vi.fn(),
}));

vi.mock('../mcp/file-browser.js', () => ({
  startFileBrowser: vi.fn(async () => ({
    port: 54321,
    close: vi.fn(),
  })),
}));

vi.mock('../mcp/preview-server.js', () => ({
  startPreviewServer: vi.fn(async () => ({
    url: 'https://mock-preview.example.com',
    port: 9876,
    close: vi.fn(),
  })),
}));

function createMockAdapter(): Adapter {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    postText: vi.fn(),
    postPermissionPrompt: vi.fn(),
    postError: vi.fn(),
    uploadFile: vi.fn(),
    sendMessage: vi.fn(),
  } as unknown as Adapter;
}

/** POST JSON to the IPC server (simulates what the MCP entry script does). */
async function ipcPost(
  server: IpcServer,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-openbridge-secret': server.secret,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, body: json };
}

describe('MCP Integration: IPC → Callback Handler → Adapter', () => {
  let slackAdapter: Adapter;
  let discordAdapter: Adapter;
  let ipcServer: IpcServer;

  beforeEach(async () => {
    slackAdapter = createMockAdapter();
    discordAdapter = createMockAdapter();

    const adapters = new Map<string, Adapter>([
      ['slack', slackAdapter],
      ['discord', discordAdapter],
    ]);

    const handler = createCallbackHandler({ adapters });
    ipcServer = await startIpcServer(handler);
  });

  afterEach(async () => {
    await ipcServer.close();
  });

  it('upload_file → IPC → callback → slack adapter.uploadFile', async () => {
    const { status, body } = await ipcPost(ipcServer, '/upload-file', {
      channelId: 'C_SLACK',
      threadId: 'T_123',
      filePath: '/tmp/screenshot.png',
      platform: 'slack',
    });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(slackAdapter.uploadFile).toHaveBeenCalledWith(
      'C_SLACK', 'T_123', '/tmp/screenshot.png',
    );
    expect(discordAdapter.uploadFile).not.toHaveBeenCalled();
  });

  it('upload_file → IPC → callback → discord adapter.uploadFile', async () => {
    const { status, body } = await ipcPost(ipcServer, '/upload-file', {
      channelId: 'D_CHAN',
      threadId: 'M_456',
      filePath: '/tmp/output.pdf',
      platform: 'discord',
    });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(discordAdapter.uploadFile).toHaveBeenCalledWith(
      'D_CHAN', 'M_456', '/tmp/output.pdf',
    );
    expect(slackAdapter.uploadFile).not.toHaveBeenCalled();
  });

  it('post_message → IPC → callback → correct adapter.sendMessage', async () => {
    const { status } = await ipcPost(ipcServer, '/post-message', {
      channelId: 'C_SLACK',
      threadId: 'T_789',
      text: 'Tunnel opened: https://example.com',
      platform: 'slack',
    });

    expect(status).toBe(200);
    expect(slackAdapter.sendMessage).toHaveBeenCalledWith(
      'C_SLACK', 'T_789', 'Tunnel opened: https://example.com',
    );
  });

  it('open_tunnel → IPC → callback → returns tunnel URL', async () => {
    const { status, body } = await ipcPost(ipcServer, '/open-tunnel', {
      port: 3000,
      ttl: 600,
    });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.url).toBe('https://mock-tunnel.example.com');
  });

  it('serve_file_browser → IPC → callback → starts browser + tunnel, returns URL', async () => {
    const { status, body } = await ipcPost(ipcServer, '/serve-file-browser', {
      directory: '/tmp/project',
    });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.url).toBe('https://mock-tunnel.example.com');
  });

  it('returns 500 for unknown platform on upload', async () => {
    const { status, body } = await ipcPost(ipcServer, '/upload-file', {
      channelId: 'C1',
      threadId: 'T1',
      filePath: '/tmp/file.txt',
      platform: 'teams',
    });

    expect(status).toBe(500);
    expect(body.error).toContain('No adapter registered for platform: teams');
  });

  it('rejects unauthorized requests through the full stack', async () => {
    const res = await fetch(`http://127.0.0.1:${ipcServer.port}/upload-file`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-openbridge-secret': 'wrong-secret',
      },
      body: JSON.stringify({
        channelId: 'C1',
        threadId: 'T1',
        filePath: '/tmp/file.txt',
        platform: 'slack',
      }),
    });

    expect(res.status).toBe(401);
    expect(slackAdapter.uploadFile).not.toHaveBeenCalled();
  });
});
