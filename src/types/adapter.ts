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

  /** Post an interactive permission prompt with Allow/Deny buttons.
   *  When requestId is provided (hook-based flow), buttons resolve the permission
   *  in-process via resolvePermission() instead of calling router.respond(). */
  postPermissionPrompt(
    channelId: string,
    threadTs: string,
    event: { toolName: string; toolInput: Record<string, unknown>; context?: string; requestId?: string },
    client: any
  ): Promise<void>;

  /** Post an interactive question with dynamic option buttons.
   *  Called when Claude Code uses AskUserQuestion — renders options as buttons. */
  postUserQuestion(
    channelId: string,
    threadTs: string,
    questions: Array<{
      question: string;
      header: string;
      options: Array<{ label: string; description: string }>;
      multiSelect: boolean;
    }>,
    requestId: string,
    client: any
  ): Promise<void>;

  /** Post an error message. */
  postError(channelId: string, threadTs: string, message: string, client: any): Promise<void>;

  /** Upload a file as an attachment in a thread. Called by MCP callbacks. */
  uploadFile(channelId: string, threadId: string, filePath: string): Promise<void>;

  /** Post a plain text message to a thread. Called by MCP callbacks (no context object needed). */
  sendMessage(channelId: string, threadId: string, text: string): Promise<void>;
}
