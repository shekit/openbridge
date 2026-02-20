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

    // Project bind/create buttons
    this.app.action('project_bind_here', async ({ body, ack, client }) => {
      await ack();
      const action = (body as any).actions?.[0];
      const projectDir = action?.value;
      const channelId = (body as any).channel?.id;
      if (!projectDir || !channelId) return;
      try {
        const channelName = path.basename(projectDir);
        this.store.createProject(channelId, projectDir, this.store.getSetting('default_backend') ?? 'claude', 'slack');
        await (client as any).chat.postMessage({
          channel: channelId,
          text: `Bound this channel to project \`${projectDir}\` (${channelName})`,
        });
      } catch (err: any) {
        await (client as any).chat.postMessage({
          channel: channelId,
          text: `:warning: Failed to bind: ${err.message}`,
        });
      }
    });

    this.app.action('project_create_new', async ({ body, ack, client }) => {
      await ack();
      const action = (body as any).actions?.[0];
      const projectDir = action?.value;
      const sourceChannelId = (body as any).channel?.id;
      if (!projectDir || !sourceChannelId) return;
      try {
        const channelName = path.basename(projectDir);
        const result = await (client as any).conversations.create({ name: channelName });
        const newChannelId = result.channel.id;
        this.store.createProject(newChannelId, projectDir, this.store.getSetting('default_backend') ?? 'claude', 'slack');
        // Invite the user who clicked the button
        const userId = (body as any).user?.id;
        if (userId) {
          await (client as any).conversations.invite({ channel: newChannelId, users: userId }).catch(() => {});
        }
        await (client as any).chat.postMessage({
          channel: sourceChannelId,
          text: `Created and bound <#${newChannelId}> to project \`${projectDir}\` (${this.store.getSetting('default_backend') ?? 'claude'})`,
        });
      } catch (err: any) {
        await (client as any).chat.postMessage({
          channel: sourceChannelId,
          text: `:warning: Failed to create channel: ${err.message}`,
        });
      }
    });

    this.app.action('project_bind_existing', async ({ body, ack, client }) => {
      await ack();
      const action = (body as any).actions?.[0];
      const sourceChannelId = (body as any).channel?.id;
      if (!action?.value || !sourceChannelId) return;
      try {
        const { channelId: targetChannelId, projectDir } = JSON.parse(action.value);
        const backend = this.store.getSetting('default_backend') ?? 'claude';
        this.store.createProject(targetChannelId, projectDir, backend, 'slack');
        await (client as any).chat.postMessage({
          channel: sourceChannelId,
          text: `Bound <#${targetChannelId}> to project \`${projectDir}\` (${backend})`,
        });
      } catch (err: any) {
        await (client as any).chat.postMessage({
          channel: sourceChannelId,
          text: `:warning: Failed to bind: ${err.message}`,
        });
      }
    });

    this.app.action(/^project_pick_/, async ({ body, ack, client }) => {
      await ack();
      const action = (body as any).actions?.[0];
      const channelId = (body as any).channel?.id;
      const projectDir = action?.value;
      if (!projectDir || !channelId) return;
      // Treat like a connect — bind to this channel
      const existing = this.store.getProjectByChannelId(channelId);
      if (existing) {
        // Channel already bound — create new channel for this project
        await this.handleProjectConnect(channelId, projectDir, { user_id: (body as any).user?.id }, client as any);
      } else {
        const backend = this.store.getSetting('default_backend') ?? 'claude';
        try {
          this.store.createProject(channelId, projectDir, backend, 'slack');
          await (client as any).chat.postMessage({
            channel: channelId,
            text: `Bound this channel to project \`${projectDir}\` (${backend})`,
          });
        } catch (err: any) {
          await (client as any).chat.postMessage({
            channel: channelId,
            text: `:warning: Failed to bind: ${err.message}`,
          });
        }
      }
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
    // Ignore bot messages (including our own) and system messages
    if (message.bot_id || message.subtype) {
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
    const rawArgs = (command.text || '').trim();
    const parts = rawArgs.split(/\s+/);
    const subcommand = parts[0] || '';
    const subArg = parts.slice(1).join(' ');

    // /project (no args) or /project help — show usage
    if (!subcommand || subcommand === 'help') {
      await client.chat.postMessage({
        channel: channelId,
        text: [
          '*`/project` commands:*',
          '• `/project new my-app` — create a new project and bind it to a channel',
          '• `/project connect /absolute/path` — bind an existing project to a channel',
          '• `/project list` — show all project bindings',
          '• `/project disconnect` — unbind this channel',
        ].join('\n'),
      });
      return;
    }

    // /project list
    if (subcommand === 'list') {
      const projects = this.store.listProjects();
      if (projects.length === 0) {
        await client.chat.postMessage({
          channel: channelId,
          text: 'No project bindings found. Use `/project connect /absolute/path` to bind one.',
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

    // /project disconnect
    if (subcommand === 'disconnect') {
      const project = this.store.getProjectByChannelId(channelId);
      if (!project) {
        await client.chat.postMessage({
          channel: channelId,
          text: 'This channel is not bound to a project.',
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
          text: `:warning: Directory already exists: \`${targetDir}\`\nUse \`/project connect ${targetDir}\` to bind to it instead.`,
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
      const existing = this.store.getProjectByChannelId(channelId);
      if (existing) {
        await this.handleProjectConnect(channelId, targetDir, command, client);
      } else {
        const backend = this.store.getSetting('default_backend') ?? 'claude';
        this.store.createProject(channelId, targetDir, backend, 'slack');
        await client.chat.postMessage({
          channel: channelId,
          text: `Created \`${targetDir}\` and bound this channel to it (${backend})`,
        });
      }
      return;
    }

    // /project connect [/path/to/dir]
    if (subcommand === 'connect') {
      const projectDir = subArg;
      if (!projectDir) {
        // No path given — show picker if projects_root is set
        const root = this.store.getSetting('projects_root');
        if (root && fs.existsSync(root)) {
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
          const buttons = entries.slice(0, 20).map((name: string) => ({
            type: 'button' as const,
            text: { type: 'plain_text' as const, text: name },
            action_id: `project_pick_${name}`,
            value: path.join(root, name),
          }));
          // Slack actions block allows max 25 elements, split into rows of 5
          const actionBlocks = [];
          for (let i = 0; i < buttons.length; i += 5) {
            actionBlocks.push({
              type: 'actions' as const,
              elements: buttons.slice(i, i + 5),
            });
          }
          await client.chat.postMessage({
            channel: channelId,
            text: `Pick a project from \`${root}\`:`,
            blocks: [
              {
                type: 'section',
                text: { type: 'mrkdwn', text: `*Pick a project from* \`${root}\`:` },
              },
              ...actionBlocks,
            ],
          });
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
        '• `/project new my-app` — create a new project and bind it to a channel',
        '• `/project connect /absolute/path` — bind an existing project to a channel',
        '• `/project list` — show all project bindings',
        '• `/project disconnect` — unbind this channel',
      ].join('\n'),
    });
  }

  /** Handle project connect flow — bind a directory to a channel. */
  private async handleProjectConnect(channelId: string, projectDir: string, command: any, client: any): Promise<void> {
    const channelName = path.basename(projectDir);
    const existing = this.store.getProjectByChannelId(channelId);

    if (existing) {
      // Channel already bound — try to create a new channel with derived name
      try {
        const result = await client.conversations.create({ name: channelName });
        const newChannelId = result.channel?.id;
        if (newChannelId) {
          this.store.createProject(newChannelId, projectDir, existing.backend_name, 'slack');
          const userId = command.user_id;
          if (userId) {
            await client.conversations.invite({ channel: newChannelId, users: userId }).catch(() => {});
          }
          await client.chat.postMessage({
            channel: channelId,
            text: `Created and bound <#${newChannelId}> to project \`${projectDir}\` (${existing.backend_name})`,
          });
        }
      } catch (err: any) {
        if (err.data?.error === 'name_taken') {
          await this.handleNameTaken(channelId, channelName, projectDir, client);
        } else {
          await client.chat.postMessage({
            channel: channelId,
            text: `:warning: Failed to create channel: ${err.message}`,
          });
        }
      }
    } else {
      // Channel is unbound — offer bind options
      await client.chat.postMessage({
        channel: channelId,
        text: `Bind project \`${projectDir}\` to this channel?`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `Bind project directory \`${projectDir}\`?`,
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
            text: `:warning: Channel <#${existingChannel.id}> is already bound to project \`${boundProject.project_dir}\``,
          });
        } else {
          await client.chat.postMessage({
            channel: channelId,
            text: `Channel <#${existingChannel.id}> already exists. Bind project \`${projectDir}\` to it?`,
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `Channel <#${existingChannel.id}> already exists. Bind project directory \`${projectDir}\` to it?`,
                },
              },
              {
                type: 'actions',
                elements: [
                  {
                    type: 'button',
                    text: { type: 'plain_text', text: `Bind to #${channelName}` },
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
          text: `:warning: Channel #${channelName} exists but the bot can't see it (likely a private channel). Go to #${channelName} and run \`/project connect ${projectDir}\` to bind it.`,
        });
      }
    } catch {
      await client.chat.postMessage({
        channel: channelId,
        text: `:warning: Channel #${channelName} already exists. Go to that channel and run \`/project connect ${projectDir}\` to bind it.`,
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
}

// splitText is imported from ../utils.js
export { splitText } from '../utils.js';
