/**
 * Tests for the tunnel manager (src/mcp/tunnel.ts).
 *
 * Since cloudflared/ngrok may not be installed in CI, we mock
 * detectTunnelTools and child_process.spawn.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

// Mock detectTunnelTools
vi.mock('../cli/init.js', () => ({
  detectTunnelTools: vi.fn(),
}));

// Mock child_process.spawn
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { openTunnel, closeAllTunnels } from '../mcp/tunnel.js';
import { detectTunnelTools } from '../cli/init.js';
import { spawn } from 'node:child_process';

/** Create a fake ChildProcess that emits events. */
function createFakeChild() {
  const child = new EventEmitter() as any;
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.kill = vi.fn();
  child.pid = 12345;
  return child;
}

describe('Tunnel Manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    closeAllTunnels();
  });

  it('throws when no tunnel tools are available', async () => {
    vi.mocked(detectTunnelTools).mockReturnValue({
      hasCloudflared: false,
      hasNgrok: false,
    });

    await expect(openTunnel(3000, 600)).rejects.toThrow('No tunnel tool available');
  });

  it('prefers cloudflared over ngrok', async () => {
    vi.mocked(detectTunnelTools).mockReturnValue({
      hasCloudflared: true,
      hasNgrok: true,
    });

    const child = createFakeChild();
    vi.mocked(spawn).mockReturnValue(child);

    // Start the tunnel (don't await yet)
    const tunnelPromise = openTunnel(3000, 600);

    // Simulate cloudflared printing URL to stderr
    child.stderr.emit('data', Buffer.from(
      'INF |  https://fast-morning-abc.trycloudflare.com\n'
    ));

    const tunnel = await tunnelPromise;
    expect(tunnel.url).toBe('https://fast-morning-abc.trycloudflare.com');
    expect(spawn).toHaveBeenCalledWith(
      'cloudflared',
      ['tunnel', '--url', 'http://localhost:3000'],
      expect.any(Object),
    );
  });

  it('uses ngrok when cloudflared is not available', async () => {
    vi.mocked(detectTunnelTools).mockReturnValue({
      hasCloudflared: false,
      hasNgrok: true,
    });

    const child = createFakeChild();
    vi.mocked(spawn).mockReturnValue(child);

    // Mock the ngrok API response
    const mockFetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        tunnels: [{ public_url: 'https://abc123.ngrok.io', proto: 'https' }],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const tunnelPromise = openTunnel(8080, 300);

    // Wait for the poll to fire
    await vi.waitFor(async () => {
      expect(mockFetch).toHaveBeenCalled();
    }, { timeout: 2000 });

    const tunnel = await tunnelPromise;
    expect(tunnel.url).toBe('https://abc123.ngrok.io');
    expect(spawn).toHaveBeenCalledWith(
      'ngrok',
      ['http', '8080'],
      expect.any(Object),
    );

    vi.unstubAllGlobals();
  });

  it('cloudflared tunnel close kills the process', async () => {
    vi.mocked(detectTunnelTools).mockReturnValue({
      hasCloudflared: true,
      hasNgrok: false,
    });

    const child = createFakeChild();
    vi.mocked(spawn).mockReturnValue(child);

    const tunnelPromise = openTunnel(3000, 600);
    child.stderr.emit('data', Buffer.from(
      'https://test-tunnel.trycloudflare.com'
    ));

    const tunnel = await tunnelPromise;
    tunnel.close();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('cloudflared rejects if process exits before URL', async () => {
    vi.mocked(detectTunnelTools).mockReturnValue({
      hasCloudflared: true,
      hasNgrok: false,
    });

    const child = createFakeChild();
    vi.mocked(spawn).mockReturnValue(child);

    const tunnelPromise = openTunnel(3000, 600);
    child.emit('exit', 1);

    await expect(tunnelPromise).rejects.toThrow('cloudflared exited with code 1');
  });

  it('cloudflared rejects on spawn error', async () => {
    vi.mocked(detectTunnelTools).mockReturnValue({
      hasCloudflared: true,
      hasNgrok: false,
    });

    const child = createFakeChild();
    vi.mocked(spawn).mockReturnValue(child);

    const tunnelPromise = openTunnel(3000, 600);
    child.emit('error', new Error('ENOENT'));

    await expect(tunnelPromise).rejects.toThrow('cloudflared failed: ENOENT');
  });

  it('closeAllTunnels kills all active processes', async () => {
    vi.mocked(detectTunnelTools).mockReturnValue({
      hasCloudflared: true,
      hasNgrok: false,
    });

    const child1 = createFakeChild();
    const child2 = createFakeChild();
    let spawnCount = 0;
    vi.mocked(spawn).mockImplementation(() => {
      spawnCount++;
      return spawnCount === 1 ? child1 : child2;
    });

    const p1 = openTunnel(3000, 600);
    child1.stderr.emit('data', Buffer.from('https://tunnel1.trycloudflare.com'));
    await p1;

    const p2 = openTunnel(4000, 600);
    child2.stderr.emit('data', Buffer.from('https://tunnel2.trycloudflare.com'));
    await p2;

    closeAllTunnels();
    expect(child1.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child2.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
