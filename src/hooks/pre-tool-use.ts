/**
 * PreToolUse hook for Claude Code.
 *
 * Fires before every tool execution. Five behaviors:
 *
 * 1. MCP tools (mcp__openbridge__*) → auto-approve immediately
 * 2. TodoWrite → fire-and-forget render to chat, then allow
 * 3. AskUserQuestion → send question to Slack/Discord via IPC, wait for
 *    user's button click, deny with the answer in the reason string
 * 4. Tools that typically need permission (Bash, Write, Edit, NotebookEdit) →
 *    send a real-time permission prompt to Slack/Discord via the IPC server,
 *    block until the user clicks Allow/Deny, return the decision
 * 5. Everything else → exit 0 (defer to Claude Code's default handling)
 *
 * This replaces the non-existent "PermissionRequest" hook event. PreToolUse
 * is the correct interception point for permission handling in -p mode.
 *
 * Environment variables (set by the bridge on the Claude process):
 *   OPENBRIDGE_IPC_PORT     — port of the bridge's IPC server
 *   OPENBRIDGE_IPC_SECRET   — auth secret for IPC requests
 *   OPENBRIDGE_CHANNEL_ID   — chat channel for the permission prompt
 *   OPENBRIDGE_THREAD_ID    — chat thread for the permission prompt
 *   OPENBRIDGE_PLATFORM     — 'slack' or 'discord'
 *
 * Input: JSON on stdin with { tool_name, tool_input, ... }
 * Output: JSON on stdout with hookSpecificOutput.permissionDecision
 */

/** Tools that need user permission (everything else is auto-approved by Claude Code). */
const PERMISSION_TOOLS = new Set(['Bash', 'Write', 'Edit', 'NotebookEdit']);

/** Default timeout for waiting for user response (5 minutes). */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** Poll interval in milliseconds. */
const POLL_INTERVAL_MS = 2000;

/** Read all of stdin as a string. */
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

/** POST JSON to the IPC server. */
async function ipcPost(
  port: number,
  secret: string,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-openbridge-secret': secret,
    },
    body: JSON.stringify(body),
  });
  return (await res.json()) as Record<string, unknown>;
}

/** Poll for a user question answer until resolved or timeout. */
async function pollForAnswer(
  port: number,
  secret: string,
  requestId: string,
  timeoutMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await ipcPost(port, secret, '/question-poll', { requestId });

    if (result.status === 'resolved') {
      return result.answer as string;
    }

    if (result.status === 'expired') {
      return null;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return null;
}

/** Poll for a permission decision until resolved or timeout. */
async function pollForDecision(
  port: number,
  secret: string,
  requestId: string,
  timeoutMs: number,
): Promise<'allow' | 'deny' | 'timeout'> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await ipcPost(port, secret, '/permission-poll', { requestId });

    if (result.status === 'resolved') {
      return result.decision as 'allow' | 'deny';
    }

    if (result.status === 'expired') {
      return 'timeout';
    }

    // Wait before next poll (the server long-polls for 5s, so this is extra safety)
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return 'timeout';
}

/** Return an allow decision for PreToolUse. */
function allowOutput(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: reason,
    },
  });
}

/** Return a deny decision for PreToolUse. */
function denyOutput(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}

async function main(): Promise<void> {
  const raw = await readStdin();
  let input: { tool_name?: string; tool_input?: Record<string, unknown> };
  try {
    input = JSON.parse(raw);
  } catch {
    // Can't parse input — defer to default handling
    process.exit(0);
    return;
  }

  const toolName = input.tool_name ?? '';

  // 1. Auto-approve our own MCP tools (belt-and-suspenders with --allowedTools)
  if (toolName.startsWith('mcp__openbridge__')) {
    process.stdout.write(allowOutput('OpenBridge MCP tool auto-approved'));
    process.exit(0);
    return;
  }

  // 2. TodoWrite → fire-and-forget render to chat, then allow
  if (toolName === 'TodoWrite') {
    const ipcPort = parseInt(process.env.OPENBRIDGE_IPC_PORT ?? '', 10);
    const ipcSecret = process.env.OPENBRIDGE_IPC_SECRET ?? '';
    const channelId = process.env.OPENBRIDGE_CHANNEL_ID ?? '';
    const threadId = process.env.OPENBRIDGE_THREAD_ID ?? '';
    const platform = process.env.OPENBRIDGE_PLATFORM ?? '';

    if (ipcPort && ipcSecret && channelId && threadId) {
      const toolInput = input.tool_input ?? {};
      const todos = (toolInput as Record<string, unknown>).todos ?? [];
      try {
        await ipcPost(ipcPort, ipcSecret, '/render-todos', {
          channelId,
          threadId,
          todos,
          platform,
        });
      } catch (err) {
        process.stderr.write(`[pre-tool-use] IPC render-todos failed: ${err}\n`);
      }
    }

    // Allow the tool — exit 0 with no output
    process.exit(0);
    return;
  }

  // 3. AskUserQuestion → send to chat, collect answer, deny with answer in reason
  if (toolName === 'AskUserQuestion') {
    const ipcPort = parseInt(process.env.OPENBRIDGE_IPC_PORT ?? '', 10);
    const ipcSecret = process.env.OPENBRIDGE_IPC_SECRET ?? '';
    const channelId = process.env.OPENBRIDGE_CHANNEL_ID ?? '';
    const threadId = process.env.OPENBRIDGE_THREAD_ID ?? '';
    const platform = process.env.OPENBRIDGE_PLATFORM ?? '';
    const timeoutMs = parseInt(process.env.OPENBRIDGE_HOOK_TIMEOUT_MS ?? '', 10) || DEFAULT_TIMEOUT_MS;

    if (!ipcPort || !ipcSecret || !channelId || !threadId) {
      process.exit(0);
      return;
    }

    const toolInput = input.tool_input ?? {};
    const questions = (toolInput as Record<string, unknown>).questions ?? [];

    let requestId: string;
    try {
      const result = await ipcPost(ipcPort, ipcSecret, '/ask-user-question', {
        channelId,
        threadId,
        questions,
        platform,
      });
      requestId = result.requestId as string;
      if (!requestId) throw new Error('No requestId returned');
    } catch (err) {
      process.stderr.write(`[pre-tool-use] IPC ask-user-question failed: ${err}\n`);
      process.exit(0);
      return;
    }

    process.stderr.write(`[pre-tool-use] waiting for answer to AskUserQuestion (${requestId})\n`);

    const answer = await pollForAnswer(ipcPort, ipcSecret, requestId, timeoutMs);

    process.stderr.write(`[pre-tool-use] answer: ${answer ?? '(timeout)'}\n`);

    if (answer) {
      process.stdout.write(denyOutput(
        `This question was presented to the user in the chat application and they selected: "${answer}". ` +
        `Do not call AskUserQuestion again for this — proceed with their choice.`
      ));
    } else {
      process.stdout.write(denyOutput(
        'The question timed out with no response from the user. Proceed with your best judgment.'
      ));
    }

    process.exit(0);
    return;
  }

  // 3. For tools that don't need permission, defer to Claude Code default
  if (!PERMISSION_TOOLS.has(toolName)) {
    process.exit(0);
    return;
  }

  // 4. For tools that need permission, send real-time prompt to Slack/Discord
  const ipcPort = parseInt(process.env.OPENBRIDGE_IPC_PORT ?? '', 10);
  const ipcSecret = process.env.OPENBRIDGE_IPC_SECRET ?? '';
  const channelId = process.env.OPENBRIDGE_CHANNEL_ID ?? '';
  const threadId = process.env.OPENBRIDGE_THREAD_ID ?? '';
  const platform = process.env.OPENBRIDGE_PLATFORM ?? '';
  const timeoutMs = parseInt(process.env.OPENBRIDGE_HOOK_TIMEOUT_MS ?? '', 10) || DEFAULT_TIMEOUT_MS;

  if (!ipcPort || !ipcSecret || !channelId || !threadId) {
    // No IPC configured — defer to Claude Code default (auto-deny in -p mode)
    process.exit(0);
    return;
  }

  const toolInput = input.tool_input ?? {};

  // Send permission request to bridge
  let requestId: string;
  try {
    const result = await ipcPost(ipcPort, ipcSecret, '/permission-request', {
      channelId,
      threadId,
      toolName,
      toolInput,
      platform,
    });
    requestId = result.requestId as string;
    if (!requestId) throw new Error('No requestId returned');
  } catch (err) {
    process.stderr.write(`[pre-tool-use] IPC request failed: ${err}\n`);
    // Can't reach bridge — defer to default
    process.exit(0);
    return;
  }

  process.stderr.write(`[pre-tool-use] waiting for decision on ${toolName} (${requestId})\n`);

  // Poll for user's decision
  const decision = await pollForDecision(ipcPort, ipcSecret, requestId, timeoutMs);

  process.stderr.write(`[pre-tool-use] decision: ${decision}\n`);

  if (decision === 'allow') {
    process.stdout.write(allowOutput('User approved via chat'));
  } else {
    const message = decision === 'timeout'
      ? 'Permission request timed out (no response from user)'
      : 'User denied permission';
    process.stdout.write(denyOutput(message));
  }

  process.exit(0);
}

main().catch((err) => {
  // On any error, log to stderr so it's visible in debug logs, then exit cleanly — don't block Claude Code
  process.stderr.write(`[pre-tool-use] fatal: ${err?.message ?? err}\n`);
  process.exit(0);
});
