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
import type { Router, RouteResult } from '../router.js';
import type { NormalizedEvent } from '../types/events.js';
import type { Store } from '../store.js';

const DISCORD_MESSAGE_LIMIT = 2000;

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
        .setDescription('Manage project bindings')
        .addStringOption((option) =>
          option.setName('name').setDescription('Project name').setRequired(false)
        ),
      new SlashCommandBuilder()
        .setName('new')
        .setDescription('Reset the current session in this thread'),
      new SlashCommandBuilder()
        .setName('settings')
        .setDescription('View or modify bridge settings')
        .addStringOption((option) =>
          option.setName('args').setDescription('Setting to change (e.g. "backend codex")').setRequired(false)
        ),
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

    // Route through the router
    let result: RouteResult;
    try {
      result = await this.router.send(channelId, threadId, text);
    } catch (err: any) {
      await this.postError(channelId, threadId, err.message, message);
      return;
    }

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
    let result: RouteResult;
    try {
      result = await this.router.respond(channelId, threadId, text);
    } catch (err: any) {
      await this.postError(channelId, threadId, err.message, message);
      return;
    }

    await this.renderEvents(channelId, threadId, result.events, message);
  }

  /** Handle button clicks for permission prompts. */
  private async handleButtonInteraction(interaction: any): Promise<void> {
    const customId = interaction.customId;
    if (customId !== 'permission_allow' && customId !== 'permission_deny') {
      return;
    }

    const channelId = this.getInteractionChannelId(interaction);
    const threadId = this.getInteractionThreadId(interaction);

    if (!channelId || !threadId) {
      await interaction.reply({ content: 'Could not determine thread context.', ephemeral: true });
      return;
    }

    const action = customId === 'permission_allow' ? 'allow' : 'deny';
    const actionLabel = action === 'allow' ? 'Allowed' : 'Denied';

    // Update the original message to show which action was taken
    try {
      await interaction.update({
        content: `**Permission ${actionLabel}**`,
        components: [],
      });
    } catch {
      // Non-fatal if update fails
    }

    // Route the response
    const responseText = action === 'allow' ? 'yes' : 'no';
    let result: RouteResult;
    try {
      result = await this.router.respond(channelId, threadId, responseText);
    } catch (err: any) {
      await this.sendToThread(threadId, interaction, `:warning: **Error:** ${err.message}`);
      return;
    }

    // Render result events
    for (const event of result.events) {
      switch (event.type) {
        case 'assistant_text':
          await this.sendToThread(threadId, interaction, event.text);
          break;
        case 'error':
          await this.sendToThread(threadId, interaction, `:warning: **Error:** ${event.message}`);
          break;
      }
    }
  }

  /** Render normalized events as Discord messages in a thread. */
  private async renderEvents(
    channelId: string,
    threadId: string,
    events: NormalizedEvent[],
    context: Message
  ): Promise<void> {
    for (const event of events) {
      switch (event.type) {
        case 'assistant_text':
          await this.postText(channelId, threadId, event.text, context);
          break;

        case 'permission_denied':
          await this.postPermissionPrompt(channelId, threadId, event, context);
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

  /** Post a permission denial prompt with Allow/Deny buttons. */
  async postPermissionPrompt(
    channelId: string,
    threadId: string,
    event: { toolName: string; toolInput: Record<string, unknown>; context?: string },
    context: any
  ): Promise<void> {
    const inputStr = JSON.stringify(event.toolInput, null, 2);
    const contextStr = event.context ? `\n${event.context}` : '';

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('permission_allow')
        .setLabel('Allow')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('permission_deny')
        .setLabel('Deny')
        .setStyle(ButtonStyle.Danger)
    );

    const content = `**Permission requested: \`${event.toolName}\`**\n\`\`\`\n${inputStr}\n\`\`\`${contextStr}\n_or type a custom response_`;

    await this.sendToThread(threadId, context, content, [row]);
  }

  /** Post an error message. */
  async postError(channelId: string, threadId: string, message: string, context: any): Promise<void> {
    await this.sendToThread(threadId, context, `:warning: **Error:** ${message}`);
  }

  /** Handle /project slash command. */
  private async handleProjectCommand(interaction: any): Promise<void> {
    const channelId = interaction.channelId;
    const name = interaction.options?.getString?.('name') || '';

    if (!name) {
      // List all bindings
      const projects = this.store.listProjects();
      if (projects.length === 0) {
        await interaction.reply('No project bindings found. Use `/project name:<name>` to create one.');
        return;
      }

      let text = '**Project Bindings:**\n';
      for (const p of projects) {
        text += `- <#${p.channel_id}> → \`${p.project_dir}\` (${p.backend_name})\n`;
      }
      await interaction.reply(text);
      return;
    }

    // Check if current channel is bound
    const existing = this.store.getProjectByChannelId(channelId);

    if (existing) {
      // Channel already bound — create a new channel with the given name
      try {
        const guild = interaction.guild;
        if (!guild) {
          await interaction.reply(':warning: This command can only be used in a server.');
          return;
        }
        const newChannel = await guild.channels.create({
          name,
          type: ChannelType.GuildText,
        });
        this.store.createProject(newChannel.id, name, existing.backend_name);
        await interaction.reply(
          `Created and bound <#${newChannel.id}> to project \`${name}\` (${existing.backend_name})`
        );
      } catch (err: any) {
        await interaction.reply(`:warning: Failed to create channel: ${err.message}`);
      }
    } else {
      // Channel is unbound — offer bind options
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`project_bind_here:${name}`)
          .setLabel('Use this channel')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`project_create_new:${name}`)
          .setLabel(`Create #${name}`)
          .setStyle(ButtonStyle.Secondary)
      );

      await interaction.reply({
        content: `Bind project \`${name}\`?`,
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

  /** Handle /settings slash command. */
  private async handleSettingsCommand(interaction: any): Promise<void> {
    const channelId = interaction.channelId;
    const project = this.store.getProjectByChannelId(channelId);

    if (!project) {
      await interaction.reply('This channel is not bound to a project. Use `/project name:<name>` first.');
      return;
    }

    const args = interaction.options?.getString?.('args') || '';

    if (!args) {
      await interaction.reply(
        `**Settings for this project:**\n- Backend: \`${project.backend_name}\`\n- Directory: \`${project.project_dir}\``
      );
      return;
    }

    const parts = args.split(/\s+/);
    if (parts[0] === 'backend' && parts[1]) {
      const newBackend = parts[1];
      if (!['claude', 'codex'].includes(newBackend)) {
        await interaction.reply(`:warning: Unknown backend \`${newBackend}\`. Valid options: \`claude\`, \`codex\``);
        return;
      }
      this.store.setSetting(`project_${project.id}_backend`, newBackend);
      await interaction.reply(`Backend changed to \`${newBackend}\` for this project.`);
    } else {
      await interaction.reply('Usage: `/settings args:backend <claude|codex>`');
    }
  }

  /** Handle file uploads in messages. */
  async handleFileUpload(
    channelId: string,
    threadId: string,
    files: { name: string; url: string }[],
    text: string,
    context: Message
  ): Promise<void> {
    const project = this.store.getProjectByChannelId(channelId);
    if (!project) return;

    const fileDescriptions: string[] = [];

    for (const file of files) {
      fileDescriptions.push(`[Uploaded file: ${file.name}]`);
    }

    const combinedText =
      fileDescriptions.length > 0 ? `${text}\n\n${fileDescriptions.join('\n')}` : text;

    let result: RouteResult;
    try {
      result = await this.router.send(channelId, threadId, combinedText);
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
}

/** Split text into chunks at word boundaries. */
export function splitText(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf(' ', limit);
    if (splitAt <= 0) {
      splitAt = limit;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}
