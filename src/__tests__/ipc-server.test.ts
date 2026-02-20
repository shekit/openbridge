/**
 * Tests for the IPC server (src/mcp/ipc-server.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startIpcServer, type IpcHandler, type IpcServer } from '../mcp/ipc-server.js';

/** Helper to POST JSON to the IPC server. */
async function post(
  server: IpcServer,
  path: string,
  body: Record<string, unknown>,
  secret?: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-openbridge-secret': secret ?? server.secret,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, body: json };
}

describe('IPC Server', () => {
  let handler: IpcHandler;
  let server: IpcServer;

  beforeEach(async () => {
    handler = {
      uploadFile: vi.fn().mockResolvedValue(undefined),
      openTunnel: vi.fn().mockResolvedValue('https://tunnel.example.com'),
      serveFileBrowser: vi.fn().mockResolvedValue('https://browser.example.com'),
      postMessage: vi.fn().mockResolvedValue(undefined),
    };
    server = await startIpcServer(handler);
  });

  afterEach(async () => {
    await server.close();
  });

  it('starts on a random port with a secret', () => {
    expect(server.port).toBeGreaterThan(0);
    expect(server.secret).toBeTruthy();
    expect(server.secret.length).toBeGreaterThan(10); // UUID
  });

  // --- Auth ---

  it('rejects requests without the secret', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/upload-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('Unauthorized');
  });

  it('rejects requests with a wrong secret', async () => {
    const { status, body } = await post(server, '/upload-file', {}, 'wrong-secret');
    expect(status).toBe(401);
    expect(body.error).toBe('Unauthorized');
  });

  // --- Method enforcement ---

  it('rejects non-POST requests', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/upload-file`, {
      method: 'GET',
      headers: { 'x-openbridge-secret': server.secret },
    });
    expect(res.status).toBe(405);
    const json = await res.json();
    expect(json.error).toBe('Method not allowed');
  });

  // --- Bad JSON ---

  it('rejects invalid JSON body', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/upload-file`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-openbridge-secret': server.secret,
      },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('Invalid JSON');
  });

  // --- Unknown route ---

  it('returns 404 for unknown routes', async () => {
    const { status, body } = await post(server, '/unknown', {});
    expect(status).toBe(404);
    expect(body.error).toBe('Not found');
  });

  // --- /upload-file ---

  it('calls handler.uploadFile on POST /upload-file', async () => {
    const { status, body } = await post(server, '/upload-file', {
      channelId: 'C123',
      threadId: 'T456',
      filePath: '/tmp/test.png',
      platform: 'slack',
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(handler.uploadFile).toHaveBeenCalledWith('C123', 'T456', '/tmp/test.png', 'slack');
  });

  // --- /open-tunnel ---

  it('calls handler.openTunnel on POST /open-tunnel', async () => {
    const { status, body } = await post(server, '/open-tunnel', {
      port: 3000,
      ttl: 600,
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.url).toBe('https://tunnel.example.com');
    expect(handler.openTunnel).toHaveBeenCalledWith(3000, 600);
  });

  // --- /serve-file-browser ---

  it('calls handler.serveFileBrowser on POST /serve-file-browser', async () => {
    const { status, body } = await post(server, '/serve-file-browser', {
      directory: '/tmp/project',
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.url).toBe('https://browser.example.com');
    expect(handler.serveFileBrowser).toHaveBeenCalledWith('/tmp/project');
  });

  // --- /post-message ---

  it('calls handler.postMessage on POST /post-message', async () => {
    const { status, body } = await post(server, '/post-message', {
      channelId: 'C789',
      threadId: 'T012',
      text: 'Hello from agent',
      platform: 'discord',
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(handler.postMessage).toHaveBeenCalledWith('C789', 'T012', 'Hello from agent', 'discord');
  });

  // --- Handler errors ---

  it('returns 500 when handler throws', async () => {
    vi.mocked(handler.uploadFile).mockRejectedValue(new Error('Upload failed'));
    const { status, body } = await post(server, '/upload-file', {
      channelId: 'C123',
      threadId: 'T456',
      filePath: '/tmp/test.png',
      platform: 'slack',
    });
    expect(status).toBe(500);
    expect(body.error).toBe('Upload failed');
  });

  // --- Close ---

  it('can be closed and stops accepting connections', async () => {
    await server.close();
    await expect(
      fetch(`http://127.0.0.1:${server.port}/upload-file`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-openbridge-secret': server.secret,
        },
        body: JSON.stringify({}),
      })
    ).rejects.toThrow();
    // Prevent afterEach from double-closing
    server = { port: 0, secret: '', close: async () => {} };
  });
});
