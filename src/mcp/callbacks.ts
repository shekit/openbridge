/**
 * Callback handler glue layer.
 *
 * Implements IpcHandler by routing MCP tool calls to the correct adapter
 * (Slack/Discord), tunnel manager, and file browser.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IpcHandler } from './ipc-server.js';
import type { Adapter } from '../types/adapter.js';
import { openTunnel } from './tunnel.js';
import { startFileBrowser, type FileBrowser } from './file-browser.js';
import { getUploadsDir } from '../utils.js';

export interface CallbackHandlerOptions {
  adapters: Map<string, Adapter>;
}

/** Tracks active file browsers for cleanup. */
const activeFileBrowsers: FileBrowser[] = [];

/**
 * Tracks which threads had post_message called during the current turn.
 * The adapter clears this before spawning a backend, and checks after
 * the backend completes to decide whether to suppress assistant_text events.
 */
const threadsWithPostMessage = new Set<string>();

/** Clear the post_message flag for a thread. Call before starting a turn. */
export function clearPostMessageFlag(threadId: string): void {
  threadsWithPostMessage.delete(threadId);
}

/** Check if post_message was called for a thread during the current turn. */
export function wasPostMessageCalled(threadId: string): boolean {
  return threadsWithPostMessage.has(threadId);
}

/** Mark that post_message was called for a thread. Used by tests. */
export function markPostMessageCalled(threadId: string): void {
  threadsWithPostMessage.add(threadId);
}

/**
 * Create an IPC handler that routes MCP tool calls to the appropriate
 * adapter, tunnel manager, or file browser.
 */
export function createCallbackHandler(options: CallbackHandlerOptions): IpcHandler {
  const { adapters } = options;

  function getAdapter(platform: string): Adapter {
    const adapter = adapters.get(platform);
    if (!adapter) {
      throw new Error(`No adapter registered for platform: ${platform}`);
    }
    return adapter;
  }

  return {
    async uploadFile(channelId, threadId, filePath, platform) {
      const adapter = getAdapter(platform);
      await adapter.uploadFile(channelId, threadId, filePath);
    },

    async openTunnel(port, ttl) {
      const tunnel = await openTunnel(port, ttl);
      return tunnel.url;
    },

    async serveFileBrowser(directory) {
      const browser = await startFileBrowser(directory);
      activeFileBrowsers.push(browser);

      // Tunnel the file browser so it's accessible externally
      const tunnel = await openTunnel(browser.port, 3600); // 1 hour default TTL
      return tunnel.url;
    },

    async postMessage(channelId, threadId, text, platform) {
      threadsWithPostMessage.add(threadId);
      const adapter = getAdapter(platform);
      await adapter.sendMessage(channelId, threadId, text);
    },

    async requestPermission(channelId, threadId, toolName, toolInput, platform, requestId) {
      const adapter = getAdapter(platform);
      await adapter.postPermissionPrompt(channelId, threadId, {
        toolName,
        toolInput,
        requestId,
      }, null);
    },

    async saveUploadedFile(uploadId, destination, projectDir) {
      const uploadsDir = getUploadsDir();
      if (!fs.existsSync(uploadsDir)) {
        throw new Error('No uploads directory found');
      }

      // Find the staging file by uploadId prefix
      const files = fs.readdirSync(uploadsDir);
      const match = files.find((f) => f.startsWith(`${uploadId}-`));
      if (!match) {
        throw new Error(`No staged file found for upload_id: ${uploadId}`);
      }

      const sourcePath = path.join(uploadsDir, match);

      // Validate destination is within the project directory
      const resolvedDest = path.resolve(projectDir, destination);
      const normalizedProject = path.resolve(projectDir);
      if (!resolvedDest.startsWith(normalizedProject + path.sep) && resolvedDest !== normalizedProject) {
        throw new Error(`Destination "${destination}" is outside the project directory`);
      }

      // Ensure parent directory exists and copy (not move, so model can save to multiple destinations)
      fs.mkdirSync(path.dirname(resolvedDest), { recursive: true });
      fs.copyFileSync(sourcePath, resolvedDest);
      console.log(`[callbacks] saved uploaded file ${uploadId} to ${resolvedDest}`);

      return resolvedDest;
    },
  };
}

/** Close all active file browsers. Called during shutdown. */
export async function closeAllFileBrowsers(): Promise<void> {
  for (const browser of activeFileBrowsers) {
    try {
      await browser.close();
    } catch {
      // Best effort
    }
  }
  activeFileBrowsers.length = 0;
}
