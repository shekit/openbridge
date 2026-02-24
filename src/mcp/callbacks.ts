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
import type { Store } from '../store.js';
import { openTunnel } from './tunnel.js';
import { startFileBrowser, type FileBrowser } from './file-browser.js';
import { startPreviewServer } from './preview-server.js';
import { getUploadsDir } from '../utils.js';
import { computeNextRun } from '../scheduler.js';

export interface CallbackHandlerOptions {
  adapters: Map<string, Adapter>;
  store?: Store;
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
 * Tracks which threads had schedule_session called during the current turn.
 * The adapter checks this after the backend completes to suppress assistant_text
 * and swap the eyes emoji to a checkmark instead.
 */
const threadsWithScheduleCreated = new Set<string>();

/** Clear the schedule-created flag for a thread. Call before starting a turn. */
export function clearScheduleFlag(threadId: string): void {
  threadsWithScheduleCreated.delete(threadId);
}

/** Check if schedule_session was called for a thread during the current turn. */
export function wasScheduleCreated(threadId: string): boolean {
  return threadsWithScheduleCreated.has(threadId);
}

/** Mark that schedule_session was called for a thread. */
export function markScheduleCreated(threadId: string): void {
  threadsWithScheduleCreated.add(threadId);
}

/**
 * Create an IPC handler that routes MCP tool calls to the appropriate
 * adapter, tunnel manager, or file browser.
 */
export function createCallbackHandler(options: CallbackHandlerOptions): IpcHandler {
  const { adapters, store } = options;

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

    async previewServer(directory, command, ttl) {
      const preview = await startPreviewServer(directory, command, ttl);
      return { url: preview.url, port: preview.port };
    },

    async postMessage(channelId, threadId, text, platform) {
      // If a schedule was just created for this thread, suppress the confirmation text
      // (Claude may still call post_message despite being told not to)
      if (threadsWithScheduleCreated.has(threadId)) {
        console.log(`[callbacks] suppressed post_message for thread ${threadId} (schedule created)`);
        return;
      }
      threadsWithPostMessage.add(threadId);
      const adapter = getAdapter(platform);
      await adapter.sendMessage(channelId, threadId, text);
    },

    async askUserQuestion(channelId, threadId, questions, platform, requestId) {
      const adapter = getAdapter(platform);
      await adapter.postUserQuestion(channelId, threadId, questions, requestId, null);
    },

    async renderTodos(channelId, threadId, todos, platform) {
      const adapter = getAdapter(platform);
      await adapter.renderTodoList(channelId, threadId, todos);
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

    async scheduleSession(channelId, threadId, prompt, originalRequest, cronExpression, scheduledAt, title) {
      if (!store) {
        throw new Error('Store not available for scheduling');
      }
      const project = store.getProjectByChannelId(channelId);
      if (!project) {
        throw new Error(`No project connected to channel ${channelId}`);
      }

      const nextRunAt = cronExpression
        ? computeNextRun(cronExpression)
        : scheduledAt!;

      const schedule = store.createSchedule(
        project.id, channelId, prompt, originalRequest,
        { cronExpression, scheduledAt, nextRunAt, threadId, title },
      );
      console.log(`[callbacks] created schedule ${schedule.id} for channel ${channelId}`);

      // Mark the thread so the adapter can suppress assistant_text and swap emoji
      if (threadId) {
        threadsWithScheduleCreated.add(threadId);
      }

      return { scheduleId: schedule.id };
    },
  };
}

/** Close all active file browsers. Called during shutdown. */
export async function closeAllFileBrowsers(): Promise<void> {
  for (const browser of activeFileBrowsers) {
    try {
      await browser.close();
    } catch (err: any) {
      console.error(`[callbacks] failed to close file browser: ${err.message}`);
    }
  }
  activeFileBrowsers.length = 0;
}
