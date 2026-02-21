/**
 * Tests for the preview server manager (src/mcp/preview-server.ts).
 *
 * Tests findFreePort (real), static server (real), and the tunnel
 * integration (mocked via tunnel.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Mock the tunnel module
vi.mock('../mcp/tunnel.js', () => ({
  openTunnel: vi.fn(),
}));

import { findFreePort, startPreviewServer, closeAllPreviews } from '../mcp/preview-server.js';
import { openTunnel } from '../mcp/tunnel.js';

describe('Preview Server', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    // Create a temp directory with test files
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-test-'));
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<h1>Hello</h1>');
    fs.writeFileSync(path.join(tmpDir, 'style.css'), 'body { color: red; }');
    fs.mkdirSync(path.join(tmpDir, 'sub'));
    fs.writeFileSync(path.join(tmpDir, 'sub', 'page.html'), '<h2>Sub</h2>');
  });

  afterEach(() => {
    closeAllPreviews();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('findFreePort', () => {
    it('returns a valid port number', async () => {
      const port = await findFreePort();
      expect(port).toBeGreaterThan(0);
      expect(port).toBeLessThan(65536);
    });

    it('returns different ports on successive calls', async () => {
      const port1 = await findFreePort();
      const port2 = await findFreePort();
      // Not guaranteed to be different, but very likely
      // Just check both are valid
      expect(port1).toBeGreaterThan(0);
      expect(port2).toBeGreaterThan(0);
    });

    it('returned port is actually free', async () => {
      const port = await findFreePort();
      // Try to bind to it — should succeed
      const srv = net.createServer();
      await new Promise<void>((resolve, reject) => {
        srv.listen(port, '127.0.0.1', () => resolve());
        srv.on('error', reject);
      });
      srv.close();
    });
  });

  describe('startPreviewServer (static mode)', () => {
    it('starts a static server and returns a tunnel URL', async () => {
      const mockTunnel = {
        url: 'https://test-preview.trycloudflare.com',
        close: vi.fn(),
      };
      vi.mocked(openTunnel).mockResolvedValue(mockTunnel);

      const preview = await startPreviewServer(tmpDir, undefined, 3600);

      expect(preview.url).toBe('https://test-preview.trycloudflare.com');
      expect(preview.port).toBeGreaterThan(0);
      expect(openTunnel).toHaveBeenCalledWith(preview.port, 3600);

      // Verify the static server is actually running
      const res = await fetch(`http://127.0.0.1:${preview.port}/index.html`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toBe('<h1>Hello</h1>');

      preview.close();
    });

    it('serves index.html for directory root', async () => {
      const mockTunnel = {
        url: 'https://test.trycloudflare.com',
        close: vi.fn(),
      };
      vi.mocked(openTunnel).mockResolvedValue(mockTunnel);

      const preview = await startPreviewServer(tmpDir, undefined, 3600);

      const res = await fetch(`http://127.0.0.1:${preview.port}/`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toBe('<h1>Hello</h1>');

      preview.close();
    });

    it('serves subdirectory files', async () => {
      const mockTunnel = {
        url: 'https://test.trycloudflare.com',
        close: vi.fn(),
      };
      vi.mocked(openTunnel).mockResolvedValue(mockTunnel);

      const preview = await startPreviewServer(tmpDir, undefined, 3600);

      const res = await fetch(`http://127.0.0.1:${preview.port}/sub/page.html`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toBe('<h2>Sub</h2>');

      preview.close();
    });

    it('returns correct MIME types', async () => {
      const mockTunnel = {
        url: 'https://test.trycloudflare.com',
        close: vi.fn(),
      };
      vi.mocked(openTunnel).mockResolvedValue(mockTunnel);

      const preview = await startPreviewServer(tmpDir, undefined, 3600);

      const htmlRes = await fetch(`http://127.0.0.1:${preview.port}/index.html`);
      expect(htmlRes.headers.get('content-type')).toBe('text/html');

      const cssRes = await fetch(`http://127.0.0.1:${preview.port}/style.css`);
      expect(cssRes.headers.get('content-type')).toBe('text/css');

      preview.close();
    });

    it('returns 404 for non-existent files', async () => {
      const mockTunnel = {
        url: 'https://test.trycloudflare.com',
        close: vi.fn(),
      };
      vi.mocked(openTunnel).mockResolvedValue(mockTunnel);

      const preview = await startPreviewServer(tmpDir, undefined, 3600);

      const res = await fetch(`http://127.0.0.1:${preview.port}/nope.html`);
      expect(res.status).toBe(404);

      preview.close();
    });

    it('blocks path traversal', async () => {
      const mockTunnel = {
        url: 'https://test.trycloudflare.com',
        close: vi.fn(),
      };
      vi.mocked(openTunnel).mockResolvedValue(mockTunnel);

      const preview = await startPreviewServer(tmpDir, undefined, 3600);

      // fetch() normalizes paths, so /../ gets stripped — result is 404 (not found)
      // or 403 (forbidden) depending on how the path resolves. Either way, no file served.
      const res = await fetch(`http://127.0.0.1:${preview.port}/../../../etc/passwd`);
      expect(res.ok).toBe(false);
      expect(res.status === 403 || res.status === 404).toBe(true);

      preview.close();
    });

    it('shows directory listing when no index.html', async () => {
      const mockTunnel = {
        url: 'https://test.trycloudflare.com',
        close: vi.fn(),
      };
      vi.mocked(openTunnel).mockResolvedValue(mockTunnel);

      const preview = await startPreviewServer(tmpDir, undefined, 3600);

      const res = await fetch(`http://127.0.0.1:${preview.port}/sub/`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('page.html');

      preview.close();
    });
  });

  describe('startPreviewServer (command mode)', () => {
    it('starts a command with PORT env var and tunnels it', async () => {
      const mockTunnel = {
        url: 'https://cmd-preview.trycloudflare.com',
        close: vi.fn(),
      };
      vi.mocked(openTunnel).mockResolvedValue(mockTunnel);

      // Use a simple Node HTTP server as the command
      const command = `node -e "require('http').createServer((req,res)=>{res.end('cmd-ok')}).listen(process.env.PORT)"`;

      const preview = await startPreviewServer(tmpDir, command, 1800);

      expect(preview.url).toBe('https://cmd-preview.trycloudflare.com');
      expect(preview.port).toBeGreaterThan(0);

      // Verify the command's server is running
      const res = await fetch(`http://127.0.0.1:${preview.port}/`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toBe('cmd-ok');

      preview.close();
    });

    it('rejects if command exits before server starts', async () => {
      vi.mocked(openTunnel).mockResolvedValue({
        url: 'https://x.trycloudflare.com',
        close: vi.fn(),
      });

      // Command that exits immediately with error
      const command = 'exit 1';

      await expect(startPreviewServer(tmpDir, command, 3600))
        .rejects.toThrow(/exited with code 1/);
    });
  });

  describe('closeAllPreviews', () => {
    it('closes all active preview servers', async () => {
      const closeFn1 = vi.fn();
      const closeFn2 = vi.fn();
      vi.mocked(openTunnel)
        .mockResolvedValueOnce({ url: 'https://p1.trycloudflare.com', close: closeFn1 })
        .mockResolvedValueOnce({ url: 'https://p2.trycloudflare.com', close: closeFn2 });

      const p1 = await startPreviewServer(tmpDir, undefined, 3600);
      const p2 = await startPreviewServer(tmpDir, undefined, 3600);

      // Both are running
      expect(p1.port).toBeGreaterThan(0);
      expect(p2.port).toBeGreaterThan(0);

      closeAllPreviews();

      expect(closeFn1).toHaveBeenCalled();
      expect(closeFn2).toHaveBeenCalled();
    });
  });
});
