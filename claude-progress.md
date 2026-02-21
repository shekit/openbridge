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
Phase 9 — Production-Readiness Fixes (complete)
Phase 10 — Wire MCP Server to Runtime (complete)
Phase 11 — Manual Test Bug Fixes (complete)
Phase 12 — Permission Modes, Image Support, Sandbox Upgrades (complete)
Phase 13 — Image Upload Staging & save_uploaded_file MCP Tool (complete)
Phase 14 — Universal File Upload Support (complete)
Phase 15 — Hook Bugfix (complete)
Phase 16 — post_message MCP Tool + Output Cleanup (complete)
Phase 17 — Consolidated Preview Server (complete)

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

### Session 11 — Code Review & Bug Fixes
- Full codebase review identified 10 issues (4 high, 3 medium, 3 low severity)
- Fixed 4 high-severity bugs:
  1. **Slack file uploads silently ignored** — `handleMessage` in slack.ts now detects `message.files` and routes through `handleFileUpload`
  2. **Discord project bind/create buttons did nothing** — added `handleProjectBindHere()` and `handleProjectCreateNew()` handlers in discord.ts for the `project_bind_here:*` and `project_create_new:*` button customIds
  3. **Discord slash commands never registered** — `start()` now calls `registerCommands()` (wrapped in try/catch so it's non-fatal in test/offline environments)
  4. **`/settings backend` change had no effect** — both adapters wrote to a dead `settings` table key instead of updating `projects.backend_name`; added `store.updateProjectBackend()` and updated both adapters to use it
- Fixed 1 medium-severity bug:
  5. **`sendWithTimeout` orphaned child processes** — timer now cleared on normal completion; `backend.stop()` called on timeout and in both `send()`/`respond()` catch blocks; active backend tracking cleaned up after successful oneshot completion
- Extracted duplicated code:
  6. **`splitText()` duplicated in slack.ts and discord.ts** — extracted to new `src/utils.ts`, both adapters import from shared module and re-export for backward compatibility
- Updated 2 test files to match new behavior (settings tests check `project.backend_name` instead of dead settings key)
- 374 tests still passing across 14 test files after all changes

### Session 12 — Phase 9: Production-Readiness Fixes
- Implemented 6 targeted fixes from a second code review:
  1. **P9.1: /project stores name as project_dir** — both adapters now require absolute paths, use `path.basename()` for channel names, validate with `path.isAbsolute()`
  2. **P9.2: .env parser quote stripping** — `loadEnvFile()` now strips surrounding single/double quotes from values
  3. **P9.3: Backend child processes unkillable on timeout** — `spawnCollect()` returns `SpawnHandle` with `.result` and `.kill()`, backends track active handles, `stop()` kills child process
  4. **P9.4: (backend as any).sessionId type bypass** — added `setSessionId()` to Backend interface, router uses it instead of type-unsafe property access
  5. **P9.5: Discord button handler drops chained permission_denied** — button handler now delegates to `renderEvents()` instead of inline event loop
  6. **P9.6: False positive shutdown test** — restructured test with deferred send pattern, assertion changed from `>= 0` to `> 0`
- 382 tests passing across 14 test files
- All 6 features (P9.1–P9.6) committed individually, all marked passing
- Total: 82 features across 9 phases (P0–P7, P9), all passing

### Session 13 — UX Overhaul, Smart Start Menu, /project new

Major UX improvements across the CLI onboarding, slash commands, and ongoing configuration.

**Slash command UX (commit 4f66a57):**
- Refactored `/project` into explicit subcommands: `connect`, `list`, `disconnect`
- Added project picker buttons (Slack Block Kit, Discord ButtonBuilder) when projects root is set and no path given
- Added `/settings` hints showing current values and usage examples
- Ported all subcommand improvements to Discord (native slash command subcommands via SlashCommandBuilder)
- Switched CLI prompts from raw readline to `@clack/prompts` (note, spinner, select, confirm, text)
- Fixed Slack button handler for project picker (project_pick_ action pattern)
- Added message subtype filtering (skip bot_message, message_changed, etc.)
- Handle Slack `name_taken` error when creating channels

**Onboarding wizard improvements (commit c04327a):**
- Inline setup instructions during onboarding — step-by-step Slack/Discord app creation shown in terminal
- Split Slack flow: show setup → enter tokens → verify with spinner → show invite instructions
- Token verification via `verifySlackToken()` (Slack auth.test API) and `verifyDiscordToken()` (Discord /users/@me)
- Token verification blocks on failure with retry prompt — loops until success or user skips
- Discord invite URL auto-generated from bot token using `extractDiscordAppId()` (base64 decode)
- Removed standalone `init` CLI command — `start` auto-runs init on first use
- Removed `createFirstProject()` step (was creating useless pending entries)
- Added `mergeEnvFile()` — reads existing .env.local, merges new tokens, writes back (preserves existing tokens when adding a platform)

**Smart start menu (commit c04327a, 40be2c8, 235739a, fe1f1c5):**
- `openbridge start` now shows an interactive menu on subsequent runs (when `.openbridge/` already exists):
  - Start the bridge (default — press Enter)
  - Add a platform (only shows unconfigured platforms)
  - Update tokens (re-enter + re-verify for configured platforms)
  - Change default backend (claude/codex auto-detected)
  - Re-run full setup (with confirmation prompt, defaults to No, warns about data loss)
  - Exit
- TTY detection: non-interactive environments (piped, background) skip the menu and start directly
- Next-steps guidance shown after bridge starts ("Ready on Slack! Use /project new or /project connect...")

**`/project new` command (commit b5d9deb):**
- `/project new my-app` — creates `{projects_root}/my-app/` directory and binds the channel
- `/project new /absolute/path` — creates directory at absolute path and binds the channel
- Errors: directory already exists (suggests `/project connect`), no projects root set (suggests setting one or using absolute path), directory creation failure
- Both Slack and Discord supported, with proper help text in all error/help messages
- Discord: registered as native subcommand with required `name` string option

**New files:**
- `slack-manifest.json` — Slack app manifest for one-click app creation (Socket Mode, 12 scopes, 3 slash commands, always_online: true)
- `QUICKSTART.md` — simplified setup: just `npx openbridge start` + what the wizard does
- `.env.example` — rewritten as reference doc (explains .env.local is auto-generated)

**Updated docs:**
- `SLASH-COMMANDS.md` — added `/project new` rows with Slack/Discord syntax
- Help text in both adapters updated to include `/project new` in command listings

**Test count:** 385 tests passing across 14 test files
- Added 4 mergeEnvFile tests, 3 extractDiscordAppId tests
- Updated cli.test.ts (removed init command tests)
- Updated cli-init.test.ts (removed createFirstProject, added Discord App ID extraction)

### Session 14 — Phase 10: Wire MCP Server to Runtime

Implemented all 10 features to connect the MCP server to the runtime so backends can invoke MCP tools and results flow back through adapters.

**Architecture:**
```
Bridge Process
  ├── IPC Server (localhost:<random-port>)
  │     POST /upload-file, /open-tunnel, /serve-file-browser, /post-message
  ├── Router → backend.start({ projectDir, mcpConfig })
  └── Adapters (Slack/Discord) ← called by IPC handler

Backend Process (Claude Code / Codex)
  └── MCP Server (src/mcp/entry.ts, stdio transport)
        └── On tool call → HTTP POST to localhost:<port>
```

**New files:**
- `src/mcp/ipc-server.ts` — localhost HTTP server on random port with UUID auth, 4 POST routes
- `src/mcp/entry.ts` — MCP entry script spawned by backends, creates fetch-based BridgeCallbacks
- `src/mcp/tunnel.ts` — tunnel manager (cloudflared preferred, ngrok fallback), TTL enforcement
- `src/mcp/file-browser.ts` — minimal file browser HTTP server with directory listing and file serving
- `src/mcp/callbacks.ts` — callback handler glue layer routing IPC to adapters/tunnels/file-browser
- `src/__tests__/ipc-server.test.ts` (12 tests)
- `src/__tests__/mcp-entry.test.ts` (6 tests)
- `src/__tests__/tunnel.test.ts` (7 tests)
- `src/__tests__/file-browser.test.ts` (10 tests)
- `src/__tests__/callbacks.test.ts` (5 tests)
- `src/__tests__/mcp-integration.test.ts` (7 tests)

**Modified files:**
- `src/store.ts` — added `platform` column to projects, updated `createProject()` signature
- `src/adapters/slack.ts` — passes 'slack' platform, added `uploadFile()` and `sendMessage()` methods
- `src/adapters/discord.ts` — passes 'discord' platform, added `uploadFile()` and `sendMessage()` methods
- `src/types/adapter.ts` — added `uploadFile()` and `sendMessage()` to Adapter interface
- `src/router.ts` — added `McpConfigFactory`, `McpConfigContext` types, passes mcpConfig to backend.start()
- `src/mcp/server.ts` — updated `getMcpConfig()` with --platform arg and IPC env vars, typed return as `McpServerEntry`
- `src/cli/start.ts` — starts IPC server, creates mcpConfigFactory, registers adapters with callback handler, shutdown cleanup

**Test count:** 442 tests passing across 20 test files
- All 10 features (P10.1–P10.10) committed individually, all marked passing
- Total: 92 features across 10 phases (P0–P7, P9, P10), all passing


### Session 15 — Manual Test Bug Fixes (12 issues)

Fixed 11 of 12 bugs found during comprehensive manual testing:

**Permission flow (Issues #4, #6, #11):**
- Allow button now actually grants permission — passes `--allowedTools <toolName>` to Claude Code CLI on resume
- Added `setAllowedTools()` to Backend interface, implemented in ClaudeBackend (passes `--allowedTools` flag)
- Router.respond() accepts optional allowedTools parameter
- Button values/customIds now carry tool name for extraction on click
- Deduplicated consecutive identical permission_denied events in renderEvents

**Message handling (Issues #5, #7):**
- Fixed Slack file+text messages silently dropped — allow `file_share` subtype through message filter
- Added "Processing..." indicator for follow-up messages in threads (both adapters), deleted after response

**UX messaging (Issues #1, #2):**
- Replaced all user-facing "bind/binding/bound/unbind" with "connect/connected/disconnect" across both adapters, router, CLI, and tests
- "Project Bindings:" → "Connected Projects:", "not bound to a project" → "not connected to a project"
- Friendlier empty state: "No projects connected to any channels yet"
- Fixed `/settings` hint: "Use `/project connect` first" (was referencing `/project <name>`)

**Onboarding (Issues #8, #9):**
- Token input now trimmed — `promptText()` trims whitespace before validation and return
- Discord "disallowed intents" error now shows specific fix instructions (enable Message Content Intent)

**Polish (Issues #10, #12):**
- Project picker shows "Showing 20 of N projects" note when there are >20 projects
- Removed artificial 5-minute backend timeout (set DEFAULT_TIMEOUT_MS to 0 = disabled)

**Issue #3 (MCP file browser) — investigated, not a code bug:**
- Architecture is sound: tool registration, config injection, IPC routing all correct
- Likely a runtime/configuration issue requiring live debugging to identify exact failure point

**Paginated project picker (commit c8e4737):**
- Added "Show more" button with offset-based pagination to both Slack and Discord project pickers
- Configurable `PICKER_PAGE_SIZE` constant (default 15, capped at 20 per platform limits)

### Session 16 — Fix Allow Button (Critical Bug)

**Root cause found and fixed:** Commander.js variadic option `--allowedTools <tools...>` was greedily consuming the prompt text. When building args like `--allowedTools Bash yes`, commander parsed `allowedTools: ['Bash', 'yes']` with `prompt: undefined`. This left Claude Code with no prompt, causing it to hang forever.

**Fix:** Added `--` separator before the prompt text in `buildClaudeArgs()` to terminate option parsing. Now args like `--allowedTools Bash -- yes` correctly parse as `allowedTools: ['Bash']` and `prompt: 'yes'`.

**Files changed:**
- `src/backends/claude.ts` — `args.push(text)` → `args.push('--', text)`
- `src/__tests__/claude.test.ts` — added 4 tests for allowedTools arg building

**Test count:** 446 tests passing across 20 test files

### Session 17 — Phase 11: Real-Time Permission Handling via Claude Code Hooks

Implemented Claude Code hooks for real-time permission prompts, replacing the broken retry-and-fail pattern in `-p` mode. Previously, Claude Code auto-denied tools 12+ times before exiting. Now, permission requests show Allow/Deny buttons in Slack/Discord immediately, and Claude continues without restarting.

**Architecture:**
```
Claude Code (-p mode) → PreToolUse hook → auto-approve MCP tools
                      → PermissionRequest hook → POST /permission-request to IPC server
                                               → adapter shows Allow/Deny buttons
                                               → user clicks → resolvePermission() in-process
                                               → hook returns allow/deny → Claude continues
```

**New files:**
- `src/hooks/pre-tool-use.ts` — auto-approves `mcp__openbridge__*` tools, defers others
- `src/hooks/permission-request.ts` — blocking hook: sends permission prompt via IPC, polls for user response (5-min timeout)
- `src/__tests__/hooks-pre-tool-use.test.ts` (5 tests)
- `src/__tests__/hooks-permission-request.test.ts` (4 tests)

**Modified files:**
- `src/backends/claude.ts` — `MCP_TOOLS` constant for pre-approval, `buildHookSettings()` generates `--settings` JSON, `buildClaudeArgs()` accepts settingsJson param, `ClaudeBackend` stores IPC/context from `start()` and passes env vars + settings to `spawnCollect()`
- `src/types/backend.ts` — `BackendOptions` extended with `ipc`, `channelId`, `threadId`, `platform`, `hookScriptDir`
- `src/router.ts` — `RouterOptions` accepts `ipc` and `hookScriptDir`, passes all fields to `backend.start()`
- `src/mcp/ipc-server.ts` — added `/permission-request`, `/permission-poll`, `/permission-resolve` endpoints, `resolvePermission()` export, stale entry cleanup
- `src/mcp/callbacks.ts` — added `requestPermission()` handler routing to adapters
- `src/types/adapter.ts` — `postPermissionPrompt()` event param now includes optional `requestId`
- `src/adapters/slack.ts` — embeds `requestId` in button values (`toolName|requestId`), resolves in-process when present, falls back to legacy `router.respond()` flow
- `src/adapters/discord.ts` — same pattern with customId format
- `src/cli/start.ts` — passes `ipc` and `hookScriptDir` to Router options

**Test count:** 481 tests passing across 22 test files
- All 9 features (P11.1–P11.9) committed individually, all marked passing

### Session 18 — Phase 12: Permission Modes, Image Support, Sandbox Upgrades

Implemented 11 features for comprehensive permission control and image passthrough:

**Schema & permission modes (P12.1–P12.4):**
- Schema migration v3: added `permission_mode` and `sandbox_mode` columns to projects table
- `/project connect` now prompts for permission mode (supervised/trusted) during setup
- Claude backend: trusted mode passes `--dangerously-skip-permissions`, skips hooks entirely
- Codex backend: trusted mode uses `danger-full-access` sandbox level

**Permission UX (P12.5–P12.7):**
- "Always Allow" button added alongside Allow/Deny for permission prompts (both adapters)
- Accumulated `allowed_tools` stored per-project in SQLite, loaded on every backend spawn
- Codex sandbox upgrade flow: when sandbox error detected, shows "Upgrade Sandbox" button

**Image passthrough (P12.8–P12.11):**
- `spawnCollect()` accepts optional `stdinData` parameter for piping data to child process
- Claude backend: `--input-format stream-json` with Anthropic API content blocks for images
- Codex backend: `--image <FILE>` flag with temp file lifecycle (create before spawn, cleanup after)
- Both adapters: download image attachments, convert to base64, pass as `ImageAttachment[]` through router
- Shared utilities in `utils.ts`: `isImageMimeType()`, `downloadToBase64()`

**New types:**
- `ImageAttachment { base64: string; mediaType: string }` in `backend.ts`
- `Backend.send()` extended: `send(text: string, images?: ImageAttachment[])`

**Test count:** 540 tests passing across 22 test files
- All 11 features (P12.1–P12.11) committed individually, all marked passing
- Total: 103 features across 12 phases (P0–P7, P9–P12), all passing

### Session 19 — Phase 13: Image Upload Staging & save_uploaded_file MCP Tool

Implemented 8 features enabling models to save uploaded images to the project directory via an MCP tool.

**Problem:** When users upload images to Slack/Discord saying "save this as the logo", models could see the image but had no way to write the raw bytes to disk. Codex's sandbox further restricts file access outside the project directory.

**Solution:** Save uploaded images to a staging directory (`~/.openbridge-ai/uploads/`), pass upload metadata in the prompt text, and provide a `save_uploaded_file` MCP tool that copies from staging to the project directory. The MCP tool runs in the bridge process (unsandboxed), so it works even with Codex's sandbox.

**Features:**
- P13.1: Staging directory utilities — `getUploadsDir()`, `saveToStagingDir()`, `cleanupStagingFiles()` in utils.ts
- P13.2: Extended `ImageAttachment` with optional `uploadId`, `filename`, `stagingPath` fields
- P13.3: Both adapters call `saveToStagingDir()` after downloading images, populating upload metadata
- P13.4: Router augments prompt text with `[Uploaded image: ... (upload_id: ...)]` and cleans up staging after each turn
- P13.5: Codex backend reuses staging file paths for `--image` instead of creating temp copies
- P13.6: Added `/save-uploaded-file` IPC endpoint with `saveUploadedFile?` on IpcHandler
- P13.7: Implemented `saveUploadedFile()` in callbacks — scans uploads dir, validates path within project, copies file
- P13.8: Registered `save_uploaded_file` MCP tool, wired through entry.ts, added to MCP_TOOLS for auto-approval

**Key design decisions:**
- Copy, not move — model can save same image to multiple destinations
- Router owns cleanup — staging files deleted after every backend turn (success or error)
- Auto-approved — user explicitly uploaded the file, saving it is expected
- Backward compatible — all new ImageAttachment fields are optional

**Test count:** 568 tests passing across 22 test files
- All 8 features (P13.1–P13.8) committed individually, all marked passing
- Total: 111 features across 13 phases (P0–P7, P9–P13), all passing

### Session 20 — Phase 14: Universal File Upload Support

Extended file upload handling from images-only to all file types (PDFs, text, CSV, binary, etc.).

**Problem:** Non-image file uploads (PDFs, text files, CSVs, ZIPs) were only described as text labels — they were never downloaded, staged, or passed to the AI. Users expected to upload any file and either ask questions about it or save it to the project.

**Solution:** Four-kind file classification system with DRY utilities shared across both adapters.

**Features:**
- P14.1: Renamed `ImageAttachment` → `FileAttachment`, added `kind: FileKind` field (`'image' | 'pdf' | 'text' | 'binary'`), added `classifyMimeType()` and `downloadAndStageFile()` utilities, renamed all references across codebase
- P14.2: Both adapters now download ALL file types using `downloadAndStageFile()` (DRY). Text file contents are included inline in the prompt as markdown code blocks.
- P14.3: Claude backend `buildStreamJsonInput()` now handles file kinds: images → `type: 'image'`, PDFs → `type: 'document'`, text/binary → no content block. `useStreamJson` only activates for images or PDFs.
- P14.4: Codex backend filters to `kind === 'image'` only for `--image` flags (Codex CLI has no PDF/document support).

**Key utilities added to `src/utils.ts`:**
- `classifyMimeType(mimeType, filename?)` — classifies into FileKind using MIME type + extension fallback
- `downloadAndStageFile(url, filename, mimeType, authHeaders?)` — download + classify + stage in one call
- `TEXT_EXTENSIONS` set — 30+ extensions (.json, .csv, .md, .ts, .py, etc.)
- `TEXT_APP_MIME_TYPES` set — application/* types that are actually text (json, xml, javascript, etc.)

**File kind behavior at each layer:**
| Kind   | Adapter                    | Claude Backend        | Codex Backend     |
|--------|----------------------------|-----------------------|-------------------|
| image  | download + stage           | type:image block      | --image flag      |
| pdf    | download + stage           | type:document block   | staging only      |
| text   | download + stage + inline  | no content block      | staging only      |
| binary | download + stage           | no content block      | staging only      |

**Test count:** 588 tests passing across 22 test files
- All 4 features (P14.1–P14.4) committed individually, all marked passing
- Total: 115 features across 14 phases (P0–P7, P9–P14), all passing

### Session 21 — Phase 15 & 16: Hook Bugfix, post_message MCP Tool, Output Cleanup

**Phase 15: Hook output bugfix (P15.1)**
- Fixed missing `hookEventName: 'PreToolUse'` in pre-tool-use.ts `allowOutput()` and `denyOutput()` functions
- Without this field, Claude Code ignored the hook's allow/deny decision → auto-deny in `-p` mode → infinite permission prompt loop
- Updated hook tests to assert hookEventName is present

**Phase 16: post_message MCP tool + output cleanup (P16.1–P16.4)**

Four features addressing two user-facing problems: (1) permission prompts crashing on large Write inputs, (2) Claude dumping verbose internal monologue to the chat thread.

- **P16.1: Permission prompt truncation** — Both adapters truncate `JSON.stringify(toolInput)` to 500 chars in `postPermissionPrompt()`. Prevents Slack's 3000-char block text limit crash when Claude writes large files.
- **P16.2: Register `post_message` MCP tool** — Added `server.registerTool('post_message', ...)` in server.ts. Infrastructure (IPC endpoint, callback handler, adapter.sendMessage) already existed; only the MCP tool registration was missing.
- **P16.3: Remove hardcoded postMessage** — Removed `callbacks.postMessage()` calls from `open_tunnel` and `serve_file_browser` handlers. Claude now calls `post_message` explicitly to share URLs. Updated tool descriptions accordingly.
- **P16.4: Track post_message per turn, suppress assistant_text** — Module-level `Set<string>` in callbacks.ts tracks threads where `post_message` was called. Both adapters clear flag before `router.send()`/`respond()`, check after. If post_message was used → suppress all assistant_text. If not → render only last assistant_text block.

**Modified files:**
- `src/hooks/pre-tool-use.ts` — added hookEventName field
- `src/mcp/server.ts` — registered post_message tool, removed hardcoded postMessage from open_tunnel/serve_file_browser
- `src/mcp/callbacks.ts` — added clearPostMessageFlag(), wasPostMessageCalled(), markPostMessageCalled()
- `src/adapters/slack.ts` — truncation in postPermissionPrompt, clearPostMessageFlag before routing, assistant_text suppression in renderEvents
- `src/adapters/discord.ts` — same changes as slack.ts
- Test files updated for all features

- **P16.5: Fallback assistant_text truncation** — When the last assistant_text block is rendered as fallback (no post_message used), text >500 chars is truncated from the top, keeping the ending (most useful part) with a "..." prefix. Constant is `MAX_FALLBACK = 500` in each adapter's `renderEvents()`.

**Test count:** 602 tests passing across 23 test files
- All features (P15.1, P16.1–P16.5) committed individually, all marked passing

### Session 22 — Phase 17: Consolidated Preview Server

**Problem:** When Claude wanted to preview a website, it had to: (1) Bash `npx serve -p 3000 &` (backgrounded, can fail silently with EADDRINUSE), (2) call `open_tunnel(3000)`, (3) call `post_message` with URL. Port collisions between different projects caused the second tunnel to serve the first project's content.

**Solution:** New `preview_server` MCP tool that consolidates server startup + port allocation + tunneling into a single call.

- **P17.1: preview-server.ts module** — `findFreePort()` via `net.createServer(0)` for collision-free port allocation. Built-in static file server with MIME types, index.html, directory listing. Command mode spawns arbitrary shell command with `PORT` env var injected. Waits for port to respond before tunneling. `closeAllPreviews()` for shutdown cleanup. 13 unit tests.
- **P17.2: IPC/callback wiring** — Added `previewServer()` to IpcHandler, BridgeCallbacks, `/preview-server` IPC endpoint, entry.ts callback. Updated all test mocks.
- **P17.3: MCP tool registration** — Registered `preview_server` tool with `directory`, `command`, `ttl` inputs. Updated `open_tunnel` description to reference `preview_server` for new servers. 6 new tests.
- **P17.4: Pre-approval + shutdown** — Added `mcp__openbridge__preview_server` to MCP_TOOLS. Added `closeAllPreviews()` to shutdown in start.ts. Hook auto-approves via `mcp__openbridge__` prefix.

**Key design:**
- Static mode: `preview_server({ directory: "./dist" })` — bridge starts built-in HTTP server
- Command mode: `preview_server({ command: "npm run dev" })` — bridge spawns command with `PORT` env var
- OS picks free port → no collisions possible
- Bridge monitors process → no silent failures
- One tool call instead of three

**Test count:** 621 tests passing across 24 test files
- All features (P17.1–P17.4) committed individually, all marked passing
