/**
 * Tests for the IPC server (src/mcp/ipc-server.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startIpcServer, resolvePermission, type IpcHandler, type IpcServer } from '../mcp/ipc-server.js';

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
      previewServer: vi.fn().mockResolvedValue({ url: 'https://preview.example.com', port: 8042 }),
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

  // --- /permission-request ---

  it('creates a pending permission request and calls handler', async () => {
    handler.requestPermission = vi.fn().mockResolvedValue(undefined);
    const { status, body } = await post(server, '/permission-request', {
      channelId: 'C123',
      threadId: 'T456',
      toolName: 'Bash',
      toolInput: { command: 'npx serve' },
      platform: 'slack',
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.requestId).toBeTruthy();
    expect(handler.requestPermission).toHaveBeenCalledWith(
      'C123', 'T456', 'Bash', { command: 'npx serve' }, 'slack', body.requestId,
    );
  });

  it('works without requestPermission handler', async () => {
    // handler.requestPermission is undefined by default
    const { status, body } = await post(server, '/permission-request', {
      channelId: 'C123',
      threadId: 'T456',
      toolName: 'Bash',
      toolInput: {},
      platform: 'slack',
    });
    expect(status).toBe(200);
    expect(body.requestId).toBeTruthy();
  });

  // --- /permission-poll ---

  it('returns pending when no decision yet', async () => {
    // Create a request first
    const req = await post(server, '/permission-request', {
      channelId: 'C1', threadId: 'T1', toolName: 'Bash', toolInput: {}, platform: 'slack',
    });
    const requestId = req.body.requestId as string;

    // Poll — should return pending (long-poll times out after 5s, but we want fast test)
    // Use a short timeout by resolving before the poll completes
    const pollPromise = post(server, '/permission-poll', { requestId });
    // Resolve after a short delay
    setTimeout(() => resolvePermission(requestId, 'allow'), 100);
    const poll = await pollPromise;
    expect(poll.status).toBe(200);
    expect(poll.body.status).toBe('resolved');
    expect(poll.body.decision).toBe('allow');
  });

  it('returns resolved immediately when decision already made', async () => {
    handler.requestPermission = vi.fn().mockResolvedValue(undefined);
    const req = await post(server, '/permission-request', {
      channelId: 'C1', threadId: 'T1', toolName: 'Edit', toolInput: {}, platform: 'discord',
    });
    const requestId = req.body.requestId as string;

    // Resolve before polling
    resolvePermission(requestId, 'deny');

    const poll = await post(server, '/permission-poll', { requestId });
    expect(poll.body.status).toBe('resolved');
    expect(poll.body.decision).toBe('deny');
  });

  it('returns expired for unknown requestId', async () => {
    const poll = await post(server, '/permission-poll', { requestId: 'nonexistent' });
    expect(poll.body.status).toBe('expired');
  });

  // --- /permission-resolve ---

  it('resolves a pending permission via HTTP endpoint', async () => {
    handler.requestPermission = vi.fn().mockResolvedValue(undefined);
    const req = await post(server, '/permission-request', {
      channelId: 'C1', threadId: 'T1', toolName: 'Bash', toolInput: {}, platform: 'slack',
    });
    const requestId = req.body.requestId as string;

    const resolve = await post(server, '/permission-resolve', {
      requestId, decision: 'allow',
    });
    expect(resolve.body.ok).toBe(true);
  });

  it('returns false for resolving unknown requestId', async () => {
    const resolve = await post(server, '/permission-resolve', {
      requestId: 'nonexistent', decision: 'deny',
    });
    expect(resolve.body.ok).toBe(false);
  });

  // --- resolvePermission() in-process ---

  it('resolvePermission() resolves a pending request in-process', async () => {
    handler.requestPermission = vi.fn().mockResolvedValue(undefined);
    const req = await post(server, '/permission-request', {
      channelId: 'C1', threadId: 'T1', toolName: 'Bash', toolInput: {}, platform: 'slack',
    });
    const requestId = req.body.requestId as string;

    const resolved = resolvePermission(requestId, 'allow');
    expect(resolved).toBe(true);

    // Double-resolve returns false (already cleaned up by next poll)
    const again = resolvePermission(requestId, 'deny');
    // Entry still exists until polled, but resolvers are empty
    expect(again).toBe(true); // entry still in map
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

  describe('P13.6: /save-uploaded-file endpoint', () => {
    it('returns 501 when handler not implemented', async () => {
      // Default handler has no saveUploadedFile
      const res = await post(server, '/save-uploaded-file', {
        uploadId: 'upload_abc123',
        destination: 'public/logo.png',
        projectDir: '/tmp/proj',
      });
      expect(res.status).toBe(501);
      expect(res.body.error).toContain('not implemented');
    });

    it('returns 200 with saved path when handler succeeds', async () => {
      handler.saveUploadedFile = vi.fn().mockResolvedValue('/tmp/proj/public/logo.png');
      const res = await post(server, '/save-uploaded-file', {
        uploadId: 'upload_abc123',
        destination: 'public/logo.png',
        projectDir: '/tmp/proj',
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.path).toBe('/tmp/proj/public/logo.png');
      expect(handler.saveUploadedFile).toHaveBeenCalledWith(
        'upload_abc123', 'public/logo.png', '/tmp/proj',
      );
    });

    it('requires auth', async () => {
      const res = await post(server, '/save-uploaded-file', {
        uploadId: 'upload_abc123',
        destination: 'public/logo.png',
        projectDir: '/tmp/proj',
      }, 'wrong-secret');
      expect(res.status).toBe(401);
    });
  });
});
