/**
 * Claude Code SDK backend wrapper.
 *
 * Uses the Agent SDK's streaming input mode instead of spawning CLI processes.
 * One long-lived query() per backend instance — messages are yielded via an
 * async generator, and interrupt() provides clean cancellation.
 */

import type {
  Query,
  SDKMessage,
  SDKUserMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKAssistantMessage,
  Options,
} from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Backend, BackendOptions, FileAttachment, McpServerEntry, SendResult } from '../types/backend.js';
import type { NormalizedEvent } from '../types/events.js';
import { MCP_TOOLS, buildHookSettings } from './claude.js';

/**
 * Promise-based message queue that bridges chat messages into the SDK's
 * AsyncIterable<SDKUserMessage> input stream.
 */
export class MessageQueue {
  private resolvers: Array<(value: SDKUserMessage) => void> = [];
  private messages: SDKUserMessage[] = [];
  private closed = false;

  /** Push a message into the queue, resolving any waiting consumer. */
  push(msg: SDKUserMessage): void {
    if (this.closed) return;
    if (this.resolvers.length > 0) {
      this.resolvers.shift()!(msg);
    } else {
      this.messages.push(msg);
    }
  }

  /** Wait for the next message. Resolves immediately if one is buffered. */
  async pop(): Promise<SDKUserMessage | null> {
    if (this.messages.length > 0) {
      return this.messages.shift()!;
    }
    if (this.closed) return null;
    return new Promise((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  /** Signal no more messages — unblock any waiting consumers. */
  close(): void {
    this.closed = true;
    // Resolve all waiting consumers with a sentinel
    for (const resolve of this.resolvers) {
      resolve(null as any);
    }
    this.resolvers = [];
    this.messages = [];
  }
}

/**
 * Build an SDKUserMessage from text and optional file attachments.
 * The session_id field is required by the type but filled by the SDK internally
 * for input messages — we pass an empty string as a placeholder.
 */
function buildUserMessage(text: string, files?: FileAttachment[]): SDKUserMessage {
  const content: Array<Record<string, unknown>> = [];

  // Add file content blocks (images and PDFs)
  if (files) {
    for (const file of files) {
      if (file.kind === 'image') {
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: file.mediaType,
            data: file.base64,
          },
        });
      } else if (file.kind === 'pdf') {
        content.push({
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: file.base64,
          },
        });
      }
    }
  }

  // Add text prompt
  content.push({ type: 'text', text });

  return {
    type: 'user',
    message: {
      role: 'user',
      content: content as any,
    },
    parent_tool_use_id: null,
    session_id: '', // Filled by SDK for input messages
  };
}

/**
 * Map an SDK message to normalized events.
 * Returns an empty array for message types we don't care about.
 */
export function mapSdkMessage(msg: SDKMessage): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];

  switch (msg.type) {
    case 'system': {
      const sys = msg as SDKSystemMessage;
      if (sys.subtype === 'init') {
        events.push({ type: 'session_started', sessionId: sys.session_id });
      }
      break;
    }

    case 'assistant': {
      const asst = msg as SDKAssistantMessage;
      const content = asst.message?.content;
      if (Array.isArray(content)) {
        const textParts = content
          .filter((block: any) => block.type === 'text' && typeof block.text === 'string')
          .map((block: any) => block.text as string);
        if (textParts.length > 0) {
          events.push({ type: 'assistant_text', text: textParts.join('\n') });
        }
      }
      break;
    }

    case 'result': {
      const result = msg as SDKResultMessage;

      // Extract permission denials
      if (result.permission_denials && result.permission_denials.length > 0) {
        for (const denial of result.permission_denials) {
          events.push({
            type: 'permission_denied',
            toolName: denial.tool_name || 'unknown',
            toolInput: denial.tool_input || {},
          });
        }
      }

      // Error results
      if (result.is_error) {
        const errorResult = result as SDKResultMessage & { errors?: string[] };
        const message = Array.isArray(errorResult.errors) && errorResult.errors.length > 0
          ? errorResult.errors[0]
          : `Claude execution failed (${result.subtype})`;
        events.push({ type: 'error', message });
      }

      // Turn completed
      events.push({ type: 'turn_completed' });
      break;
    }

    // Ignore user messages, replays, compact boundaries, partial messages, etc.
    default:
      break;
  }

  return events;
}

export class ClaudeSdkBackend implements Backend {
  private sessionId: string | null = null;
  private projectDir: string = '';
  private mcpConfig: McpServerEntry | undefined;
  private allowedTools: string[] = [];
  private ipc?: { port: number; secret: string };
  private channelId?: string;
  private threadId?: string;
  private platform?: string;
  private hookScriptDir?: string;
  private permissionMode?: string;

  private activeQuery: Query | null = null;
  private messageQueue: MessageQueue | null = null;
  private abortController: AbortController | null = null;
  private eventBuffer: NormalizedEvent[] = [];
  private resultResolve: (() => void) | null = null;
  private eventLoopPromise: Promise<void> | null = null;

  async start(options: BackendOptions): Promise<void> {
    this.projectDir = options.projectDir;
    this.mcpConfig = options.mcpConfig;
    this.ipc = options.ipc;
    this.channelId = options.channelId;
    this.threadId = options.threadId;
    this.platform = options.platform;
    this.hookScriptDir = options.hookScriptDir;
    this.permissionMode = options.permissionMode;

    // Create message queue and abort controller
    this.messageQueue = new MessageQueue();
    this.abortController = new AbortController();
    this.eventBuffer = [];

    // Build the async generator that feeds messages to the SDK
    const queue = this.messageQueue;
    async function* streamInput(): AsyncGenerator<SDKUserMessage> {
      while (true) {
        const msg = await queue.pop();
        if (msg === null) return; // Queue closed
        yield msg;
      }
    }

    // Build SDK options
    const sdkOptions = this.buildOptions();

    // Start the query
    console.log(`[claude-sdk] starting query for project: ${this.projectDir}`);
    this.activeQuery = query({
      prompt: streamInput(),
      options: sdkOptions,
    });

    // Start the background event loop
    this.eventLoopPromise = this.runEventLoop();
  }

  /**
   * Build SDK options from the backend configuration.
   */
  private buildOptions(): Options {
    const trusted = this.permissionMode === 'trusted';

    // Build env vars for hook scripts
    const env: Record<string, string | undefined> = { ...process.env };
    if (this.ipc) {
      env.OPENBRIDGE_IPC_PORT = String(this.ipc.port);
      env.OPENBRIDGE_IPC_SECRET = this.ipc.secret;
      if (this.channelId) env.OPENBRIDGE_CHANNEL_ID = this.channelId;
      if (this.threadId) env.OPENBRIDGE_THREAD_ID = this.threadId;
      if (this.platform) env.OPENBRIDGE_PLATFORM = this.platform;
      if (this.permissionMode) env.OPENBRIDGE_PERMISSION_MODE = this.permissionMode;
    }

    // Always pre-approve our MCP tools, plus any user-approved tools
    const allTools = [...MCP_TOOLS, ...this.allowedTools];
    const uniqueTools = [...new Set(allTools)];

    // MCP server configuration
    const mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> = {};
    if (this.mcpConfig) {
      mcpServers['openbridge'] = {
        command: this.mcpConfig.command,
        args: this.mcpConfig.args,
        ...(this.mcpConfig.env ? { env: this.mcpConfig.env } : {}),
      };
    }

    // Build hook settings via extraArgs (keeps existing hook system working)
    const extraArgs: Record<string, string | null> = {};
    if (this.hookScriptDir) {
      extraArgs['settings'] = buildHookSettings(this.hookScriptDir);
    }

    const opts: Options = {
      cwd: this.projectDir,
      env,
      allowedTools: uniqueTools,
      mcpServers,
      extraArgs,
      settingSources: ['project'], // Load CLAUDE.md files
      abortController: this.abortController ?? undefined,
      stderr: (data: string) => {
        console.error(`[claude-sdk:stderr] ${data.trimEnd()}`);
      },
    };

    // Session resume
    if (this.sessionId) {
      opts.resume = this.sessionId;
    }

    // Permission mode
    if (trusted) {
      opts.permissionMode = 'bypassPermissions';
      opts.allowDangerouslySkipPermissions = true;
    }

    return opts;
  }

  /**
   * Background event loop — consumes SDK messages and buffers them.
   * When a result message arrives, signals the waiting send() call.
   */
  private async runEventLoop(): Promise<void> {
    if (!this.activeQuery) return;

    try {
      for await (const msg of this.activeQuery) {
        const events = mapSdkMessage(msg);
        this.eventBuffer.push(...events);

        // Check for session ID in system init messages
        if (msg.type === 'system' && 'subtype' in msg && msg.subtype === 'init') {
          this.sessionId = msg.session_id;
          console.log(`[claude-sdk] session started: ${this.sessionId}`);
        }

        // When we get a result, signal the waiting send() call
        if (msg.type === 'result') {
          if (this.resultResolve) {
            this.resultResolve();
            this.resultResolve = null;
          }
        }
      }
    } catch (err: any) {
      // AbortError is expected on stop/interrupt
      if (err?.name === 'AbortError' || this.abortController?.signal.aborted) {
        console.log('[claude-sdk] query aborted');
      } else {
        console.error('[claude-sdk] event loop error:', err);
        this.eventBuffer.push({ type: 'error', message: err?.message ?? 'SDK error' });
      }
      // Signal any waiting send()
      if (this.resultResolve) {
        this.resultResolve();
        this.resultResolve = null;
      }
    }
  }

  async send(text: string, files?: FileAttachment[]): Promise<SendResult> {
    if (!this.messageQueue || !this.activeQuery) {
      throw new Error('Backend not started — call start() first');
    }

    // Clear the event buffer for this turn
    this.eventBuffer = [];

    // Build and push the user message
    const msg = buildUserMessage(text, files);
    this.messageQueue.push(msg);

    // Wait for the result message to arrive
    await new Promise<void>((resolve) => {
      this.resultResolve = resolve;
    });

    // Clear allowed tools after use (one-shot approval)
    this.allowedTools = [];

    // Ensure turn_completed is present
    if (!this.eventBuffer.some(e => e.type === 'turn_completed')) {
      this.eventBuffer.push({ type: 'turn_completed' });
    }

    return {
      events: [...this.eventBuffer],
      sessionId: this.sessionId,
    };
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  setSessionId(id: string | null): void {
    this.sessionId = id;
  }

  setAllowedTools(tools: string[]): void {
    this.allowedTools = tools;
  }

  async interrupt(): Promise<void> {
    if (this.activeQuery) {
      console.log('[claude-sdk] interrupting');
      try {
        await this.activeQuery.interrupt();
      } catch (err: any) {
        console.error('[claude-sdk] interrupt error:', err);
      }
    }
  }

  isAlive(): boolean {
    return this.activeQuery !== null;
  }

  async stop(): Promise<void> {
    console.log('[claude-sdk] stopping');

    // Close the message queue to end the generator
    if (this.messageQueue) {
      this.messageQueue.close();
      this.messageQueue = null;
    }

    // Close the query (hard kill)
    if (this.activeQuery) {
      try {
        this.activeQuery.close();
      } catch { /* already closed */ }
      this.activeQuery = null;
    }

    // Abort any pending operations
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    // Wait for event loop to finish
    if (this.eventLoopPromise) {
      try {
        await this.eventLoopPromise;
      } catch { /* ignore */ }
      this.eventLoopPromise = null;
    }

    this.sessionId = null;
  }
}
