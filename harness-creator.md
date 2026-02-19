# Harness Creator Guide

This document describes how to set up a **development harness** for any project that Claude will work on iteratively. The harness provides structure, tracking, and protocols that ensure reliable progress across multiple sessions.

> **Reference:** Many patterns here are derived from [Anthropic's research on effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents).

## Prerequisites

Before creating a harness, you need an **architecture file** that describes what you're building. This document is the source of truth for system design — the feature list is derived from it.

The architecture file should include:
- What the system does (purpose, goals)
- Major components and how they interact
- Technical decisions (languages, frameworks, APIs)
- Scope boundaries (what's in, what's out)
- Phases and milestones

Without an architecture file, you cannot create a meaningful feature list. The harness creation process assumes this document already exists.

## Overview

A harness consists of:
- **Architecture file** — System design document (prerequisite; CLAUDE.md references this)
- **CLAUDE.md** — Project-specific instructions for Claude, including reference to architecture
- **claude-progress.md** — Session history and current state
- **feature-list** — Structured feature tracking (JSON format recommended), derived from the architecture
- **init script** — Environment verification AND dev server control (start/stop)
- **scripts/** — Build/deploy/test scripts with environment setup baked in
- **E2E tests** — Browser-based tests for UI features (Playwright recommended)

## Core Concepts

### Work Hierarchy

Organize work into a hierarchy:

**Phases** → **Features**

- **Phases** are major milestones with a **testable outcome** — something you can verify at the end (e.g., "app launches on device", "user can log in")
- **Features** are atomic units of work within a phase, small enough to complete and commit individually
- Each feature has a **test** — how you verify it works
- Each feature tracks **pass/fail status** (starts as "failing")

The feature list is the **source of truth** for what's done and what's pending. Don't duplicate this information elsewhere.

**Phase 0 — Project Setup:** The first phase should always be project setup (initialize project, configure database, set up testing framework, etc.). This keeps setup tasks in the same tracking system as implementation work.

**Feature Granularity:** Features should be atomic and individually testable. Prefer many small features over few large ones. Granular features (50-200+) prevent agents from "declaring victory early" on incomplete work. If a feature takes more than one session, it's too big — break it down.

### Atomic Commits

One feature = one commit. After completing each feature:
1. Verify it works
2. Mark it as passing in the feature list
3. Commit immediately
4. Move to the next feature

Never batch commits at the end of a phase.

### Environment Independence

Never rely on the user's shell configuration (`~/.zshrc`, `~/.bashrc`). Instead:
- Set environment variables in scripts
- Use project config files where the platform supports it
- Have init scripts verify and set up the environment

### Documentation Lookup

Use the Context7 MCP to look up current library documentation before implementing code with external libraries. Don't rely on training data for API details — models, API shapes, and parameters change frequently.

## Setup Steps

### 1. Create Feature List

Create a file that tracks all work organized by phases and features. Use whatever format suits your project (JSON, YAML, etc.).

Each feature should include:
- Unique identifier (e.g., P1.1, P1.2)
- Description of what it does
- Verification array — list of concrete test steps
- Status — starts as `"failing"`, changes to `"passing"` when ALL verification steps pass

**Example structure (JSON):**
```json
{
  "id": "P1.3",
  "description": "User login endpoint",
  "verification": [
    "POST /api/login with valid credentials returns 200 and token",
    "POST /api/login with invalid credentials returns 401",
    "Token expires after configured timeout"
  ],
  "status": "failing"
}
```

**Rules:**
- Each feature must have concrete, verifiable test steps (not vague descriptions)
- Status starts as `"failing"` — never `"pending"` or `"not started"`. This prevents optimistic completion.
- Only mark `"passing"` when ALL verification steps pass
- This file is the single source of truth for progress
- **Never remove or weaken verification steps** — if a step is failing, fix the code, not the test

### 2. Create Progress Log (`claude-progress.md`)

A simple log of session history:
- Current status (which phase, what state)
- Session entries with what was accomplished
- Any blockers or issues

**Rules:**
- Do NOT add "next steps" — use the feature list for that
- Keep entries concise
- Focus on what was done, not what will be done

### 3. Create Project Instructions (`CLAUDE.md`)

Include these sections (all are required):

#### Architecture Reference

```markdown
## Architecture

For system design, components, and scope, see: `[architecture-file.md]`

This document is the source of truth for what we're building. The feature list is derived from it.
```

Replace `[architecture-file.md]` with the actual path to the project's architecture document. This ensures every Claude session knows where to find the overall design context.

#### Documentation Lookup

```markdown
## Documentation Lookup

Use the **Context7 MCP** to look up current library documentation before implementing code with external libraries. Don't rely on training data for API details — library APIs, method signatures, and parameters change frequently.

**When to use Context7:**
- Before using [list project-specific libraries]
- Before using any npm package you haven't used recently
- When error messages suggest API has changed
```

#### Secrets Setup

```markdown
## Secrets Setup

Copy `.env.example` to `.env.local` and fill in the values:

[List required secrets grouped by functionality]

Never commit `.env.local` — it's gitignored.
```

#### Commit Protocol

```markdown
### CRITICAL: Commit After EVERY Feature

**This is a hard requirement. Do not batch commits.**

After completing each feature:
1. Verify it works
2. Update feature list to mark as passing
3. **Immediately commit**
4. Then move to the next feature

**Only commit files YOU created or modified:**
- Use `git add <specific-files>` — NOT `git add .` or `git add -A`
- Check `git status` first
- Only stage files you directly worked on
```

#### Session Protocol

```markdown
### Starting a Session
1. Read progress log to understand current state
2. Read feature list to see what's done/pending
3. Check recent git history
4. Run init script to verify environment
5. Start the dev server (`./scripts/init.sh start`)
6. Run existing tests as sanity check — if tests fail, investigate before proceeding

### During a Session
- Work on ONE feature at a time
- Update feature list when a feature passes/fails
- For UI features: verify in the browser, not just via API responses

### Ending a Session
- Commit all work in progress
- Update progress log with what was accomplished and current state
- Stop the dev server (`./scripts/init.sh stop`) — free ports for next session
- Do NOT add "next steps" — the feature list handles that
```

#### Development Feedback Loop

```markdown
### Development Feedback Loop

After writing or changing code:

1. **Build**: Run the build
2. **Run/Deploy**: Execute or deploy
3. **Check Output**: Look at logs, errors, behavior
4. **Understand**: Did it work? Why or why not?
5. **Fix & Repeat**: If broken, fix and go back to step 1
6. **Clean Up**: Stop running processes after testing

Never assume code works because it compiled — always verify.
```

#### Logging

```markdown
### Logging in Code

Add logging at key points so there's something to check:
- Important events
- State changes
- Errors with context

Use consistent tags/prefixes so logs are easy to filter.
```

#### Manual Testing

```markdown
### Requesting Manual Testing

If you need the user to test something, present it as a brief table:

| Action | Expected Outcome |
|--------|------------------|
| Do X | Y happens |
| Do A | B appears |

Keep it succinct. Don't leave things running without explicitly requesting testing.
```

#### E2E Testing for UI Features

For projects with a user interface, set up browser-based E2E tests (Playwright recommended). This creates a feedback loop where agents can verify their own UI work.

```markdown
### E2E Testing (Playwright)

For **UI features**, write Playwright tests after implementing.

**Test location:** `e2e/` or `tests/e2e/`
**Naming:** `FEATURE_ID-description.spec.ts` (e.g., `P2.5-markets-list.spec.ts`)

**Running tests:**
- `npx playwright test P2.5` — run specific feature test
- `npm run test:e2e` — run all tests
- `npx playwright test --ui` — run with visual debugger

**Test-gated completion:**
- Do NOT mark a UI feature as `"passing"` until its Playwright tests pass
- If tests fail, fix the implementation and re-run
- Only after tests pass: update feature-list, update progress log, commit

**What to test:**
- Each item in the feature's `verification` array should have a corresponding test assertion
- Test user-visible behavior, not implementation details
- Browser verification > API verification for UI features
```

**Why this matters:** Agents often verify API responses work but miss UI bugs. Browser-based tests catch rendering issues, broken interactions, and user-facing problems that API tests miss.

#### Rules

Include a rules section with hard requirements. These should be strongly worded:

```markdown
### Rules

1. **One feature at a time** — Complete fully (including tests) before moving to next
2. **Never remove or weaken tests** — If a test is failing, fix the code, not the test
3. **Never remove or weaken verification steps** — They exist for a reason
4. **Always verify before marking passing** — Run through ALL verification steps
5. **Commit after each feature** — Keep git history clean and recoverable
6. **Update progress file** — Document what you did for the next session
7. **Follow the architecture** — Don't deviate without discussion
8. **Browser verification for UI** — API responses alone are not sufficient
9. **Stop the server when done** — Free ports for the next session
10. **Ask when unclear** — Don't make assumptions
```

**Why strong wording matters:** Agents can drift toward optimistic behavior (marking things done prematurely, weakening tests that fail). Strong, explicit rules counteract this tendency.

### 4. Create Init Script

The init script should support three subcommands:

```bash
./scripts/init.sh check   # Verify environment is ready
./scripts/init.sh start   # Start dev server (background)
./scripts/init.sh stop    # Stop dev server, free ports
```

**`check` subcommand:**
1. Verify all dependencies are present (runtime, package manager, etc.)
2. Check that required environment variables are set
3. Verify connections (databases, external services, etc.)

**`start` subcommand:**
1. Start the dev server in the background
2. Store the process ID so it can be stopped later
3. Wait for the server to be ready before returning
4. Fail clearly if server doesn't start

**`stop` subcommand:**
1. Kill the dev server process
2. Clean up any orphaned processes on the port
3. Free the port for the next session

**Why start/stop matters:** When agents work in sequence, each session needs to spin up a fresh dev server. If the previous session left the server running, the port is blocked. The stop command ensures clean handoff between sessions.

**Key principle:** Don't assume the user's shell is configured correctly. Set what you need.

### 5. Create Build/Deploy Scripts

**Key principle:** Bake environment setup INTO the scripts so they work regardless of shell configuration.

Each script should:
1. Set any required environment variables at the top
2. Do its job (build, deploy, test, etc.)
3. Provide clear output on success or failure

Also configure environment in **project config files** where the platform supports it (e.g., specifying runtime versions, SDK paths).

### 6. Handle Secrets

For API keys, credentials, and other secrets:
- Create a template file showing what's needed (e.g., `.env.example`, `config.example.json`)
- Gitignore the actual secrets file
- Document in CLAUDE.md how to set up secrets

The exact approach varies by platform — use whatever is idiomatic for your stack.

### 7. Configure `.gitignore`

Ignore:
- Build artifacts
- Local config with secrets
- IDE folders
- OS files

Include:
- Any wrapper/bootstrap files needed to build from scratch

## Common Pitfalls

### Declaring Victory Early

Agents tend toward optimistic completion — marking features done before they're fully verified, or attempting to build multiple features at once. Combat this with:

- **Granular features** — 50-200+ small features are better than 10-20 large ones
- **Status starts as "failing"** — psychologically harder to mark "passing" than to leave "pending"
- **Test-gated completion** — can't mark passing until tests actually pass
- **Strong verification language** — "never remove tests", "always verify before marking"

### Skipping Browser Verification

For UI features, agents often verify the API works and assume the UI is fine. This misses rendering bugs, broken interactions, and visual issues. Require browser-based E2E tests (Playwright) for UI features, and explicitly state that API verification is insufficient.

### Command Output Buffering

Avoid piping command output through `head`, `tail`, `less`, or `more` — these can cause buffering issues or hangs. Use command-native flags instead:
- `git log -n 10` instead of `git log | head -10`
- Platform-specific equivalents for other tools

### Cached State

When environment changes (new SDK version, different runtime), cached state can cause confusing errors. Know how to clear caches for your platform:
- Stop background daemons/servers
- Clear build caches
- Remove generated files

### Device/Service Connectivity

For projects that connect to external devices or services, the init script should verify connectivity is working before starting work.

### Regression Introduction

When implementing new features, agents can inadvertently break existing functionality. Combat this with:

- **Sanity check at session start** — run existing tests before attempting new work
- **Run full test suite before committing** — catch regressions before they're committed
- **Atomic commits** — if a regression is introduced, it's easy to identify which commit caused it

## Checklist

Before handing off to Claude:

- [ ] Architecture file exists and defines system design
- [ ] Feature list created as JSON with phases and atomic features (derived from architecture)
- [ ] All features start with `"status": "failing"`
- [ ] Each feature has a `verification` array with concrete test steps
- [ ] Phase 0 includes project setup tasks
- [ ] Progress log initialized
- [ ] CLAUDE.md has project-specific instructions and references the architecture file
- [ ] CLAUDE.md includes Documentation Lookup section (Context7 MCP)
- [ ] CLAUDE.md includes Secrets Setup section
- [ ] CLAUDE.md includes Rules section with "never remove tests" rule
- [ ] Init script has `check`, `start`, and `stop` subcommands
- [ ] Secrets handling documented with template files (`.env.example`)
- [ ] `.gitignore` configured (includes secrets, build artifacts, dev server state files)
- [ ] Git repo initialized
- [ ] For UI projects: Playwright (or equivalent) is set up for E2E testing
- [ ] At least one working build/deploy cycle verified manually
