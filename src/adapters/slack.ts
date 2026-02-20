/**
 * Slack adapter for OpenBridge.
 *
 * Connects to Slack via Socket Mode using @slack/bolt.
 * Listens for messages and slash commands, routes them through the router,
 * and posts responses back to the appropriate threads.
 */

import { App, type LogLevel } from '@slack/bolt';
import type { Router, RouteResult } from '../router.js';
import type { NormalizedEvent } from '../types/events.js';
import type { Store } from '../store.js';
import { splitText } from '../utils.js';

const SLACK_MESSAGE_LIMIT = 4000;

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

    // Slash commands
    this.app.command('/project', async ({ command, ack, client }) => {
      await ack();
      await this.handleProjectCommand(command, client);
    });

    this.app.command('/new', async ({ command, ack, client }) => {
      await ack();
      await this.handleNewCommand(command, client);
    });

    this.app.command('/settings', async ({ command, ack, client }) => {
      await ack();
      await this.handleSettingsCommand(command, client);
    });
  }

  /** Handle an incoming Slack message. */
  private async handleMessage(message: any, client: any): Promise<void> {
    // Ignore bot messages (including our own)
    if (message.bot_id || message.subtype === 'bot_message') {
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

    // Route through the router
    let result: RouteResult;
    try {
      result = await this.router.send(channelId, threadTs, text);
    } catch (err: any) {
      await this.postError(channelId, threadTs, err.message, client);
      return;
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
    let result: RouteResult;
    try {
      result = await this.router.respond(channelId, threadTs, text);
    } catch (err: any) {
      await this.postError(channelId, threadTs, err.message, client);
      return;
    }

    await this.renderEvents(channelId, threadTs, result.events, client);
  }

  /** Handle permission Allow/Deny button clicks. */
  private async handlePermissionAction(body: any, action: string, client: any): Promise<void> {
    const channelId = body.channel?.id;
    const threadTs = body.message?.thread_ts;
    const messageTs = body.message?.ts;

    if (!channelId || !threadTs) {
      return;
    }

    // Update the original message to show which action was taken
    const actionLabel = action === 'allow' ? 'Allowed' : 'Denied';
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

    // Route the response
    const responseText = action === 'allow' ? 'yes' : 'no';
    let result: RouteResult;
    try {
      result = await this.router.respond(channelId, threadTs, responseText);
    } catch (err: any) {
      await this.postError(channelId, threadTs, err.message, client);
      return;
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
    for (const event of events) {
      switch (event.type) {
        case 'assistant_text':
          await this.postText(channelId, threadTs, event.text, client);
          break;

        case 'permission_denied':
          await this.postPermissionPrompt(channelId, threadTs, event, client);
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

  /** Post a permission denial prompt with Allow/Deny buttons. */
  async postPermissionPrompt(
    channelId: string,
    threadTs: string,
    event: { toolName: string; toolInput: Record<string, unknown>; context?: string },
    client: any
  ): Promise<void> {
    const inputStr = JSON.stringify(event.toolInput, null, 2);
    const contextStr = event.context ? `\n${event.context}` : '';

    await client.chat.postMessage({
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
              value: 'allow',
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Deny' },
              style: 'danger',
              action_id: 'permission_deny',
              value: 'deny',
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

  /** Handle /project slash command. */
  private async handleProjectCommand(command: any, client: any): Promise<void> {
    const channelId = command.channel_id;
    const args = (command.text || '').trim();

    if (!args) {
      // List all bindings
      const projects = this.store.listProjects();
      if (projects.length === 0) {
        await client.chat.postMessage({
          channel: channelId,
          text: 'No project bindings found. Use `/project <name>` to create one.',
        });
        return;
      }

      let text = '*Project Bindings:*\n';
      for (const p of projects) {
        text += `• <#${p.channel_id}> → \`${p.project_dir}\` (${p.backend_name})\n`;
      }
      await client.chat.postMessage({ channel: channelId, text });
      return;
    }

    // Check if current channel is bound
    const existing = this.store.getProjectByChannelId(channelId);

    if (existing) {
      // Channel already bound — create a new channel with the given name
      try {
        const result = await client.conversations.create({ name: args });
        const newChannelId = result.channel?.id;
        if (newChannelId) {
          // Bind the new channel — use same project dir pattern and backend
          this.store.createProject(newChannelId, args, existing.backend_name);
          await client.chat.postMessage({
            channel: channelId,
            text: `Created and bound <#${newChannelId}> to project \`${args}\` (${existing.backend_name})`,
          });
        }
      } catch (err: any) {
        await client.chat.postMessage({
          channel: channelId,
          text: `:warning: Failed to create channel: ${err.message}`,
        });
      }
    } else {
      // Channel is unbound — offer bind options
      await client.chat.postMessage({
        channel: channelId,
        text: `Bind project \`${args}\` to this channel?`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `Bind project \`${args}\`?`,
            },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: 'Use this channel' },
                action_id: 'project_bind_here',
                value: args,
              },
              {
                type: 'button',
                text: { type: 'plain_text', text: `Create #${args}` },
                action_id: 'project_create_new',
                value: args,
              },
            ],
          },
        ],
      });
    }
  }

  /** Handle /new slash command. */
  private async handleNewCommand(command: any, client: any): Promise<void> {
    const channelId = command.channel_id;
    // Slash commands don't have thread_ts in the standard way.
    // The user must invoke /new within a thread. We'll use channel_id as fallback.
    // In Slack, slash commands don't carry thread_ts by default, but if invoked
    // from a thread context, it may be available in some cases.
    // We'll handle both scenarios.
    const threadTs = command.thread_ts || null;

    if (!threadTs) {
      await client.chat.postMessage({
        channel: channelId,
        text: 'Use `/new` inside a thread to reset the session.',
      });
      return;
    }

    try {
      this.router.resetSession(channelId, threadTs);
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: 'Session reset. Your next message will start a fresh conversation.',
      });
    } catch (err: any) {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `:warning: ${err.message}`,
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
        text: 'This channel is not bound to a project. Use `/project <name>` first.',
      });
      return;
    }

    const args = (command.text || '').trim();

    if (!args) {
      // Show current settings
      await client.chat.postMessage({
        channel: channelId,
        text: `*Settings for this project:*\n• Backend: \`${project.backend_name}\`\n• Directory: \`${project.project_dir}\``,
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
    } else {
      await client.chat.postMessage({
        channel: channelId,
        text: 'Usage: `/settings backend <claude|codex>`',
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
}

// splitText is imported from ../utils.js
export { splitText } from '../utils.js';
