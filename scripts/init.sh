#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CONFIG_DIR="$HOME/.openbridge-ai"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}OK${NC}   $1"; }
warn() { echo -e "  ${YELLOW}WARN${NC} $1"; }
fail() { echo -e "  ${RED}FAIL${NC} $1"; }

check_env() {
  echo "Environment check for OpenBridge"
  echo "================================"
  echo ""

  # Node.js
  if command -v node &>/dev/null; then
    NODE_VERSION=$(node -v)
    NODE_MAJOR=$(echo "$NODE_VERSION" | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_MAJOR" -ge 18 ]; then
      ok "Node.js $NODE_VERSION"
    else
      fail "Node.js $NODE_VERSION (need >= 18)"
    fi
  else
    fail "Node.js not found"
  fi

  # npm
  if command -v npm &>/dev/null; then
    ok "npm $(npm -v)"
  else
    fail "npm not found"
  fi

  # TypeScript (project-local)
  if [ -f "$PROJECT_DIR/node_modules/.bin/tsc" ]; then
    ok "TypeScript (project-local)"
  else
    warn "TypeScript not installed — run npm install"
  fi

  # Claude Code CLI
  if command -v claude &>/dev/null; then
    ok "Claude Code CLI found"
  else
    warn "Claude Code CLI not found — Claude backend won't work"
  fi

  # Codex CLI
  if command -v codex &>/dev/null; then
    ok "Codex CLI found"
  else
    warn "Codex CLI not found — Codex backend won't work"
  fi

  # .env.local
  if [ -f "$CONFIG_DIR/.env.local" ]; then
    ok ".env.local exists ($CONFIG_DIR/.env.local)"
  else
    warn ".env.local not found — run 'openbridge start' to set up"
  fi

  # node_modules
  if [ -d "$PROJECT_DIR/node_modules" ]; then
    ok "node_modules present"
  else
    warn "node_modules missing — run npm install"
  fi

  echo ""
}

case "${1:-}" in
  check)
    check_env
    ;;
  *)
    echo "Usage: $0 check"
    exit 1
    ;;
esac
