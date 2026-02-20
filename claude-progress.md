# OpenBridge Progress

## Current Status
Phase 0 — Project Setup (complete)
Phase 1 — Normalized Event Types and Backend Interface (complete)
Phase 2 — SQLite Persistence and Router (complete)
Phase 3 — Slack Adapter (complete)
Phase 4 — Discord Adapter (complete)
Phase 5 — Bridge MCP Server (complete)
Phase 6 — CLI Setup Wizard (complete)
Phase 7 — Integration and Polish (complete)

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

### Session 6 — Phase 3: Slack Adapter
- Installed `@slack/bolt` and `@slack/web-api`
- Created `src/types/adapter.ts` — shared Adapter interface (start, stop, postText, postPermissionPrompt, postError)
- Created `src/adapters/slack.ts` — Slack adapter:
  - `createBoltApp()` factory for Socket Mode connection with bot/app tokens
  - `SlackAdapter` class with DI-friendly constructor (accepts optional pre-created App for testing)
  - Message handler: filters bots/self, routes bound channels, ignores unbound
  - Auto-threading: top-level messages use their ts as thread_ts, posts "Processing..." indicator
  - Thread-to-session routing via router.send() with thread_ts as session key
  - `renderEvents()` dispatches AssistantText, PermissionDenied, and Error events
  - `postText()` with splitText() utility for messages exceeding 4000 char limit
  - `postPermissionPrompt()` renders Block Kit: section with tool name/input, actions with Allow/Deny buttons, context with "or type a custom response"
  - `handlePermissionAction()` for Allow/Deny buttons: updates message, routes via router.respond()
  - Freeform text routing: checks session.state before routing, uses router.respond() when waiting_for_input
  - `postError()` for backend failures and Error events
  - `/project` command: no-args lists bindings, from bound channel creates new channel, from unbound offers bind options
  - `/new` command: resets session via router.resetSession(), warns if not in thread
  - `/settings` command: shows backend/directory, supports "backend <name>" to switch
  - `handleFileUpload()` combines file descriptions with message text and routes through backend
- Created `src/__tests__/slack.test.ts` — 52 tests using mock Bolt App injection
- 205 tests passing across 8 test files
- All 18 features (P3.1–P3.18) committed individually, all marked passing

### Session 7 — Phase 4: Discord Adapter
- Installed `discord.js`
- Created `src/adapters/discord.ts` — Discord adapter:
  - `createDiscordClient()` factory with GuildMessages, Guilds, MessageContent intents
  - `DiscordAdapter` class with DI-friendly constructor (accepts optional pre-created Client for testing)
  - Message handler: filters bots, routes bound channels (using parent channel ID for threads), ignores unbound
  - Auto-threading: top-level messages use `message.startThread()` with message text as thread name, posts "Processing..." indicator
  - Thread-to-session routing via router.send() with thread channel ID as session key
  - `renderEvents()` dispatches AssistantText, PermissionDenied, and Error events
  - `postText()` with splitText() utility for messages exceeding 2000 char limit
  - `postPermissionPrompt()` renders ActionRowBuilder with Allow/Deny ButtonBuilders (Success/Danger styles), includes tool name/input and "or type a custom response"
  - `handleButtonInteraction()` for Allow/Deny buttons: interaction.update() clears components, routes via router.respond()
  - Freeform text routing: checks session.state before routing, uses router.respond() when waiting_for_input
  - `postError()` for backend failures and Error events
  - `registerCommands()` uses REST API + SlashCommandBuilder to register /project, /new, /settings globally
  - `/project` command: no-args lists bindings, from bound channel creates new guild channel, from unbound offers bind buttons
  - `/new` command: resets session via router.resetSession() using parent channel ID, warns if not in thread
  - `/settings` command: shows backend/directory, supports "backend <name>" to switch
  - `handleFileUpload()` detects message.attachments, combines file descriptions with text, routes through backend
- Created `src/__tests__/discord.test.ts` — 48 tests using mock Discord Client injection
- 253 tests passing across 9 test files
- All 14 features (P4.1–P4.14) committed individually, all marked passing

### Session 8 — Phase 5: Bridge MCP Server
- Installed `@modelcontextprotocol/sdk` and `zod`
- Created `src/mcp/server.ts` — Bridge MCP server:
  - `createMcpServer()` — creates McpServer with three registered tools using `@modelcontextprotocol/sdk`
  - `startMcpServer()` — connects server via StdioServerTransport
  - `BridgeCallbacks` interface — adapter-agnostic callbacks (uploadFile, openTunnel, serveFileBrowser, postMessage)
  - `McpSessionContext` — ties each MCP server instance to a specific chat channel/thread/project
  - `validateProjectPath()` — resolves paths against project directory, rejects traversal attacks
  - `getMcpConfig()` — generates MCP server config entry for backend injection
  - `upload_file` tool — accepts file_path, validates within project, calls uploadFile callback
  - `open_tunnel` tool — accepts port + optional TTL (default 3600s), calls openTunnel callback, posts URL in thread
  - `serve_file_browser` tool — accepts optional directory (defaults to project root), calls serveFileBrowser callback, posts URL
- Added `McpServerEntry` interface to `src/types/backend.ts` — `BackendOptions` now accepts optional `mcpConfig`
- Modified `src/backends/claude.ts`:
  - `writeClaudeMcpConfig()` — writes `.mcp.json` in project directory with openbridge stdio server entry
  - `ClaudeBackend.start()` writes MCP config if provided, preserves existing MCP servers in file
- Modified `src/backends/codex.ts`:
  - `writeCodexMcpConfig()` — writes `.codex/config.toml` with `[mcp_servers.openbridge]` TOML block
  - `CodexBackend.start()` writes MCP config if provided, preserves existing config sections
- Created `src/__tests__/mcp-server.test.ts` — 39 tests covering all 6 features:
  - P5.1: Server creation, tool registration (6 tests)
  - P5.2: Config generation, Claude .mcp.json writing, Codex .codex/config.toml writing (11 tests)
  - P5.3: upload_file — callback invocation, missing file error, path rejection, absolute path (4 tests)
  - P5.4: open_tunnel — port+TTL, default TTL, URL posting, error handling, URL return (5 tests)
  - P5.5: serve_file_browser — directory resolution, subdirectory, URL posting, path rejection, nonexistent dir, default root (6 tests)
  - P5.6: validateProjectPath — within-project, root, absolute, traversal attacks, nested (7 tests)
- 292 tests passing across 10 test files
- All 6 features (P5.1–P5.6) committed individually, all marked passing

### Session 9 — Phase 6: CLI Setup Wizard
- Created `src/cli.ts` — CLI entry point:
  - `parseArgs()` parses subcommands (init, start, --help, --version)
  - `cli()` dispatches to runInit/runStart, shows usage/version
  - Handles unknown commands with error and exit code 1
- Created `src/cli/prompt.ts` — interactive prompt utilities:
  - `PromptIO` interface wrapping readline (injectable for testing)
  - `promptSelect()` — numbered list selection, supports multi-select
  - `promptText()` — text input with optional validation function
  - `promptConfirm()` — yes/no with configurable default
- Created `src/cli/init.ts` — setup wizard:
  - `selectPlatforms()` — Slack / Discord / Both selection (P6.2)
  - `inputTokens()` — platform-conditional token prompts (P6.3)
  - Token validators: `validateSlackBotToken` (xoxb-), `validateSlackAppToken` (xapp-), `validateDiscordToken` (length)
  - `detectCli()` — checks PATH for claude/codex (P6.4)
  - `detectBackend()` — auto-detects available backends, prompts if multiple found
  - `createFirstProject()` — prompts for name + directory, creates project in SQLite (P6.5)
  - `writeEnvFile()` — writes tokens to .env.local (P6.6)
  - `saveConfig()` — persists platforms and default_backend to store settings (P6.6)
  - `runInit()` — orchestrates full wizard flow, accepts optional PromptIO for testing
- Created `src/cli/start.ts` — bridge launcher:
  - `loadEnvFile()` — parses .env.local into process.env (key=value, skips comments)
  - `createBackendFactory()` — produces ClaudeBackend or CodexBackend by name
  - `runStart()` — loads config from .openbridge/, creates router + adapters, starts listening
  - Supports dryRun mode for testing without connecting to platforms
  - Graceful shutdown on SIGTERM/SIGINT
- Created test files: `cli.test.ts` (15 tests), `cli-init.test.ts` (20 tests), `cli-start.test.ts` (12 tests)
- 347 tests passing across 13 test files
- All 7 features (P6.1–P6.7) committed individually, all marked passing

### Session 10 — Phase 7: Integration and Polish
- Created `src/__tests__/integration.test.ts` — 27 integration tests covering all P7 features:
  - P7.1: End-to-end Slack → Claude Code → response in thread (2 tests)
  - P7.2: Slack permission denial → Allow button → resume (1 test)
  - P7.3: Slack permission denial → freeform text → resume (1 test)
  - P7.4: Discord → Codex CLI → response in thread (2 tests)
  - P7.5: Session persistence across bridge restart (3 tests)
  - P7.6: Graceful shutdown (3 tests)
  - P7.7: Missing CLI tool error handling (3 tests)
  - P7.8: Backend timeout error handling (3 tests)
  - P7.9: Backend crash error handling (3 tests)
  - P7.10: Consistent logging prefixes (6 tests)
- Modified `src/router.ts`:
  - Added `activeBackends` map to track backends during send/respond
  - Added `shutdown()` method to stop all active backends
  - Added `sendWithTimeout()` with configurable timeout (default 5 min)
  - Added `RouterOptions` interface with `timeoutMs` option
  - Auto-recovery from dead sessions: dead → idle with cleared backend_session_id
- Modified `src/backends/claude.ts`:
  - ENOENT detection in send() with user-friendly install instructions
- Modified `src/backends/codex.ts`:
  - ENOENT detection in send() with user-friendly install instructions
- Modified `src/cli/start.ts`:
  - Shutdown handler now calls `router.shutdown()` before stopping adapters
  - Added per-adapter stop logging during shutdown
- Modified `src/cli.ts`:
  - Added `[cli]` prefix to error messages
- Modified `src/cli/init.ts`:
  - Added `[init]` prefix to all log messages
- 374 tests passing across 14 test files
- All 10 features (P7.1–P7.10) committed individually, all marked passing
- All 76 features across all 8 phases (P0–P7) are now passing
