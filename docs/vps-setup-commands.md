# VPS Setup Commands

## VPS: Initial Setup (SSH in as root)

### Install Tailscale
```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
# Open the URL in your browser to authorize
# Note your VPS Tailscale IP (e.g. 100.96.245.55)
```

### Install Node.js 22
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

### Install tools (as root — goes to /usr/lib/node_modules/, shared by all users)
```bash
npm install -g openbridge-ai @anthropic-ai/claude-code @openai/codex
sudo apt install -y git sqlite3
```

### Install cloudflared
```bash
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install -y cloudflared
```

### Create a dedicated user (DO NOT run OpenBridge as root)

Claude Code refuses `--dangerously-skip-permissions` under root for security reasons.
Always run OpenBridge as a non-root user.

```bash
adduser --disabled-password --gecos "" openbridge

# Copy SSH keys so Mutagen and SSH can connect as this user
mkdir -p /home/openbridge/.ssh
cp /root/.ssh/authorized_keys /home/openbridge/.ssh/authorized_keys
chown -R openbridge:openbridge /home/openbridge/.ssh
chmod 700 /home/openbridge/.ssh
chmod 600 /home/openbridge/.ssh/authorized_keys
```

### Log in to Claude and Codex (as the openbridge user)
```bash
su - openbridge
claude        # follow browser auth flow
codex         # press Esc, choose "Sign in with Device Code"
exit
```

### Start OpenBridge (first time — runs setup wizard)
```bash
su - openbridge -c "openbridge-ai start"
```

---

## Laptop: Tailscale + Mutagen

### Install Tailscale
```bash
# Install from Mac App Store, sign in with same account as VPS
```

### Install Mutagen
```bash
brew install mutagen-io/mutagen/mutagen
```

### Create sync (laptop → VPS, as the openbridge user)
```bash
mutagen sync create \
  --ignore="assets" \
  --ignore="spokesperson" \
  --ignore="runcraft" \
  --ignore="conference-meeting-device" \
  --ignore="puppet" \
  ~/Documents/bigmac openbridge@100.96.245.55:~/bigmac
```

### Sync Claude Code sessions (required for `/resume` command)
```bash
mutagen sync create \
  ~/.claude/projects openbridge@100.96.245.55:~/.claude/projects
```

### Check sync status
```bash
mutagen sync list
```

---

## VPS: Run OpenBridge as a service

### Rebuild native modules (after first sync or npm update)

Mutagen syncs macOS binaries which won't work on Linux. Rebuild on VPS as root:

```bash
cd /home/openbridge/bigmac/openbridge && npm rebuild better-sqlite3
```

### npm link (if using local dev version instead of npm global)

Run as root (writes to /usr/lib/node_modules/), pointing to the openbridge user's copy:

```bash
cd /home/openbridge/bigmac/openbridge && npm link
```

### Update project paths in database (if migrating from root)
```bash
sqlite3 /home/openbridge/.openbridge-ai/bridge.db \
  "UPDATE projects SET project_dir = REPLACE(project_dir, '/root/', '/home/openbridge/');"
```

### Create systemd service
```bash
sudo tee /etc/systemd/system/openbridge.service << 'EOF'
[Unit]
Description=OpenBridge
After=network.target

[Service]
ExecStart=/usr/bin/openbridge-ai start
Restart=always
User=openbridge
Environment=HOME=/home/openbridge

[Install]
WantedBy=multi-user.target
EOF
```

### Enable and start
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now openbridge
```

### Useful commands
```bash
systemctl status openbridge          # check if running
journalctl -u openbridge -f          # follow logs
systemctl restart openbridge         # restart after updates
systemctl stop openbridge            # stop
```

---

## Maintenance

### Update OpenBridge (npm global)
```bash
npm install -g openbridge-ai
systemctl restart openbridge
```

### Update OpenBridge (npm link from synced repo)

Code changes sync automatically via Mutagen. If `dist/` is committed, just restart:
```bash
systemctl restart openbridge
```

If native modules changed (e.g. better-sqlite3 update):
```bash
cd /home/openbridge/bigmac/openbridge && npm rebuild better-sqlite3
systemctl restart openbridge
```

### Clean up Mutagen (if sync gets stuck)
```bash
# On VPS (as openbridge user)
rm -rf ~/.mutagen

# On laptop
mutagen sync terminate <session-id>
# Then recreate the sync
```

### Delete old root data (after migrating to openbridge user)
```bash
rm -rf /root/bigmac /root/.openbridge-ai /root/.claude
```
