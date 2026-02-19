# OpenBridge Progress

## Current Status
Phase 0 — Project Setup (not started)

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
