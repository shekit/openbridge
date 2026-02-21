/**
 * Callback handler glue layer.
 *
 * Implements IpcHandler by routing MCP tool calls to the correct adapter
 * (Slack/Discord), tunnel manager, and file browser.
 */

import type { IpcHandler } from './ipc-server.js';
import type { Adapter } from '../types/adapter.js';
import { openTunnel } from './tunnel.js';
import { startFileBrowser, type FileBrowser } from './file-browser.js';

export interface CallbackHandlerOptions {
  adapters: Map<string, Adapter>;
}

/** Tracks active file browsers for cleanup. */
const activeFileBrowsers: FileBrowser[] = [];

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
