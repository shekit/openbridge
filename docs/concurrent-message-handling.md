# Concurrent Message Handling in OpenBridge

## Problem

When Claude is actively working in a thread and a user sends another message in that same thread, the message **does not steer the in-progress session**. Instead, OpenBridge spawns a second independent `claude -p` process.

Both processes run in parallel against the same session history (via `-r sessionId`), which causes:

- **Race conditions** on session state — both processes write to the same DB session row
- **Messy conversation history** — interleaved turns from two concurrent processes
- **No busy guard** — `router.send()` unconditionally transitions to `running` and spawns a new process with no check for an already-running session

The only way to interrupt a running session is `cancel`/`/cancel`, which kills the entire process group.

## Root Cause

OpenBridge uses a **oneshot architecture**: each user message spawns a new `claude -p` CLI process via `spawnCollect()`, waits for it to exit, then parses the collected JSONL output. There is no stdin pipe to an already-running process, and no mutex/lock preventing concurrent spawns for the same session.

### Relevant code paths

- `router.ts:184` — Unconditionally sets session state to `running` and spawns a backend
- `claude.ts:489` — Each `send()` call spawns a brand new `claude -p` process
- `claude.ts:46` — `spawnCollect()` uses `stdio: 'ignore'` for stdin (no way to write to it)

## Proposed Solution: Agent SDK Streaming Input

The official `@anthropic-ai/claude-agent-sdk` TypeScript SDK supports **streaming input mode** — a single long-lived process per session where user messages are streamed in over time.

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

const conversation = query({
  prompt: asyncIterableOfUserMessages, // yields SDKUserMessage over time
  options: { cwd: projectDir, resume: sessionId }
});

// Real-time event consumption (replaces parseClaudeOutput)
for await (const message of conversation) {
  // handle SDKMessage events as they arrive
}

// Steer the running session with new input
await conversation.streamInput(moreMessages());

// Clean interruption (replaces process group kill)
await conversation.interrupt();
```

## Implementation Outline

### 1. `claude.ts` — Backend rewrite

- Replace `spawnCollect('claude', args)` with `query({ prompt, options })` from the Agent SDK
- Keep one `Query` object alive per session instead of spawning/exiting per message
- New user messages are yielded into the query's async iterable input stream

### 2. Backend interface changes

- `send()` stops spawning a new process — instead yields a `SDKUserMessage` into the existing stream
- Add `interrupt()` method wrapping `query.interrupt()`
- Backend lifecycle becomes: start once, send many, stop on session end

### 3. Router guards

- Add a busy check: if session is `running`, either queue the message or stream it into the active backend
- Remove process-group-kill cancellation — use `interrupt()` instead

### 4. Event parsing

- Replace `parseClaudeOutput()` (post-hoc JSONL string parsing) with real-time `for await (const msg of query)` over typed `SDKMessage` objects
- Events are emitted as they happen instead of collected after process exit

### 5. Lifecycle management

- Manage subprocess lifetime: when to start, idle timeout, crash recovery
- Handle process death gracefully (restart on next message)
- Memory consideration: one live Node subprocess per active session

## Scope

Medium-large change. Touches:
- `src/backends/claude.ts` (major rewrite)
- `src/types/backend.ts` (interface changes)
- `src/router.ts` (busy guards, lifecycle)
- `src/adapters/slack.ts` and `src/adapters/discord.ts` (real-time event rendering)

The event parsing gets simpler but lifecycle management gets more complex.
