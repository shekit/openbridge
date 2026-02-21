import { describe, it, expect } from 'vitest';
import { spawnCollect } from '../backends/claude.js';
import * as path from 'node:path';

const HOOK_SCRIPT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../dist/hooks/pre-tool-use.js',
);

/** Run the hook script with JSON input on stdin and return parsed stdout. */
async function runHook(input: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  // Use node to run the compiled hook script, piping input via a wrapper
  const inputJson = JSON.stringify(input);
  const handle = spawnCollect(
    'node',
    ['-e', `
      const { spawn } = require('child_process');
      const proc = spawn('node', ['${HOOK_SCRIPT}'], { stdio: ['pipe', 'pipe', 'pipe'] });
      proc.stdin.write(${JSON.stringify(inputJson)});
      proc.stdin.end();
      let stdout = '';
      proc.stdout.on('data', c => stdout += c);
      proc.on('close', () => {
        process.stdout.write(stdout);
      });
    `],
    process.cwd(),
  );
  const result = await handle.result;
  const trimmed = result.stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

describe('PreToolUse hook script', () => {
  it('auto-approves mcp__openbridge__ tools', async () => {
    const output = await runHook({
      tool_name: 'mcp__openbridge__open_tunnel',
      tool_input: { port: 3000 },
    });
    expect(output).not.toBeNull();
    const decision = (output as any)?.hookSpecificOutput;
    expect(decision).toBeDefined();
    expect(decision.hookEventName).toBe('PreToolUse');
    expect(decision.permissionDecision).toBe('allow');
  });

  it('auto-approves mcp__openbridge__serve_file_browser', async () => {
    const output = await runHook({
      tool_name: 'mcp__openbridge__serve_file_browser',
      tool_input: { directory: '.' },
    });
    expect(output).not.toBeNull();
    expect((output as any)?.hookSpecificOutput?.permissionDecision).toBe('allow');
  });

  it('returns empty for non-MCP tools (defers to default)', async () => {
    const output = await runHook({
      tool_name: 'Bash',
      tool_input: { command: 'npx serve -p 3000' },
    });
    // Hook exits cleanly with no output = defer to default
    expect(output).toBeNull();
  });

  it('returns empty for unknown tools', async () => {
    const output = await runHook({
      tool_name: 'SomeUnknownTool',
      tool_input: {},
    });
    expect(output).toBeNull();
  });

  it('handles invalid JSON input gracefully', async () => {
    // Send garbage input — hook should exit cleanly
    const handle = spawnCollect(
      'node',
      ['-e', `
        const { spawn } = require('child_process');
        const proc = spawn('node', ['${HOOK_SCRIPT}'], { stdio: ['pipe', 'pipe', 'pipe'] });
        proc.stdin.write('not valid json');
        proc.stdin.end();
        let stdout = '';
        proc.stdout.on('data', c => stdout += c);
        proc.on('close', (code) => {
          process.stdout.write(JSON.stringify({ exitCode: code, stdout }));
        });
      `],
      process.cwd(),
    );
    const result = await handle.result;
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.exitCode).toBe(0); // exits cleanly, doesn't crash
  });
});
