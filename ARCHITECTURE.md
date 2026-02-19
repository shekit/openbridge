# OpenBridge

A remote control for coding agents. Operate Claude Code or Codex CLI from your phone through Slack or Discord — with each chat channel mapped to a separate project.

## What This Is

A lightweight bridge between messaging platforms and CLI-based coding tools. It doesn't replace these tools or build its own agent — it connects you to agents that already exist, letting you control them conversationally from anywhere. No LLM in the middle. Messages go straight from chat to the coding agent's stdin.

**This is not a general-purpose AI assistant.** It does one thing: lets developers text their coding agents from their phone.

## Architecture

```
Messaging Adapters (Slack, Discord)
        ↓
   Router (chat/channel ID → project config)
        ↓
   Coding Backends (Claude Code, Codex CLI)
        ↑
   Bridge MCP Server (upload_file, open_tunnel, etc.)
```

**Messaging adapters** handle platform-specific concerns: listening for messages, posting responses, creating channels. Each adapter implements a small shared interface. V1 ships Slack (Socket Mode) and Discord (bot gateway).

**The router** maps a chat/channel ID to a project directory and coding backend. Mappings are stored in SQLite on disk and managed through chat commands.

**Coding backends** are thin wrappers around existing CLI tools. They receive a text prompt and a project directory, shell out to the appropriate CLI, and return the output. They are not LLM integrations — they delegate to tools that already handle that. V1 ships Claude Code and Codex CLI.

**Bridge MCP server** — the bridge exposes itself as an MCP server to the coding agents. When the bridge spawns a backend session, it passes MCP config pointing back to itself. The agent gets tools like `upload_file` and `open_tunnel` alongside its native tools — no special setup per project. This lets the coding agent trigger platform-specific actions (uploading a file as a chat attachment, starting a tunnel and posting the URL) without knowing anything about Slack or Discord. Both Claude Code and Codex CLI support MCP natively.

## Key Workflows

### Project Creation from Chat
One command: `/project my-app`. The bridge handles it deterministically — no LLM involved.

- **Channel already bound to a project** → creates a new `#my-app` channel and binds it. No question needed.
- **Channel is unbound** → bridge presents two buttons: "Use this channel" / "Create #my-app". User picks.
- **No args** (`/project`) → lists all bindings (channel → directory → backend) and unbound project directories. User picks one to link.

### Conversational Coding
User sends a message in a project channel → router identifies the project → message is passed to the configured coding backend → response is posted back. Each channel is an isolated conversation with a specific project.

Within a project channel, **threads serve as separate sessions**. Starting a new thread starts a new agent session against the same project. This allows parallel work — "fix the auth bug" in one thread, "add dark mode" in another — without interleaving. Messages sent directly in the channel (not in a thread) are automatically moved into a new thread by the bot — every interaction becomes a thread. The channel stays clean as a project home; threads are the work sessions. `/new` is still available to reset within a thread.

### File Uploads to the Agent
User sends a file attachment in a project channel (screenshot, design mockup, error log, code file) → bridge downloads it from the messaging platform → saves it to the project directory or a temp location → passes it to the coding backend with context.

### Interactive Prompts
CLI coding tools have interactive moments — permission requests, multiple choice options, confirmation dialogs. The bridge detects when a backend is waiting for user input, translates the prompt into platform-native interactive elements (Slack Block Kit buttons, Discord message components), and sends the user's selection back to the CLI. The bridge tracks when the backend is waiting for input so that the next user interaction — button tap or typed message — is routed back to the pending prompt rather than treated as a new conversational message.

**Permission prompt UX:** When the backend reports a permission denial (e.g., "Edit file foo.js"), the bridge posts a message with buttons matching the available options (Allow, Deny, etc.) plus a line like "or type a custom response." If the user taps a button, the bridge sends the corresponding selection. If the user types a message instead, the bridge sends that text as the freeform response. Both Slack and Discord support buttons natively in messages; freeform text is just the next message in the thread — no modals needed.

### Error Handling
Backend crashes, timeouts, missing CLI tools, auth failures — all reported back to the user in chat with a clear explanation and suggested fix. The bridge never silently fails. If the coding backend process dies mid-task, the bridge catches it and posts what happened.

### Preview Tunnels
User asks the coding agent to show what was built → agent starts a dev server → calls the bridge's `open_tunnel` MCP tool → bridge spins up a tunnel (Cloudflare Tunnel or ngrok) and posts the public URL in the channel. The agent handles the dev server, the bridge handles the tunnel and posting.

### File Viewing
User asks to see a file → agent calls the bridge's `upload_file` MCP tool with the file path → bridge uploads it as a native chat attachment. For full project structure, agent calls `serve_file_browser` → bridge serves a lightweight file browser behind a tunnel and posts the URL. The agent decides what to show, the bridge handles platform-specific presentation.

## Bridge Commands

Three commands. Everything else goes to the coding agent as natural language.

- `/project [name]` — with a name, starts project creation flow (see above). With no args, lists all bindings and lets user link one.
- `/new` — end current backend session and start fresh within the current thread. Starting a new thread also creates a new session automatically.
- `/settings` — manage bridge configuration (backend selection, per-project overrides) from chat.

Commands are registered natively on each platform (Slack app manifest, Discord slash commands) so they show up with autocomplete.

## Design Principles

**Opinionated defaults, optional overrides.** Works out of the box with zero config. Default backend auto-detected. Customizable later, from chat.

**Everything controllable from chat.** Project creation, settings, backend switching — all through the messaging interface. If it requires SSH after initial setup, it's a bug.

**Platform-agnostic core.** The router and backend logic know nothing about Slack or Discord. Adapters are plugins. Adding a new messaging platform means implementing a small interface, nothing more.

**Each user runs their own instance.** No central server. The bot runs on the user's machine (laptop or VPS) and connects outward to messaging platforms via Socket Mode or long polling. No public URLs required.

## Messaging Platform Notes

- **Slack** — Socket Mode, no inbound networking needed. Channel model maps naturally to projects, threads map to sessions. Bot setup via app manifest.
- **Discord** — Bot gateway connection. Same channel/thread model. Single bot token.

## Auth Modes for Coding Backends

- **Subscription mode** — bot shells out to the CLI using whatever auth is configured on the machine (e.g., Claude Code Max subscription, Codex CLI with ChatGPT subscription). Simple, no key management.
- **API key mode** — bot passes an API key to the CLI or calls the API directly. No usage caps, pay per token.

Users choose per-project or globally.

## Setup Experience

```
npm install -g openbridge
openbridge init
```

The wizard asks: which platform, paste your token (with a manifest/link to make app creation trivial), which coding backend. First project created automatically. Under five minutes from install to first message.

## Implementation Notes

**CLI subprocess model (validated by prototype):** Both CLIs use oneshot mode — each message spawns a new CLI process, collects structured JSON output, and exits. Session continuity is maintained via resume flags:

- **Claude Code:** `claude -p --verbose --output-format stream-json --input-format text "prompt"` for first message, add `-r SESSION_ID` for follow-ups. Output is structured JSONL on stdout.
- **Codex CLI:** `codex exec --skip-git-repo-check --json "prompt"` for first message, `codex exec resume --skip-git-repo-check --json SESSION_ID "follow-up"` for follow-ups.

Persistent processes (PTY mode) do not work — both CLIs are TUI applications whose output is garbled with ANSI rendering artifacts when spawned in a pseudo-terminal. Oneshot JSON mode gives clean structured output with zero parsing ambiguity.

**Thread-to-session lifecycle:** A thread maps to a session ID stored in SQLite. Each message in the thread spawns a new CLI process that resumes the session by ID. If the session ID is missing or invalid, a fresh session starts automatically. Claude Code and Codex CLI both maintain their own session history internally — the bridge only needs to store and pass the ID.

**Permission detection (validated by prototype):** Both backends report permission denials deterministically in their JSON output — no heuristic prompt detection needed:

- **Claude Code:** The `result` event includes a `permission_denials` array with `tool_name`, `tool_use_id`, and `tool_input` for each denied tool call. Additionally, `user` events with `is_error: true` contain context text about what was denied and why. 100% deterministic.
- **Codex CLI:** Uses OS-level sandboxing (`--sandbox workspace-write`). When the sandbox blocks a command, the model reports the OS error ("Operation not permitted") as text. Detection is pattern-based but the OS errors are deterministic. Note: `--sandbox` flag is only accepted on the initial invocation, not on resume — the sandbox setting persists automatically.

**On-disk state:** All bridge state lives in a SQLite database (single file in `.openbridge/`). Channel-to-project mappings, per-project backend config, session IDs for resume, settings — all written as they change. No external database, no state server. SQLite gives atomic writes, indexed lookups by channel/session, and built-in corruption resistance (WAL mode) — without adding infrastructure. One npm dependency (`better-sqlite3`). When the bridge restarts, it reads the database and resumes. The bridge is a single long-running process that holds messaging connections and backend subprocesses; the SQLite file is the only persistence layer.

**Bridge MCP server:** The bridge runs an MCP server (stdio transport) and injects its config when spawning each backend session. Initial tools: `upload_file` (uploads a file as a chat attachment), `open_tunnel` (starts a tunnel on a given port and posts the URL), `serve_file_browser` (serves a file browser behind a tunnel). Both Claude Code and Codex CLI support MCP natively via their config files. The agent doesn't need to know about the bridge — it just sees tools.

## V1 Guardrails (Brief)

Keep these as lightweight constraints, not hard implementation dictates.

- **Session states:** model a thread session with a small state machine (`running`, `waiting_for_input`, `idle`, `dead`) so routing decisions are deterministic.
- **Event hygiene:** normalize incoming platform events and dedupe by platform event ID to avoid duplicate sends/replies.
- **Adapter contract:** adapters translate platform-specific payloads into one shared event shape; core/router never consume raw Slack/Discord payloads.
- **Backend contract:** each backend wrapper should expose the same minimal lifecycle (`start`, `send`, `send_input`, `stop`) and emit normalized output events.
- **Safety defaults for MCP tools:** default file access to project directory, add explicit confirmation for out-of-project paths, and enforce tunnel TTL + explicit close.
- **Persistence robustness:** SQLite with WAL mode for all bridge state. Schema migrations via a version table so upgrades are safe.

## Prototype (Done)

The I/O prototype validated subprocess communication, permission detection, and session resume for both backends. Key outcomes:

- **Oneshot + resume** is the correct subprocess model (PTY mode does not work with TUI CLIs)
- **Permission denials** are deterministic and structured for both backends
- **Session resume** works reliably via session/thread IDs
- **No deadlocks, no lost output, no parsing ambiguity** with JSON output mode

Full findings: `prototype/FINDINGS.md`. Test harness: `prototype/io-harness/`.

## Future

Features and extensions beyond V1.

- **Voice notes** — user sends a voice note → bot transcribes using the project's file tree as context (so function names and file paths transcribe accurately) → posts transcription as a quote → passes to backend.
- **Long-running task feedback** — immediate acknowledgment for slow requests, streaming or periodic progress updates, edit-in-place rather than message spam.
- **Session summary handoff** — when ending a session with `/new`, generate a context summary the next session can pick up.
- **Additional platforms** — Telegram (limited by lack of native threads).
- **Additional backends** — OpenCode, Aider, Gemini CLI.

### Deployment Note: Laptop/VPS Failover

Not an OpenBridge feature, but a deployment pattern worth supporting:

Run OpenBridge on both a laptop and a VPS with identical config. Use [Mutagen](https://mutagen.io/) to keep the project folder (including `.openbridge/`) synced bidirectionally. Both instances try to connect to Slack/Discord, but only one can hold the bot token at a time — both Socket Mode and Discord bot gateway disconnect the previous client when a new one connects.

- **Laptop on** → laptop bridge is active, edits happen locally, Mutagen syncs to VPS
- **Laptop sleeps** → connection drops → VPS bridge picks up automatically
- **Laptop wakes** → Mutagen syncs changes the VPS agent made → laptop bridge reclaims connection

The SQLite database must be part of the sync so whichever instance takes over can resume sessions with the stored session IDs. Note: SQLite WAL mode uses separate `-wal` and `-shm` files that may conflict if both instances write during the brief handover window. If this causes issues, switch to `DELETE` journal mode for the synced database — slightly slower but safe for file sync tools. Optional: a `/handoff` command for clean disconnect instead of waiting for connection timeout.
