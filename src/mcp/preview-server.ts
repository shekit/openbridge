/**
 * Preview server manager — starts a local server and tunnels it.
 *
 * Consolidates the "start server + open tunnel" flow into one operation:
 * 1. Find a free port
 * 2. Start a server (built-in static or user command)
 * 3. Wait for the server to respond
 * 4. Open a tunnel to expose it publicly
 *
 * This prevents port collisions and silent failures that occur when
 * the AI agent tries to background servers manually.
 */

import * as http from 'node:http';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { openTunnel, type Tunnel } from './tunnel.js';

export interface PreviewServer {
  /** Public tunnel URL. */
  url: string;
  /** Local port the server is running on. */
  port: number;
  /** Shut down the server and tunnel. */
  close(): void;
}

interface ActivePreview {
  serverProcess: ChildProcess | null;
  httpServer: http.Server | null;
  tunnel: Tunnel;
}

/** Tracks all active preview servers for cleanup. */
const activePreviews = new Map<string, ActivePreview>();

/** Common MIME types for static file serving. */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

/** Find a free port by briefly binding to port 0. */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close();
        reject(new Error('Failed to get free port'));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/**
 * Start a built-in static file server for the given directory.
 * Serves files as-is with proper MIME types. For directories, serves index.html if present.
 */
function startStaticServer(directory: string, port: number): Promise<http.Server> {
  const rootDir = path.resolve(directory);

  const server = http.createServer((req, res) => {
    let urlPath = decodeURIComponent(req.url?.split('?')[0] ?? '/');

    // Resolve to filesystem path
    let filePath = path.resolve(rootDir, '.' + urlPath);

    // Prevent path traversal
    if (!filePath.startsWith(rootDir)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    try {
      const stat = fs.statSync(filePath);

      if (stat.isDirectory()) {
        // Try index.html
        const indexPath = path.join(filePath, 'index.html');
        if (fs.existsSync(indexPath)) {
          filePath = indexPath;
        } else {
          // Simple directory listing
          const entries = fs.readdirSync(filePath);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          const links = entries.map(e => {
            const href = urlPath.endsWith('/') ? `${urlPath}${e}` : `${urlPath}/${e}`;
            return `<li><a href="${href}">${e}</a></li>`;
          }).join('\n');
          res.end(`<!DOCTYPE html><html><body><h2>Index of ${urlPath}</h2><ul>${links}</ul></body></html>`);
          return;
        }
      }

      if (fs.statSync(filePath).isFile()) {
        res.writeHead(200, { 'Content-Type': getMimeType(filePath) });
        fs.createReadStream(filePath).pipe(res);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
      }
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  });

  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => {
      console.log(`[preview] static server listening on 127.0.0.1:${port} for ${rootDir}`);
      resolve(server);
    });
    server.on('error', reject);
  });
}

/**
 * Spawn a user-provided command with PORT injected as an env var.
 * Returns the child process. The caller should wait for the port to become available.
 */
function spawnServerCommand(command: string, cwd: string, port: number): ChildProcess {
  console.log(`[preview] spawning command: ${command} (PORT=${port}, cwd=${cwd})`);

  const child = spawn('sh', ['-c', command], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(port),
    },
  });

  // Log stderr for debugging
  child.stderr?.on('data', (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) console.log(`[preview:stderr] ${line}`);
  });

  child.stdout?.on('data', (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) console.log(`[preview:stdout] ${line}`);
  });

  return child;
}

/**
 * Wait for something to start listening on a port.
 * Polls with TCP connect attempts.
 */
function waitForPort(port: number, timeoutMs: number = 30000): Promise<void> {
  const start = Date.now();

  return new Promise((resolve, reject) => {
    function tryConnect() {
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Server did not start listening on port ${port} within ${timeoutMs / 1000}s`));
        return;
      }

      const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
        sock.destroy();
        resolve();
      });

      sock.on('error', () => {
        // Not ready yet — retry after 300ms
        setTimeout(tryConnect, 300);
      });
    }

    tryConnect();
  });
}

/**
 * Start a preview server and tunnel it.
 *
 * @param directory - The directory to serve (absolute path).
 * @param command - Optional shell command to run instead of built-in static server.
 *                  PORT env var is injected automatically.
 * @param ttl - Tunnel time-to-live in seconds.
 */
export async function startPreviewServer(
  directory: string,
  command: string | undefined,
  ttl: number,
): Promise<PreviewServer> {
  const port = await findFreePort();
  const id = `preview-${port}-${Date.now()}`;

  let serverProcess: ChildProcess | null = null;
  let httpServer: http.Server | null = null;

  try {
    if (command) {
      // User-provided command (e.g., "npm run dev")
      serverProcess = spawnServerCommand(command, directory, port);

      // Watch for early exit (command failed to start)
      const earlyExitPromise = new Promise<never>((_, reject) => {
        serverProcess!.on('exit', (code) => {
          reject(new Error(`Server command exited with code ${code} before it started listening`));
        });
        serverProcess!.on('error', (err) => {
          reject(new Error(`Server command failed: ${err.message}`));
        });
      });

      // Race: either the port becomes available or the process exits early
      await Promise.race([
        waitForPort(port),
        earlyExitPromise,
      ]);
    } else {
      // Built-in static file server
      httpServer = await startStaticServer(directory, port);
    }

    // Open tunnel
    const tunnel = await openTunnel(port, ttl);

    activePreviews.set(id, { serverProcess, httpServer, tunnel });

    console.log(`[preview] preview server ready: ${tunnel.url} (port ${port}, TTL ${ttl}s)`);

    return {
      url: tunnel.url,
      port,
      close: () => closePreview(id),
    };
  } catch (err) {
    // Cleanup on failure
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
    }
    if (httpServer) {
      httpServer.close();
    }
    throw err;
  }
}

/** Close a specific preview server. */
function closePreview(id: string): void {
  const preview = activePreviews.get(id);
  if (!preview) return;

  preview.tunnel.close();
  if (preview.serverProcess) {
    preview.serverProcess.kill('SIGTERM');
  }
  if (preview.httpServer) {
    preview.httpServer.close();
  }
  activePreviews.delete(id);
  console.log(`[preview] closed preview ${id}`);
}

/** Close all active preview servers. Called during shutdown. */
export function closeAllPreviews(): void {
  for (const [id] of activePreviews) {
    closePreview(id);
  }
}
