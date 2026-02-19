# Prototype Findings

Findings from the I/O harness prototype. Covers per-backend behavior differences and a recommended event/state model for OpenBridge core.

## What Was Tested

Local harness that spawns Claude Code and Codex CLI as subprocesses, sends prompts, streams output, detects permission boundaries, sends replies, and verifies recovery. No Slack/Discord integration — just raw subprocess I/O.

## Per-Backend Behavior

### Claude Code

**Working mode:** Oneshot with session resume.

```
claude -p --verbose --output-format stream-json --input-format text "prompt"
claude -p --verbose --output-format stream-json -r SESSION_ID "follow-up"
```

Each message spawns a new CLI invocation. The `-r` flag resumes the previous conversation by session ID. Output is structured JSONL on stdout.

**Key events in the stream:**
- `system` (subtype `init`) — contains `session_id` for resume
- `assistant` — contains `message.content[]` with text and tool_use blocks
- `user` — contains `tool_result` blocks (including `is_error: true` for denials)
- `result` — final event per invocation, contains `permission_denials[]` array

**Permission handling:** Deterministic and structured. When Claude Code denies a tool call in default permission mode (`-p` without `--dangerously-skip-permissions`), the `result` event includes:

```json
{
  "permission_denials": [
    {
      "tool_name": "Bash",
      "tool_use_id": "toolu_01...",
      "tool_input": { "command": "touch file.txt" }
    },
    {
      "tool_name": "Write",
      "tool_use_id": "toolu_02...",
      "tool_input": { "file_path": "file.txt", "content": "" }
    }
  ]
}
```

Additionally, `user` events with `is_error: true` and `tool_result` content containing words like "blocked", "not granted", or "permission" provide context about what was denied and why.

### Codex CLI

**Working mode:** Oneshot with session resume.

```
codex exec --skip-git-repo-check --json "prompt"
codex exec resume --skip-git-repo-check --json SESSION_ID "follow-up"
```

Same model as Claude — each message is a separate CLI invocation, resume by session ID.

**Key events in the stream:**
- `thread.started` — contains `thread_id` for resume
- `item.completed` (type `agent_message`) — assistant text responses
- `item.completed` (type `command_execution`) — shell command results with `exit_code` and `aggregated_output`
- `item.completed` (type `reasoning`) — model thinking (can be ignored)
- `turn.completed` — end of turn with usage stats

**Permission handling:** OS-level sandboxing, not application-level. Codex uses macOS sandbox-exec (or equivalent) controlled by the `--sandbox` flag:

- `workspace-write` — can only write within the project directory
- `read-only` — no writes at all
- `danger-full-access` — unrestricted

When the sandbox blocks a command, there is no structured denial event. The model reports the OS error as text in an `agent_message`:

```
touch: /etc/test.txt: Operation not permitted
```

Detection relies on matching patterns like "operation not permitted" or "permission denied" in agent message text. Not as clean as Claude's structured denials, but deterministic — the OS error is always the same.

**Note on `--sandbox` and resume:** The `--sandbox` flag is only accepted on the initial `codex exec` invocation. It is rejected by `codex exec resume`. The sandbox setting persists across the session automatically.

### What Didn't Work

**PTY mode (node-pty).** Both Claude Code and Codex CLI are TUI applications. When spawned in a pseudo-terminal:

- Output includes ANSI cursor positioning, screen clearing, and UI chrome that cannot be reliably parsed even after stripping escape codes
- Claude Code's output was garbled — response text was lost in TUI rendering artifacts
- Codex CLI had similar issues

PTY mode is fundamentally wrong for TUI-based CLIs. It would require a full terminal emulator (like xterm.js) to decode the screen buffer, which is massive overkill. The oneshot JSON mode gives clean structured output with zero parsing ambiguity.

**LLM roleplay testing.** Early prototype included scenarios that asked the LLM to pretend to show interactive prompts ("ask me a yes/no question with these options"). This produced non-deterministic results — the LLM doesn't always comply with exact formatting, and the tests were verifying harness plumbing rather than actual CLI behavior. All roleplay scenarios were removed in favor of tests that trigger real native permission systems.

## Recommended Event Model for OpenBridge

Based on what both CLIs actually produce, the bridge should normalize output into these event types:

```
assistant_text     — text response from the agent
tool_use           — agent wants to use a tool (from Claude's assistant events)
tool_result        — result of a tool execution (success or error)
command_execution  — shell command run by the agent (from Codex's item events)
permission_denied  — a tool or command was blocked by the permission system
session_started    — new session, includes session_id for resume
turn_completed     — agent finished responding, ready for next input
error              — agent or CLI error
```

### Session State Machine

```
idle ──send()──> running ──output done──> idle
                    │
                    ├──permission_denied──> waiting_for_input
                    │                           │
                    │                      user responds
                    │                           │
                    │                           v
                    │                       running
                    │
                    └──crash/timeout──> dead ──restart──> idle
```

**Key states:**
- `idle` — session exists, ready for next message
- `running` — CLI process is executing, output streaming
- `waiting_for_input` — permission denial detected, need human decision
- `dead` — process crashed or timed out, needs restart

### Permission Detection Strategy

**Claude Code:** Parse the `permission_denials` array from the `result` JSON event. This is 100% deterministic — if the array is non-empty, the agent hit a permission boundary. Each denial includes the exact tool name and input, which can be rendered as a Slack/Discord interactive message.

**Codex CLI:** Parse agent message text for OS sandbox error patterns (`/operation not permitted|permission denied/i`). Less structured than Claude, but the OS errors are deterministic. The bridge should render these as informational messages rather than interactive prompts, since Codex's sandbox decisions are made at process startup (via `--sandbox` flag), not per-action.

### Backend Contract

Both backends should expose:

```
start(projectDir)              → spawn or prepare session
send(text) → { events[] }      → send prompt, return normalized events
getSessionId() → string|null   → for resume after restart
stop()                          → clean shutdown
```

The `send()` return should include normalized events that the router can forward to the messaging adapter without knowing which backend produced them.

## Running the Tests

```bash
cd prototype/io-harness

# Single scenario
node run.js --backend claude --scenario claude-permission-text-option

# Full matrix (all real permission tests)
node run-matrix.js --backend claude,codex-sandboxed --max-attempts 2
```

## Files

```
prototype/io-harness/
  run.js                              — scenario runner (oneshot mode)
  run-matrix.js                       — matrix runner with assertions
  backends/
    claude.json                       — Claude Code backend config
    codex.json                        — Codex CLI backend config (unrestricted)
    codex-sandboxed.json              — Codex CLI with workspace-write sandbox
  scenarios/
    claude-permission-text-option.json — triggers Bash + Write denials in Claude
    claude-edit-denial.json           — triggers Edit denial in Claude
    codex-sandbox-denial.json         — triggers OS sandbox denial in Codex
  matrices/
    full-io-matrix.json               — deterministic permission test suite
```
