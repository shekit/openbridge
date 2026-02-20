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
import type { Backend, BackendOptions, McpServerEntry, SendResult } from '../types/backend.js';
import type { NormalizedEvent } from '../types/events.js';

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Spawn a process and collect stdout/stderr until exit. */
export function spawnCollect(
  command: string,
  args: string[],
  cwd: string,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
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

/** Build CLI args for a claude oneshot invocation. */
export function buildClaudeArgs(
  text: string,
  sessionId: string | null,
): string[] {
  const args = [
    '-p',
    '--verbose',
    '--output-format', 'stream-json',
    '--input-format', 'text',
  ];

  if (sessionId) {
    args.push('-r', sessionId);
  }

  args.push(text);
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

  async start(options: BackendOptions): Promise<void> {
    this.projectDir = options.projectDir;
    this.mcpConfig = options.mcpConfig;

    // Write MCP config if provided so Claude discovers the bridge tools
    if (this.mcpConfig) {
      writeClaudeMcpConfig(this.projectDir, this.mcpConfig);
    }

    console.log(`[claude] initialized for project: ${this.projectDir}`);
  }

  async send(text: string): Promise<SendResult> {
    const args = buildClaudeArgs(text, this.sessionId);

    console.log(`[claude] spawning: claude ${args.join(' ').slice(0, 120)}...`);
    const result = await spawnCollect('claude', args, this.projectDir);
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

  async stop(): Promise<void> {
    console.log('[claude] stopping');
    this.sessionId = null;
  }
}
