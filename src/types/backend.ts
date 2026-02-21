/**
 * Backend interface for OpenBridge coding agent wrappers.
 *
 * Each backend (Claude Code, Codex CLI) implements this interface.
 * The router calls these methods without knowing which backend is active.
 */

import type { NormalizedEvent } from './events.js';

export interface SendResult {
  events: NormalizedEvent[];
  sessionId: string | null;
}

/** MCP server configuration for injection into backend CLI. */
export interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface BackendOptions {
  projectDir: string;
  /** Optional MCP server config to inject so the backend agent gets bridge tools. */
  mcpConfig?: McpServerEntry;
  /** IPC server connection info for hook scripts. */
  ipc?: { port: number; secret: string };
  /** Chat context for hook scripts to send permission prompts. */
  channelId?: string;
  threadId?: string;
  platform?: string;
  /** Path to compiled hook scripts directory (dist/hooks/). */
  hookScriptDir?: string;
  /** Permission mode for the project ('trusted' skips all permission prompts). */
  permissionMode?: string;
}

export interface Backend {
  /** Prepare the backend (e.g., validate CLI is available). */
  start(options: BackendOptions): Promise<void>;

  /** Send a prompt and return normalized events + session ID. */
  send(text: string): Promise<SendResult>;

  /** Return the current session ID for resume, or null if none. */
  getSessionId(): string | null;

  /** Set the session ID for resume (used by the router to restore from DB). */
  setSessionId(id: string | null): void;

  /** Set tools to auto-approve on the next send (for permission Allow flow). */
  setAllowedTools(tools: string[]): void;

  /** Clean shutdown — kill any running process. */
  stop(): Promise<void>;
}
