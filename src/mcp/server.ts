/**
 * Bridge MCP server for OpenBridge.
 *
 * Exposes tools (upload_file, open_tunnel, serve_file_browser) to coding
 * backends via stdio transport. When the bridge spawns a backend session,
 * it injects MCP config pointing to this server so the agent gains access
 * to platform-specific actions without knowing about Slack or Discord.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { McpServerEntry } from '../types/backend.js';

/**
 * Callback interface for bridge actions that the MCP server triggers.
 * The adapter (Slack/Discord) implements these to perform platform-specific work.
 */
export interface BridgeCallbacks {
  /** Upload a file as a chat attachment in the originating thread. */
  uploadFile(filePath: string, channelId: string, threadId: string): Promise<void>;
  /** Start a tunnel on the given port and return the public URL. */
  openTunnel(port: number, ttl: number): Promise<string>;
  /** Serve a file browser for a directory behind a tunnel and return the URL. */
  serveFileBrowser(directory: string): Promise<string>;
  /** Post a text message in the originating thread. */
  postMessage(channelId: string, threadId: string, text: string): Promise<void>;
}

/**
 * Session context passed when creating an MCP server instance.
 * Identifies the originating chat thread so tools can post back.
 */
export interface McpSessionContext {
  channelId: string;
  threadId: string;
  projectDir: string;
}

/**
 * Validates that a file path is within the allowed project directory.
 * Returns the resolved absolute path, or throws if out of bounds.
 */
export function validateProjectPath(filePath: string, projectDir: string): string {
  const resolved = path.resolve(projectDir, filePath);
  const normalizedProject = path.resolve(projectDir);

  if (!resolved.startsWith(normalizedProject + path.sep) && resolved !== normalizedProject) {
    throw new Error(
      `Path "${filePath}" is outside the project directory "${projectDir}". ` +
      `Access is restricted to the project directory for safety.`
    );
  }

  return resolved;
}

/**
 * Create and configure the Bridge MCP server with all tools registered.
 */
export function createMcpServer(
  context: McpSessionContext,
  callbacks: BridgeCallbacks,
): McpServer {
  const server = new McpServer({
    name: 'openbridge',
    version: '0.1.0',
  });

  // --- upload_file tool ---
  server.registerTool(
    'upload_file',
    {
      description:
        'Upload a file from the project directory as a chat attachment in the originating Slack/Discord thread.',
      inputSchema: {
        file_path: z.string().describe('Path to the file to upload (relative to project directory or absolute within it)'),
      },
    },
    async ({ file_path }) => {
      try {
        const resolved = validateProjectPath(file_path, context.projectDir);

        if (!fs.existsSync(resolved)) {
          return {
            content: [{ type: 'text', text: `Error: File not found: ${resolved}` }],
            isError: true,
          };
        }

        await callbacks.uploadFile(resolved, context.channelId, context.threadId);
        return {
          content: [{ type: 'text', text: `File uploaded successfully: ${path.basename(resolved)}` }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `Error uploading file: ${message}` }],
          isError: true,
        };
      }
    },
  );

  // --- open_tunnel tool ---
  server.registerTool(
    'open_tunnel',
    {
      description:
        'Expose a local port via a public tunnel (Cloudflare Tunnel or ngrok) and post the URL in the chat thread. ' +
        'IMPORTANT: Before calling this, start your dev server in the BACKGROUND using a shell command with & ' +
        '(e.g. `npm run dev &` or `npx serve -p 3000 &`). Do NOT run the server in the foreground — ' +
        'it will block forever. Once the server is running in the background, call this tool with its port number.',
      inputSchema: {
        port: z.number().int().min(1).max(65535).describe('Port number to tunnel'),
        ttl: z.number().int().min(60).max(86400).default(3600).optional()
          .describe('Time-to-live in seconds (default 3600, max 86400)'),
      },
    },
    async ({ port, ttl }) => {
      try {
        const tunnelTtl = ttl ?? 3600;
        const url = await callbacks.openTunnel(port, tunnelTtl);

        // Post the URL in the chat thread
        await callbacks.postMessage(
          context.channelId,
          context.threadId,
          `Tunnel opened: ${url}\n(expires in ${Math.round(tunnelTtl / 60)} minutes)`,
        );

        return {
          content: [{ type: 'text', text: `Tunnel opened: ${url} (TTL: ${tunnelTtl}s)` }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `Error opening tunnel: ${message}` }],
          isError: true,
        };
      }
    },
  );

  // --- serve_file_browser tool ---
  server.registerTool(
    'serve_file_browser',
    {
      description:
        'Serve a lightweight file browser for the project directory (or a subdirectory) behind a public tunnel. Posts the URL in the chat thread.',
      inputSchema: {
        directory: z.string().default('.').optional()
          .describe('Directory to serve (relative to project directory, defaults to project root)'),
      },
    },
    async ({ directory }) => {
      try {
        const dir = directory ?? '.';
        const resolved = validateProjectPath(dir, context.projectDir);

        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
          return {
            content: [{ type: 'text', text: `Error: Directory not found: ${resolved}` }],
            isError: true,
          };
        }

        const url = await callbacks.serveFileBrowser(resolved);

        // Post the URL in the chat thread
        await callbacks.postMessage(
          context.channelId,
          context.threadId,
          `File browser: ${url}`,
        );

        return {
          content: [{ type: 'text', text: `File browser available at: ${url}` }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `Error serving file browser: ${message}` }],
          isError: true,
        };
      }
    },
  );

  console.error('[mcp] server created with tools: upload_file, open_tunnel, serve_file_browser');
  return server;
}

/**
 * Start the MCP server with stdio transport.
 * This is called when the bridge spawns a backend session and pipes
 * the MCP server's stdin/stdout to the backend process.
 */
export async function startMcpServer(
  context: McpSessionContext,
  callbacks: BridgeCallbacks,
): Promise<McpServer> {
  const server = createMcpServer(context, callbacks);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[mcp] server connected via stdio transport');
  return server;
}

/**
 * Generate the MCP server configuration that should be injected into
 * backend CLI invocations. Both Claude Code and Codex CLI support MCP
 * natively via config.
 *
 * Returns the config object for the MCP server entry.
 */
export function getMcpConfig(
  entryScriptPath: string,
  context: McpSessionContext & { platform: string },
  ipc: { port: number; secret: string },
): McpServerEntry {
  return {
    command: 'node',
    args: [
      entryScriptPath,
      '--channel', context.channelId,
      '--thread', context.threadId,
      '--project-dir', context.projectDir,
      '--platform', context.platform,
    ],
    env: {
      OPENBRIDGE_IPC_PORT: String(ipc.port),
      OPENBRIDGE_IPC_SECRET: ipc.secret,
    },
  };
}
