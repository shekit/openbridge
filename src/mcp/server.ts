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
  /** Start a preview server (static or command) and tunnel it. Returns { url, port }. */
  previewServer(directory: string, command: string | undefined, ttl: number): Promise<{ url: string; port: number }>;
  /** Post a text message in the originating thread. */
  postMessage(channelId: string, threadId: string, text: string): Promise<void>;
  /** Copy a staged uploaded file to a destination in the project directory. */
  saveUploadedFile(uploadId: string, destination: string, projectDir: string): Promise<string>;
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
        'Send a file from the project to the user as an attachment. ' +
        'Use this when the user asks you to share, send, or show them a file from the project.',
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
        'Create a public URL for a server that is already running on a local port. ' +
        'Use this only when a server is already running and you know its port number. ' +
        'If you need to start a new server, use preview_server instead — it handles everything in one step. ' +
        'After receiving the URL, use post_message to share it with the user.',
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
        'Give the user a browsable view of the project files and folders via a public URL. ' +
        'Use this when the user asks to see, browse, or explore the project file structure. ' +
        'Returns a URL. Use post_message to share it with the user.',
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

  // --- preview_server tool ---
  server.registerTool(
    'preview_server',
    {
      description:
        'Start a server and give the user a public URL to preview the project. ' +
        'Handles port allocation, server startup, and public URL creation in one step, and works regardless of sandbox restrictions. ' +
        'Use this when the user asks to preview, demo, or share their website or app, or asks for a live URL or dev server. ' +
        'Always use this instead of starting servers manually via shell commands. ' +
        'For static sites: just provide the directory. ' +
        'For dev servers: provide a command (e.g. "npm run dev") — the PORT env var is injected automatically, do NOT hardcode a port. ' +
        'After receiving the URL, use post_message to share it with the user.',
      inputSchema: {
        directory: z.string().default('.').optional()
          .describe('Directory to serve (relative to project directory, defaults to project root)'),
        command: z.string().optional()
          .describe('Optional shell command to start a dev server (e.g. "npm run dev"). PORT env var is injected. If omitted, a built-in static file server is used.'),
        ttl: z.number().int().min(60).max(86400).default(3600).optional()
          .describe('Time-to-live in seconds (default 3600, max 86400)'),
      },
    },
    async ({ directory, command, ttl }) => {
      try {
        const dir = directory ?? '.';
        const resolved = validateProjectPath(dir, context.projectDir);

        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
          return {
            content: [{ type: 'text', text: `Error: Directory not found: ${resolved}` }],
            isError: true,
          };
        }

        const previewTtl = ttl ?? 3600;
        const result = await callbacks.previewServer(resolved, command ?? undefined, previewTtl);

        return {
          content: [{ type: 'text', text: `Preview server started on port ${result.port}.\nPublic URL: ${result.url}\nTTL: ${previewTtl}s` }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `Error starting preview server: ${message}` }],
          isError: true,
        };
      }
    },
  );

  // --- save_uploaded_file tool ---
  server.registerTool(
    'save_uploaded_file',
    {
      description:
        'Save a file the user uploaded to a location in the project directory. ' +
        'When the user sends a file, it is staged with an upload_id included in the message. ' +
        'Use this when the user asks you to save, add, or place an uploaded file into the project. ' +
        'The upload_id is in the message text (e.g. upload_abc123def456).',
      inputSchema: {
        upload_id: z.string().describe('The upload ID from the image upload notification (e.g., upload_abc123def456)'),
        destination: z.string().describe('Destination path relative to project directory (e.g., "public/logo.png" or "assets/images/hero.jpg")'),
      },
    },
    async ({ upload_id, destination }) => {
      try {
        const savedPath = await callbacks.saveUploadedFile(upload_id, destination, context.projectDir);
        return {
          content: [{ type: 'text', text: `File saved successfully to: ${savedPath}` }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `Error saving uploaded file: ${message}` }],
          isError: true,
        };
      }
    },
  );

  // --- post_message tool ---
  server.registerTool(
    'post_message',
    {
      description:
        'Send a message to the user. Your internal thinking is NOT shown to the user — only messages sent through this tool are visible to them. ' +
        'Use this whenever you need to communicate anything to the user: results, progress, URLs, answers, or status updates. ' +
        'Always call this at least once per turn.',
      inputSchema: {
        text: z.string().describe('The message text to post to the user'),
      },
    },
    async ({ text }) => {
      try {
        await callbacks.postMessage(context.channelId, context.threadId, text);
        return {
          content: [{ type: 'text', text: 'Message posted' }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `Error posting message: ${message}` }],
          isError: true,
        };
      }
    },
  );

  console.error('[mcp] server created with tools: upload_file, open_tunnel, serve_file_browser, preview_server, save_uploaded_file, post_message');
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
      '--ipc-port', String(ipc.port),
      '--ipc-secret', ipc.secret,
    ],
    env: {
      OPENBRIDGE_IPC_PORT: String(ipc.port),
      OPENBRIDGE_IPC_SECRET: ipc.secret,
    },
  };
}
