/**
 * Discord adapter for OpenBridge.
 *
 * Connects to Discord via the bot gateway using discord.js.
 * Listens for messages, slash commands, and button interactions,
 * routes them through the router, and posts responses back to threads.
 */

import {
  Client,
  GatewayIntentBits,
  Events,
  ActivityType,
  PresenceUpdateStatus,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  REST,
  Routes,
  ChannelType,
  type Message,
  type Interaction,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { Router, RouteResult } from '../router.js';
import type { NormalizedEvent } from '../types/events.js';
import type { Store } from '../store.js';
import { splitText, downloadAndStageFile, markdownToDiscord, formatToolInput } from '../utils.js';
import type { FileAttachment } from '../types/backend.js';
import { resolvePermission, resolveUserQuestion, hasPendingQuestion, resolveQuestionByThread } from '../mcp/ipc-server.js';
import { clearPostMessageFlag, wasPostMessageCalled, clearScheduleFlag, wasScheduleCreated } from '../mcp/callbacks.js';
import { getSessionPage, RESUME_PAGE_SIZE, type SessionInfo } from '../session-scanner.js';

const DISCORD_MESSAGE_LIMIT = 2000;

/**
 * Number of projects to show per page in the project picker.
 * Capped at 20 (Discord allows max 5 ActionRows × 5 buttons, minus one row for "Show more").
 */
const PICKER_PAGE_SIZE = 15;

export interface DiscordAdapterOptions {
  botToken: string;
  router: Router;
  store: Store;
  /** Optional pre-created Client instance (for testing). */
  client?: Client;
  /** Application (client) ID for slash command registration. */
  clientId?: string;
}

export function createDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
}

export class DiscordAdapter {
  private client: Client;
  private router: Router;
  private store: Store;
  private botToken: string;
  private clientId: string | null;
  private botUserId: string | null = null;
  /** Option labels for pending AskUserQuestion prompts, keyed by requestId. */
  private pendingQuestionOptions = new Map<string, string[]>();
  /** Message refs for pending AskUserQuestion prompts, for updating on resolution. */
  private questionMessages = new Map<string, Message>();
  /** Message refs for todo checklist messages, keyed by threadId (one per thread). */
  private todoMessages = new Map<string, Message>();
  /** Tracked permission/question ack messages per thread, for 👀 cleanup after backend responds. */
  private permissionAckMessages = new Map<string, Message[]>();
  /** Pending resume session IDs per channel (set by /resume, consumed by next thread message). */
  private pendingResumeSessions = new Map<string, string>();

  constructor(options: DiscordAdapterOptions) {
    this.router = options.router;
    this.store = options.store;
    this.botToken = options.botToken;
    this.clientId = options.clientId ?? null;

    this.client = options.client ?? createDiscordClient();

    this.registerHandlers();
  }

  /** Start the Discord adapter — connects via gateway. */
  async start(): Promise<void> {
    await this.client.login(this.botToken);
    this.botUserId = this.client.user?.id ?? null;
    console.log('[discord] connected via gateway');

    // Register slash commands — non-fatal if it fails (e.g., rate limits, test env)
    try {
      await this.registerCommands();
    } catch (err) {
      console.warn('[discord] failed to register slash commands (non-fatal):', err);
    }
  }

  /** Stop the Discord adapter — disconnect. */
  async stop(): Promise<void> {
    this.client.destroy();
    console.log('[discord] disconnected');
  }

  /** Get the underlying Discord client (for testing). */
  getClient(): Client {
    return this.client;
  }

  /** Register slash commands with Discord's API. */
  async registerCommands(): Promise<void> {
    if (!this.clientId) {
      console.log('[discord] no clientId provided, skipping command registration');
      return;
    }

    const commands = [
      new SlashCommandBuilder()
        .setName('project')
        .setDescription('Manage project connections')
        .addSubcommand((sub) =>
          sub.setName('connect')
            .setDescription('Connect a project directory to a channel')
            .addStringOption((opt) => opt.setName('path').setDescription('Absolute path to project directory').setRequired(false))
        )
        .addSubcommand((sub) =>
          sub.setName('list')
            .setDescription('List all connected projects')
        )
        .addSubcommand((sub) =>
          sub.setName('disconnect')
            .setDescription('Disconnect this channel from its project')
        )
        .addSubcommand((sub) =>
          sub.setName('new')
            .setDescription('Create a new project and connect it to a channel')
            .addStringOption((opt) => opt.setName('name').setDescription('Project name or absolute path').setRequired(true))
        )
        .addSubcommand((sub) =>
          sub.setName('backend')
            .setDescription('Switch the AI backend for this channel')
            .addStringOption((opt) =>
              opt.setName('name').setDescription('Backend name').setRequired(true)
                .addChoices({ name: 'claude', value: 'claude' }, { name: 'codex', value: 'codex' })
            )
        )
        .addSubcommand((sub) =>
          sub.setName('info')
            .setDescription('Show project info for this channel')
        ),
      new SlashCommandBuilder()
        .setName('new')
        .setDescription('Reset the current session in this thread'),
      new SlashCommandBuilder()
        .setName('settings')
        .setDescription('View or modify global bridge settings')
        .addSubcommand((sub) =>
          sub.setName('view')
            .setDescription('View current settings')
        )
        .addSubcommand((sub) =>
          sub.setName('root')
            .setDescription('Set the projects root folder')
            .addStringOption((opt) => opt.setName('path').setDescription('Absolute path to projects root').setRequired(true))
        )
        .addSubcommand((sub) =>
          sub.setName('schedule-list')
            .setDescription('List active schedules for this channel')
        )
        .addSubcommand((sub) =>
          sub.setName('schedule-cancel')
            .setDescription('Cancel a schedule by ID')
            .addIntegerOption((opt) => opt.setName('id').setDescription('Schedule ID (from /settings schedule-list)').setRequired(true))
        ),
      new SlashCommandBuilder()
        .setName('cancel')
        .setDescription('Cancel the running task in this thread'),
      new SlashCommandBuilder()
        .setName('resume')
        .setDescription('Resume a laptop Claude Code session'),
    ];

    const rest = new REST().setToken(this.botToken);
    const commandData = commands.map((c) => c.toJSON());

    // Clear global commands (they duplicate guild commands in the autocomplete)
    await rest.put(Routes.applicationCommands(this.clientId), { body: [] });

    // Register per-guild (shows up instantly in autocomplete)
    const guilds = this.client.guilds.cache;
    for (const [guildId, guild] of guilds) {
      try {
        await rest.put(Routes.applicationGuildCommands(this.clientId!, guildId), {
          body: commandData,
        });
        console.log(`[discord] guild commands registered for ${guild.name}`);
      } catch (err) {
        console.warn(`[discord] failed to register guild commands for ${guild.name}:`, err);
      }
    }

    console.log('[discord] slash commands registered');
  }

  /** Register all Discord event handlers. */
  private registerHandlers(): void {
    // Ready handler — set online presence when connected
    this.client.once(Events.ClientReady, (readyClient) => {
      console.log(`[discord] ready — logged in as ${readyClient.user.tag}`);
      readyClient.user.setPresence({
        status: PresenceUpdateStatus.Online,
        activities: [{ name: 'for messages', type: ActivityType.Listening }],
      });
    });

    // Message handler
    this.client.on(Events.MessageCreate, async (message: Message) => {
      await this.handleMessage(message);
    });

    // Interaction handler (slash commands + buttons)
    this.client.on(Events.InteractionCreate, async (interaction: Interaction) => {
      await this.handleInteraction(interaction);
    });
  }

  /** React with 👀 to acknowledge a user's message. */
  private async reactSeen(message: Message): Promise<void> {
    try {
      await message.react('👀');
    } catch (err: any) {
      console.error(`[discord] failed to add eyes reaction: ${err.message}`);
    }
  }

  /** Swap 👀 to ✅ to confirm a schedule was created (no text reply needed). */
  private async reactScheduleConfirm(message: Message): Promise<void> {
    await this.removeReactSeen(message);
    try {
      await message.react('✅');
    } catch (err: any) {
      console.error(`[discord] failed to add checkmark reaction: ${err.message}`);
    }
  }

  /** Remove the 👀 reaction after the backend has responded. */
  private async removeReactSeen(message: Message): Promise<void> {
    try {
      const reaction = message.reactions.cache.get('👀');
      if (reaction) await reaction.users.remove(this.client.user?.id);
    } catch {
      // Non-fatal — reaction may already be removed or missing
    }
  }

  /** Track a permission/question ack message for later 👀 cleanup. */
  private trackPermissionAck(threadId: string, message: Message): void {
    const list = this.permissionAckMessages.get(threadId) ?? [];
    list.push(message);
    this.permissionAckMessages.set(threadId, list);
  }

  /** Remove 👀 from all tracked permission ack messages for a thread. */
  private async cleanupPermissionAcks(threadId: string): Promise<void> {
    const acks = this.permissionAckMessages.get(threadId);
    if (!acks || acks.length === 0) return;
    this.permissionAckMessages.delete(threadId);
    for (const msg of acks) {
      await this.removeReactSeen(msg);
    }
  }

  /** Handle an incoming Discord message. */
  private async handleMessage(message: Message): Promise<void> {
    // Ignore bot messages (including our own)
    if (message.author.bot) {
      return;
    }

    const channelId = this.getChannelId(message);
    const text = message.content || '';
    let threadId = this.getThreadId(message);

    // Intercept messages that look like our slash commands typed as plain text
    const COMMAND_NAMES = ['/project', '/settings', '/new', '/cancel'];
    const firstWord = text.split(/\s/)[0]?.toLowerCase();
    if (firstWord && COMMAND_NAMES.includes(firstWord)) {
      await message.reply('That looks like a slash command — type `/` to use Discord slash commands instead.');
      return;
    }

    // Check if this channel is bound to a project
    const project = this.store.getProjectByChannelId(channelId);
    if (!project) {
      return; // Not a bound channel, ignore
    }

    // If this is a top-level message (not in a thread), create a new thread
    if (!threadId) {
      try {
        const thread = await message.startThread({
          name: text.slice(0, 100) || 'Session',
        });
        threadId = thread.id;
      } catch {
        // If thread creation fails, use the message ID
        threadId = message.id;
      }
    }

    // React with 👀 to acknowledge the user's message
    await this.reactSeen(message);

    // Handle file attachments (after thread creation so they land in the thread)
    if (message.attachments.size > 0) {
      const files = Array.from(message.attachments.values()).map((a) => ({
        name: a.name ?? 'unknown',
        url: a.url,
        contentType: a.contentType ?? undefined,
      }));
      await this.handleFileUpload(channelId, threadId, files, text, message);
      return;
    }

    // If there's a pending AskUserQuestion for this thread, resolve it with the typed text
    if (hasPendingQuestion(threadId)) {
      const requestId = resolveQuestionByThread(threadId, text);
      console.log(`[discord] resolved pending question for thread ${threadId} with typed response`);
      // Update the button message to show it's been answered
      if (requestId) {
        const questionMsg = this.questionMessages.get(requestId);
        if (questionMsg) {
          this.questionMessages.delete(requestId);
          this.pendingQuestionOptions.delete(requestId);
          try {
            await questionMsg.edit({ content: `${questionMsg.content}\n\n**Answered:** ${text}`, components: [] });
          } catch (err: any) {
            console.error(`[discord] failed to update question message for thread ${threadId}: ${err.message}`);
          }
        }
      }
      // Track the 👀 on this freeform message so it gets cleaned up
      // when the original handleMessage call finishes (cleanupPermissionAcks)
      this.trackPermissionAck(threadId, message);
      return;
    }

    // Check if the session is waiting_for_input (freeform text response)
    const session = this.store.getSessionByThreadId(threadId);
    if (session && session.state === 'waiting_for_input') {
      await this.handleFreeformResponse(channelId, threadId, text, message);
      return;
    }

    // If there's a pending resume session for this channel, apply it to this thread
    const pendingResumeId = this.pendingResumeSessions.get(channelId);
    if (pendingResumeId) {
      this.pendingResumeSessions.delete(channelId);
      const resolved = this.router.resolve(channelId, threadId);
      if (resolved) {
        this.store.updateBackendSessionId(resolved.session.id, pendingResumeId);
        console.log(`[discord] applied pending resume session ${pendingResumeId} to thread ${threadId}`);
      }
    }

    // Route through the router
    clearPostMessageFlag(threadId);
    clearScheduleFlag(threadId);
    let result: RouteResult;
    try {
      result = await this.router.send(channelId, threadId, text);
    } catch (err: any) {
      await this.postError(channelId, threadId, err.message, message);
      return;
    }

    // If a schedule was created, swap eyes → checkmark and suppress text
    const scheduleCreated = wasScheduleCreated(threadId);
    clearScheduleFlag(threadId);  // Always clear after checking to avoid stale flags
    if (scheduleCreated) {
      await this.reactScheduleConfirm(message);
      await this.cleanupPermissionAcks(threadId);
    } else {
      await this.renderEvents(channelId, threadId, result.events, message);
      await this.removeReactSeen(message);
      await this.cleanupPermissionAcks(threadId);
    }
  }

  /** Handle an interaction (slash command or button click). */
  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (interaction.isChatInputCommand()) {
      switch (interaction.commandName) {
        case 'project':
          await this.handleProjectCommand(interaction);
          break;
        case 'new':
          await this.handleNewCommand(interaction);
          break;
        case 'settings':
          await this.handleSettingsCommand(interaction);
          break;
        case 'cancel':
          await this.handleCancelCommand(interaction);
          break;
        case 'resume':
          await this.handleResumeCommand(interaction);
          break;
        // schedule subcommands are handled under /settings (schedule-list, schedule-cancel)
      }
    } else if (interaction.isButton()) {
      await this.handleButtonInteraction(interaction);
    }
  }

  /** Handle freeform text when session is waiting_for_input. */
  private async handleFreeformResponse(
    channelId: string,
    threadId: string,
    text: string,
    message: Message
  ): Promise<void> {
    clearPostMessageFlag(threadId);
    clearScheduleFlag(threadId);
    let result: RouteResult;
    try {
      result = await this.router.respond(channelId, threadId, text);
    } catch (err: any) {
      await this.postError(channelId, threadId, err.message, message);
      return;
    }

    await this.renderEvents(channelId, threadId, result.events, message);
    await this.removeReactSeen(message);
    await this.cleanupPermissionAcks(threadId);
  }

  /** Handle button clicks for permission prompts and project bind actions. */
  private async handleButtonInteraction(interaction: any): Promise<void> {
    const customId: string = interaction.customId;

    // Handle project bind/create buttons
    if (customId.startsWith('project_bind_here:')) {
      await this.handleProjectBindHere(interaction, customId.slice('project_bind_here:'.length));
      return;
    }
    if (customId.startsWith('project_create_new:')) {
      await this.handleProjectCreateNew(interaction, customId.slice('project_create_new:'.length));
      return;
    }
    if (customId.startsWith('project_pick:')) {
      const projectDir = customId.slice('project_pick:'.length);
      const channelId = interaction.channelId;
      await this.handleProjectConnect(interaction, channelId, projectDir);
      return;
    }
    if (customId.startsWith('project_picker_more:')) {
      const offset = parseInt(customId.slice('project_picker_more:'.length), 10);
      await this.postProjectPicker(interaction, offset);
      return;
    }
    if (customId.startsWith('resume_session:')) {
      const sessionId = customId.slice('resume_session:'.length);
      const channelId = this.getInteractionChannelId(interaction);
      if (channelId) {
        await this.handleResumeSession(interaction, channelId, sessionId);
      }
      return;
    }
    if (customId.startsWith('resume_picker_more:')) {
      const offset = parseInt(customId.slice('resume_picker_more:'.length), 10);
      await this.postResumePicker(interaction, offset);
      return;
    }
    if (customId === 'sandbox_upgrade') {
      const channelId = this.getInteractionChannelId(interaction);
      const threadId = this.getInteractionThreadId(interaction);
      if (channelId) {
        const project = this.store.getProjectByChannelId(channelId);
        if (project) {
          this.store.updateSandboxMode(project.id, 'danger-full-access');
          console.log(`[discord] upgraded sandbox to danger-full-access for project ${project.id}`);

          // Reset the session so the next message starts fresh with the new sandbox mode.
          // Without this, `codex exec resume` would carry the old sandbox from the initial invocation.
          if (threadId) {
            try {
              this.router.resetSession(channelId, threadId);
              console.log(`[discord] reset session for thread ${threadId} after sandbox upgrade`);
            } catch (err: any) {
              console.error(`[discord] failed to reset session after sandbox upgrade for thread ${threadId}: ${err.message}`);
            }
          }
        }
      }
      await interaction.update({
        content: '**Sandbox upgraded to full access.** Session reset — your next message will use the new permissions.',
        components: [],
      });
      return;
    }
    if (customId.startsWith('perm_mode_')) {
      const rest = customId.slice('perm_mode_'.length); // e.g. "trusted:42"
      const colonIdx = rest.indexOf(':');
      const mode = rest.slice(0, colonIdx);
      const projectId = parseInt(rest.slice(colonIdx + 1), 10);
      if (mode === 'trusted' || mode === 'supervised') {
        this.store.updatePermissionMode(projectId, mode);
        const label = mode === 'trusted'
          ? 'Permission mode set to **trusted** — all permissions will be auto-approved'
          : 'Permission mode set to **supervised** — you\'ll be asked to approve actions';
        await interaction.update({ content: label, components: [] });
      }
      return;
    }

    // AskUserQuestion option buttons
    if (customId.startsWith('question_answer:')) {
      const afterPrefix = customId.slice('question_answer:'.length);
      const pipeIdx = afterPrefix.indexOf('|');
      const index = parseInt(afterPrefix.slice(0, pipeIdx), 10);
      const requestId = afterPrefix.slice(pipeIdx + 1);

      const labels = this.pendingQuestionOptions.get(requestId);
      const label = labels?.[index] ?? `Option ${index}`;
      this.pendingQuestionOptions.delete(requestId);
      this.questionMessages.delete(requestId);

      resolveUserQuestion(requestId, label);
      console.log(`[discord] resolved question ${requestId} → "${label}"`);

      const originalContent = (interaction as any).message?.content ?? '';
      await interaction.update({
        content: `${originalContent}\n\n**Answered:** ${label}`,
        components: [],
      });

      // React with 👀 on the question message to acknowledge the click
      const questionMsg = (interaction as any).message;
      if (questionMsg?.react) {
        try { await questionMsg.react('👀'); } catch { /* non-fatal */ }
        const qThreadId = this.getInteractionThreadId(interaction);
        if (qThreadId) this.trackPermissionAck(qThreadId, questionMsg);
      }
      return;
    }

    if (!customId.startsWith('permission_allow') && !customId.startsWith('permission_deny')
      && !customId.startsWith('permission_always_allow')) {
      return;
    }

    const channelId = this.getInteractionChannelId(interaction);
    const threadId = this.getInteractionThreadId(interaction);

    if (!channelId || !threadId) {
      await interaction.reply({ content: 'Could not determine thread context.', ephemeral: true });
      return;
    }

    const isAlwaysAllow = customId.startsWith('permission_always_allow');
    const isAllow = isAlwaysAllow || customId.startsWith('permission_allow');

    // Parse customId: "permission_allow:toolName|requestId" or "permission_allow:toolName"
    const afterColon = customId.split(':').slice(1).join(':');
    const pipeIdx = afterColon.indexOf('|');
    const toolName = pipeIdx >= 0 ? afterColon.slice(0, pipeIdx) : (afterColon || undefined);
    const requestId = pipeIdx >= 0 ? afterColon.slice(pipeIdx + 1) : undefined;

    // For "always_allow", persist the tool pattern for future sessions
    if (isAlwaysAllow && toolName) {
      const project = this.store.getProjectByChannelId(channelId);
      if (project) {
        this.store.addAllowedTool(project.id, toolName);
        console.log(`[discord] added always-allow tool '${toolName}' for project ${project.id}`);
      }
    }

    const actionLabel = isAlwaysAllow ? 'Always Allowed' : (isAllow ? 'Allowed' : 'Denied');

    // Update the original message to show which action was taken
    try {
      await interaction.update({
        content: `**Permission ${actionLabel}**`,
        components: [],
      });
    } catch (err: any) {
      console.error(`[discord] failed to update permission interaction: ${err.message}`);
    }

    // React with 👀 on the permission message to acknowledge the click
    const permMsg = (interaction as any).message;
    if (permMsg?.react) {
      try { await permMsg.react('👀'); } catch { /* non-fatal */ }
      if (threadId) this.trackPermissionAck(threadId, permMsg);
    }

    // Hook-based flow: resolve in-process, no need to call router.respond()
    if (requestId) {
      const decision = isAllow ? 'allow' : 'deny';
      resolvePermission(requestId, decision);
      console.log(`[discord] resolved permission ${requestId} → ${decision}`);
      return;
    }

    // Legacy flow: route through router.respond()
    const responseText = isAllow ? 'yes' : 'no';
    const allowedTools = isAllow && toolName ? [toolName] : undefined;
    clearPostMessageFlag(threadId);
    clearScheduleFlag(threadId);
    let result: RouteResult;
    try {
      result = await this.router.respond(channelId, threadId, responseText, allowedTools);
    } catch (err: any) {
      await this.sendToThread(threadId, interaction, `:warning: **Error:** ${err.message}`);
      return;
    }

    await this.renderEvents(channelId, threadId, result.events, interaction);
    if (threadId) await this.cleanupPermissionAcks(threadId);
  }

  /** Handle "Use this channel" button for project binding. */
  private async handleProjectBindHere(interaction: any, projectPath: string): Promise<void> {
    const backend = this.getDefaultBackend();
    await this.bindProjectToChannel(
      interaction.channelId, projectPath, backend,
      (text) => interaction.update({ content: text, components: [] }),
      interaction.channel,
    );
  }

  /** Handle "Create #name" button for project creation. */
  private async handleProjectCreateNew(interaction: any, projectPath: string): Promise<void> {
    const backend = this.getDefaultBackend();
    await this.createChannelAndBind(
      interaction.guild, projectPath, backend,
      (text) => interaction.update({ content: text, components: [] }),
    );
  }

  /** Render normalized events as Discord messages in a thread. */
  private async renderEvents(
    channelId: string,
    threadId: string,
    events: NormalizedEvent[],
    context: any
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
    const postMessageUsed = wasPostMessageCalled(threadId);
    const assistantTexts = deduped.filter(e => e.type === 'assistant_text');
    const lastAssistantText = assistantTexts.length > 0
      ? assistantTexts[assistantTexts.length - 1]
      : null;

    for (const event of deduped) {
      switch (event.type) {
        case 'assistant_text':
          if (!postMessageUsed && event === lastAssistantText) {
            await this.postText(channelId, threadId, event.text, context);
          }
          break;

        case 'permission_denied':
          // AskUserQuestion denials are expected — the hook already rendered buttons
          if (event.toolName === 'AskUserQuestion') break;
          if (event.toolName === 'sandbox') {
            await this.postSandboxUpgradePrompt(channelId, threadId, event.context || '', context);
          } else {
            await this.postPermissionPrompt(channelId, threadId, event, context);
          }
          break;

        case 'error':
          await this.postError(channelId, threadId, event.message, context);
          break;

        default:
          break;
      }
    }
  }

  /** Post text response, splitting if it exceeds Discord's limit. */
  async postText(channelId: string, threadId: string, text: string, context: any): Promise<void> {
    const converted = markdownToDiscord(text);
    if (converted.length <= DISCORD_MESSAGE_LIMIT) {
      await this.sendToThread(threadId, context, converted);
    } else {
      const chunks = splitText(converted, DISCORD_MESSAGE_LIMIT);
      for (const chunk of chunks) {
        await this.sendToThread(threadId, context, chunk);
      }
    }
  }

  /** Post a permission denial prompt with Allow/Deny buttons.
   *  When event.requestId is set (hook-based flow), it's embedded in button customIds
   *  so the action handler can resolve the permission in-process. */
  async postPermissionPrompt(
    channelId: string,
    threadId: string,
    event: { toolName: string; toolInput: Record<string, unknown>; context?: string; requestId?: string },
    context: any
  ): Promise<void> {
    let inputStr = formatToolInput(event.toolName, event.toolInput);
    // Truncate to avoid exceeding Discord's 2000-char message limit
    const MAX_INPUT_DISPLAY = 500;
    if (inputStr.length > MAX_INPUT_DISPLAY) {
      inputStr = inputStr.slice(0, MAX_INPUT_DISPLAY) + '\n... (truncated)';
    }
    const contextStr = event.context ? `\n${event.context}` : '';

    // Embed requestId in customId: "permission_allow:toolName|requestId" or "permission_allow:toolName"
    const idSuffix = event.requestId
      ? `${event.toolName}|${event.requestId}`
      : event.toolName;

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`permission_allow:${idSuffix}`)
        .setLabel('Allow')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`permission_always_allow:${idSuffix}`)
        .setLabel('Always Allow')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`permission_deny:${idSuffix}`)
        .setLabel('Deny')
        .setStyle(ButtonStyle.Danger)
    );

    const content = `**Permission requested: \`${event.toolName}\`**\n\`\`\`\n${inputStr}\n\`\`\`${contextStr}\n_or type a custom response_`;

    await this.sendToThread(threadId, context, content, [row]);
  }

  /** Post an interactive question with dynamic option buttons.
   *  Renders the first question from AskUserQuestion as Discord buttons. */
  async postUserQuestion(
    channelId: string,
    threadId: string,
    questions: Array<{
      question: string;
      header: string;
      options: Array<{ label: string; description: string }>;
      multiSelect: boolean;
    }>,
    requestId: string,
    context: any
  ): Promise<void> {
    const q = questions[0];
    if (!q) return;

    this.pendingQuestionOptions.set(requestId, q.options.map((o) => o.label));

    const optionLines = q.options.map((o) =>
      `- **${o.label}**${o.description ? ` — ${o.description}` : ''}`
    ).join('\n');

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...q.options.map((opt, i) =>
        new ButtonBuilder()
          .setCustomId(`question_answer:${i}|${requestId}`)
          .setLabel(opt.label.slice(0, 80))
          .setStyle(ButtonStyle.Primary)
      )
    );

    const content = `**${q.question}**\n${optionLines}`;
    const msg = await this.sendToThread(threadId, context, content, [row]);
    this.questionMessages.set(requestId, msg);
  }

  /** Post a sandbox upgrade prompt for Codex sandbox denials. */
  async postSandboxUpgradePrompt(
    channelId: string,
    threadId: string,
    contextText: string,
    context: any
  ): Promise<void> {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('sandbox_upgrade')
        .setLabel('Upgrade to Full Access')
        .setStyle(ButtonStyle.Danger)
    );

    const content = `**Sandbox denied this action:**\n${contextText.slice(0, 500)}\n_This will allow unrestricted file system access for all future Codex sessions in this project_`;
    await this.sendToThread(threadId, context, content, [row]);
  }

  /** Post an error message. */
  async postError(channelId: string, threadId: string, message: string, context: any): Promise<void> {
    const MAX_ERROR = 1800; // Leave room for the prefix within Discord's 2000-char limit
    const truncated = message.length > MAX_ERROR
      ? message.slice(0, MAX_ERROR) + '\n... (truncated)'
      : message;
    await this.sendToThread(threadId, context, `:warning: **Error:** ${truncated}`);
  }

  /** Handle /project slash command. */
  private async handleProjectCommand(interaction: any): Promise<void> {
    const channelId = interaction.channelId;
    const subcommand = interaction.options?.getSubcommand?.() || '';

    // /project list
    if (subcommand === 'list') {
      const projects = this.store.listProjects();
      if (projects.length === 0) {
        const root = this.store.getSetting('projects_root');
        const hint = root
          ? 'Use `/project connect` to pick one, or `/project connect path:/absolute/path`.'
          : 'Use `/project connect path:/absolute/path` to connect one.';
        await interaction.reply(`No projects connected to any channels yet. ${hint}`);
        return;
      }
      let text = '**Connected Projects:**\n';
      for (const p of projects) {
        // Cross-platform channels show as "slack:#channel-id" since Discord can't resolve them
        const channelLabel = p.platform === 'discord'
          ? `<#${p.channel_id}>`
          : `${p.platform} channel`;
        text += `- ${channelLabel} → \`${p.project_dir}\` (${p.backend_name})\n`;
      }
      await interaction.reply(text);
      return;
    }

    // /project disconnect
    if (subcommand === 'disconnect') {
      const project = this.store.getProjectByChannelId(channelId);
      if (!project) {
        await interaction.reply('This channel is not connected to a project.');
      } else {
        this.store.deleteProject(project.id);
        await interaction.reply(`Disconnected this channel from \`${project.project_dir}\`.`);
      }
      return;
    }

    // /project new <name|/absolute/path>
    if (subcommand === 'new') {
      const name = interaction.options?.getString?.('name') || '';
      if (!name) {
        await interaction.reply(':warning: Usage: `/project new name:my-app` or `/project new name:/absolute/path/my-app`');
        return;
      }

      let targetDir: string;
      if (path.isAbsolute(name)) {
        targetDir = name;
      } else {
        const root = this.store.getSetting('projects_root');
        if (!root) {
          await interaction.reply([
            ':warning: No projects root configured. Either:',
            '- Set one with `/settings root path:/path` then use `/project new name:my-app`',
            '- Or provide an absolute path: `/project new name:/home/user/my-app`',
          ].join('\n'));
          return;
        }
        targetDir = path.join(root, name);
      }

      if (fs.existsSync(targetDir)) {
        await interaction.reply(`:warning: Directory already exists: \`${targetDir}\`\nUse \`/project connect path:${targetDir}\` to connect to it instead.`);
        return;
      }

      try {
        fs.mkdirSync(targetDir, { recursive: true });
      } catch (err: any) {
        await interaction.reply(`:warning: Failed to create directory: ${err.message}`);
        return;
      }

      await this.handleProjectConnect(interaction, channelId, targetDir);
      return;
    }

    // /project backend <claude|codex>
    if (subcommand === 'info') {
      const project = this.store.getProjectByChannelId(channelId);
      if (!project) {
        await interaction.reply('No project connected to this channel. Use `/project connect` to set one up.');
        return;
      }
      const backendLabel = project.backend_name === 'claude' ? 'Claude Code' : 'Codex';
      const text = [
        '**Project Info**',
        `- Path: \`${project.project_dir}\``,
        `- Backend: ${backendLabel}`,
        `- Permissions: ${project.permission_mode}`,
      ].join('\n');
      await interaction.reply(text);
      return;
    }

    if (subcommand === 'backend') {
      const project = this.store.getProjectByChannelId(channelId);
      if (!project) {
        await interaction.reply('This channel is not connected to a project. Use `/project connect` first.');
        return;
      }
      const newBackend = interaction.options.getString('name');
      this.store.updateProjectBackend(project.id, newBackend);
      await interaction.reply(`Backend changed to \`${newBackend}\` for this project.`);
      return;
    }

    // /project connect [path]
    if (subcommand === 'connect') {
      const projectPath = interaction.options?.getString?.('path') || '';

      if (!projectPath) {
        // No path — show picker if projects_root is set
        const root = this.store.getSetting('projects_root');
        if (root && fs.existsSync(root)) {
          await this.postProjectPicker(interaction, 0);
        } else {
          await interaction.reply(':warning: Provide a path: `/project connect path:/absolute/path`\n_Tip: Set a projects root with `/settings root path:/path` to enable the picker._');
        }
        return;
      }

      if (!path.isAbsolute(projectPath)) {
        // Check if it matches a subdirectory in projects_root
        const root = this.store.getSetting('projects_root');
        if (root) {
          const fullPath = path.join(root, projectPath);
          if (fs.existsSync(fullPath)) {
            await this.handleProjectConnect(interaction, channelId, fullPath);
            return;
          }
        }
        await interaction.reply(':warning: Please provide an absolute directory path. Example: `/project connect path:/home/user/my-app`');
        return;
      }

      await this.handleProjectConnect(interaction, channelId, projectPath);
      return;
    }

    await interaction.reply([
      ':warning: Unsupported command. Try one of these:',
      ...this.getProjectCommandLines(),
      '',
      '**Other commands:**',
      '- `/new` — reset the session in a thread',
      '- `/cancel` — stop a running task in a thread',
      '- `/settings` — set projects root folder',
    ].join('\n'));
  }

  /** Build the list of /project subcommand descriptions. */
  private getProjectCommandLines(): string[] {
    return [
      '- `/project new name:my-app` — create a new project and connect it to a channel',
      '- `/project connect` — connect an existing project to a channel',
      '- `/project list` — show all connected projects',
      '- `/project disconnect` — disconnect this channel',
      '- `/project backend name:claude` or `codex` — switch the AI backend',
    ];
  }

  /** Post a project picker with pagination support. */
  private async postProjectPicker(interaction: any, offset: number): Promise<void> {
    const PAGE_SIZE = Math.min(PICKER_PAGE_SIZE, 20);
    const root = this.store.getSetting('projects_root');
    if (!root || !fs.existsSync(root)) return;

    const entries = fs.readdirSync(root, { withFileTypes: true })
      .filter((e: fs.Dirent) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e: fs.Dirent) => e.name)
      .sort();

    if (entries.length === 0) {
      await interaction.reply(`:warning: No subdirectories found in \`${root}\`. Use \`/project connect path:/absolute/path\` instead.`);
      return;
    }

    const page = entries.slice(offset, offset + PAGE_SIZE);
    const hasMore = offset + PAGE_SIZE < entries.length;

    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    for (let i = 0; i < page.length; i += 5) {
      const row = new ActionRowBuilder<ButtonBuilder>();
      for (const name of page.slice(i, i + 5)) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`project_pick:${path.join(root, name)}`)
            .setLabel(name)
            .setStyle(ButtonStyle.Secondary)
        );
      }
      rows.push(row);
    }

    // Add "Show more" button if there are more entries (Discord max 5 ActionRows)
    if (hasMore && rows.length < 5) {
      const moreRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`project_picker_more:${offset + PAGE_SIZE}`)
          .setLabel(`Show more (${entries.length - offset - PAGE_SIZE} remaining)`)
          .setStyle(ButtonStyle.Primary)
      );
      rows.push(moreRow);
    }

    const rangeLabel = offset > 0
      ? `**Projects from** \`${root}\` **(${offset + 1}–${offset + page.length} of ${entries.length}):**`
      : `**Pick a project from** \`${root}\`:`;
    const hint = '_Or use `/project connect path:/absolute/path` for a custom directory._';

    const content = { content: `${rangeLabel}\n${hint}`, components: rows };
    if (offset === 0) {
      await interaction.reply(content);
    } else {
      // For "Show more", update the original message
      await interaction.update(content);
    }
  }

  /** Handle /resume slash command — show laptop sessions to resume. */
  private async handleResumeCommand(interaction: any): Promise<void> {
    const channelId = this.getInteractionChannelId(interaction);
    if (!channelId) return;

    const project = this.store.getProjectByChannelId(channelId);
    if (!project) {
      await interaction.reply(':warning: This channel is not connected to a project. Use `/project connect` first.');
      return;
    }

    await this.postResumePicker(interaction, 0);
  }

  /** Post a session resume picker with pagination support (page size 3). */
  private async postResumePicker(interaction: any, offset: number): Promise<void> {
    const channelId = this.getInteractionChannelId(interaction);
    if (!channelId) return;

    const project = this.store.getProjectByChannelId(channelId);
    if (!project) return;

    const { sessions, total, hasMore } = await getSessionPage(project.project_dir, offset);

    if (total === 0) {
      const msg = ':mag: No laptop sessions found for this project. Make sure `~/.claude/projects` is synced via Mutagen.';
      if (offset === 0) {
        await interaction.reply(msg);
      } else {
        await interaction.update({ content: msg, components: [] });
      }
      return;
    }

    // One button per row for readability (session labels can be long)
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    for (const s of sessions) {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`resume_session:${s.sessionId}`)
          .setLabel(`${s.relativeTime}: "${s.lastMessage}"`)
          .setStyle(ButtonStyle.Secondary)
      );
      rows.push(row);
    }

    // Add "Show more" button if there are more sessions (Discord max 5 ActionRows)
    if (hasMore && rows.length < 5) {
      const moreRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`resume_picker_more:${offset + RESUME_PAGE_SIZE}`)
          .setLabel(`Show more (${total - offset - RESUME_PAGE_SIZE} remaining)`)
          .setStyle(ButtonStyle.Primary)
      );
      rows.push(moreRow);
    }

    const rangeLabel = offset > 0
      ? `**Resume a laptop session** **(${offset + 1}–${offset + sessions.length} of ${total}):**`
      : '**Resume a laptop session:**';

    const content = { content: rangeLabel, components: rows };
    if (offset === 0) {
      await interaction.reply(content);
    } else {
      await interaction.update(content);
    }
  }

  /** Handle a session resume button click — set backend_session_id for the next thread. */
  private async handleResumeSession(interaction: any, channelId: string, sessionId: string): Promise<void> {
    const project = this.store.getProjectByChannelId(channelId);
    if (!project) return;

    await interaction.update({
      content: `:arrows_counterclockwise: Session \`${sessionId.slice(0, 8)}…\` loaded. Send a message in a thread to continue the conversation.`,
      components: [],
    });

    console.log(`[discord] resume session ${sessionId} queued for project ${project.id} in channel ${channelId}`);
    this.pendingResumeSessions.set(channelId, sessionId);
  }

  /** Get the default backend, or throw if not configured. */
  private getDefaultBackend(): string {
    const backend = this.store.getSetting('default_backend');
    if (!backend) {
      throw new Error('No default backend configured. Run the setup wizard first.');
    }
    return backend;
  }

  /** Post permission mode selection buttons after project creation. */
  private async postPermissionModePrompt(channel: any, projectId: number): Promise<void> {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`perm_mode_supervised:${projectId}`)
        .setLabel('Supervised')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`perm_mode_trusted:${projectId}`)
        .setLabel('Trusted')
        .setStyle(ButtonStyle.Danger),
    );
    await channel.send({
      content: '**Permission mode:** How should the coding agent handle actions that need approval?\n*Supervised* — approve actions individually (recommended) | *Trusted* — skip all permission checks',
      components: [row],
    });
  }

  /** Bind a project to a channel and respond with confirmation. */
  private async bindProjectToChannel(
    channelId: string,
    projectDir: string,
    backend: string,
    respond: (text: string) => Promise<void>,
    channel?: any,
  ): Promise<void> {
    try {
      const project = this.store.createProject(channelId, projectDir, backend, 'discord');
      await respond(`Connected this channel to project \`${projectDir}\` (${backend})`);
      if (channel) {
        await this.postPermissionModePrompt(channel, project.id);
      }
    } catch (err: any) {
      await respond(`:warning: Failed to connect: ${err.message}`);
    }
  }

  /** Create a new Discord channel, bind a project to it, and respond. */
  private async createChannelAndBind(
    guild: any,
    projectDir: string,
    backend: string,
    respond: (text: string) => Promise<void>,
  ): Promise<void> {
    if (!guild) {
      await respond(':warning: This command can only be used in a server.');
      return;
    }
    const channelName = path.basename(projectDir);
    try {
      const newChannel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
      });
      const project = this.store.createProject(newChannel.id, projectDir, backend, 'discord');
      await respond(`Created and connected <#${newChannel.id}> to project \`${projectDir}\` (${backend})`);
      await this.postPermissionModePrompt(newChannel, project.id);
    } catch (err: any) {
      await respond(`:warning: Failed to create channel: ${err.message}`);
    }
  }

  /** Handle project connect flow for Discord. */
  private async handleProjectConnect(interaction: any, channelId: string, projectPath: string): Promise<void> {
    const existing = this.store.getProjectByChannelId(channelId);

    if (existing) {
      // Channel already bound — create a new channel for this project
      await this.createChannelAndBind(
        interaction.guild, projectPath, existing.backend_name,
        (text) => interaction.reply(text),
      );
    } else {
      // Channel is unbound — offer bind options
      const channelName = path.basename(projectPath);
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`project_bind_here:${projectPath}`)
          .setLabel('Use this channel')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`project_create_new:${projectPath}`)
          .setLabel(`Create #${channelName}`)
          .setStyle(ButtonStyle.Secondary)
      );

      await interaction.reply({
        content: `Connect project directory \`${projectPath}\`?`,
        components: [row],
      });
    }
  }

  /** Handle /new slash command. */
  private async handleNewCommand(interaction: any): Promise<void> {
    const channelId = interaction.channelId;
    const channel = interaction.channel;

    // Check if we're in a thread
    const threadId = channel?.isThread?.() ? channel.id : null;

    if (!threadId) {
      await interaction.reply('Use `/new` inside a thread to reset the session.');
      return;
    }

    // Get the parent channel ID for routing
    const parentChannelId = channel.parentId || channelId;

    try {
      this.router.resetSession(parentChannelId, threadId);
      await interaction.reply('Session reset. Your next message will start a fresh conversation.');
    } catch (err: any) {
      await interaction.reply(`:warning: ${err.message}`);
    }
  }

  /** Handle /cancel slash command — kill a stuck backend process. */
  private async handleCancelCommand(interaction: any): Promise<void> {
    const channelId = interaction.channelId;
    const channel = interaction.channel;

    const threadId = channel?.isThread?.() ? channel.id : null;

    if (!threadId) {
      await interaction.reply('Use `/cancel` inside a thread to stop a running task.');
      return;
    }

    const parentChannelId = channel.parentId || channelId;

    try {
      const cancelled = await this.router.cancelBackend(parentChannelId, threadId);
      if (cancelled) {
        await interaction.reply('Task cancelled. The running process has been stopped.');
      } else {
        await interaction.reply('Nothing to cancel — no task is currently running in this thread.');
      }
    } catch (err: any) {
      await interaction.reply(`:warning: ${err.message}`);
    }
  }

  /** Handle /settings slash command. */
  private async handleSettingsCommand(interaction: any): Promise<void> {
    const channelId = interaction.channelId;
    const subcommand = interaction.options?.getSubcommand?.() ?? 'view';

    if (subcommand === 'root') {
      const rootPath = interaction.options.getString('path');
      if (!path.isAbsolute(rootPath)) {
        await interaction.reply(':warning: Please provide an absolute path. Example: `/settings root path:/home/user/projects`');
        return;
      }
      this.store.setSetting('projects_root', rootPath);
      await interaction.reply(`Projects root set to \`${rootPath}\`. Use \`/project connect\` to pick from subdirectories.`);
      return;
    }

    if (subcommand === 'schedule-list') {
      await this.handleScheduleList(interaction);
      return;
    }

    if (subcommand === 'schedule-cancel') {
      await this.handleScheduleCancel(interaction);
      return;
    }

    // view
    const root = this.store.getSetting('projects_root');
    const project = this.store.getProjectByChannelId(channelId);
    let text = '**Bridge settings:**';
    if (root) {
      text += `\n- Projects root: \`${root}\``;
    } else {
      text += '\n- Projects root: _(not set)_';
    }
    if (project) {
      text += `\n\n**This channel's project:**\n- Backend: \`${project.backend_name}\` — change with \`/project backend\`\n- Directory: \`${project.project_dir}\``;
    }
    text += '\n\n_Commands:_';
    text += '\n- `/settings root path:/path` — set projects root folder';
    text += '\n- `/settings schedule-list` — list active schedules';
    text += '\n- `/settings schedule-cancel id:<id>` — cancel a schedule';
    await interaction.reply(text);
  }

  /** Handle /settings schedule-list subcommand. */
  private async handleScheduleList(interaction: any): Promise<void> {
    const channelId = interaction.channelId;
    const schedules = this.store.getSchedulesByChannelId(channelId);
    if (schedules.length === 0) {
      await interaction.reply('No scheduled sessions for this channel.');
      return;
    }
    const fmt = (iso: string | null) => iso ? new Date(iso).toLocaleString() : '—';
    const lines = schedules.map((s, i) => {
      const typeLabel = s.is_recurring ? `recurring` : `one-time`;
      return `${i + 1}. "${s.original_request}" — ${typeLabel}, next: ${fmt(s.next_run_at)} [ID: ${s.id}]`;
    });
    await interaction.reply(`**Scheduled Sessions**\n${lines.join('\n')}`);
  }

  /** Handle /settings schedule-cancel subcommand. */
  private async handleScheduleCancel(interaction: any): Promise<void> {
    const channelId = interaction.channelId;
    const id = interaction.options.getInteger('id');
    if (!id) {
      await interaction.reply('Usage: `/settings schedule-cancel id:<schedule ID>`');
      return;
    }
    const schedule = this.store.getScheduleById(id);
    if (!schedule || schedule.channel_id !== channelId || !schedule.is_active) {
      await interaction.reply(`No active schedule with ID ${id} found in this channel.`);
      return;
    }
    this.store.deactivateSchedule(id);
    await interaction.reply(`Cancelled schedule: "${schedule.original_request}"`);
  }

  /** Handle file uploads in messages — downloads all file types for backend passthrough. */
  async handleFileUpload(
    channelId: string,
    threadId: string,
    files: { name: string; url: string; contentType?: string }[],
    text: string,
    context: Message
  ): Promise<void> {
    const project = this.store.getProjectByChannelId(channelId);
    if (!project) return;

    const attachments: FileAttachment[] = [];
    const textInclusions: string[] = [];

    for (const file of files) {
      // Discord URLs are public — no auth headers needed
      const attachment = await downloadAndStageFile(file.url, file.name, file.contentType);

      if (attachment) {
        attachments.push(attachment);
        // Include text file contents inline so the AI can read them
        if (attachment.kind === 'text' && attachment.stagingPath) {
          try {
            const content = fs.readFileSync(attachment.stagingPath, 'utf8');
            textInclusions.push(`\`\`\`${attachment.filename}\n${content}\n\`\`\``);
          } catch (err: any) {
            console.error(`[discord] failed to read staged text file ${attachment.stagingPath}: ${err.message}`);
          }
        }
        console.log(`[discord] downloaded ${attachment.kind} file ${file.name} (${attachment.mediaType}, staged as ${attachment.uploadId})`);
      } else {
        textInclusions.push(`[Uploaded file: ${file.name} (download failed)]`);
      }
    }

    const combinedText = textInclusions.length > 0
      ? `${text}\n\n${textInclusions.join('\n\n')}`
      : text;

    clearPostMessageFlag(threadId);
    let result: RouteResult;
    try {
      result = await this.router.send(
        channelId, threadId, combinedText,
        attachments.length > 0 ? attachments : undefined,
      );
    } catch (err: any) {
      await this.postError(channelId, threadId, err.message, context);
      return;
    }

    await this.renderEvents(channelId, threadId, result.events, context);
    await this.removeReactSeen(context);
    await this.cleanupPermissionAcks(threadId);
  }

  /** Send a message to a thread (or channel if no thread context).
   *  Returns the sent Message for callers that need to update it later. */
  private async sendToThread(
    threadId: string,
    context: any,
    content: string,
    components?: ActionRowBuilder<ButtonBuilder>[]
  ): Promise<Message> {
    // If context is a Message with a channel reference, use it directly
    if (context?.channel) {
      const channel = context.channel;
      if (channel.isThread?.()) {
        return await channel.send({ content, components });
      }
      // Try to get the thread by ID from the channel
      try {
        const thread = await channel.threads?.fetch(threadId);
        if (thread) {
          return await thread.send({ content, components });
        }
      } catch {
        // Thread not found — fall through to send in channel
      }
      return await channel.send({ content, components });
    }

    // No context (e.g. IPC/hook callback) — fetch the channel directly
    let channel: any = null;
    try {
      channel = await this.client.channels.fetch(threadId);
    } catch {
      try {
        channel = await this.client.channels.fetch(threadId.split('/')[0]);
      } catch {
        // Both fetches failed
      }
    }
    if (!channel || !('send' in channel)) {
      throw new Error(`[discord] sendToThread: cannot find sendable channel for thread ${threadId}`);
    }
    return await (channel as any).send({ content, components });
  }

  /** Get the channel ID from a message (parent channel for threads). */
  private getChannelId(message: Message): string {
    const channel = message.channel;
    if (channel.isThread?.()) {
      return (channel as ThreadChannel).parentId ?? channel.id;
    }
    return channel.id;
  }

  /** Get the thread ID from a message (null if not in a thread). */
  private getThreadId(message: Message): string | null {
    const channel = message.channel;
    if (channel.isThread?.()) {
      return channel.id;
    }
    return null;
  }

  /** Get the channel ID from an interaction. */
  private getInteractionChannelId(interaction: any): string | null {
    const channel = interaction.channel;
    if (!channel) return null;
    if (channel.isThread?.()) {
      return channel.parentId ?? channel.id;
    }
    return channel.id;
  }

  /** Get the thread ID from an interaction. */
  private getInteractionThreadId(interaction: any): string | null {
    const channel = interaction.channel;
    if (!channel) return null;
    if (channel.isThread?.()) {
      return channel.id;
    }
    return interaction.message?.id ?? null;
  }

  /** Upload a file to a Discord thread. Called by MCP callback handler. */
  async uploadFile(channelId: string, threadId: string, filePath: string): Promise<void> {
    const filename = path.basename(filePath);
    let channel: any = null;
    try {
      channel = await this.client.channels.fetch(threadId);
    } catch {
      channel = await this.client.channels.fetch(channelId);
    }
    if (!channel || !('send' in channel)) {
      throw new Error(`[discord] uploadFile: cannot find sendable channel for ${channelId}/${threadId}`);
    }
    await (channel as TextChannel).send({
      files: [{ attachment: filePath, name: filename }],
    });
    console.log(`[discord] uploaded file ${filename} to ${channelId}/${threadId}`);
  }

  /** Post a plain text message to a Discord thread. Called by MCP callback handler. */
  async sendMessage(channelId: string, threadId: string, text: string): Promise<void> {
    let channel: any = null;
    try {
      channel = await this.client.channels.fetch(threadId);
    } catch {
      channel = await this.client.channels.fetch(channelId);
    }
    if (!channel || !('send' in channel)) {
      throw new Error(`[discord] sendMessage: cannot find sendable channel for ${channelId}/${threadId}`);
    }
    const converted = markdownToDiscord(text);
    // Discord message limit is 2000 chars — truncate as a failsafe
    const MAX = 2000;
    const truncated = converted.length > MAX ? converted.slice(0, MAX - 15) + '\n... (truncated)' : converted;
    await (channel as TextChannel).send({ content: truncated });
  }

  async createThread(channelId: string, title: string): Promise<string> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      throw new Error(`[discord] createThread: channel ${channelId} is not a text channel`);
    }
    const thread = await (channel as TextChannel).threads.create({
      name: title.substring(0, 100),
      autoArchiveDuration: 60,
    });
    return thread.id;
  }

  /** Format todos as Discord markdown checklist. */
  private formatTodosDiscord(
    todos: Array<{ content: string; status: string; activeForm: string }>,
  ): string {
    if (todos.length === 0) return '*No tasks*';
    return todos.map((t) => {
      switch (t.status) {
        case 'completed':
          return `~~${t.content}~~`;
        case 'in_progress':
          return `> **${t.activeForm}...**`;
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
    const content = this.formatTodosDiscord(todos);
    const existing = this.todoMessages.get(threadId);

    if (existing) {
      try {
        await existing.edit({ content });
      } catch (err: any) {
        console.error(`[discord] failed to update todo message for thread ${threadId}: ${err.message}`);
        this.todoMessages.delete(threadId);
        await this.renderTodoList(channelId, threadId, todos);
      }
    } else {
      try {
        const msg = await this.sendToThread(threadId, null, content);
        this.todoMessages.set(threadId, msg);
      } catch (err: any) {
        console.error(`[discord] failed to post todo message for thread ${threadId}: ${err.message}`);
      }
    }
  }
}

// splitText is imported from ../utils.js
export { splitText } from '../utils.js';
