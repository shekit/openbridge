/**
 * MCP entry point — spawned by the backend (Claude Code / Codex) as a
 * grandchild process. Connects via stdio transport and uses fetch() to
 * call back to the bridge's IPC server for side-effects.
 *
 * Usage:
 *   node dist/mcp/entry.js --channel C123 --thread T456 --project-dir /path --platform slack
 *
 * Environment:
 *   OPENBRIDGE_IPC_PORT   — port of the bridge's IPC server
 *   OPENBRIDGE_IPC_SECRET — auth secret for IPC requests
 */

import { startMcpServer, type BridgeCallbacks, type McpSessionContext } from './server.js';

/** Parse --key value pairs from argv. */
function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--') && i + 1 < argv.length) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++; // skip value
    }
  }
  return args;
}

/** POST JSON to the IPC server and return the parsed response. */
async function ipcPost(
  port: number,
  secret: string,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-openbridge-secret': secret,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json() as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`IPC ${path} failed (${res.status}): ${json.error ?? 'unknown'}`);
  }
  return json;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const channelId = args['channel'];
  const threadId = args['thread'];
  const projectDir = args['project-dir'];
  const platform = args['platform'];
  const timezone = args['timezone'] || undefined;

  if (!channelId || !threadId || !projectDir || !platform) {
    console.error('[mcp-entry] missing required args: --channel, --thread, --project-dir, --platform');
    process.exit(1);
  }

  // Read IPC config from args first (needed for Codex which doesn't pass env),
  // fall back to environment variables (Claude Code passes them via env)
  const ipcPort = parseInt(args['ipc-port'] ?? process.env.OPENBRIDGE_IPC_PORT ?? '', 10);
  const ipcSecret = args['ipc-secret'] ?? process.env.OPENBRIDGE_IPC_SECRET ?? '';

  if (!ipcPort || !ipcSecret) {
    console.error('[mcp-entry] missing env: OPENBRIDGE_IPC_PORT, OPENBRIDGE_IPC_SECRET');
    process.exit(1);
  }

  const context: McpSessionContext = { channelId, threadId, projectDir, timezone };

  const callbacks: BridgeCallbacks = {
    async uploadFile(filePath, chId, thId) {
      await ipcPost(ipcPort, ipcSecret, '/upload-file', {
        channelId: chId,
        threadId: thId,
        filePath,
        platform,
      });
    },

    async openTunnel(port, ttl) {
      const result = await ipcPost(ipcPort, ipcSecret, '/open-tunnel', { port, ttl });
      return result.url as string;
    },

    async serveFileBrowser(directory) {
      const result = await ipcPost(ipcPort, ipcSecret, '/serve-file-browser', { directory });
      return result.url as string;
    },

    async previewServer(directory, command, ttl) {
      const result = await ipcPost(ipcPort, ipcSecret, '/preview-server', { directory, command, ttl });
      return { url: result.url as string, port: result.port as number };
    },

    async postMessage(chId, thId, text) {
      await ipcPost(ipcPort, ipcSecret, '/post-message', {
        channelId: chId,
        threadId: thId,
        text,
        platform,
      });
    },

    async saveUploadedFile(uploadId, destination, projDir) {
      const result = await ipcPost(ipcPort, ipcSecret, '/save-uploaded-file', {
        uploadId,
        destination,
        projectDir: projDir,
      });
      return result.path as string;
    },

    async scheduleSession(chId, thId, prompt, originalRequest, cronExpression, scheduledAt, title, tz) {
      const result = await ipcPost(ipcPort, ipcSecret, '/schedule-session', {
        channelId: chId,
        threadId: thId,
        prompt,
        originalRequest,
        cronExpression,
        scheduledAt,
        title,
        timezone: tz ?? timezone,
        platform,
      });
      return { scheduleId: result.scheduleId as number };
    },

    async listSchedules(chId) {
      const result = await ipcPost(ipcPort, ipcSecret, '/list-schedules', { channelId: chId });
      return { schedules: result.schedules as any[] };
    },

    async cancelSchedule(chId, scheduleId) {
      const result = await ipcPost(ipcPort, ipcSecret, '/cancel-schedule', { channelId: chId, scheduleId });
      return { ok: result.ok as boolean, error: result.error as string | undefined };
    },
  };

  console.error('[mcp-entry] starting MCP server for', { channelId, threadId, projectDir, platform, timezone: timezone ?? 'UTC' });
  await startMcpServer(context, callbacks);
  console.error('[mcp-entry] MCP server connected via stdio');
}

main().catch((err) => {
  console.error('[mcp-entry] fatal:', err);
  process.exit(1);
});
