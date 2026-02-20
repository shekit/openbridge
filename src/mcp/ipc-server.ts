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
  postMessage(channelId: string, threadId: string, text: string, platform: string): Promise<void>;
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

        case '/post-message': {
          const { channelId, threadId, text, platform } = data as {
            channelId: string; threadId: string; text: string; platform: string;
          };
          await handler.postMessage(channelId, threadId, text, platform);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
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
