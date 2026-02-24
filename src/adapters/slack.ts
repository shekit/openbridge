/**
 * Slack adapter for OpenBridge.
 *
 * Connects to Slack via Socket Mode using @slack/bolt.
 * Listens for messages and slash commands, routes them through the router,
 * and posts responses back to the appropriate threads.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { App, type LogLevel } from '@slack/bolt';
import type { Router, RouteResult } from '../router.js';
import type { NormalizedEvent } from '../types/events.js';
import type { Store } from '../store.js';
import { splitText, downloadAndStageFile, markdownToSlackMrkdwn } from '../utils.js';
import type { FileAttachment } from '../types/backend.js';
import { resolvePermission, resolveUserQuestion, hasPendingQuestion, resolveQuestionByThread } from '../mcp/ipc-server.js';
import { clearPostMessageFlag, wasPostMessageCalled } from '../mcp/callbacks.js';

const SLACK_MESSAGE_LIMIT = 4000;

/**
 * Number of projects to show per page in the project picker.
 * Capped at 20 (Slack allows max 5 action blocks × 5 buttons, minus one row for "Show more").
 */
const PICKER_PAGE_SIZE = 15;

export interface SlackAdapterOptions {
  botToken: string;
  appToken: string;
  router: Router;
  store: Store;
  /** Optional pre-created App instance (for testing). */
  app?: App;
}

export function createBoltApp(botToken: string, appToken: string): App {
  return new App({
    token: botToken,
    socketMode: true,
    appToken: appToken,
  });
}

export class SlackAdapter {
  private app: App;
  private router: Router;
  private store: Store;
  private botUserId: string | null = null;
  /** Message refs for pending AskUserQuestion prompts, for updating on resolution. */
  private questionMessages = new Map<string, { channel: string; ts: string; blocks: any[] }>();
  /** Message refs for todo checklist messages, keyed by threadId (one per thread). */
  private todoMessages = new Map<string, { channel: string; ts: string }>();
  /** Tracked permission/question ack messages per thread, for 👀 cleanup after backend responds. */
  private permissionAckMessages = new Map<string, Array<{ channel: string; ts: string }>>();

  constructor(options: SlackAdapterOptions) {
    this.router = options.router;
    this.store = options.store;

    this.app = options.app ?? createBoltApp(options.botToken, options.appToken);

    this.registerHandlers();
  }

  /** Start the Slack adapter — connects via Socket Mode. */
  async start(): Promise<void> {
    await this.app.start();

    // Fetch our own bot user ID to filter out self-messages
    const authResult = await this.app.client.auth.test({ token: (this.app as any).token });
    this.botUserId = authResult.user_id ?? null;

    console.log('[slack] connected via Socket Mode');
  }

  /** Stop the Slack adapter — disconnect. */
  async stop(): Promise<void> {
    await this.app.stop();
    console.log('[slack] disconnected');
  }

  /** Get the underlying Bolt app (for testing). */
  getApp(): App {
    return this.app;
  }

  /** Register all Slack event handlers. */
  private registerHandlers(): void {
    // Message handler
    this.app.message(async ({ message, client }) => {
      await this.handleMessage(message as any, client);
    });

    // Button action handlers for permission prompts
    this.app.action('permission_allow', async ({ body, ack, client }) => {
      await ack();
      await this.handlePermissionAction(body as any, 'allow', client);
    });

    this.app.action('permission_deny', async ({ body, ack, client }) => {
      await ack();
      await this.handlePermissionAction(body as any, 'deny', client);
    });

    // AskUserQuestion dynamic option buttons
    this.app.action(/^question_answer_/, async ({ body, ack, client }) => {
      await ack();
      await this.handleQuestionAnswer(body as any, client);
    });

    // Project bind/create buttons — delegate to shared helpers
    this.app.action('project_bind_here', async ({ body, ack, client }) => {
      await ack();
      const projectDir = (body as any).actions?.[0]?.value;
      const channelId = (body as any).channel?.id;
      if (!projectDir || !channelId) return;
      await this.bindProjectToChannel(channelId, projectDir, client as any);
    });

    this.app.action('project_create_new', async ({ body, ack, client }) => {
      await ack();
      const projectDir = (body as any).actions?.[0]?.value;
      const sourceChannelId = (body as any).channel?.id;
      if (!projectDir || !sourceChannelId) return;
      const userId = (body as any).user?.id;
      const backend = this.getDefaultBackend();
      await this.createChannelAndBind(sourceChannelId, projectDir, backend, userId, client as any);
    });

    this.app.action('project_bind_existing', async ({ body, ack, client }) => {
      await ack();
      const action = (body as any).actions?.[0];
      const sourceChannelId = (body as any).channel?.id;
      if (!action?.value || !sourceChannelId) return;
      const { channelId: targetChannelId, projectDir } = JSON.parse(action.value);
      await this.bindProjectToChannel(targetChannelId, projectDir, client as any, sourceChannelId);
    });

    this.app.action(/^project_pick_/, async ({ body, ack, client }) => {
      await ack();
      const action = (body as any).actions?.[0];
      const channelId = (body as any).channel?.id;
      const projectDir = action?.value;
      if (!projectDir || !channelId) return;
      await this.handleProjectConnect(channelId, projectDir, { user_id: (body as any).user?.id }, client as any);
    });

    this.app.action('permission_always_allow', async ({ body, ack, client }) => {
      await ack();
      await this.handlePermissionAction(body as any, 'always_allow', client);
    });

    this.app.action('sandbox_upgrade', async ({ body, ack, client }) => {
      await ack();
      await this.handleSandboxUpgrade(body as any, client);
    });

    this.app.action('perm_mode_trusted', async ({ body, ack, client }) => {
      await ack();
      await this.handlePermModeAction(body as any, 'trusted', client);
    });

    this.app.action('perm_mode_supervised', async ({ body, ack, client }) => {
      await ack();
      await this.handlePermModeAction(body as any, 'supervised', client);
    });

    this.app.action('project_picker_more', async ({ body, ack, client }) => {
      await ack();
      const channelId = (body as any).channel?.id;
      const offset = parseInt((body as any).actions?.[0]?.value ?? '0', 10);
      if (!channelId) return;
      await this.postProjectPicker(channelId, offset, client as any);
    });

    // Slash commands
    this.app.command('/project', async ({ command, ack, client }) => {
      await ack();
      if (!(await this.ensureInChannel(command.channel_id, client))) return;
      await this.handleProjectCommand(command, client);
    });

    this.app.command('/settings', async ({ command, ack, client }) => {
      await ack();
      if (!(await this.ensureInChannel(command.channel_id, client))) return;
      await this.handleSettingsCommand(command, client);
    });

    // /schedule subcommands are handled under /settings (schedule list, schedule cancel)
  }

  /**
   * Auto-join a channel if the bot isn't already in it.
   * Returns true if the bot is in the channel, false if it can't join.
   */
  private async ensureInChannel(channelId: string, client: any): Promise<boolean> {
    // First check if we're already in the channel (works for both public and private)
    try {
      const info = await client.conversations.info({ channel: channelId });
      if (info.channel?.is_member) {
        return true;
      }
    } catch {
      // Can't even see the channel — bot hasn't been invited to a private channel
      console.log(`[slack] cannot access channel ${channelId} — bot may not be invited`);
      return false;
    }

    // Not a member yet — try to join (only works for public channels)
    try {
      await client.conversations.join({ channel: channelId });
      return true;
    } catch (err: any) {
      const errorCode = err?.data?.error;
      // Private channel — bot can see it but can't self-join
      try {
        await client.chat.postMessage({
          channel: channelId,
          text: 'I need to be in this channel first. Run `/invite @OpenBridge` and try again.',
        });
      } catch (postErr: any) {
        console.error(`[slack] cannot join or post to channel ${channelId}: ${errorCode}, post error: ${postErr.message}`);
      }
      return false;
    }
  }

  /** React with 👀 to acknowledge a user's message. */
  private async reactSeen(channelId: string, messageTs: string, client: any): Promise<void> {
    try {
      await client.reactions.add({ channel: channelId, timestamp: messageTs, name: 'eyes' });
    } catch (err: any) {
      console.error(`[slack] failed to add eyes reaction in ${channelId}: ${err.message}`);
    }
  }

  /** Remove the 👀 reaction after the backend has responded. */
  private async removeReactSeen(channelId: string, messageTs: string, client: any): Promise<void> {
    try {
      await client.reactions.remove({ channel: channelId, timestamp: messageTs, name: 'eyes' });
    } catch {
      // Non-fatal — reaction may already be removed or missing
    }
  }

  /** Track a permission/question ack message for later 👀 cleanup. */
  private trackPermissionAck(threadTs: string, channelId: string, messageTs: string): void {
    const list = this.permissionAckMessages.get(threadTs) ?? [];
    list.push({ channel: channelId, ts: messageTs });
    this.permissionAckMessages.set(threadTs, list);
  }

  /** Remove 👀 from all tracked permission ack messages for a thread. */
  private async cleanupPermissionAcks(threadTs: string, client: any): Promise<void> {
    const acks = this.permissionAckMessages.get(threadTs);
    if (!acks || acks.length === 0) return;
    this.permissionAckMessages.delete(threadTs);
    for (const ack of acks) {
      await this.removeReactSeen(ack.channel, ack.ts, client);
    }
  }

  /** Handle an incoming Slack message. */
  private async handleMessage(message: any, client: any): Promise<void> {
    // Ignore bot messages (including our own) and system messages
    // Allow file_share subtype through so image+text messages are handled
    if (message.bot_id) {
      return;
    }
    if (message.subtype && message.subtype !== 'file_share') {
      return;
    }
    if (this.botUserId && message.user === this.botUserId) {
      return;
    }

    const channelId = message.channel;
    const text = message.text || '';
    let threadTs = message.thread_ts || null;

    // Check if this channel is bound to a project
    const project = this.store.getProjectByChannelId(channelId);
    if (!project) {
      return; // Not a bound channel, ignore
    }

    // Handle text commands in threads (slash commands don't work in Slack threads)
    if (threadTs) {
      const trimmed = text.trim().toLowerCase();
      if (trimmed === 'cancel') {
        try {
          const cancelled = await this.router.cancelBackend(channelId, threadTs);
          if (cancelled) {
            await client.chat.postMessage({
              channel: channelId,
              thread_ts: threadTs,
              text: 'Cancelling the running task...',
            });
          } else {
            await client.chat.postMessage({
              channel: channelId,
              thread_ts: threadTs,
              text: 'Nothing to cancel — no task is currently running in this thread.',
            });
          }
        } catch (err: any) {
          await this.postError(channelId, threadTs, err.message, client);
        }
        return;
      }
      if (trimmed === 'new') {
        try {
          this.router.resetSession(channelId, threadTs);
          await client.chat.postMessage({
            channel: channelId,
            thread_ts: threadTs,
            text: 'Session reset. Your next message will start a fresh conversation.',
          });
        } catch (err: any) {
          await this.postError(channelId, threadTs, err.message, client);
        }
        return;
      }
    }

    // If this is a top-level message (no thread_ts), create a new thread
    if (!threadTs) {
      threadTs = message.ts;
    }

    // React with 👀 to acknowledge the user's message
    await this.reactSeen(channelId, message.ts, client);

    // Handle file attachments — route through handleFileUpload
    if (Array.isArray(message.files) && message.files.length > 0) {
      await this.handleFileUpload(channelId, threadTs, message.files, text, client, message.ts);
      return;
    }

    // If there's a pending AskUserQuestion for this thread, resolve it with the typed text
    if (hasPendingQuestion(threadTs)) {
      const requestId = resolveQuestionByThread(threadTs, text);
      console.log(`[slack] resolved pending question for thread ${threadTs} with typed response`);
      // Update the button message to show it's been answered
      if (requestId) {
        const msgRef = this.questionMessages.get(requestId);
        if (msgRef) {
          this.questionMessages.delete(requestId);
          try {
            const updatedBlocks = [...msgRef.blocks, { type: 'section', text: { type: 'mrkdwn', text: `*Answered:* ${text}` } }];
            await client.chat.update({
              channel: msgRef.channel,
              ts: msgRef.ts,
              text: `Answered: ${text}`,
              blocks: updatedBlocks,
            });
          } catch (err: any) {
            console.error(`[slack] failed to update question message for thread ${threadTs}: ${err.message}`);
          }
        }
      }
      // Track the 👀 on this freeform message so it gets cleaned up
      // when the original handleMessage call finishes (cleanupPermissionAcks)
      this.trackPermissionAck(threadTs, channelId, message.ts);
      return;
    }

    // Check if the session is waiting_for_input (freeform text response)
    const session = this.store.getSessionByThreadId(threadTs);
    if (session && session.state === 'waiting_for_input') {
      await this.handleFreeformResponse(channelId, threadTs, text, client, message.ts);
      return;
    }

    // Route through the router
    clearPostMessageFlag(threadTs);
    let result: RouteResult;
    try {
      result = await this.router.send(channelId, threadTs, text);
    } catch (err: any) {
      await this.postError(channelId, threadTs, err.message, client);
      return;
    }

    await this.renderEvents(channelId, threadTs, result.events, client);
    await this.removeReactSeen(channelId, message.ts, client);
    await this.cleanupPermissionAcks(threadTs, client);
  }

  /** Handle freeform text when session is waiting_for_input. */
  private async handleFreeformResponse(
    channelId: string,
    threadTs: string,
    text: string,
    client: any,
    messageTs?: string,
  ): Promise<void> {
    clearPostMessageFlag(threadTs);
    let result: RouteResult;
    try {
      result = await this.router.respond(channelId, threadTs, text);
    } catch (err: any) {
      await this.postError(channelId, threadTs, err.message, client);
      return;
    }

    await this.renderEvents(channelId, threadTs, result.events, client);
    if (messageTs) await this.removeReactSeen(channelId, messageTs, client);
    await this.cleanupPermissionAcks(threadTs, client);
  }

  /** Handle permission Allow/Deny/Always Allow button clicks.
   *  Button value is "toolName|requestId" (hook flow) or "toolName" (legacy). */
  private async handlePermissionAction(body: any, action: string, client: any): Promise<void> {
    const channelId = body.channel?.id;
    const threadTs = body.message?.thread_ts;
    const messageTs = body.message?.ts;
    const rawValue: string = body.actions?.[0]?.value ?? '';

    if (!channelId || !threadTs) {
      return;
    }

    // Parse button value: "toolName|requestId" or just "toolName"
    const pipeIdx = rawValue.indexOf('|');
    const toolName = pipeIdx >= 0 ? rawValue.slice(0, pipeIdx) : rawValue;
    const requestId = pipeIdx >= 0 ? rawValue.slice(pipeIdx + 1) : undefined;

    // For "always_allow", persist the tool pattern for future sessions
    if (action === 'always_allow' && toolName) {
      const project = this.store.getProjectByChannelId(channelId);
      if (project) {
        this.store.addAllowedTool(project.id, toolName);
        console.log(`[slack] added always-allow tool '${toolName}' for project ${project.id}`);
      }
    }

    // Determine display label and effective action
    const isAllow = action === 'allow' || action === 'always_allow';
    const actionLabel = action === 'always_allow' ? 'Always Allowed' : (isAllow ? 'Allowed' : 'Denied');

    // Update the original message to show which action was taken
    try {
      await client.chat.update({
        channel: channelId,
        ts: messageTs,
        text: `Permission: ${actionLabel}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Permission ${actionLabel}*`,
            },
          },
        ],
      });
    } catch (err: any) {
      console.error(`[slack] failed to update permission message in ${channelId}: ${err.message}`);
    }

    // React with 👀 on the permission message to acknowledge the click
    if (channelId && messageTs) {
      await this.reactSeen(channelId, messageTs, client);
      this.trackPermissionAck(threadTs, channelId, messageTs);
    }

    // Hook-based flow: resolve in-process, no need to call router.respond()
    if (requestId) {
      const decision = isAllow ? 'allow' : 'deny';
      resolvePermission(requestId, decision);
      console.log(`[slack] resolved permission ${requestId} → ${decision}`);
      return;
    }

    // Legacy flow: route through router.respond()
    const responseText = isAllow ? 'yes' : 'no';
    const allowedTools = isAllow && toolName ? [toolName] : undefined;
    clearPostMessageFlag(threadTs);
    let result: RouteResult;
    try {
      result = await this.router.respond(channelId, threadTs, responseText, allowedTools);
    } catch (err: any) {
      await this.postError(channelId, threadTs, err.message, client);
      return;
    }

    await this.renderEvents(channelId, threadTs, result.events, client);
    await this.cleanupPermissionAcks(threadTs, client);
  }

  /** Render normalized events as Slack messages in a thread. */
  private async renderEvents(
    channelId: string,
    threadTs: string,
    events: NormalizedEvent[],
    client: any
  ): Promise<void> {
    // Deduplicate consecutive identical permission_denied events
    const seenDenials = new Set<string>();
    const deduped = events.filter((event) => {
      if (event.type === 'permission_denied') {
        const key = `${event.toolName}:${JSON.stringify(event.toolInput)}`;
        if (seenDenials.has(key)) return false;
        seenDenials.add(key);
      }
      return true;
    });

    // If Claude used post_message during this turn, suppress assistant_text
    // (Claude already communicated directly). Otherwise, render only the last
    // assistant_text block as a fallback summary.
    const postMessageUsed = wasPostMessageCalled(threadTs);
    const assistantTexts = deduped.filter(e => e.type === 'assistant_text');
    const lastAssistantText = assistantTexts.length > 0
      ? assistantTexts[assistantTexts.length - 1]
      : null;

    for (const event of deduped) {
      switch (event.type) {
        case 'assistant_text':
          if (!postMessageUsed && event === lastAssistantText) {
            // Truncate fallback text to last 500 chars (keep the ending, which is most useful)
            const MAX_FALLBACK = 500;
            let fallbackText = event.text;
            if (fallbackText.length > MAX_FALLBACK) {
              fallbackText = '...' + fallbackText.slice(-MAX_FALLBACK);
            }
            await this.postText(channelId, threadTs, fallbackText, client);
          }
          break;

        case 'permission_denied':
          // AskUserQuestion denials are expected — the hook already rendered buttons
          if (event.toolName === 'AskUserQuestion') break;
          if (event.toolName === 'sandbox') {
            await this.postSandboxUpgradePrompt(channelId, threadTs, event.context || '', client);
          } else {
            await this.postPermissionPrompt(channelId, threadTs, event, client);
          }
          break;

        case 'error':
          await this.postError(channelId, threadTs, event.message, client);
          break;

        // Other event types (tool_use, tool_result, command_execution, etc.)
        // are not rendered to the user — they're internal to the backend
        default:
          break;
      }
    }
  }

  /** Post text response, splitting if it exceeds Slack's limit. */
  async postText(channelId: string, threadTs: string, text: string, client: any): Promise<void> {
    const converted = markdownToSlackMrkdwn(text);
    if (converted.length <= SLACK_MESSAGE_LIMIT) {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: converted,
      });
    } else {
      // Split into chunks
      const chunks = splitText(converted, SLACK_MESSAGE_LIMIT);
      for (const chunk of chunks) {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: chunk,
        });
      }
    }
  }

  /** Post a permission denial prompt with Allow/Deny buttons.
   *  When event.requestId is set (hook-based flow), it's embedded in button values
   *  so the action handler can resolve the permission in-process. */
  async postPermissionPrompt(
    channelId: string,
    threadTs: string,
    event: { toolName: string; toolInput: Record<string, unknown>; context?: string; requestId?: string },
    client: any
  ): Promise<void> {
    let inputStr = JSON.stringify(event.toolInput, null, 2);
    // Truncate tool input to avoid exceeding Slack's 3000-char block text limit
    const MAX_INPUT_DISPLAY = 500;
    if (inputStr.length > MAX_INPUT_DISPLAY) {
      inputStr = inputStr.slice(0, MAX_INPUT_DISPLAY) + '\n... (truncated)';
    }
    const contextStr = event.context ? `\n${event.context}` : '';

    // Embed requestId in button value: "toolName|requestId" (hook flow) or "toolName" (legacy)
    const buttonValue = event.requestId
      ? `${event.toolName}|${event.requestId}`
      : event.toolName;

    // When called from IPC callback (requestPermission), client is null — use stored client
    const chatClient = client ?? this.app.client;

    await chatClient.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `Permission requested: ${event.toolName}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Permission requested: \`${event.toolName}\`*\n\`\`\`${inputStr}\`\`\`${contextStr}`,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Allow' },
              style: 'primary',
              action_id: 'permission_allow',
              value: buttonValue,
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Always Allow' },
              action_id: 'permission_always_allow',
              value: buttonValue,
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Deny' },
              style: 'danger',
              action_id: 'permission_deny',
              value: buttonValue,
            },
          ],
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: '_or type a custom response_',
            },
          ],
        },
      ],
    });
  }

  /** Post an interactive question with dynamic option buttons.
   *  Renders the first question from AskUserQuestion as Slack blocks with buttons. */
  async postUserQuestion(
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
  ): Promise<void> {
    const chatClient = client ?? this.app.client;
    const q = questions[0];
    if (!q) return;

    const optionLines = q.options.map((o) =>
      `• *${o.label}*${o.description ? ` — ${o.description}` : ''}`
    ).join('\n');

    const buttons = q.options.map((opt, i) => ({
      type: 'button' as const,
      text: { type: 'plain_text' as const, text: opt.label.slice(0, 75) },
      action_id: `question_answer_${i}`,
      value: requestId,
    }));

    const questionBlock = {
      type: 'section',
      text: { type: 'mrkdwn', text: `*${q.question}*\n${optionLines}` },
    };
    const result = await chatClient.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: q.question,
      blocks: [questionBlock, { type: 'actions', elements: buttons }],
    });
    if (result.ts) {
      this.questionMessages.set(requestId, { channel: channelId, ts: result.ts, blocks: [questionBlock] });
    }
  }

  /** Handle AskUserQuestion option button clicks.
   *  Resolves the pending question via IPC and updates the message. */
  private async handleQuestionAnswer(body: any, client: any): Promise<void> {
    const action = body.actions?.[0];
    if (!action) return;

    const requestId = action.value;
    const label = action.text?.text ?? '';
    const channelId = body.channel?.id;
    const messageTs = body.message?.ts;
    const threadTs = body.message?.thread_ts;

    if (!requestId || !label) return;

    resolveUserQuestion(requestId, label);
    this.questionMessages.delete(requestId);
    console.log(`[slack] resolved question ${requestId} → "${label}"`);

    if (channelId && messageTs) {
      try {
        // Keep original question/options blocks, remove action buttons, append answer
        const origBlocks = (body.message?.blocks ?? []) as any[];
        const keptBlocks = origBlocks.filter((b: any) => b.type !== 'actions');
        keptBlocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Answered:* ${label}` } });
        await client.chat.update({
          channel: channelId,
          ts: messageTs,
          text: `Answered: ${label}`,
          blocks: keptBlocks,
        });
      } catch (err: any) {
        console.error(`[slack] failed to update question answer message in ${channelId}: ${err.message}`);
      }
    }

    // React with 👀 on the question message to acknowledge the click
    if (channelId && messageTs) {
      await this.reactSeen(channelId, messageTs, client);
      if (threadTs) this.trackPermissionAck(threadTs, channelId, messageTs);
    }
  }

  /** Post an error message. */
  async postError(channelId: string, threadTs: string, message: string, client: any): Promise<void> {
    const MAX_ERROR = 3000;
    const truncated = message.length > MAX_ERROR
      ? message.slice(0, MAX_ERROR) + '\n... (truncated)'
      : message;
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `:warning: *Error:* ${truncated}`,
    });
  }

  /** Build the list of /project subcommand descriptions. */
  private getProjectCommandLines(): string[] {
    const root = this.store.getSetting('projects_root');
    const lines = [
      '• `/project new my-app` — create a new project and connect it to a channel',
    ];
    if (root) {
      lines.push('• `/project connect` — pick a project from your projects root');
      lines.push('• `/project connect /absolute/path` — connect a specific directory');
    } else {
      lines.push('• `/project connect /absolute/path` — connect an existing project to a channel');
    }
    lines.push('• `/project list` — show all connected projects');
    lines.push('• `/project disconnect` — disconnect this channel');
    lines.push('• `/project backend codex` — switch the AI backend for this project');
    return lines;
  }

  /** Handle /project slash command. */
  private async handleProjectCommand(command: any, client: any): Promise<void> {
    const channelId = command.channel_id;
    const rawArgs = (command.text || '').trim();
    const parts = rawArgs.split(/\s+/);
    const subcommand = parts[0] || '';
    const subArg = parts.slice(1).join(' ');

    // /project (no args) or /project help — show usage
    if (!subcommand || subcommand === 'help') {
      const lines = [
        '*`/project` commands:*',
        ...this.getProjectCommandLines(),
        '',
        '*Other commands:*',
        '• `/settings` — view bridge settings',
        '• `/settings root /path` — set projects root folder',
        '• `/settings schedule list` — list active schedules',
        '• `/settings schedule cancel <id>` — cancel a schedule',
      ];
      await client.chat.postMessage({
        channel: channelId,
        text: lines.join('\n'),
      });
      return;
    }

    // /project list
    if (subcommand === 'list') {
      const projects = this.store.listProjects();
      if (projects.length === 0) {
        const root = this.store.getSetting('projects_root');
        const hint = root
          ? 'Use `/project connect` to pick one, or `/project connect /absolute/path`.'
          : 'Use `/project connect /absolute/path` to connect one.';
        await client.chat.postMessage({
          channel: channelId,
          text: `No projects connected to any channels yet. ${hint}`,
        });
        return;
      }
      let text = '*Connected Projects:*\n';
      for (const p of projects) {
        const channelLabel = p.platform === 'slack'
          ? `<#${p.channel_id}>`
          : `${p.platform} channel`;
        text += `• ${channelLabel} → \`${p.project_dir}\` (${p.backend_name})\n`;
      }
      await client.chat.postMessage({ channel: channelId, text });
      return;
    }

    // /project disconnect
    if (subcommand === 'disconnect') {
      const project = this.store.getProjectByChannelId(channelId);
      if (!project) {
        await client.chat.postMessage({
          channel: channelId,
          text: 'This channel is not connected to a project.',
        });
      } else {
        this.store.deleteProject(project.id);
        await client.chat.postMessage({
          channel: channelId,
          text: `Disconnected this channel from \`${project.project_dir}\`.`,
        });
      }
      return;
    }

    // /project new <name|/absolute/path>
    if (subcommand === 'new') {
      const name = subArg;
      if (!name) {
        await client.chat.postMessage({
          channel: channelId,
          text: ':warning: Usage: `/project new my-app` or `/project new /absolute/path/my-app`',
        });
        return;
      }

      let targetDir: string;
      if (path.isAbsolute(name)) {
        targetDir = name;
      } else {
        const root = this.store.getSetting('projects_root');
        if (!root) {
          await client.chat.postMessage({
            channel: channelId,
            text: [
              `:warning: No projects root configured. Either:`,
              '• Set one with `/settings root /path` then use `/project new my-app`',
              '• Or provide an absolute path: `/project new /home/user/my-app`',
            ].join('\n'),
          });
          return;
        }
        targetDir = path.join(root, name);
      }

      if (fs.existsSync(targetDir)) {
        await client.chat.postMessage({
          channel: channelId,
          text: `:warning: Directory already exists: \`${targetDir}\`\nUse \`/project connect ${targetDir}\` to connect to it instead.`,
        });
        return;
      }

      try {
        fs.mkdirSync(targetDir, { recursive: true });
      } catch (err: any) {
        await client.chat.postMessage({
          channel: channelId,
          text: `:warning: Failed to create directory: ${err.message}`,
        });
        return;
      }

      // Bind to this channel (or create a new channel if already bound)
      await this.handleProjectConnect(channelId, targetDir, command, client);
      return;
    }

    // /project connect [/path/to/dir]
    if (subcommand === 'connect') {
      const projectDir = subArg;
      if (!projectDir) {
        // No path given — show picker if projects_root is set
        const root = this.store.getSetting('projects_root');
        if (root && fs.existsSync(root)) {
          await this.postProjectPicker(channelId, 0, client);
        } else {
          await client.chat.postMessage({
            channel: channelId,
            text: ':warning: Usage: `/project connect /absolute/path/to/dir`\n_Tip: Set a projects root with `/settings root /path` to enable the project picker._',
          });
        }
        return;
      }
      if (!path.isAbsolute(projectDir)) {
        // Check if it's a name that matches a subdirectory in projects_root
        const root = this.store.getSetting('projects_root');
        if (root) {
          const fullPath = path.join(root, projectDir);
          if (fs.existsSync(fullPath)) {
            await this.handleProjectConnect(channelId, fullPath, command, client);
            return;
          }
        }
        await client.chat.postMessage({
          channel: channelId,
          text: ':warning: Please provide an absolute path. Example: `/project connect /home/user/my-app`',
        });
        return;
      }
      await this.handleProjectConnect(channelId, projectDir, command, client);
      return;
    }

    // /project backend [claude|codex]
    if (subcommand === 'backend') {
      const project = this.store.getProjectByChannelId(channelId);
      if (!project) {
        await client.chat.postMessage({
          channel: channelId,
          text: 'This channel is not connected to a project. Use `/project connect` first.',
        });
        return;
      }
      if (!subArg) {
        await client.chat.postMessage({
          channel: channelId,
          text: `Current backend: \`${project.backend_name}\`. Use \`/project backend claude\` or \`/project backend codex\` to switch.`,
        });
        return;
      }
      if (!['claude', 'codex'].includes(subArg)) {
        await client.chat.postMessage({
          channel: channelId,
          text: `:warning: Unknown backend \`${subArg}\`. Valid options: \`claude\`, \`codex\``,
        });
        return;
      }
      this.store.updateProjectBackend(project.id, subArg);
      await client.chat.postMessage({
        channel: channelId,
        text: `Backend changed to \`${subArg}\` for this project.`,
      });
      return;
    }

    // /project info
    if (subcommand === 'info') {
      const project = this.store.getProjectByChannelId(channelId);
      if (!project) {
        await client.chat.postMessage({
          channel: channelId,
          text: 'No project connected to this channel. Use `/project connect` to set one up.',
        });
        return;
      }
      const backendLabel = project.backend_name === 'claude' ? 'Claude Code' : 'Codex';
      const text = [
        '*Project Info*',
        `• Path: \`${project.project_dir}\``,
        `• Backend: ${backendLabel}`,
        `• Permissions: ${project.permission_mode}`,
      ].join('\n');
      await client.chat.postMessage({ channel: channelId, text });
      return;
    }

    // Backwards compat: /project /absolute/path still works
    if (path.isAbsolute(subcommand + (subArg ? ' ' + subArg : ''))) {
      const projectDir = rawArgs;
      await this.handleProjectConnect(channelId, projectDir, command, client);
      return;
    }

    await client.chat.postMessage({
      channel: channelId,
      text: [
        `:warning: Unsupported command \`${subcommand}\`. Try one of these:`,
        ...this.getProjectCommandLines(),
      ].join('\n'),
    });
  }

  /** Handle project connect flow — bind a directory to a channel. */
  private async handleProjectConnect(channelId: string, projectDir: string, command: any, client: any): Promise<void> {
    const existing = this.store.getProjectByChannelId(channelId);

    if (existing) {
      // Channel already bound — create a new channel for this project
      await this.createChannelAndBind(channelId, projectDir, existing.backend_name, command.user_id, client);
    } else {
      // Channel is unbound — offer bind options
      const channelName = path.basename(projectDir);
      await client.chat.postMessage({
        channel: channelId,
        text: `Connect project \`${projectDir}\` to this channel?`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `Connect project directory \`${projectDir}\`?`,
            },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: 'Use this channel' },
                action_id: 'project_bind_here',
                value: projectDir,
              },
              {
                type: 'button',
                text: { type: 'plain_text', text: `Create #${channelName}` },
                action_id: 'project_create_new',
                value: projectDir,
              },
            ],
          },
        ],
      });
    }
  }

  /** Post a project picker with pagination support. */
  private async postProjectPicker(channelId: string, offset: number, client: any): Promise<void> {
    const PAGE_SIZE = Math.min(PICKER_PAGE_SIZE, 20);
    const root = this.store.getSetting('projects_root');
    if (!root || !fs.existsSync(root)) return;

    const entries = fs.readdirSync(root, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name)
      .sort();

    if (entries.length === 0) {
      await client.chat.postMessage({
        channel: channelId,
        text: `:warning: No subdirectories found in \`${root}\`. Use \`/project connect /absolute/path\` instead.`,
      });
      return;
    }

    const page = entries.slice(offset, offset + PAGE_SIZE);
    const hasMore = offset + PAGE_SIZE < entries.length;

    const buttons = page.map((name: string) => ({
      type: 'button' as const,
      text: { type: 'plain_text' as const, text: name },
      action_id: `project_pick_${name}`,
      value: path.join(root, name),
    }));

    const actionBlocks = [];
    for (let i = 0; i < buttons.length; i += 5) {
      actionBlocks.push({
        type: 'actions' as const,
        elements: buttons.slice(i, i + 5),
      });
    }

    // Add "Show more" button if there are more entries
    if (hasMore) {
      actionBlocks.push({
        type: 'actions' as const,
        elements: [{
          type: 'button' as const,
          text: { type: 'plain_text' as const, text: `Show more (${entries.length - offset - PAGE_SIZE} remaining)` },
          action_id: 'project_picker_more',
          value: String(offset + PAGE_SIZE),
        }],
      });
    }

    const rangeLabel = offset > 0
      ? `*Projects from* \`${root}\` *(${offset + 1}–${offset + page.length} of ${entries.length}):*`
      : `*Pick a project from* \`${root}\`:`;

    await client.chat.postMessage({
      channel: channelId,
      text: `Pick a project from \`${root}\`:`,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: rangeLabel },
        },
        ...actionBlocks,
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: '_Or use `/project connect /absolute/path` for a custom directory._' }],
        },
      ],
    });
  }

  /** Get the default backend, or throw if not configured. */
  private getDefaultBackend(): string {
    const backend = this.store.getSetting('default_backend');
    if (!backend) {
      throw new Error('No default backend configured. Run the setup wizard first.');
    }
    return backend;
  }

  /** Handle permission mode button action. */
  private async handlePermModeAction(body: any, mode: 'trusted' | 'supervised', client: any): Promise<void> {
    const action = body.actions?.[0];
    const channelId = body.channel?.id;
    if (!action?.value || !channelId) return;
    const projectId = parseInt(action.value.split(':')[1], 10);
    this.store.updatePermissionMode(projectId, mode);
    await client.chat.postMessage({
      channel: channelId,
      text: `Permission mode set to *${mode}*${mode === 'trusted' ? ' — all permissions will be auto-approved' : ' — you\'ll be asked to approve actions'}`,
    });
  }

  /** Handle sandbox upgrade button click. */
  private async handleSandboxUpgrade(body: any, client: any): Promise<void> {
    const channelId = body.channel?.id;
    const messageTs = body.message?.ts;
    const threadTs = body.message?.thread_ts;
    if (!channelId) return;

    const project = this.store.getProjectByChannelId(channelId);
    if (project) {
      this.store.updateSandboxMode(project.id, 'danger-full-access');
      console.log(`[slack] upgraded sandbox to danger-full-access for project ${project.id}`);

      // Reset the session so the next message starts fresh with the new sandbox mode.
      // Without this, `codex exec resume` would carry the old sandbox from the initial invocation.
      if (threadTs) {
        try {
          this.router.resetSession(channelId, threadTs);
          console.log(`[slack] reset session for thread ${threadTs} after sandbox upgrade`);
        } catch (err: any) {
          console.error(`[slack] failed to reset session after sandbox upgrade for thread ${threadTs}: ${err.message}`);
        }
      }
    }

    try {
      await client.chat.update({
        channel: channelId,
        ts: messageTs,
        text: 'Sandbox upgraded to full access. Session reset — your next message will use the new permissions.',
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: '*Sandbox upgraded to full access.* Session reset — your next message will use the new permissions.' },
          },
        ],
      });
    } catch (err: any) {
      console.error(`[slack] failed to update sandbox upgrade message in ${channelId}: ${err.message}`);
    }
  }

  /** Post a sandbox upgrade prompt for Codex sandbox denials. */
  private async postSandboxUpgradePrompt(
    channelId: string,
    threadTs: string,
    context: string,
    client: any
  ): Promise<void> {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: 'Sandbox denied this action',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Sandbox denied this action:*\n${context.slice(0, 500)}`,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Upgrade to Full Access' },
              style: 'danger',
              action_id: 'sandbox_upgrade',
            },
          ],
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: '_This will allow unrestricted file system access for all future Codex sessions in this project_',
            },
          ],
        },
      ],
    });
  }

  /** Post permission mode selection buttons after project creation. */
  private async postPermissionModePrompt(channelId: string, projectId: number, client: any): Promise<void> {
    await client.chat.postMessage({
      channel: channelId,
      text: 'Choose a permission mode for this project:',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '*Permission mode:*\nHow should the coding agent handle actions that need approval?',
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Supervised' },
              action_id: 'perm_mode_supervised',
              value: `supervised:${projectId}`,
              style: 'primary',
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Trusted' },
              action_id: 'perm_mode_trusted',
              value: `trusted:${projectId}`,
              style: 'danger',
            },
          ],
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: '*Supervised* — approve actions individually (recommended) | *Trusted* — skip all permission checks',
            },
          ],
        },
      ],
    });
  }

  /** Bind a project to a channel and post confirmation. */
  private async bindProjectToChannel(
    channelId: string,
    projectDir: string,
    client: any,
    notifyChannelId?: string,
  ): Promise<void> {
    const backend = this.getDefaultBackend();
    const notify = notifyChannelId ?? channelId;
    try {
      const project = this.store.createProject(channelId, projectDir, backend, 'slack');
      const label = notifyChannelId ? `<#${channelId}>` : 'this channel';
      await client.chat.postMessage({
        channel: notify,
        text: `Connected ${label} to project \`${projectDir}\` (${backend})`,
      });
      await this.postPermissionModePrompt(notify, project.id, client);
    } catch (err: any) {
      await client.chat.postMessage({
        channel: notify,
        text: `:warning: Failed to connect: ${err.message}`,
      });
    }
  }

  /** Create a new Slack channel, bind a project to it, and invite the user. */
  private async createChannelAndBind(
    sourceChannelId: string,
    projectDir: string,
    backend: string,
    userId: string | null,
    client: any,
  ): Promise<void> {
    const channelName = path.basename(projectDir);
    try {
      const result = await client.conversations.create({ name: channelName });
      const newChannelId = result.channel?.id;
      if (newChannelId) {
        const project = this.store.createProject(newChannelId, projectDir, backend, 'slack');
        if (userId) {
          await client.conversations.invite({ channel: newChannelId, users: userId }).catch((err: any) => {
            console.error(`[slack] failed to invite user ${userId} to channel ${newChannelId}: ${err.message}`);
          });
        }
        await client.chat.postMessage({
          channel: sourceChannelId,
          text: `Created and connected <#${newChannelId}> to project \`${projectDir}\` (${backend})`,
        });
        await this.postPermissionModePrompt(newChannelId, project.id, client);
      }
    } catch (err: any) {
      if (err.data?.error === 'name_taken') {
        await this.handleNameTaken(sourceChannelId, channelName, projectDir, client);
      } else {
        await client.chat.postMessage({
          channel: sourceChannelId,
          text: `:warning: Failed to create channel: ${err.message}`,
        });
      }
    }
  }

  /** Handle name_taken error when creating a channel — offer to bind existing. */
  private async handleNameTaken(channelId: string, channelName: string, projectDir: string, client: any): Promise<void> {
    try {
      const listResult = await client.conversations.list({ types: 'public_channel,private_channel', limit: 1000 });
      const existingChannel = listResult.channels?.find((c: any) => c.name === channelName);
      if (existingChannel) {
        const boundProject = this.store.getProjectByChannelId(existingChannel.id);
        if (boundProject) {
          await client.chat.postMessage({
            channel: channelId,
            text: `:warning: Channel <#${existingChannel.id}> is already connected to project \`${boundProject.project_dir}\``,
          });
        } else {
          await client.chat.postMessage({
            channel: channelId,
            text: `Channel <#${existingChannel.id}> already exists. Connect project \`${projectDir}\` to it?`,
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `Channel <#${existingChannel.id}> already exists. Connect project directory \`${projectDir}\` to it?`,
                },
              },
              {
                type: 'actions',
                elements: [
                  {
                    type: 'button',
                    text: { type: 'plain_text', text: `Connect to #${channelName}` },
                    action_id: 'project_bind_existing',
                    value: JSON.stringify({ channelId: existingChannel.id, projectDir }),
                  },
                ],
              },
            ],
          });
        }
      } else {
        await client.chat.postMessage({
          channel: channelId,
          text: `:warning: Channel #${channelName} exists but the bot can't see it (likely a private channel). Go to #${channelName} and run \`/project connect ${projectDir}\` to connect it.`,
        });
      }
    } catch {
      await client.chat.postMessage({
        channel: channelId,
        text: `:warning: Channel #${channelName} already exists. Go to that channel and run \`/project connect ${projectDir}\` to connect it.`,
      });
    }
  }


  /** Handle /settings slash command. */
  private async handleSettingsCommand(command: any, client: any): Promise<void> {
    const channelId = command.channel_id;
    const args = (command.text || '').trim();

    if (!args) {
      // Show current settings
      const root = this.store.getSetting('projects_root');
      const project = this.store.getProjectByChannelId(channelId);
      let text = '*Bridge settings:*';
      if (root) {
        text += `\n• Projects root: \`${root}\``;
      } else {
        text += '\n• Projects root: _(not set)_';
      }
      if (project) {
        text += `\n\n*This channel's project:*\n• Backend: \`${project.backend_name}\` — change with \`/project backend\`\n• Directory: \`${project.project_dir}\``;
      }
      text += '\n\n_Commands:_';
      text += '\n• `/settings root /path` — set projects root folder';
      text += '\n• `/settings schedule list` — list active schedules';
      text += '\n• `/settings schedule cancel <id>` — cancel a schedule';
      await client.chat.postMessage({
        channel: channelId,
        text,
      });
      return;
    }

    const parts = args.split(/\s+/);
    if (parts[0] === 'root' && parts[1]) {
      const rootPath = parts.slice(1).join(' ');
      if (!path.isAbsolute(rootPath)) {
        await client.chat.postMessage({
          channel: channelId,
          text: ':warning: Please provide an absolute path. Example: `/settings root /home/user/projects`',
        });
        return;
      }
      this.store.setSetting('projects_root', rootPath);
      await client.chat.postMessage({
        channel: channelId,
        text: `Projects root set to \`${rootPath}\`. Use \`/project connect\` to pick from subdirectories.`,
      });
    } else if (parts[0] === 'schedule') {
      const sub = parts[1] || '';
      if (!sub || sub === 'help') {
        await client.chat.postMessage({
          channel: channelId,
          text: [
            '*Schedule commands:*',
            '• `/settings schedule list` — list active schedules for this channel',
            '• `/settings schedule cancel <id>` — cancel a schedule by ID',
          ].join('\n'),
        });
        return;
      }
      if (sub === 'list') {
        const schedules = this.store.getSchedulesByChannelId(channelId);
        if (schedules.length === 0) {
          await client.chat.postMessage({
            channel: channelId,
            text: 'No scheduled sessions for this channel.',
          });
          return;
        }
        const lines = schedules.map((s, i) => {
          const typeLabel = s.is_recurring ? `cron: \`${s.cron_expression}\`` : `one-time: ${s.scheduled_at}`;
          return `${i + 1}. "${s.original_request}" — ${typeLabel} (next: ${s.next_run_at}) [ID: ${s.id}]`;
        });
        await client.chat.postMessage({
          channel: channelId,
          text: `*Scheduled Sessions*\n${lines.join('\n')}`,
        });
        return;
      }
      if (sub === 'cancel') {
        const idStr = parts[2];
        if (!idStr) {
          await client.chat.postMessage({
            channel: channelId,
            text: 'Usage: `/settings schedule cancel <id>` — get IDs from `/settings schedule list`',
          });
          return;
        }
        const id = parseInt(idStr, 10);
        if (isNaN(id)) {
          await client.chat.postMessage({
            channel: channelId,
            text: `Invalid schedule ID: \`${idStr}\``,
          });
          return;
        }
        const schedule = this.store.getScheduleById(id);
        if (!schedule || schedule.channel_id !== channelId || !schedule.is_active) {
          await client.chat.postMessage({
            channel: channelId,
            text: `No active schedule with ID ${id} found in this channel.`,
          });
          return;
        }
        this.store.deactivateSchedule(id);
        await client.chat.postMessage({
          channel: channelId,
          text: `Cancelled schedule: "${schedule.original_request}"`,
        });
        return;
      }
      await client.chat.postMessage({
        channel: channelId,
        text: `Unknown schedule subcommand: \`${sub}\`. Try \`/settings schedule help\`.`,
      });
    } else {
      await client.chat.postMessage({
        channel: channelId,
        text: '*Usage:*\n• `/settings root /path` — set projects root folder\n• `/settings schedule list` — list active schedules\n• `/settings schedule cancel <id>` — cancel a schedule',
      });
    }
  }


  /** Handle file uploads in messages — downloads all file types for backend passthrough. */
  async handleFileUpload(
    channelId: string,
    threadTs: string,
    files: any[],
    text: string,
    client: any,
    messageTs?: string,
  ): Promise<void> {
    const project = this.store.getProjectByChannelId(channelId);
    if (!project) return;

    const attachments: FileAttachment[] = [];
    const textInclusions: string[] = [];

    // Get the bot token for authenticated downloads from Slack
    const botToken = (this.app as any).client?.token
      ?? (this.app as any).token;

    for (const file of files) {
      const fileName = file.name || 'unknown';
      const mimeType = file.mimetype || '';
      const fileUrl = file.url_private_download || file.url_private;
      if (!fileUrl) continue;

      const attachment = await downloadAndStageFile(fileUrl, fileName, mimeType, {
        Authorization: `Bearer ${botToken}`,
      });

      if (attachment) {
        attachments.push(attachment);
        // Include text file contents inline so the AI can read them
        if (attachment.kind === 'text' && attachment.stagingPath) {
          try {
            const content = fs.readFileSync(attachment.stagingPath, 'utf8');
            textInclusions.push(`\`\`\`${attachment.filename}\n${content}\n\`\`\``);
          } catch (err: any) {
            console.error(`[slack] failed to read staged text file ${attachment.stagingPath}: ${err.message}`);
          }
        }
        console.log(`[slack] downloaded ${attachment.kind} file ${fileName} (${attachment.mediaType}, staged as ${attachment.uploadId})`);
      } else {
        textInclusions.push(`[Uploaded file: ${fileName} (download failed)]`);
      }
    }

    // Combine text inclusions with the message text
    const combinedText = textInclusions.length > 0
      ? `${text}\n\n${textInclusions.join('\n\n')}`
      : text;

    // Route with all file attachments
    clearPostMessageFlag(threadTs);
    let result: RouteResult;
    try {
      result = await this.router.send(
        channelId, threadTs, combinedText,
        attachments.length > 0 ? attachments : undefined,
      );
    } catch (err: any) {
      await this.postError(channelId, threadTs, err.message, client);
      return;
    }

    await this.renderEvents(channelId, threadTs, result.events, client);
    if (messageTs) await this.removeReactSeen(channelId, messageTs, client);
    await this.cleanupPermissionAcks(threadTs, client);
  }

  /** Upload a file to a Slack thread. Called by MCP callback handler. */
  async uploadFile(channelId: string, threadId: string, filePath: string): Promise<void> {
    const filename = path.basename(filePath);
    await this.app.client.filesUploadV2({
      channel_id: channelId,
      thread_ts: threadId,
      file: filePath,
      filename,
    });
    console.log(`[slack] uploaded file ${filename} to ${channelId}/${threadId}`);
  }

  /** Post a plain text message to a Slack thread. Called by MCP callback handler. */
  async sendMessage(channelId: string, threadId: string, text: string): Promise<void> {
    const converted = markdownToSlackMrkdwn(text);
    // Slack message limit is 40000 chars — truncate as a failsafe
    const MAX = 40000;
    const truncated = converted.length > MAX ? converted.slice(0, MAX - 15) + '\n... (truncated)' : converted;
    await this.app.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadId,
      text: truncated,
    });
  }

  async createThread(channelId: string, title: string): Promise<string> {
    const result = await this.app.client.chat.postMessage({
      channel: channelId,
      text: title,
    });
    if (!result.ts) {
      throw new Error('Failed to create thread — no message timestamp returned');
    }
    return result.ts;
  }

  /** Format todos as Slack mrkdwn checklist. */
  private formatTodosSlack(
    todos: Array<{ content: string; status: string; activeForm: string }>,
  ): string {
    if (todos.length === 0) return '_No tasks_';
    return todos.map((t) => {
      switch (t.status) {
        case 'completed':
          return `~${t.content}~`;
        case 'in_progress':
          return `> *${t.activeForm}...*`;
        default:
          return t.content;
      }
    }).join('\n');
  }

  async renderTodoList(
    channelId: string,
    threadId: string,
    todos: Array<{ content: string; status: string; activeForm: string }>,
  ): Promise<void> {
    const text = this.formatTodosSlack(todos);
    const blocks = [{ type: 'section' as const, text: { type: 'mrkdwn' as const, text } }];
    const existing = this.todoMessages.get(threadId);

    if (existing) {
      try {
        await this.app.client.chat.update({
          channel: existing.channel,
          ts: existing.ts,
          text: 'Task list',
          blocks,
        });
      } catch (err: any) {
        console.error(`[slack] failed to update todo message for thread ${threadId}: ${err.message}`);
        this.todoMessages.delete(threadId);
        await this.renderTodoList(channelId, threadId, todos);
      }
    } else {
      try {
        const result = await this.app.client.chat.postMessage({
          channel: channelId,
          thread_ts: threadId,
          text: 'Task list',
          blocks,
        });
        if (result.ts) {
          this.todoMessages.set(threadId, { channel: channelId, ts: result.ts as string });
        }
      } catch (err: any) {
        console.error(`[slack] failed to post todo message for thread ${threadId}: ${err.message}`);
      }
    }
  }
}

// splitText is imported from ../utils.js
export { splitText } from '../utils.js';
