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
import { splitText } from '../utils.js';
import { resolvePermission } from '../mcp/ipc-server.js';

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
    try {
      const authResult = await this.app.client.auth.test({ token: (this.app as any).token });
      this.botUserId = authResult.user_id ?? null;
    } catch {
      // Non-fatal — we'll filter by bot_id instead
    }

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
      } catch {
        console.log(`[slack] cannot join or post to channel ${channelId}: ${errorCode}`);
      }
      return false;
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
      // Post a "thinking" indicator in the new thread
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: 'Processing...',
      });
    }

    // Handle file attachments — route through handleFileUpload
    if (Array.isArray(message.files) && message.files.length > 0) {
      await this.handleFileUpload(channelId, threadTs, message.files, text, client);
      return;
    }

    // Check if the session is waiting_for_input (freeform text response)
    const session = this.store.getSessionByThreadId(threadTs);
    if (session && session.state === 'waiting_for_input') {
      await this.handleFreeformResponse(channelId, threadTs, text, client);
      return;
    }

    // Post a processing indicator for follow-up messages in existing threads
    let processingTs: string | null = null;
    if (threadTs !== message.ts) {
      try {
        const processingMsg = await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: 'Processing...',
        });
        processingTs = processingMsg.ts ?? null;
      } catch {
        // Non-fatal — continue without indicator
      }
    }

    // Route through the router
    let result: RouteResult;
    try {
      result = await this.router.send(channelId, threadTs, text);
    } catch (err: any) {
      if (processingTs) {
        await client.chat.delete({ channel: channelId, ts: processingTs }).catch(() => {});
      }
      await this.postError(channelId, threadTs, err.message, client);
      return;
    }

    // Remove the processing indicator before posting real response
    if (processingTs) {
      await client.chat.delete({ channel: channelId, ts: processingTs }).catch(() => {});
    }

    // Render the response events
    await this.renderEvents(channelId, threadTs, result.events, client);
  }

  /** Handle freeform text when session is waiting_for_input. */
  private async handleFreeformResponse(
    channelId: string,
    threadTs: string,
    text: string,
    client: any
  ): Promise<void> {
    // Post a processing indicator while waiting for the backend response
    let processingTs: string | null = null;
    try {
      const processingMsg = await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: 'Processing...',
      });
      processingTs = processingMsg.ts ?? null;
    } catch {
      // Non-fatal — continue without indicator
    }

    let result: RouteResult;
    try {
      result = await this.router.respond(channelId, threadTs, text);
    } catch (err: any) {
      if (processingTs) {
        await client.chat.delete({ channel: channelId, ts: processingTs }).catch(() => {});
      }
      await this.postError(channelId, threadTs, err.message, client);
      return;
    }

    // Remove the processing indicator before posting real response
    if (processingTs) {
      await client.chat.delete({ channel: channelId, ts: processingTs }).catch(() => {});
    }

    await this.renderEvents(channelId, threadTs, result.events, client);
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
    } catch {
      // Non-fatal if update fails
    }

    // Hook-based flow: resolve in-process, no need to call router.respond()
    if (requestId) {
      const decision = isAllow ? 'allow' : 'deny';
      resolvePermission(requestId, decision);
      console.log(`[slack] resolved permission ${requestId} → ${decision}`);
      return;
    }

    // Legacy flow: route through router.respond()
    let processingTs: string | null = null;
    try {
      const processingMsg = await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: 'Processing...',
      });
      processingTs = processingMsg.ts ?? null;
    } catch {
      // Non-fatal — continue without indicator
    }

    const responseText = isAllow ? 'yes' : 'no';
    const allowedTools = isAllow && toolName ? [toolName] : undefined;
    let result: RouteResult;
    try {
      result = await this.router.respond(channelId, threadTs, responseText, allowedTools);
    } catch (err: any) {
      if (processingTs) {
        await client.chat.delete({ channel: channelId, ts: processingTs }).catch(() => {});
      }
      await this.postError(channelId, threadTs, err.message, client);
      return;
    }

    if (processingTs) {
      await client.chat.delete({ channel: channelId, ts: processingTs }).catch(() => {});
    }

    await this.renderEvents(channelId, threadTs, result.events, client);
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

    for (const event of deduped) {
      switch (event.type) {
        case 'assistant_text':
          await this.postText(channelId, threadTs, event.text, client);
          break;

        case 'permission_denied':
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
    if (text.length <= SLACK_MESSAGE_LIMIT) {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text,
      });
    } else {
      // Split into chunks
      const chunks = splitText(text, SLACK_MESSAGE_LIMIT);
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
    const inputStr = JSON.stringify(event.toolInput, null, 2);
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

  /** Post an error message. */
  async postError(channelId: string, threadTs: string, message: string, client: any): Promise<void> {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `:warning: *Error:* ${message}`,
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
        '• `/settings` — view or change bridge settings',
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
        text += `• <#${p.channel_id}> → \`${p.project_dir}\` (${p.backend_name})\n`;
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
    if (!channelId) return;

    const project = this.store.getProjectByChannelId(channelId);
    if (project) {
      this.store.updateSandboxMode(project.id, 'danger-full-access');
      console.log(`[slack] upgraded sandbox to danger-full-access for project ${project.id}`);
    }

    try {
      await client.chat.update({
        channel: channelId,
        ts: messageTs,
        text: 'Sandbox upgraded to full access. Try your request again.',
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: '*Sandbox upgraded to full access.* Try your request again.' },
          },
        ],
      });
    } catch { /* non-fatal */ }
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
          await client.conversations.invite({ channel: newChannelId, users: userId }).catch(() => {});
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
    const project = this.store.getProjectByChannelId(channelId);

    if (!project) {
      await client.chat.postMessage({
        channel: channelId,
        text: 'This channel is not connected to a project. Use `/project connect` first.',
      });
      return;
    }

    const args = (command.text || '').trim();

    if (!args) {
      // Show current settings with usage hints
      const root = this.store.getSetting('projects_root');
      let text = `*Settings for this project:*\n• Backend: \`${project.backend_name}\`\n• Directory: \`${project.project_dir}\``;
      if (root) {
        text += `\n• Projects root: \`${root}\``;
      }
      text += '\n\n_Commands:_';
      text += '\n• `/settings backend claude` or `codex` — switch backend';
      text += '\n• `/settings root /path` — set projects root folder';
      await client.chat.postMessage({
        channel: channelId,
        text,
      });
      return;
    }

    // Parse setting changes, e.g. "backend codex"
    const parts = args.split(/\s+/);
    if (parts[0] === 'backend' && parts[1]) {
      const newBackend = parts[1];
      if (!['claude', 'codex'].includes(newBackend)) {
        await client.chat.postMessage({
          channel: channelId,
          text: `:warning: Unknown backend \`${newBackend}\`. Valid options: \`claude\`, \`codex\``,
        });
        return;
      }
      this.store.updateProjectBackend(project.id, newBackend);
      await client.chat.postMessage({
        channel: channelId,
        text: `Backend changed to \`${newBackend}\` for this project.`,
      });
    } else if (parts[0] === 'root' && parts[1]) {
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
    } else {
      await client.chat.postMessage({
        channel: channelId,
        text: '*Usage:*\n• `/settings backend <claude|codex>`\n• `/settings root /path`',
      });
    }
  }

  /** Handle file uploads in messages. */
  async handleFileUpload(
    channelId: string,
    threadTs: string,
    files: any[],
    text: string,
    client: any
  ): Promise<void> {
    const project = this.store.getProjectByChannelId(channelId);
    if (!project) return;

    const fileDescriptions: string[] = [];

    for (const file of files) {
      const fileName = file.name || 'unknown';
      const fileUrl = file.url_private_download || file.url_private;

      if (fileUrl) {
        fileDescriptions.push(`[Uploaded file: ${fileName}]`);
      }
    }

    // Combine file descriptions with the message text
    const combinedText = fileDescriptions.length > 0
      ? `${text}\n\n${fileDescriptions.join('\n')}`
      : text;

    // Route the combined message
    let result: RouteResult;
    try {
      result = await this.router.send(channelId, threadTs, combinedText);
    } catch (err: any) {
      await this.postError(channelId, threadTs, err.message, client);
      return;
    }

    await this.renderEvents(channelId, threadTs, result.events, client);
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
    await this.app.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadId,
      text,
    });
  }
}

// splitText is imported from ../utils.js
export { splitText } from '../utils.js';
