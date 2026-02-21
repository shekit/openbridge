/**
 * Codex CLI backend wrapper.
 *
 * Spawns `codex` CLI in oneshot mode with `--json` output.
 * Parses JSONL output into normalized events. Supports session resume
 * via `codex exec resume` subcommand.
 *
 * Reference: prototype/io-harness/run.js (parseCodexJson)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Backend, BackendOptions, FileAttachment, McpServerEntry, SendResult } from '../types/backend.js';
import type { NormalizedEvent } from '../types/events.js';
import { spawnCollect, type SpawnHandle, type SpawnResult } from './claude.js';

export type SandboxMode = 'workspace-write' | 'read-only' | 'danger-full-access';

export interface CodexBackendConfig {
  sandbox?: SandboxMode;
}

const SANDBOX_DENIAL_RE =
  /operation not permitted|permission denied|sandbox.*(?:block|denied|restrict)|read.only.*file.?system/i;

function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Parse Codex CLI JSON output into normalized events. */
export function parseCodexOutput(
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

    // Thread ID from thread.started
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
      sessionId = event.thread_id;
      events.push({ type: 'session_started', sessionId });
      continue;
    }

    // Agent message text
    if (event.type === 'item.completed') {
      const item = event.item as Record<string, unknown> | undefined;
      if (!item) continue;

      if (item.type === 'agent_message' && typeof item.text === 'string') {
        const text = item.text as string;
        events.push({ type: 'assistant_text', text });

        // Check for sandbox denial patterns in agent message
        if (SANDBOX_DENIAL_RE.test(text)) {
          events.push({
            type: 'permission_denied',
            toolName: 'sandbox',
            toolInput: {},
            context: text.slice(0, 500),
          });
        }
        continue;
      }

      // Command execution
      if (item.type === 'command_execution') {
        const command = (item.command as string) || '';
        const exitCodeVal = (item.exit_code as number) ?? -1;
        const output = (item.aggregated_output as string) || '';

        events.push({
          type: 'command_execution',
          command,
          exitCode: exitCodeVal,
          output,
        });

        // Check for sandbox denial in command output (only on non-zero exit)
        if (exitCodeVal !== 0 && SANDBOX_DENIAL_RE.test(output)) {
          events.push({
            type: 'permission_denied',
            toolName: 'sandbox',
            toolInput: { command },
            context: output.slice(0, 500),
          });
        }
        continue;
      }

      // Reasoning events — ignored
      if (item.type === 'reasoning') continue;
    }

    // Error events
    if (event.type === 'error' && typeof event.message === 'string') {
      events.push({ type: 'error', message: event.message as string });
      continue;
    }

    if (event.type === 'turn.failed') {
      const error = event.error as Record<string, unknown> | undefined;
      const message = error && typeof error.message === 'string'
        ? (error.message as string)
        : 'Codex turn failed';
      events.push({ type: 'error', message });
      continue;
    }
  }

  // Non-zero exit with no structured error
  if (exitCode !== 0 && !events.some((e) => e.type === 'error')) {
    events.push({ type: 'error', message: `Codex exited with code ${exitCode}` });
  }

  // Turn completed
  events.push({ type: 'turn_completed' });

  return { events, sessionId };
}

/** Map MIME type to file extension for temp image files. */
export function mimeToExtension(mediaType: string): string {
  const map: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
  };
  return map[mediaType] || '.png';
}

/**
 * Save images to temp files and return their paths.
 * Caller is responsible for cleaning up the files.
 */
export function saveImagesToTemp(images: FileAttachment[]): string[] {
  const tmpDir = os.tmpdir();
  const paths: string[] = [];
  for (let i = 0; i < images.length; i++) {
    const ext = mimeToExtension(images[i].mediaType);
    const tmpPath = path.join(tmpDir, `openbridge-img-${Date.now()}-${i}${ext}`);
    fs.writeFileSync(tmpPath, Buffer.from(images[i].base64, 'base64'));
    paths.push(tmpPath);
  }
  return paths;
}

/** Clean up temp image files (best-effort, ignores errors). */
export function cleanupTempImages(paths: string[]): void {
  for (const p of paths) {
    try {
      fs.unlinkSync(p);
    } catch { /* file may already be gone */ }
  }
}

/** Build CLI args for a codex oneshot invocation. */
export function buildCodexArgs(
  text: string,
  sessionId: string | null,
  sandbox: SandboxMode,
  imagePaths?: string[],
): string[] {
  if (sessionId) {
    // Resume: codex exec resume --skip-git-repo-check --json SESSION_ID -- "prompt"
    // Note: --sandbox and -i are NOT included in resume (persists from initial invocation)
    return ['exec', 'resume', '--skip-git-repo-check', '--json', sessionId, '--', text];
  }

  const args = ['exec', '--skip-git-repo-check', '--json', '--sandbox', sandbox];

  // Attach images via -i/--image flag (Codex CLI multimodal input)
  if (imagePaths) {
    for (const imgPath of imagePaths) {
      args.push('-i', imgPath);
    }
  }

  // Use -- to separate options from the prompt positional argument.
  // Without this, the arg parser can misinterpret the prompt as a flag value.
  args.push('--', text);
  return args;
}

/**
 * Write a .codex/config.toml file with the bridge MCP server config.
 * Codex CLI reads project-scoped .codex/config.toml for MCP servers.
 * Uses a minimal TOML serializer (no dependency needed for simple structures).
 */
export function writeCodexMcpConfig(projectDir: string, mcpConfig: McpServerEntry): void {
  const codexDir = path.join(projectDir, '.codex');
  if (!fs.existsSync(codexDir)) {
    fs.mkdirSync(codexDir, { recursive: true });
  }

  const configPath = path.join(codexDir, 'config.toml');

  // Read existing config lines (preserve non-MCP settings)
  let existingLines: string[] = [];
  try {
    existingLines = fs.readFileSync(configPath, 'utf8').split('\n');
  } catch {
    // File doesn't exist — start fresh
  }

  // Remove any existing openbridge MCP server block
  const filtered: string[] = [];
  let inOpenbridgeBlock = false;
  for (const line of existingLines) {
    if (line.trim() === '[mcp_servers.openbridge]') {
      inOpenbridgeBlock = true;
      continue;
    }
    if (inOpenbridgeBlock && line.startsWith('[')) {
      inOpenbridgeBlock = false;
    }
    if (!inOpenbridgeBlock) {
      filtered.push(line);
    }
  }

  // Build the openbridge MCP server TOML block
  const argsToml = mcpConfig.args.map((a) => `"${a}"`).join(', ');
  const lines = [
    ...filtered.filter((l) => l.trim() !== ''), // Remove trailing blank lines
    '',
    '[mcp_servers.openbridge]',
    `command = "${mcpConfig.command}"`,
    `args = [${argsToml}]`,
  ];

  if (mcpConfig.env && Object.keys(mcpConfig.env).length > 0) {
    const envEntries = Object.entries(mcpConfig.env)
      .map(([k, v]) => `${k} = "${v}"`)
      .join(', ');
    lines.push(`env = { ${envEntries} }`);
  }

  lines.push('');
  fs.writeFileSync(configPath, lines.join('\n'));
  console.log(`[codex] wrote MCP config to ${configPath}`);
}

export class CodexBackend implements Backend {
  private sessionId: string | null = null;
  private projectDir: string = '';
  private sandbox: SandboxMode;
  private mcpConfig: McpServerEntry | undefined;
  private activeHandle: SpawnHandle | null = null;

  constructor(config: CodexBackendConfig = {}) {
    this.sandbox = config.sandbox || 'workspace-write';
  }

  async start(options: BackendOptions): Promise<void> {
    this.projectDir = options.projectDir;
    this.mcpConfig = options.mcpConfig;

    // Trusted mode — override sandbox to full access (no restrictions)
    if (options.permissionMode === 'trusted') {
      this.sandbox = 'danger-full-access';
    } else if (options.sandboxMode && ['workspace-write', 'read-only', 'danger-full-access'].includes(options.sandboxMode)) {
      // Use sandbox mode from project settings (may have been upgraded via P12.7)
      this.sandbox = options.sandboxMode as SandboxMode;
    }

    // Write MCP config if provided so Codex discovers the bridge tools
    if (this.mcpConfig) {
      writeCodexMcpConfig(this.projectDir, this.mcpConfig);
    }

    console.log(`[codex] initialized for project: ${this.projectDir} (sandbox: ${this.sandbox})`);
  }

  async send(text: string, files?: FileAttachment[]): Promise<SendResult> {
    // Filter to image files for the -i flag (Codex CLI multimodal input)
    const imageFiles = files?.filter((f) => f.kind === 'image');

    let imagePaths: string[] | undefined;
    let shouldCleanupImages = false;
    if (imageFiles && imageFiles.length > 0) {
      const allHaveStaging = imageFiles.every((img) => !!img.stagingPath);
      if (allHaveStaging) {
        imagePaths = imageFiles.map((img) => img.stagingPath!);
        console.log(`[codex] reusing ${imagePaths.length} staging file(s) for -i`);
      } else {
        imagePaths = saveImagesToTemp(imageFiles);
        shouldCleanupImages = true;
        console.log(`[codex] saved ${imagePaths.length} image(s) to temp files`);
      }
    }

    const args = buildCodexArgs(text, this.sessionId, this.sandbox, imagePaths);

    console.log(`[codex] spawning: codex ${args.join(' ').slice(0, 120)}...`);
    const handle = spawnCollect('codex', args, this.projectDir);
    this.activeHandle = handle;

    let result: SpawnResult;
    try {
      result = await handle.result;
    } catch (err: any) {
      this.activeHandle = null;
      if (imagePaths && shouldCleanupImages) cleanupTempImages(imagePaths);
      if (err?.code === 'ENOENT') {
        throw new Error(
          'Codex CLI not found. Install it with: npm install -g @openai/codex',
        );
      }
      throw err;
    }
    this.activeHandle = null;
    if (imagePaths && shouldCleanupImages) cleanupTempImages(imagePaths);
    console.log(`[codex] process exited with code ${result.exitCode}`);

    const parsed = parseCodexOutput(result.stdout, result.stderr, result.exitCode);

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

  setAllowedTools(_tools: string[]): void {
    // Codex uses OS-level sandbox — tool-level approval is not supported
  }

  async stop(): Promise<void> {
    console.log('[codex] stopping');
    if (this.activeHandle) {
      this.activeHandle.kill();
      this.activeHandle = null;
    }
    this.sessionId = null;
  }
}
