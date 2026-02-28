# Platform Setup

## Slack Setup

**Quick way:** Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From an app manifest** → paste the [slack-manifest.json](https://github.com/shekit/openbridge/blob/main/slack-manifest.json) → **Create** → skip to step 5 below.

**Manual way:**

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. Name it whatever you want (e.g., "OpenBridge"), pick your workspace
3. **Socket Mode** → Enable it → Create an app-level token (give it `connections:write` scope) → copy the `xapp-...` token → that's your `SLACK_APP_TOKEN`
4. **OAuth & Permissions** → Add these **Bot Token Scopes**:
   - `chat:write` — post messages
   - `channels:history` — read messages in public channels
   - `channels:read` — list channels, get channel info
   - `channels:manage` — create new channels
   - `channels:join` — join public channels programmatically
   - `groups:history` — read messages in private channels
   - `groups:read` — get info about private channels
   - `groups:write` — create private channels
   - `files:read` — download user-uploaded file attachments
   - `files:write` — upload files as chat attachments
   - `commands` — register slash commands (`/project`, `/new`, `/settings`)
   - `reactions:write` — add emoji reactions to acknowledge messages
   - `users:read` — fetch user timezone for correct schedule timing
5. **Install to Workspace** → copy the `xoxb-...` token → that's your `SLACK_BOT_TOKEN`
6. **Event Subscriptions** → Enable → Subscribe to bot events:
   - `message.channels` (messages in public channels)
   - `message.groups` (messages in private channels)
7. **Slash Commands** → **Create New Command** for each:

   | Command | Request URL | Description |
   |---------|-------------|-------------|
   | `/project` | `https://localhost` | Bind channel to a project |
   | `/new` | `https://localhost` | Reset session |
   | `/settings` | `https://localhost` | View/change settings |

   (Request URL is ignored in Socket Mode — any placeholder works.)

8. **Reinstall the app** to your workspace after adding commands
9. Invite the bot to a channel with `/invite @OpenBridge`

## Discord Setup

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application** (Team: Personal)
2. **Bot** tab → **Reset Token** → copy it → that's your `DISCORD_BOT_TOKEN`
3. **Bot** tab → **Privileged Gateway Intents** → Enable **Message Content Intent**
4. **OAuth2** → **URL Generator** → select `bot` scope → select these permissions:

   **General Permissions:**
   - View Channels
   - Manage Channels

   **Text Permissions:**
   - Send Messages
   - Create Public Threads
   - Create Private Threads
   - Send Messages in Threads
   - Manage Messages
   - Manage Threads
   - Embed Links
   - Attach Files
   - Read Message History
   - Add Reactions
   - Use Slash Commands

5. Copy the generated URL → open it in your browser → pick your server → **Authorize**

## Environment Variables

Copy `.env.example` to `.env.local` and fill in the tokens:

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
DISCORD_BOT_TOKEN=...
```

You don't need both platforms. Fill in only the tokens for the platform(s) you're using.
