# Session Resume — Continue Laptop Sessions from Slack/Discord

**Goal:** When you walk away from your laptop, pick up an active Claude Code session via Slack/Discord through the VPS — continuing the exact conversation where you left off.

## Problem

You're coding on your laptop with Claude Code in the terminal. You step away. The VPS is running OpenBridge and connected to Slack/Discord, but it only knows about sessions it spawned — not the ones running locally on your laptop.

## Prerequisites

### Mutagen Sync for Claude Sessions

Add a second Mutagen sync so Claude Code's session data is available on both machines:

```bash
mutagen sync create \
  ~/.claude/projects openbridge@<vps-tailscale-ip>:~/.claude/projects
```

This makes laptop session history readable by the VPS. Each session is a standalone UUID directory + JSONL file — no conflicts when both machines' sessions coexist.

**Caveat:** Don't resume the same session simultaneously on both machines.

## Design

### `/resume` Command

A new slash command that shows recent laptop-only sessions and lets the user pick one to continue via Slack/Discord.

### Session Discovery

Read `~/.claude/projects/<current-project-dir>/` on the VPS (which mirrors the laptop via Mutagen):

1. List all `*.jsonl` session files
2. **Filter to laptop-only sessions** — read the first `"type": "user"` entry in each JSONL; keep only those with `"userType": "human"` (Claude Code sets `"userType": "external"` for programmatic/OpenBridge sessions)
3. Sort by file mtime descending (most recent first)
4. Paginate in pages of 3 (offset-based)

### Session Preview

For each session, extract from the JSONL:
- **Relative timestamp** from file mtime (e.g., "5min ago", "2hr ago", "yesterday")
- **Last user message** — scan from end of JSONL, find the last `"type": "user"` entry, truncate `content[0].text` to ~40 chars

### UX

Show 3 sessions per page with a "Show more" button for pagination (same pattern as the project picker, but page size of 3 instead of 15):

```
Resume a laptop session:

[5min ago: "can you also handle the edge case wh…"]
[2hr ago: "let's switch to using Redis instead o…"]
[yesterday: "refactor the auth middleware to supp…"]

                    [Show more (4 remaining)]
```

On session button tap:
1. Set the selected session's UUID as the thread's `backend_session_id` in the database
2. Next message in that thread spawns Claude Code with `-r <session-id>`, resuming the conversation

On "Show more" tap:
- Re-render with the next 3 sessions (offset-based, identical to project picker pagination)

### Platform Support

Both Slack and Discord, following the existing button patterns:
- **Slack:** Block Kit action buttons with `action_id: resume_session_<uuid>` and session UUID in `value`. "Show more" button with `action_id: resume_picker_more` and next offset in `value`
- **Discord:** `ButtonBuilder` with `customId: resume_session:<uuid>`. "Show more" with `customId: resume_picker_more:<offset>`

### Edge Cases

- **No laptop sessions found** → post message: "No laptop sessions found for this project. Make sure `~/.claude/projects` is synced via Mutagen."
- **Session data not yet synced** → same message (files just haven't arrived yet)
- **Project not connected** → existing guard: `/resume` only works in a project-bound channel
- **Session already active in thread** → warn and ask for confirmation, or require `/reset` first

## How It Fits

This reuses existing infrastructure:
- **Claude backend** already supports `-r SESSION_ID` (line 333 in `claude.ts`)
- **Router** already restores `backend_session_id` before spawning
- **Store** already has `backend_session_id` column on sessions table
- **Adapters** already have button/action patterns from the project picker

New code is limited to:
- Command registration (`/resume` in both adapters)
- Session JSONL scanner (read + filter + sort + preview extraction)
- Button rendering (3 buttons, no pagination)
- Action handler (set `backend_session_id` and confirm)
