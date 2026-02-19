/**
 * Codex CLI backend wrapper.
 *
 * Spawns `codex` CLI in oneshot mode with `--json` output.
 * Parses JSONL output into normalized events. Supports session resume
 * via `codex exec resume` subcommand.
 *
 * Reference: prototype/io-harness/run.js (parseCodexJson)
 */

import type { Backend, BackendOptions, SendResult } from '../types/backend.js';
import type { NormalizedEvent } from '../types/events.js';
import { spawnCollect } from './claude.js';

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

        // Check for sandbox denial in command output
        if (SANDBOX_DENIAL_RE.test(output)) {
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

/** Build CLI args for a codex oneshot invocation. */
export function buildCodexArgs(
  text: string,
  sessionId: string | null,
  sandbox: SandboxMode,
): string[] {
  if (sessionId) {
    // Resume: codex exec resume --skip-git-repo-check --json SESSION_ID "prompt"
    // Note: --sandbox is NOT included in resume (persists from initial invocation)
    return ['exec', 'resume', '--skip-git-repo-check', '--json', sessionId, text];
  }

  // Initial: codex exec --skip-git-repo-check --json --sandbox MODE "prompt"
  return ['exec', '--skip-git-repo-check', '--json', '--sandbox', sandbox, text];
}

export class CodexBackend implements Backend {
  private sessionId: string | null = null;
  private projectDir: string = '';
  private sandbox: SandboxMode;

  constructor(config: CodexBackendConfig = {}) {
    this.sandbox = config.sandbox || 'workspace-write';
  }

  async start(options: BackendOptions): Promise<void> {
    this.projectDir = options.projectDir;
    console.log(`[codex] initialized for project: ${this.projectDir} (sandbox: ${this.sandbox})`);
  }

  async send(text: string): Promise<SendResult> {
    const args = buildCodexArgs(text, this.sessionId, this.sandbox);

    console.log(`[codex] spawning: codex ${args.join(' ').slice(0, 120)}...`);
    const result = await spawnCollect('codex', args, this.projectDir);
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

  async stop(): Promise<void> {
    console.log('[codex] stopping');
    this.sessionId = null;
  }
}
