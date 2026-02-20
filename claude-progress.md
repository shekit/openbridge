# OpenBridge Progress

## Current Status
Phase 0 — Project Setup (complete)
Phase 1 — Normalized Event Types and Backend Interface (complete)
Phase 2 — SQLite Persistence and Router (complete)

## Session Log

### Session 1 — Prototype
- Built I/O harness prototype (`prototype/io-harness/`) validating subprocess communication with Claude Code and Codex CLI
- Tested PTY mode — failed (TUI CLIs produce garbled output). Removed all PTY code.
- Validated oneshot + resume mode for both backends with structured JSON output
- Validated permission denial detection: Claude Code `permission_denials` array (structured), Codex CLI sandbox errors (pattern-matched)
- Confirmed session resume works via `-r SESSION_ID` (Claude) and `codex exec resume SESSION_ID` (Codex)
- Discovered: `--sandbox` flag rejected on `codex exec resume` — persists from initial invocation automatically
- Removed all LLM roleplay test scenarios, kept only deterministic permission tests
- Final matrix: 3/3 tests pass (Claude Bash+Write denial, Claude Edit denial, Codex sandbox denial)
- Wrote findings doc (`prototype/FINDINGS.md`)

### Session 2 — Architecture Updates & Harness Setup
- Updated ARCHITECTURE.md Implementation Notes with validated prototype findings (CLI subprocess model, permission detection, session lifecycle)
- Changed persistence from JSON config to SQLite (`better-sqlite3`, WAL mode)
- Added permission prompt UX section (buttons + freeform text via next message in thread)
- Marked prototype section as done
- Added laptop/VPS failover deployment note (Mutagen sync, automatic bot token handover, SQLite journal mode consideration)
- Created full project harness:
  - `feature-list.json` — 76 features across 8 phases (P0–P7), all status: failing
  - `CLAUDE.md` — project instructions, tech stack, session protocol, rules
  - `claude-progress.md` — this file
  - `scripts/init.sh` — check/start/stop subcommands
  - `scripts/build.sh` — TypeScript compilation
  - `scripts/test.sh` — vitest runner
  - `.env.example` — Slack + Discord token template
  - `.gitignore` — node_modules, dist, .env.local, .openbridge/, logs

### Session 3 — Phase 0: Project Setup
- Created `package.json` (name: openbridge, bin → dist/cli.js, engines ≥ 18, scripts for build/test)
- Created `tsconfig.json` (strict mode, ES2022, Node16 module resolution, output → dist/)
- Created `src/index.ts` with exported `main()` function
- Installed dev dependencies: typescript, vitest, @types/node
- Created `vitest.config.ts` and `src/__tests__/placeholder.test.ts`
- All verification passed: build succeeds, tests pass (1/1), init.sh check passes, dist/ output correct, .gitignore covers all required paths
- Marked P0.1–P0.9 as passing in feature-list.json

### Session 4 — Phase 1: Normalized Event Types and Backend Interface
- Created `src/types/events.ts` — 8 normalized event type interfaces (AssistantText, ToolUse, ToolResult, CommandExecution, PermissionDenied, SessionStarted, TurnCompleted, ErrorEvent) with NormalizedEvent discriminated union
- Created `src/types/backend.ts` — Backend interface (start, send, getSessionId, stop) with SendResult type
- Created `src/backends/claude.ts` — Claude Code backend:
  - `spawnCollect()` — spawns process, collects stdout/stderr, returns exit code
  - `parseClaudeOutput()` — parses stream-json JSONL into normalized events
  - `buildClaudeArgs()` — constructs CLI args, adds `-r SESSION_ID` for resume
  - Handles: session_id extraction, assistant text, permission_denials, permission context from user errors, error events
- Created `src/backends/codex.ts` — Codex CLI backend:
  - `parseCodexOutput()` — parses JSON JSONL into normalized events
  - `buildCodexArgs()` — constructs CLI args, uses `exec resume` subcommand for resume (no `--sandbox` on resume)
  - Handles: thread_id extraction, agent_message text, command_execution, sandbox denial pattern detection
  - Configurable sandbox mode (workspace-write, read-only, danger-full-access)
- Created test files: `events.test.ts`, `backend.test.ts`, `claude.test.ts`, `codex.test.ts`
- 71 tests passing across 5 test files
- All 16 features (P1.1–P1.16) committed individually, all marked passing

### Session 5 — Phase 2: SQLite Persistence and Router
- Installed `better-sqlite3` and `@types/better-sqlite3`
- Created `src/store.ts` — SQLite persistence layer:
  - Store class with WAL mode, foreign keys, migration system
  - Schema v1: projects table (channel_id UNIQUE), sessions table (thread_id UNIQUE, state machine), settings table (key-value)
  - `validateTransition()` enforces state machine: idle→running, running→idle/waiting_for_input/dead, waiting_for_input→running, dead→idle
  - Full CRUD for projects, sessions, settings
- Created `src/router.ts` — Channel/thread routing:
  - `resolve()` — maps channel_id + thread_id to project + session, auto-creates session for unknown thread
  - `send()` — routes message through backend, manages state transitions, persists backend_session_id
  - `respond()` — handles user response when session is waiting_for_input (permission denial resume flow)
  - `resetSession()` — clears backend_session_id and transitions to idle for /new command
- Created `src/__tests__/store.test.ts` — 48 tests covering P2.1–P2.9
- Created `src/__tests__/router.test.ts` — 34 tests covering P2.10–P2.15
- 153 tests passing across 7 test files
- All 15 features (P2.1–P2.15) committed individually, all marked passing
