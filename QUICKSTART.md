# Quick Start

```bash
npx openbridge-ai start
```

That's it. The setup wizard runs automatically on first launch and walks you through everything:

1. **Pick a platform** — Slack, Discord, or both
2. **Create the app** — step-by-step instructions shown right in the terminal
3. **Paste your tokens** — the wizard verifies they work immediately
4. **Add the bot** — for Discord, a pre-filled invite URL is generated from your token; for Slack, you're told to `/invite @OpenBridge` in a channel
5. **Backend detection** — auto-detects Claude Code or Codex CLI
6. **Optional: set a projects root** — enables the `/project connect` picker

All config and tokens are stored in `~/.openbridge-ai/`.

## After setup

| Action | Expected |
|--------|----------|
| `/project connect /path/to/your/project` | Offers to bind the channel |
| Type a message in the bound channel | Bot creates a thread and responds via Claude Code |
| `/project list` | Shows all project bindings |
| `/settings` | Shows current settings with usage hints |

## Reference docs

- [PLATFORM-SETUP.md](PLATFORM-SETUP.md) — full manual setup guide (if you prefer doing it yourself)
- [SLASH-COMMANDS.md](SLASH-COMMANDS.md) — all slash commands for both platforms
- [slack-manifest.json](slack-manifest.json) — Slack app manifest (used during setup wizard)
