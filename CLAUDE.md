# OpenBridge — Project Instructions

## Architecture

For system design, components, and scope, see: `ARCHITECTURE.md`

This document is the source of truth for what we're building. The feature list (`feature-list.json`) is derived from it.

Prototype findings that informed the architecture: `prototype/FINDINGS.md`

## Documentation Lookup

Use the **Context7 MCP** to look up current library documentation before implementing code with external libraries. Don't rely on training data for API details — library APIs, method signatures, and parameters change frequently.

**When to use Context7:**
- Before using `@slack/bolt` or `@slack/web-api`
- Before using `discord.js`
- Before using `better-sqlite3`
- Before using `@modelcontextprotocol/sdk`
- Before using any npm package you haven't used recently
- When error messages suggest API has changed

## Tech Stack

- **Language:** TypeScript (strict mode, ES2022 target)
- **Runtime:** Node.js >= 18
- **Test framework:** vitest
- **Persistence:** SQLite via `better-sqlite3` (WAL mode)
- **Slack SDK:** `@slack/bolt` (Socket Mode)
- **Discord SDK:** `discord.js`
- **MCP SDK:** `@modelcontextprotocol/sdk`
- **Build:** tsc → dist/

## Secrets Setup

Run `openbridge start` — the setup wizard handles token input and verification.

All config is stored in `~/.openbridge-ai/`:
- `~/.openbridge-ai/bridge.db` — SQLite database (settings, projects, sessions)
- `~/.openbridge-ai/.env.local` — platform tokens

**Required tokens:**

**Slack (Socket Mode):**
- `SLACK_BOT_TOKEN` — Bot User OAuth Token (xoxb-...)
- `SLACK_APP_TOKEN` — App-Level Token for Socket Mode (xapp-...)

**Discord:**
- `DISCORD_BOT_TOKEN` — Bot token from Discord Developer Portal

## Project Structure

```
src/
  index.ts              — main entry point
  cli.ts                — openbridge CLI (init, start)
  router.ts             — channel/thread → project/session routing
  store.ts              — SQLite persistence layer
  types/
    events.ts           — normalized event type interfaces
    backend.ts          — backend interface
    adapter.ts          — messaging adapter interface
  backends/
    claude.ts           — Claude Code backend wrapper
    codex.ts            — Codex CLI backend wrapper
  adapters/
    slack.ts            — Slack Socket Mode adapter
    discord.ts          — Discord bot gateway adapter
  mcp/
    server.ts           — Bridge MCP server
scripts/
  init.sh               — environment check, start, stop
  build.sh              — TypeScript compilation
  test.sh               — test runner
```

### CRITICAL: Commit After EVERY SINGLE Feature — Not at the End of a Phase

**This is the most important rule in this project. Violating it is a blocking failure.**

Each feature (e.g., P1.1, P1.2, P1.3) gets its own individual git commit. You must commit IMMEDIATELY after completing each feature — not after finishing a group of features, not at the end of a phase, not when you feel like it. ONE feature = ONE commit. No exceptions.

**The workflow for EVERY feature is:**
1. Implement the feature
2. Verify it works (run ALL verification steps)
3. Update feature-list.json to mark that feature as passing
4. `git add` the specific files you changed
5. `git commit` with a message referencing the feature ID (e.g., "P1.3: Claude Code backend — parse assistant text")
6. **ONLY THEN** move to the next feature

**Do NOT do this:**
- Implement P1.1, P1.2, P1.3, then commit them all together — WRONG
- Finish an entire phase, then make one big commit — WRONG
- "I'll commit at the end" — WRONG

**Do this:**
- Implement P1.1 → verify → update feature-list → commit
- Implement P1.2 → verify → update feature-list → commit
- Implement P1.3 → verify → update feature-list → commit

**Only commit files YOU created or modified:**
- Use `git add <specific-files>` — NOT `git add .` or `git add -A`
- Check `git status` first
- Only stage files you directly worked on

### Starting a Session
1. Read `claude-progress.md` to understand current state
2. Read `feature-list.json` to see what's done/pending
3. Check recent git history: `git log -n 10 --oneline`
4. Run init script to verify environment: `./scripts/init.sh check`
5. Run existing tests as sanity check: `./scripts/test.sh` — if tests fail, investigate before proceeding

### During a Session
- Work on ONE feature at a time
- Run tests after implementing each feature
- Update feature-list.json when a feature passes/fails
- **Commit immediately after each feature passes** — do not continue to the next feature without committing first
- Never move to the next feature until the current one passes all verification steps AND is committed

### Ending a Session
- Commit all work in progress
- Update `claude-progress.md` with what was accomplished and current state
- Do NOT add "next steps" — the feature list handles that

### Development Feedback Loop

After writing or changing code:

1. **Build**: `./scripts/build.sh`
2. **Test**: `./scripts/test.sh`
3. **Check Output**: Look at logs, errors, behavior
4. **Understand**: Did it work? Why or why not?
5. **Fix & Repeat**: If broken, fix and go back to step 1

Never assume code works because it compiled — always verify.

### Logging in Code

Add logging at key points so there's something to check:
- Important events (connection established, message received, backend spawned)
- State changes (session state transitions)
- Errors with context (which backend, which session, what failed)

Use consistent prefixes: `[slack]`, `[discord]`, `[router]`, `[claude]`, `[codex]`, `[store]`, `[mcp]`

### Requesting Manual Testing

If you need the user to test something, present it as a brief table:

| Action | Expected Outcome |
|--------|------------------|
| Do X | Y happens |
| Do A | B appears |

Keep it succinct. Don't leave things running without explicitly requesting testing.

### Rules

1. **One feature at a time** — Complete fully (including tests) before moving to next
2. **Never remove or weaken tests** — If a test is failing, fix the code, not the test
3. **Never remove or weaken verification steps** — They exist for a reason
4. **Always verify before marking passing** — Run through ALL verification steps
5. **Commit after EACH feature, not at the end of a phase** — Every feature ID gets its own commit. This is non-negotiable.
6. **Update progress file** — Document what you did for the next session
7. **Follow the architecture** — Don't deviate without discussion
8. **Ask when unclear** — Don't make assumptions
9. **Use Context7 for library docs** — Don't guess at API shapes
10. **Reuse prototype learnings** — The parsers in `prototype/io-harness/run.js` are reference implementations for Claude and Codex output parsing
