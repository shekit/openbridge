/**
 * Normalized event types for OpenBridge.
 *
 * Both Claude Code and Codex CLI produce different output formats.
 * These types represent the bridge's internal event model that all
 * backend output is normalized into before being passed to adapters.
 */

export interface AssistantText {
  type: 'assistant_text';
  text: string;
}

export interface ToolUse {
  type: 'tool_use';
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId?: string;
}

export interface ToolResult {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError: boolean;
}

export interface CommandExecution {
  type: 'command_execution';
  command: string;
  exitCode: number;
  output: string;
}

export interface PermissionDenied {
  type: 'permission_denied';
  toolName: string;
  toolInput: Record<string, unknown>;
  context?: string;
}

export interface SessionStarted {
  type: 'session_started';
  sessionId: string;
}

export interface TurnCompleted {
  type: 'turn_completed';
}

export interface ErrorEvent {
  type: 'error';
  message: string;
}

export type NormalizedEvent =
  | AssistantText
  | ToolUse
  | ToolResult
  | CommandExecution
  | PermissionDenied
  | SessionStarted
  | TurnCompleted
  | ErrorEvent;
