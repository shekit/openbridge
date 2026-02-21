/**
 * PreToolUse hook for Claude Code.
 *
 * Auto-approves OpenBridge MCP tools so they never trigger permission prompts.
 * For all other tools, defers to Claude Code's default permission handling.
 *
 * Input: JSON on stdin with { tool_name, tool_input, ... }
 * Output: JSON on stdout with hookSpecificOutput (or empty for default behavior)
 */

/** Read all of stdin as a string. */
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

async function main(): Promise<void> {
  const raw = await readStdin();
  let input: { tool_name?: string };
  try {
    input = JSON.parse(raw);
  } catch {
    // Can't parse input — defer to default handling
    process.exit(0);
    return;
  }

  const toolName = input.tool_name ?? '';

  // Auto-approve our own MCP tools (belt-and-suspenders with --allowedTools)
  if (toolName.startsWith('mcp__openbridge__')) {
    const output = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'OpenBridge MCP tool auto-approved',
      },
    };
    process.stdout.write(JSON.stringify(output));
    process.exit(0);
    return;
  }

  // For all other tools, exit cleanly to defer to default permission handling
  process.exit(0);
}

main().catch(() => {
  // On any error, exit cleanly — don't block Claude Code
  process.exit(0);
});
