# OpenBridge

Chat with your projects directly from Slack or Discord. 

Openbridge uses your existing Claude Code or Codex subscriptions so there are no additional API fees.

Each channel is a project. Each conversation within it becomes a thread, keeping things nicely organized.

Set it up on a your laptop or a VPS and then chat with your projects from anywhere!

## Demo

[![Watch the demo](https://img.youtube.com/vi/HTGZughMCdU/maxresdefault.jpg)](https://www.youtube.com/watch?v=HTGZughMCdU)

## Quick Start

```bash
npx openbridge-ai start
```

Or install globally:

```bash
npm install -g openbridge-ai
openbridge-ai start
```

To change settings later:

```bash
openbridge-ai configure
```

## Requirements

- Node.js >= 18
- At least one coding backend:
  - **Claude Code**: `npm install -g @anthropic-ai/claude-code`
  - **Codex CLI**: `npm install -g @openai/codex`
- Optional (for preview links and file browsing):
  - **Cloudflared** (recommended): `brew install cloudflared` or [download](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
  - **ngrok**: `brew install ngrok` or [download](https://ngrok.com/download)

## Chat Commands

| Command | Description |
|---------|-------------|
| `/project connect` | Pick a project from your projects root |
| `/project connect /absolute/path` | Connect a specific directory |
| `/project new my-app` | Create a new project directory |
| `/project list` | Show all connected projects |
| `/project disconnect` | Disconnect this channel |
| `/project backend claude\|codex` | Switch backend for this project |
| `/settings root /path` | Set the projects root folder |

In Slack threads: type `cancel` to stop a running task, `new` to reset the session.

On Discord, the same commands are available as slash commands, plus `/new` and `/cancel`.

## Platform Setup

The setup wizard walks you through creating your Slack or Discord bot and entering tokens. For detailed manual instructions, see [PLATFORM-SETUP.md](https://github.com/shekit/openbridge/blob/main/docs/PLATFORM-SETUP.md).

