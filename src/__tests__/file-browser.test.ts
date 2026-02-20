/**
 * Tests for the file browser HTTP server (src/mcp/file-browser.ts).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { startFileBrowser, type FileBrowser } from '../mcp/file-browser.js';

describe('File Browser', () => {
  let tmpDir: string;
  let browser: FileBrowser;

  beforeEach(async () => {
    // Create a temp directory with test files
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openbridge-fb-test-'));
    fs.writeFileSync(path.join(tmpDir, 'hello.txt'), 'Hello, world!');
    fs.writeFileSync(path.join(tmpDir, 'style.css'), 'body { color: red; }');
    fs.writeFileSync(path.join(tmpDir, 'data.json'), '{"key":"value"}');
    fs.mkdirSync(path.join(tmpDir, 'subdir'));
    fs.writeFileSync(path.join(tmpDir, 'subdir', 'nested.txt'), 'nested content');

    browser = await startFileBrowser(tmpDir);
  });

  afterEach(async () => {
    await browser.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('starts on a random port', () => {
    expect(browser.port).toBeGreaterThan(0);
  });

  it('serves directory listing as HTML at root', async () => {
    const res = await fetch(`http://127.0.0.1:${browser.port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');

    const html = await res.text();
    expect(html).toContain('hello.txt');
    expect(html).toContain('style.css');
    expect(html).toContain('data.json');
    expect(html).toContain('subdir/');
  });

  it('serves file content with correct MIME type', async () => {
    const res = await fetch(`http://127.0.0.1:${browser.port}/hello.txt`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect(await res.text()).toBe('Hello, world!');
  });

  it('serves CSS with correct MIME type', async () => {
    const res = await fetch(`http://127.0.0.1:${browser.port}/style.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/css');
  });

  it('serves JSON with correct MIME type', async () => {
    const res = await fetch(`http://127.0.0.1:${browser.port}/data.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
  });

  it('serves subdirectory listing', async () => {
    const res = await fetch(`http://127.0.0.1:${browser.port}/subdir`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('nested.txt');
    expect(html).toContain('..');
  });

  it('serves nested file', async () => {
    const res = await fetch(`http://127.0.0.1:${browser.port}/subdir/nested.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('nested content');
  });

  it('returns 404 for non-existent files', async () => {
    const res = await fetch(`http://127.0.0.1:${browser.port}/nope.txt`);
    expect(res.status).toBe(404);
  });

  it('prevents path traversal', async () => {
    // Note: fetch() normalizes /../ in URLs, so we use %2e%2e to bypass
    // client-side normalization and test the server's path traversal guard.
    const res = await fetch(`http://127.0.0.1:${browser.port}/%2e%2e/%2e%2e/etc/passwd`);
    // Server should return 403 (traversal blocked) or 404 (file not found)
    expect([403, 404]).toContain(res.status);
    const body = await res.text();
    // Ensure we didn't get actual file content
    expect(body).not.toContain('root:');
  });

  it('can be closed', async () => {
    await browser.close();
    await expect(
      fetch(`http://127.0.0.1:${browser.port}/`)
    ).rejects.toThrow();
    // Prevent afterEach from double-closing
    browser = { port: 0, close: async () => {} };
  });
});
