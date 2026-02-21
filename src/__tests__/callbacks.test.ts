/**
 * Tests for the callback handler glue layer (src/mcp/callbacks.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock tunnel and file-browser modules
vi.mock('../mcp/tunnel.js', () => ({
  openTunnel: vi.fn(),
}));

vi.mock('../mcp/file-browser.js', () => ({
  startFileBrowser: vi.fn(),
}));

import { createCallbackHandler } from '../mcp/callbacks.js';
import { openTunnel } from '../mcp/tunnel.js';
import { startFileBrowser } from '../mcp/file-browser.js';
import type { Adapter } from '../types/adapter.js';

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

describe('Callback Handler', () => {
  let slackAdapter: Adapter;
  let discordAdapter: Adapter;
  let adapters: Map<string, Adapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    slackAdapter = createMockAdapter();
    discordAdapter = createMockAdapter();
    adapters = new Map([
      ['slack', slackAdapter],
      ['discord', discordAdapter],
    ]);
  });

  it('routes uploadFile to the correct adapter', async () => {
    const handler = createCallbackHandler({ adapters });

    await handler.uploadFile('C1', 'T1', '/tmp/file.png', 'slack');
    expect(slackAdapter.uploadFile).toHaveBeenCalledWith('C1', 'T1', '/tmp/file.png');
    expect(discordAdapter.uploadFile).not.toHaveBeenCalled();

    await handler.uploadFile('D1', 'M1', '/tmp/file.png', 'discord');
    expect(discordAdapter.uploadFile).toHaveBeenCalledWith('D1', 'M1', '/tmp/file.png');
  });

  it('routes postMessage to the correct adapter', async () => {
    const handler = createCallbackHandler({ adapters });

    await handler.postMessage('C1', 'T1', 'hello', 'slack');
    expect(slackAdapter.sendMessage).toHaveBeenCalledWith('C1', 'T1', 'hello');

    await handler.postMessage('D1', 'M1', 'world', 'discord');
    expect(discordAdapter.sendMessage).toHaveBeenCalledWith('D1', 'M1', 'world');
  });

  it('throws for unknown platform', async () => {
    const handler = createCallbackHandler({ adapters });
    await expect(handler.uploadFile('C1', 'T1', '/tmp/f', 'teams')).rejects.toThrow(
      'No adapter registered for platform: teams'
    );
  });

  it('routes openTunnel to tunnel manager', async () => {
    vi.mocked(openTunnel).mockResolvedValue({
      url: 'https://tunnel.example.com',
      close: vi.fn(),
    });

    const handler = createCallbackHandler({ adapters });
    const url = await handler.openTunnel(3000, 600);

    expect(url).toBe('https://tunnel.example.com');
    expect(openTunnel).toHaveBeenCalledWith(3000, 600);
  });

  it('routes requestPermission to adapter.postPermissionPrompt with requestId', async () => {
    const handler = createCallbackHandler({ adapters });

    await handler.requestPermission!('C1', 'T1', 'Bash', { command: 'rm -rf' }, 'slack', 'req_abc');
    expect(slackAdapter.postPermissionPrompt).toHaveBeenCalledWith(
      'C1', 'T1',
      { toolName: 'Bash', toolInput: { command: 'rm -rf' }, requestId: 'req_abc' },
      null,
    );
  });

  it('routes serveFileBrowser to file browser + tunnel', async () => {
    vi.mocked(startFileBrowser).mockResolvedValue({
      port: 54321,
      close: vi.fn(),
    });
    vi.mocked(openTunnel).mockResolvedValue({
      url: 'https://browser.example.com',
      close: vi.fn(),
    });

    const handler = createCallbackHandler({ adapters });
    const url = await handler.serveFileBrowser('/tmp/project');

    expect(url).toBe('https://browser.example.com');
    expect(startFileBrowser).toHaveBeenCalledWith('/tmp/project');
    // Should tunnel the file browser's port
    expect(openTunnel).toHaveBeenCalledWith(54321, 3600);
  });
});
