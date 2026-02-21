/**
 * Claude Code backend wrapper.
 *
 * Spawns `claude` CLI in oneshot mode with `--output-format stream-json`.
 * Parses JSONL output into normalized events. Supports session resume via `-r`.
 *
 * Reference: prototype/io-harness/run.js (parseClaudeStreamJson)
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Backend, BackendOptions, FileAttachment, McpServerEntry, SendResult } from '../types/backend.js';
import type { NormalizedEvent } from '../types/events.js';

/** Directory for backend log files. */
const LOG_DIR = path.join(os.homedir(), '.openbridge-ai', 'logs');

/** MCP tools that should always be pre-approved (our own tools, safe by design). */
export const MCP_TOOLS = [
  'mcp__openbridge__open_tunnel',
  'mcp__openbridge__serve_file_browser',
  'mcp__openbridge__upload_file',
  'mcp__openbridge__post_message',
  'mcp__openbridge__save_uploaded_file',
];

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SpawnHandle {
  result: Promise<SpawnResult>;
  kill(): void;
}

/** Spawn a process and collect stdout/stderr until exit. Returns a handle with kill().
 *  Uses detached: true so the child gets its own process group — kill() sends
 *  SIGTERM to the entire group, cleaning up any grandchild processes (e.g., dev servers).
 *  If stderrLogPath is provided, stderr is also streamed to that file in real-time.
 *  If env is provided, it is merged with process.env for the child process.
 *  If stdinData is provided, it is written to stdin and stdin is closed after. */
export function spawnCollect(
  command: string,
  args: string[],
  cwd: string,
  stderrLogPath?: string,
  env?: Record<string, string>,
  stdinData?: string,
): SpawnHandle {
  const proc = spawn(command, args, {
    cwd,
    stdio: [stdinData ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    detached: true,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });

  // Write stdin data and close
  if (stdinData && proc.stdin) {
    proc.stdin.write(stdinData);
    proc.stdin.end();
  }

  let stdout = '';
  let stderr = '';

  // Open a write stream for real-time stderr logging
  let logStream: fs.WriteStream | null = null;
  if (stderrLogPath) {
    try {
      fs.mkdirSync(path.dirname(stderrLogPath), { recursive: true });
      logStream = fs.createWriteStream(stderrLogPath, { flags: 'w' });
      logStream.write(`[${new Date().toISOString()}] spawn: ${command} ${args.join(' ').slice(0, 200)}\n`);
      logStream.write(`[${new Date().toISOString()}] cwd: ${cwd}\n\n`);
    } catch {
      // If we can't create the log file, continue without it
    }
  }

  proc.stdout!.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    stdout += text;
    if (logStream) {
      logStream.write(text);
    }
  });
  proc.stderr!.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    stderr += text;
    if (logStream) {
      logStream.write(text);
    }
  });

  const result = new Promise<SpawnResult>((resolve, reject) => {
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (logStream) {
        logStream.write(`\n[${new Date().toISOString()}] exited with code ${code}\n`);
        logStream.end();
      }
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });

  return {
    result,
    kill() {
      // Kill the entire process group (negative PID) to clean up grandchildren
      try {
        if (proc.pid) {
          process.kill(-proc.pid, 'SIGTERM');
        }
      } catch { /* already exited */ }
    },
  };
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Parse Claude Code stream-json JSONL output into normalized events. */
export function parseClaudeOutput(
  stdout: string,
  stderr: string,
  exitCode: number,
): { events: NormalizedEvent[]; sessionId: string | null } {
  const lines = `${stdout}\n${stderr}`.split(/\r?\n/);
  let sessionId: string | null = null;
  const events: NormalizedEvent[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const event = parseJsonLine(trimmed);
    if (!event) continue;

    // Session ID from system init
    if (
      event.type === 'system' &&
      event.subtype === 'init' &&
      typeof event.session_id === 'string'
    ) {
      sessionId = event.session_id;
      events.push({ type: 'session_started', sessionId });
      continue;
    }

    // Assistant text
    if (event.type === 'assistant') {
      const message = event.message as Record<string, unknown> | undefined;
      if (message && Array.isArray(message.content)) {
        const textParts = (message.content as Array<Record<string, unknown>>)
          .filter((p) => p.type === 'text' && typeof p.text === 'string')
          .map((p) => p.text as string);
        if (textParts.length > 0) {
          events.push({ type: 'assistant_text', text: textParts.join('\n') });
        }
      }
      continue;
    }

    // Permission denials from result event
    if (event.type === 'result' && Array.isArray(event.permission_denials)) {
      for (const denial of event.permission_denials as Array<Record<string, unknown>>) {
        if (!denial || typeof denial !== 'object') continue;
        events.push({
          type: 'permission_denied',
          toolName: (denial.tool_name as string) || 'unknown',
          toolInput: (denial.tool_input as Record<string, unknown>) || {},
        });
      }
    }

    // Permission context from user error events
    if (event.type === 'user') {
      const message = event.message as Record<string, unknown> | undefined;
      if (message && Array.isArray(message.content)) {
        for (const part of message.content as Array<Record<string, unknown>>) {
          if (
            part &&
            part.is_error === true &&
            typeof part.content === 'string'
          ) {
            const text = (part.content as string).trim();
            if (/permission|blocked|not granted|denied/i.test(text)) {
              // Attach context to the most recent PermissionDenied event
              const lastDenial = [...events]
                .reverse()
                .find((e) => e.type === 'permission_denied');
              if (lastDenial && lastDenial.type === 'permission_denied') {
                lastDenial.context = text;
              }
            }
          }
        }
      }
      continue;
    }

    // Error from result event
    if (event.type === 'result' && event.is_error === true) {
      const errors = event.errors as string[] | undefined;
      const message =
        Array.isArray(errors) && errors.length > 0
          ? String(errors[0])
          : `Claude execution failed (${(event.subtype as string) || 'unknown'})`;
      events.push({ type: 'error', message });
      continue;
    }
  }

  // Non-zero exit with no structured error
  if (exitCode !== 0 && !events.some((e) => e.type === 'error')) {
    events.push({ type: 'error', message: `Claude exited with code ${exitCode}` });
  }

  // Turn completed
  events.push({ type: 'turn_completed' });

  return { events, sessionId };
}

/**
 * Build a --settings JSON string that configures Claude Code hooks.
 * PreToolUse hook handles both MCP tool auto-approval and real-time
 * permission prompts for tools like Bash, Write, Edit.
 */
export function buildHookSettings(hookScriptDir: string): string {
  return JSON.stringify({
    hooks: {
      PreToolUse: [{
        matcher: '*',
        hooks: [{
          type: 'command',
          command: `node ${hookScriptDir}/hooks/pre-tool-use.js`,
          timeout: 310,
        }],
      }],
    },
  });
}

/**
 * Build stream-json JSONL input for Claude Code stdin.
 * Used when passing images — text-only messages don't need this (use --input-format text).
 * Format matches Anthropic API content blocks inside a stream-json user message.
 */
export function buildStreamJsonInput(text: string, images?: FileAttachment[]): string {
  const content: Array<Record<string, unknown>> = [];

  // Add images first (model sees them before the text prompt)
  if (images) {
    for (const img of images) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: img.mediaType,
          data: img.base64,
        },
      });
    }
  }

  // Add text prompt
  content.push({ type: 'text', text });

  const message = {
    type: 'user',
    message: {
      role: 'user',
      content,
    },
  };

  return JSON.stringify(message) + '\n';
}

/** Build CLI args for a claude oneshot invocation. */
export function buildClaudeArgs(
  text: string,
  sessionId: string | null,
  allowedTools?: string[],
  mcpConfigJson?: string,
  settingsJson?: string,
  dangerouslySkipPermissions?: boolean,
  useStreamJsonInput?: boolean,
): string[] {
  const args = [
    '-p',
    '--verbose',
    '--output-format', 'stream-json',
    '--input-format', useStreamJsonInput ? 'stream-json' : 'text',
  ];

  // Trusted mode — skip all permission prompts (no hooks needed)
  if (dangerouslySkipPermissions) {
    args.push('--dangerously-skip-permissions');
  }

  if (sessionId) {
    args.push('-r', sessionId);
  }

  // Explicitly pass MCP config so Claude Code discovers bridge tools.
  // More reliable than .mcp.json file discovery, especially in -p mode.
  if (mcpConfigJson) {
    args.push('--mcp-config', mcpConfigJson);
  }

  // Hook settings for real-time permission handling
  if (settingsJson) {
    args.push('--settings', settingsJson);
  }

  // Always pre-approve our MCP tools, plus any user-approved tools
  const allTools = [...MCP_TOOLS, ...(allowedTools ?? [])];
  const uniqueTools = [...new Set(allTools)];
  for (const tool of uniqueTools) {
    args.push('--allowedTools', tool);
  }

  if (useStreamJsonInput) {
    // Stream-json mode: prompt comes via stdin, no positional arg needed
  } else {
    // Text mode: use '--' to separate options from the prompt text.
    // Without this, commander.js variadic options like --allowedTools (<tools...>)
    // consume the prompt as another tool name, leaving Claude with no prompt.
    args.push('--', text);
  }
  return args;
}

/**
 * Write a .mcp.json file to the project directory with the bridge MCP server config.
 * Claude Code reads this file automatically for project-scoped MCP servers.
 */
export function writeClaudeMcpConfig(projectDir: string, mcpConfig: McpServerEntry): void {
  const mcpJsonPath = path.join(projectDir, '.mcp.json');

  // Read existing config if present, to avoid clobbering user's other MCP servers
  let existing: Record<string, unknown> = {};
  try {
    const content = fs.readFileSync(mcpJsonPath, 'utf8');
    existing = JSON.parse(content) as Record<string, unknown>;
  } catch {
    // File doesn't exist or is invalid — start fresh
  }

  // Ensure mcpServers object exists
  const mcpServers = (existing.mcpServers as Record<string, unknown>) || {};
  mcpServers['openbridge'] = {
    type: 'stdio',
    command: mcpConfig.command,
    args: mcpConfig.args,
    ...(mcpConfig.env ? { env: mcpConfig.env } : {}),
  };
  existing.mcpServers = mcpServers;

  fs.writeFileSync(mcpJsonPath, JSON.stringify(existing, null, 2) + '\n');
  console.log(`[claude] wrote MCP config to ${mcpJsonPath}`);
}

export class ClaudeBackend implements Backend {
  private sessionId: string | null = null;
  private projectDir: string = '';
  private mcpConfig: McpServerEntry | undefined;
  private activeHandle: SpawnHandle | null = null;
  private allowedTools: string[] = [];
  private ipc?: { port: number; secret: string };
  private channelId?: string;
  private threadId?: string;
  private platform?: string;
  private hookScriptDir?: string;
  private permissionMode?: string;

  async start(options: BackendOptions): Promise<void> {
    this.projectDir = options.projectDir;
    this.mcpConfig = options.mcpConfig;
    this.ipc = options.ipc;
    this.channelId = options.channelId;
    this.threadId = options.threadId;
    this.platform = options.platform;
    this.hookScriptDir = options.hookScriptDir;
    this.permissionMode = options.permissionMode;

    // Write MCP config if provided so Claude discovers the bridge tools
    if (this.mcpConfig) {
      writeClaudeMcpConfig(this.projectDir, this.mcpConfig);
    }

    console.log(`[claude] initialized for project: ${this.projectDir}`);
  }

  async send(text: string, images?: FileAttachment[]): Promise<SendResult> {
    // Build MCP config JSON for explicit --mcp-config flag
    let mcpConfigJson: string | undefined;
    if (this.mcpConfig) {
      mcpConfigJson = JSON.stringify({
        mcpServers: {
          openbridge: {
            command: this.mcpConfig.command,
            args: this.mcpConfig.args,
            ...(this.mcpConfig.env ? { env: this.mcpConfig.env } : {}),
          },
        },
      });
    }

    // In trusted mode, skip hooks entirely — all permissions are auto-approved
    const trusted = this.permissionMode === 'trusted';

    // Build hook settings if we have a hook script dir (supervised mode only)
    const settingsJson = (!trusted && this.hookScriptDir)
      ? buildHookSettings(this.hookScriptDir)
      : undefined;

    // Use stream-json input when images are attached (text-only uses simpler text input)
    const useStreamJson = images !== undefined && images.length > 0;
    let stdinData: string | undefined;
    if (useStreamJson) {
      stdinData = buildStreamJsonInput(text, images);
    }

    const args = buildClaudeArgs(
      text,
      this.sessionId,
      this.allowedTools.length > 0 ? this.allowedTools : undefined,
      mcpConfigJson,
      settingsJson,
      trusted,
      useStreamJson,
    );
    // Clear allowed tools after use (one-shot approval)
    this.allowedTools = [];

    // Build env vars for hook scripts (supervised mode only)
    let hookEnv: Record<string, string> | undefined;
    if (!trusted && this.ipc) {
      hookEnv = {
        OPENBRIDGE_IPC_PORT: String(this.ipc.port),
        OPENBRIDGE_IPC_SECRET: this.ipc.secret,
        ...(this.channelId ? { OPENBRIDGE_CHANNEL_ID: this.channelId } : {}),
        ...(this.threadId ? { OPENBRIDGE_THREAD_ID: this.threadId } : {}),
        ...(this.platform ? { OPENBRIDGE_PLATFORM: this.platform } : {}),
      };
    }

    // Log file for real-time stderr — readable with: tail -f ~/.openbridge-ai/logs/claude-latest.log
    const logPath = path.join(LOG_DIR, 'claude-latest.log');
    console.log(`[claude] spawning: claude ${args.join(' ').slice(0, 120)}...`);
    console.log(`[claude] stderr log: ${logPath}`);
    const handle = spawnCollect('claude', args, this.projectDir, logPath, hookEnv, stdinData);
    this.activeHandle = handle;

    let result: SpawnResult;
    try {
      result = await handle.result;
    } catch (err: any) {
      this.activeHandle = null;
      if (err?.code === 'ENOENT') {
        throw new Error(
          'Claude Code CLI not found. Install it with: npm install -g @anthropic-ai/claude-code',
        );
      }
      throw err;
    }
    this.activeHandle = null;
    console.log(`[claude] process exited with code ${result.exitCode}`);

    const parsed = parseClaudeOutput(result.stdout, result.stderr, result.exitCode);

    if (parsed.sessionId) {
      this.sessionId = parsed.sessionId;
    }

    return {
      events: parsed.events,
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

  async stop(): Promise<void> {
    console.log('[claude] stopping');
    if (this.activeHandle) {
      this.activeHandle.kill();
      this.activeHandle = null;
    }
    this.sessionId = null;
  }
}
