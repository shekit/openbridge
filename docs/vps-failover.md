# OpenBridge on a VPS

**Goal:** OpenBridge runs permanently on a VPS. You code on your laptop, files sync bidirectionally, and the bot is always available via Slack/Discord — even when your laptop is off.

## Components

| Piece | What it does | Cost |
|-------|-------------|------|
| **VPS** | Always-on server (Hetzner/DO, Ubuntu, smallest tier) | ~$5/mo |
| **Tailscale** | Secure tunnel between laptop ↔ VPS | Free |
| **Mutagen** | Fast bi-directional file sync over SSH, built for dev workflows | Free |

## What Lives Where

| Machine | What runs |
|---------|-----------|
| **Laptop** | Your editor, git, direct coding |
| **VPS** | OpenBridge, `~/.openbridge-ai/`, `~/.claude/` |
| **Both** | Project files (synced via Mutagen, including `.git/`) |

## How It Works

1. OpenBridge runs on VPS permanently (via systemd), connected to Slack/Discord
2. Mutagen syncs your project directories bidirectionally between laptop and VPS
3. You code on your laptop — edits sync to VPS in sub-second
4. You message the bot via Slack/Discord — it reads/writes files on VPS
5. Bot's file changes sync back to your laptop automatically
6. Either side can `git commit` — the `.git/` directory is synced too

No failover, no watchdog, no handoff logic. One instance of OpenBridge, always on.

## Setup Steps

### 1. VPS
```bash
# Spin up Ubuntu VPS on Hetzner/DigitalOcean (1 vCPU, 1GB RAM is fine)
```

### 2. Tailscale (both machines)
```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
# Note your VPS's Tailscale IP (e.g. 100.x.x.x)
```

### 3. Mutagen (laptop only)
```bash
# Install on laptop (manages sync from your side)
brew install mutagen-io/mutagen/mutagen

# Sync project directories (uses SSH via Tailscale)
mutagen sync create ~/projects user@<vps-tailscale-ip>:~/projects

# Check status anytime
mutagen sync list
```

### 4. OpenBridge on VPS
```bash
npm install -g openbridge-ai
openbridge start
# Setup wizard handles tokens
```

### 5. Keep OpenBridge Running (systemd)

`/etc/systemd/system/openbridge.service`:
```ini
[Unit]
Description=OpenBridge
After=network.target

[Service]
ExecStart=/usr/bin/env openbridge start
Restart=always
User=user
Environment=HOME=/home/user

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now openbridge
```

## Caveats

- **Don't commit on both machines simultaneously.** If you're editing on your laptop while the bot is actively working on VPS, avoid committing at the exact same time — the synced `.git/` directory could get corrupted. In practice this is unlikely since you can see when the bot is active in Slack.
- **Mutagen sync delay.** If you save a file and immediately message the bot, there's a tiny window (~1s) where the VPS might not have the latest version. The time it takes to switch to Slack and type is usually longer than this.

## Performance

VPS does almost nothing — OpenBridge is just relaying messages. A $5/mo box handles it easily. Claude API response time is the same regardless of where you run it.
