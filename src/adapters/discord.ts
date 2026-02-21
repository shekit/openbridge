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
import { splitText, isImageMimeType, downloadToBase64 } from '../utils.js';
import type { ImageAttachment } from '../types/backend.js';
import { resolvePermission } from '../mcp/ipc-server.js';

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
        ),
      new SlashCommandBuilder()
        .setName('new')
        .setDescription('Reset the current session in this thread'),
      new SlashCommandBuilder()
        .setName('settings')
        .setDescription('View or modify bridge settings')
        .addStringOption((option) =>
          option.setName('args').setDescription('Setting to change (e.g. "backend codex", "root /path")').setRequired(false)
        ),
      new SlashCommandBuilder()
        .setName('cancel')
        .setDescription('Cancel the running task in this thread'),
    ];

    const rest = new REST().setToken(this.botToken);
    await rest.put(Routes.applicationCommands(this.clientId), {
      body: commands.map((c) => c.toJSON()),
    });

    console.log('[discord] slash commands registered');
  }

  /** Register all Discord event handlers. */
  private registerHandlers(): void {
    // Message handler
    this.client.on(Events.MessageCreate, async (message: Message) => {
      await this.handleMessage(message);
    });

    // Interaction handler (slash commands + buttons)
    this.client.on(Events.InteractionCreate, async (interaction: Interaction) => {
      await this.handleInteraction(interaction);
    });
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

    // Check if this channel is bound to a project
    const project = this.store.getProjectByChannelId(channelId);
    if (!project) {
      return; // Not a bound channel, ignore
    }

    // Handle file attachments
    if (message.attachments.size > 0) {
      const files = Array.from(message.attachments.values()).map((a) => ({
        name: a.name ?? 'unknown',
        url: a.url,
        contentType: a.contentType ?? undefined,
      }));
      await this.handleFileUpload(channelId, threadId ?? message.id, files, text, message);
      return;
    }

    // If this is a top-level message (not in a thread), create a new thread
    if (!threadId) {
      try {
        const thread = await message.startThread({
          name: text.slice(0, 100) || 'Session',
        });
        threadId = thread.id;
        await thread.send('Processing...');
      } catch {
        // If thread creation fails, use the message ID
        threadId = message.id;
      }
    }

    // Check if the session is waiting_for_input (freeform text response)
    const session = this.store.getSessionByThreadId(threadId);
    if (session && session.state === 'waiting_for_input') {
      await this.handleFreeformResponse(channelId, threadId, text, message);
      return;
    }

    // Post a processing indicator for follow-up messages in threads
    let processingMsg: Message | null = null;
    if (message.channel.isThread?.()) {
      try {
        processingMsg = await message.channel.send('Processing...');
      } catch {
        // Non-fatal
      }
    }

    // Route through the router
    let result: RouteResult;
    try {
      result = await this.router.send(channelId, threadId, text);
    } catch (err: any) {
      if (processingMsg) await processingMsg.delete().catch(() => {});
      await this.postError(channelId, threadId, err.message, message);
      return;
    }

    // Remove the processing indicator before posting real response
    if (processingMsg) await processingMsg.delete().catch(() => {});

    // Render the response events
    await this.renderEvents(channelId, threadId, result.events, message);
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
    // Post a processing indicator while waiting for the backend response
    let processingMsg: Message | null = null;
    try {
      if (message.channel.isThread?.()) {
        processingMsg = await message.channel.send('Processing...');
      }
    } catch {
      // Non-fatal — continue without indicator
    }

    let result: RouteResult;
    try {
      result = await this.router.respond(channelId, threadId, text);
    } catch (err: any) {
      if (processingMsg) await processingMsg.delete().catch(() => {});
      await this.postError(channelId, threadId, err.message, message);
      return;
    }

    // Remove the processing indicator before posting real response
    if (processingMsg) await processingMsg.delete().catch(() => {});

    await this.renderEvents(channelId, threadId, result.events, message);
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
    if (customId === 'sandbox_upgrade') {
      const channelId = this.getInteractionChannelId(interaction);
      if (channelId) {
        const project = this.store.getProjectByChannelId(channelId);
        if (project) {
          this.store.updateSandboxMode(project.id, 'danger-full-access');
          console.log(`[discord] upgraded sandbox to danger-full-access for project ${project.id}`);
        }
      }
      await interaction.update({
        content: '**Sandbox upgraded to full access.** Try your request again.',
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
    } catch {
      // Non-fatal if update fails
    }

    // Hook-based flow: resolve in-process, no need to call router.respond()
    if (requestId) {
      const decision = isAllow ? 'allow' : 'deny';
      resolvePermission(requestId, decision);
      console.log(`[discord] resolved permission ${requestId} → ${decision}`);
      return;
    }

    // Legacy flow: route through router.respond()
    let processingMsg: Message | null = null;
    try {
      const channel = interaction.channel;
      if (channel && 'send' in channel) {
        processingMsg = await (channel as any).send('Processing...');
      }
    } catch {
      // Non-fatal — continue without indicator
    }

    const responseText = isAllow ? 'yes' : 'no';
    const allowedTools = isAllow && toolName ? [toolName] : undefined;
    let result: RouteResult;
    try {
      result = await this.router.respond(channelId, threadId, responseText, allowedTools);
    } catch (err: any) {
      if (processingMsg) await processingMsg.delete().catch(() => {});
      await this.sendToThread(threadId, interaction, `:warning: **Error:** ${err.message}`);
      return;
    }

    if (processingMsg) await processingMsg.delete().catch(() => {});

    await this.renderEvents(channelId, threadId, result.events, interaction);
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

    for (const event of deduped) {
      switch (event.type) {
        case 'assistant_text':
          await this.postText(channelId, threadId, event.text, context);
          break;

        case 'permission_denied':
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
    if (text.length <= DISCORD_MESSAGE_LIMIT) {
      await this.sendToThread(threadId, context, text);
    } else {
      const chunks = splitText(text, DISCORD_MESSAGE_LIMIT);
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
    const inputStr = JSON.stringify(event.toolInput, null, 2);
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
    await this.sendToThread(threadId, context, `:warning: **Error:** ${message}`);
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
        text += `- <#${p.channel_id}> → \`${p.project_dir}\` (${p.backend_name})\n`;
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
            '- Set one with `/settings args:root /path` then use `/project new name:my-app`',
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

    // /project connect [path]
    if (subcommand === 'connect') {
      const projectPath = interaction.options?.getString?.('path') || '';

      if (!projectPath) {
        // No path — show picker if projects_root is set
        const root = this.store.getSetting('projects_root');
        if (root && fs.existsSync(root)) {
          await this.postProjectPicker(interaction, 0);
        } else {
          await interaction.reply(':warning: Provide a path: `/project connect path:/absolute/path`\n_Tip: Set a projects root with `/settings args:root /path` to enable the picker._');
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
      '- `/settings` — view or change bridge settings',
    ].join('\n'));
  }

  /** Build the list of /project subcommand descriptions. */
  private getProjectCommandLines(): string[] {
    return [
      '- `/project new name:my-app` — create a new project and connect it to a channel',
      '- `/project connect` — connect an existing project to a channel',
      '- `/project list` — show all connected projects',
      '- `/project disconnect` — disconnect this channel',
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
    const project = this.store.getProjectByChannelId(channelId);

    if (!project) {
      await interaction.reply('This channel is not connected to a project. Use `/project connect` first.');
      return;
    }

    const args = interaction.options?.getString?.('args') || '';

    if (!args) {
      const root = this.store.getSetting('projects_root');
      let text = `**Settings for this project:**\n- Backend: \`${project.backend_name}\`\n- Directory: \`${project.project_dir}\``;
      if (root) {
        text += `\n- Projects root: \`${root}\``;
      }
      text += '\n\n_Commands:_';
      text += '\n- `/settings args:backend claude` or `codex` — switch backend';
      text += '\n- `/settings args:root /path` — set projects root folder';
      await interaction.reply(text);
      return;
    }

    const parts = args.split(/\s+/);
    if (parts[0] === 'backend' && parts[1]) {
      const newBackend = parts[1];
      if (!['claude', 'codex'].includes(newBackend)) {
        await interaction.reply(`:warning: Unknown backend \`${newBackend}\`. Valid options: \`claude\`, \`codex\``);
        return;
      }
      this.store.updateProjectBackend(project.id, newBackend);
      await interaction.reply(`Backend changed to \`${newBackend}\` for this project.`);
    } else if (parts[0] === 'root' && parts[1]) {
      const rootPath = parts.slice(1).join(' ');
      if (!path.isAbsolute(rootPath)) {
        await interaction.reply(':warning: Please provide an absolute path. Example: `/settings args:root /home/user/projects`');
        return;
      }
      this.store.setSetting('projects_root', rootPath);
      await interaction.reply(`Projects root set to \`${rootPath}\`. Use \`/project connect\` to pick from subdirectories.`);
    } else {
      await interaction.reply('**Usage:**\n- `/settings args:backend <claude|codex>`\n- `/settings args:root /path`');
    }
  }

  /** Handle file uploads in messages — downloads images for backend passthrough. */
  async handleFileUpload(
    channelId: string,
    threadId: string,
    files: { name: string; url: string; contentType?: string }[],
    text: string,
    context: Message
  ): Promise<void> {
    const project = this.store.getProjectByChannelId(channelId);
    if (!project) return;

    const images: ImageAttachment[] = [];
    const fileDescriptions: string[] = [];

    for (const file of files) {
      if (isImageMimeType(file.contentType)) {
        // Download image for passthrough to backend (Discord URLs are public)
        const downloaded = await downloadToBase64(file.url);
        if (downloaded) {
          images.push({ base64: downloaded.base64, mediaType: downloaded.mediaType });
          console.log(`[discord] downloaded image ${file.name} (${downloaded.mediaType})`);
        } else {
          fileDescriptions.push(`[Uploaded image: ${file.name} (download failed)]`);
        }
      } else {
        fileDescriptions.push(`[Uploaded file: ${file.name}]`);
      }
    }

    const combinedText =
      fileDescriptions.length > 0 ? `${text}\n\n${fileDescriptions.join('\n')}` : text;

    let result: RouteResult;
    try {
      result = await this.router.send(
        channelId, threadId, combinedText,
        images.length > 0 ? images : undefined,
      );
    } catch (err: any) {
      await this.postError(channelId, threadId, err.message, context);
      return;
    }

    await this.renderEvents(channelId, threadId, result.events, context);
  }

  /** Send a message to a thread (or channel if no thread context). */
  private async sendToThread(
    threadId: string,
    context: any,
    content: string,
    components?: ActionRowBuilder<ButtonBuilder>[]
  ): Promise<void> {
    // If context is a Message
    if (context?.channel) {
      const channel = context.channel;
      // If the message is in a thread, send directly to the thread
      if (channel.isThread?.()) {
        await channel.send({ content, components });
      } else {
        // Try to get the thread by ID
        try {
          const thread = await channel.threads?.fetch(threadId);
          if (thread) {
            await thread.send({ content, components });
          } else {
            await channel.send({ content, components });
          }
        } catch {
          // Fallback: reply in the current channel
          await channel.send({ content, components });
        }
      }
    }
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
    const channel = await this.client.channels.fetch(threadId).catch(() => null)
      ?? await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel || !('send' in channel)) {
      throw new Error(`Cannot find sendable channel for ${channelId}/${threadId}`);
    }
    await (channel as TextChannel).send({
      files: [{ attachment: filePath, name: filename }],
    });
    console.log(`[discord] uploaded file ${filename} to ${channelId}/${threadId}`);
  }

  /** Post a plain text message to a Discord thread. Called by MCP callback handler. */
  async sendMessage(channelId: string, threadId: string, text: string): Promise<void> {
    const channel = await this.client.channels.fetch(threadId).catch(() => null)
      ?? await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel || !('send' in channel)) {
      throw new Error(`Cannot find sendable channel for ${channelId}/${threadId}`);
    }
    await (channel as TextChannel).send({ content: text });
  }
}

// splitText is imported from ../utils.js
export { splitText } from '../utils.js';
