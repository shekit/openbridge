/**
 * Shared adapter interface for OpenBridge messaging platforms.
 *
 * Each messaging adapter (Slack, Discord) implements this interface.
 * The core bridge code calls these methods without knowing which platform
 * is active.
 */

import type { NormalizedEvent } from './events.js';

export interface Adapter {
  /** Connect to the messaging platform and start listening. */
  start(): Promise<void>;

  /** Disconnect from the messaging platform. */
  stop(): Promise<void>;

  /** Post a text message in a thread. Splits long messages as needed. */
  postText(channelId: string, threadTs: string, text: string, client: any): Promise<void>;

  /** Post an interactive permission prompt with Allow/Deny buttons. */
  postPermissionPrompt(
    channelId: string,
    threadTs: string,
    event: { toolName: string; toolInput: Record<string, unknown>; context?: string },
    client: any
  ): Promise<void>;

  /** Post an error message. */
  postError(channelId: string, threadTs: string, message: string, client: any): Promise<void>;

  /** Upload a file as an attachment in a thread. Called by MCP callbacks. */
  uploadFile(channelId: string, threadId: string, filePath: string): Promise<void>;

  /** Post a plain text message to a thread. Called by MCP callbacks (no context object needed). */
  sendMessage(channelId: string, threadId: string, text: string): Promise<void>;
}
