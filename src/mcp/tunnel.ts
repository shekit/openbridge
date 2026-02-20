/**
 * Tunnel manager — opens public tunnels via cloudflared or ngrok.
 *
 * Tunnels are only used for user-facing things (dev server previews,
 * file browsers) — never for the bridge's own IPC server.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { detectTunnelTools } from '../cli/init.js';

export interface Tunnel {
  url: string;
  close(): void;
}

interface ActiveTunnel {
  process: ChildProcess;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Tracks all active tunnels for cleanup. */
const activeTunnels = new Map<string, ActiveTunnel>();

/**
 * Open a tunnel on the given port using cloudflared (preferred) or ngrok.
 * Auto-closes after `ttl` seconds.
 */
export async function openTunnel(port: number, ttl: number): Promise<Tunnel> {
  const { hasCloudflared, hasNgrok } = detectTunnelTools();

  if (hasCloudflared) {
    return openCloudflaredTunnel(port, ttl);
  }
  if (hasNgrok) {
    return openNgrokTunnel(port, ttl);
  }

  throw new Error(
    'No tunnel tool available. Install cloudflared or ngrok:\n' +
    '  brew install cloudflared\n' +
    '  brew install ngrok'
  );
}

/** Open a cloudflared tunnel. Parses the public URL from stderr. */
function openCloudflaredTunnel(port: number, ttl: number): Promise<Tunnel> {
  return new Promise((resolve, reject) => {
    const child = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const id = `cf-${port}-${Date.now()}`;
    let resolved = false;

    const timer = ttl > 0 ? setTimeout(() => {
      closeTunnel(id);
    }, ttl * 1000) : null;

    activeTunnels.set(id, { process: child, timer });

    // cloudflared prints the URL to stderr like:
    // "... https://some-random.trycloudflare.com ..."
    let stderrBuf = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      const match = stderrBuf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match && !resolved) {
        resolved = true;
        const url = match[0];
        console.log(`[tunnel] cloudflared tunnel opened: ${url} (port ${port}, TTL ${ttl}s)`);
        resolve({
          url,
          close: () => closeTunnel(id),
        });
      }
    });

    child.on('error', (err) => {
      activeTunnels.delete(id);
      if (timer) clearTimeout(timer);
      if (!resolved) reject(new Error(`cloudflared failed: ${err.message}`));
    });

    child.on('exit', (code) => {
      activeTunnels.delete(id);
      if (timer) clearTimeout(timer);
      if (!resolved) reject(new Error(`cloudflared exited with code ${code} before URL was available`));
    });

    // Timeout if URL not found within 30 seconds
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        closeTunnel(id);
        reject(new Error('cloudflared timed out waiting for URL'));
      }
    }, 30000);
  });
}

/** Open an ngrok tunnel. Queries the local API for the public URL. */
function openNgrokTunnel(port: number, ttl: number): Promise<Tunnel> {
  return new Promise((resolve, reject) => {
    const child = spawn('ngrok', ['http', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const id = `ngrok-${port}-${Date.now()}`;
    let resolved = false;

    const timer = ttl > 0 ? setTimeout(() => {
      closeTunnel(id);
    }, ttl * 1000) : null;

    activeTunnels.set(id, { process: child, timer });

    child.on('error', (err) => {
      activeTunnels.delete(id);
      if (timer) clearTimeout(timer);
      if (!resolved) reject(new Error(`ngrok failed: ${err.message}`));
    });

    child.on('exit', (code) => {
      activeTunnels.delete(id);
      if (timer) clearTimeout(timer);
      if (!resolved) reject(new Error(`ngrok exited with code ${code}`));
    });

    // Poll the ngrok local API for the tunnel URL
    const pollInterval = setInterval(async () => {
      try {
        const res = await fetch('http://127.0.0.1:4040/api/tunnels');
        const data = await res.json() as { tunnels: Array<{ public_url: string; proto: string }> };
        const tunnel = data.tunnels?.find(t => t.proto === 'https') ?? data.tunnels?.[0];
        if (tunnel && !resolved) {
          resolved = true;
          clearInterval(pollInterval);
          const url = tunnel.public_url;
          console.log(`[tunnel] ngrok tunnel opened: ${url} (port ${port}, TTL ${ttl}s)`);
          resolve({
            url,
            close: () => closeTunnel(id),
          });
        }
      } catch {
        // ngrok API not ready yet — keep polling
      }
    }, 500);

    // Timeout after 30 seconds
    setTimeout(() => {
      clearInterval(pollInterval);
      if (!resolved) {
        resolved = true;
        closeTunnel(id);
        reject(new Error('ngrok timed out waiting for tunnel URL'));
      }
    }, 30000);
  });
}

/** Close a specific tunnel by its internal ID. */
function closeTunnel(id: string): void {
  const tunnel = activeTunnels.get(id);
  if (tunnel) {
    if (tunnel.timer) clearTimeout(tunnel.timer);
    tunnel.process.kill('SIGTERM');
    activeTunnels.delete(id);
    console.log(`[tunnel] closed tunnel ${id}`);
  }
}

/** Close all active tunnels. Called during shutdown. */
export function closeAllTunnels(): void {
  for (const [id] of activeTunnels) {
    closeTunnel(id);
  }
}
