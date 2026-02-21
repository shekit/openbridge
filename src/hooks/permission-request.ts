/**
 * PermissionRequest hook for Claude Code.
 *
 * When Claude Code is about to show a permission dialog, this hook
 * sends the request to the bridge's IPC server, which relays it to
 * Slack/Discord as Allow/Deny buttons. The hook then polls for the
 * user's decision and returns allow/deny to Claude Code.
 *
 * Environment variables (set by the bridge on the Claude process):
 *   OPENBRIDGE_IPC_PORT     — port of the bridge's IPC server
 *   OPENBRIDGE_IPC_SECRET   — auth secret for IPC requests
 *   OPENBRIDGE_CHANNEL_ID   — chat channel for the permission prompt
 *   OPENBRIDGE_THREAD_ID    — chat thread for the permission prompt
 *   OPENBRIDGE_PLATFORM     — 'slack' or 'discord'
 *
 * Input: JSON on stdin with { tool_name, tool_input, ... }
 * Output: JSON on stdout with hookSpecificOutput.decision
 */

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

async function main(): Promise<void> {
  const raw = await readStdin();
  let input: { tool_name?: string; tool_input?: Record<string, unknown> };
  try {
    input = JSON.parse(raw);
  } catch {
    // Can't parse — deny safely
    const output = {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'Hook failed to parse input' },
      },
    };
    process.stdout.write(JSON.stringify(output));
    process.exit(0);
    return;
  }

  const toolName = input.tool_name ?? 'unknown';
  const toolInput = input.tool_input ?? {};

  // Read IPC connection info from environment
  const ipcPort = parseInt(process.env.OPENBRIDGE_IPC_PORT ?? '', 10);
  const ipcSecret = process.env.OPENBRIDGE_IPC_SECRET ?? '';
  const channelId = process.env.OPENBRIDGE_CHANNEL_ID ?? '';
  const threadId = process.env.OPENBRIDGE_THREAD_ID ?? '';
  const platform = process.env.OPENBRIDGE_PLATFORM ?? '';
  const timeoutMs = parseInt(process.env.OPENBRIDGE_HOOK_TIMEOUT_MS ?? '', 10) || DEFAULT_TIMEOUT_MS;

  if (!ipcPort || !ipcSecret || !channelId || !threadId) {
    // Missing env vars — can't communicate with bridge, deny
    process.stderr.write('[permission-hook] missing env vars, denying\n');
    const output = {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'Permission hook not configured' },
      },
    };
    process.stdout.write(JSON.stringify(output));
    process.exit(0);
    return;
  }

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
    process.stderr.write(`[permission-hook] IPC request failed: ${err}\n`);
    const output = {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'Failed to send permission request to bridge' },
      },
    };
    process.stdout.write(JSON.stringify(output));
    process.exit(0);
    return;
  }

  process.stderr.write(`[permission-hook] waiting for decision on ${toolName} (${requestId})\n`);

  // Poll for user's decision
  const decision = await pollForDecision(ipcPort, ipcSecret, requestId, timeoutMs);

  process.stderr.write(`[permission-hook] decision: ${decision}\n`);

  if (decision === 'allow') {
    const output = {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    };
    process.stdout.write(JSON.stringify(output));
  } else {
    const message = decision === 'timeout'
      ? 'Permission request timed out (no response from user)'
      : 'User denied permission';
    const output = {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message },
      },
    };
    process.stdout.write(JSON.stringify(output));
  }

  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[permission-hook] fatal: ${err}\n`);
  // On any error, deny — don't leave Claude hanging
  const output = {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'deny', message: 'Permission hook crashed' },
    },
  };
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
});
