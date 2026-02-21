/**
 * Local HTTP IPC server for MCP callback communication.
 *
 * The bridge starts this on 127.0.0.1:0 (random port). The MCP entry
 * script (grandchild process) makes fetch() calls to it when the agent
 * invokes MCP tools like upload_file or open_tunnel.
 *
 * Auth: every request must include the OPENBRIDGE_IPC_SECRET header.
 */

import * as http from 'node:http';
import { randomUUID } from 'node:crypto';

/** Handler interface — the callback handler implements this. */
export interface IpcHandler {
  uploadFile(channelId: string, threadId: string, filePath: string, platform: string): Promise<void>;
  openTunnel(port: number, ttl: number): Promise<string>;
  serveFileBrowser(directory: string): Promise<string>;
  /** Start a preview server (static or command) and tunnel it. Returns { url, port }. */
  previewServer(directory: string, command: string | undefined, ttl: number): Promise<{ url: string; port: number }>;
  postMessage(channelId: string, threadId: string, text: string, platform: string): Promise<void>;
  /** Send a permission prompt to the user and return immediately (non-blocking). */
  requestPermission?(channelId: string, threadId: string, toolName: string,
    toolInput: Record<string, unknown>, platform: string, requestId: string): Promise<void>;
  /** Copy a staged uploaded file to a destination in the project directory. */
  saveUploadedFile?(uploadId: string, destination: string, projectDir: string): Promise<string>;
}

/** Pending permission request — waiting for user to click Allow/Deny. */
interface PendingPermission {
  decision: 'allow' | 'deny' | null;
  resolvers: Array<(decision: 'allow' | 'deny') => void>;
  createdAt: number;
}

/** In-memory store for pending permission requests. */
const pendingPermissions = new Map<string, PendingPermission>();

/** Stale entry cleanup interval (10 minutes). */
const STALE_TIMEOUT_MS = 10 * 60 * 1000;

/** Resolve a pending permission request (called by adapters in-process). */
export function resolvePermission(requestId: string, decision: 'allow' | 'deny'): boolean {
  const entry = pendingPermissions.get(requestId);
  if (!entry) return false;
  entry.decision = decision;
  for (const resolver of entry.resolvers) {
    resolver(decision);
  }
  entry.resolvers = [];
  return true;
}

/** Clean up stale permission entries older than STALE_TIMEOUT_MS. */
function cleanupStalePermissions(): void {
  const now = Date.now();
  for (const [id, entry] of pendingPermissions) {
    if (now - entry.createdAt > STALE_TIMEOUT_MS) {
      // Resolve any waiting pollers with deny
      for (const resolver of entry.resolvers) {
        resolver('deny');
      }
      pendingPermissions.delete(id);
    }
  }
}

export interface IpcServer {
  port: number;
  secret: string;
  close(): Promise<void>;
}

/** Read the full request body as a string. */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/**
 * Start the IPC server on localhost with a random port.
 * Returns the port, secret, and a close function.
 */
export function startIpcServer(handler: IpcHandler): Promise<IpcServer> {
  const secret = randomUUID();

  const server = http.createServer(async (req, res) => {
    // Auth check
    const authHeader = req.headers['x-openbridge-secret'] as string | undefined;
    if (authHeader !== secret) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    // Only accept POST
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    const body = await readBody(req);
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    try {
      switch (req.url) {
        case '/upload-file': {
          const { channelId, threadId, filePath, platform } = data as {
            channelId: string; threadId: string; filePath: string; platform: string;
          };
          await handler.uploadFile(channelId, threadId, filePath, platform);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          break;
        }

        case '/open-tunnel': {
          const { port, ttl } = data as { port: number; ttl: number };
          const url = await handler.openTunnel(port, ttl);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, url }));
          break;
        }

        case '/serve-file-browser': {
          const { directory } = data as { directory: string };
          const url = await handler.serveFileBrowser(directory);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, url }));
          break;
        }

        case '/preview-server': {
          const { directory, command, ttl } = data as {
            directory: string; command?: string; ttl: number;
          };
          const result = await handler.previewServer(directory, command ?? undefined, ttl);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, url: result.url, port: result.port }));
          break;
        }

        case '/post-message': {
          const { channelId, threadId, text, platform } = data as {
            channelId: string; threadId: string; text: string; platform: string;
          };
          await handler.postMessage(channelId, threadId, text, platform);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          break;
        }

        case '/permission-request': {
          const { channelId, threadId, toolName, toolInput, platform } = data as {
            channelId: string; threadId: string; toolName: string;
            toolInput: Record<string, unknown>; platform: string;
          };
          const requestId = randomUUID();
          pendingPermissions.set(requestId, {
            decision: null,
            resolvers: [],
            createdAt: Date.now(),
          });
          console.log(`[ipc] permission-request: ${toolName} (${requestId})`);
          // Notify adapter to show Allow/Deny buttons
          if (handler.requestPermission) {
            await handler.requestPermission(channelId, threadId, toolName, toolInput, platform, requestId);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, requestId }));
          break;
        }

        case '/permission-poll': {
          const { requestId } = data as { requestId: string };
          cleanupStalePermissions();
          const entry = pendingPermissions.get(requestId);
          if (!entry) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'expired' }));
            break;
          }
          if (entry.decision) {
            // Already resolved — return immediately
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'resolved', decision: entry.decision }));
            pendingPermissions.delete(requestId);
            break;
          }
          // Long-poll: wait up to 5 seconds for a decision
          const decision = await new Promise<'allow' | 'deny' | 'pending'>((resolve) => {
            const timeout = setTimeout(() => resolve('pending'), 5000);
            entry.resolvers.push((d) => {
              clearTimeout(timeout);
              resolve(d);
            });
          });
          if (decision === 'pending') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'pending' }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'resolved', decision }));
            pendingPermissions.delete(requestId);
          }
          break;
        }

        case '/permission-resolve': {
          const { requestId: resolveId, decision: resolveDecision } = data as {
            requestId: string; decision: 'allow' | 'deny';
          };
          const resolved = resolvePermission(resolveId, resolveDecision);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: resolved }));
          break;
        }

        case '/save-uploaded-file': {
          const { uploadId, destination, projectDir } = data as {
            uploadId: string; destination: string; projectDir: string;
          };
          if (!handler.saveUploadedFile) {
            res.writeHead(501, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'saveUploadedFile not implemented' }));
            break;
          }
          const savedPath = await handler.saveUploadedFile(uploadId, destination, projectDir);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, path: savedPath }));
          break;
        }

        default:
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[ipc] handler error:', message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    }
  });

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to get server address'));
        return;
      }
      const port = addr.port;
      console.log(`[ipc] server listening on 127.0.0.1:${port}`);

      resolve({
        port,
        secret,
        close() {
          return new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          });
        },
      });
    });

    server.on('error', reject);
  });
}
