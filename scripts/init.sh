#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PID_FILE="$PROJECT_DIR/.openbridge/bridge.pid"

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
  if [ -f "$PROJECT_DIR/.env.local" ]; then
    ok ".env.local exists"
  else
    warn ".env.local not found — copy .env.example to .env.local and fill in values"
  fi

  # node_modules
  if [ -d "$PROJECT_DIR/node_modules" ]; then
    ok "node_modules present"
  else
    warn "node_modules missing — run npm install"
  fi

  echo ""
}

start_bridge() {
  if [ -f "$PID_FILE" ]; then
    EXISTING_PID=$(cat "$PID_FILE")
    if kill -0 "$EXISTING_PID" 2>/dev/null; then
      echo "Bridge already running (PID $EXISTING_PID)"
      exit 1
    else
      rm -f "$PID_FILE"
    fi
  fi

  mkdir -p "$(dirname "$PID_FILE")"

  echo "Starting OpenBridge..."
  cd "$PROJECT_DIR"
  node dist/index.js &
  BRIDGE_PID=$!
  echo "$BRIDGE_PID" > "$PID_FILE"
  echo "Bridge started (PID $BRIDGE_PID)"
}

stop_bridge() {
  if [ ! -f "$PID_FILE" ]; then
    echo "No PID file found — bridge may not be running"
    exit 0
  fi

  BRIDGE_PID=$(cat "$PID_FILE")
  if kill -0 "$BRIDGE_PID" 2>/dev/null; then
    echo "Stopping bridge (PID $BRIDGE_PID)..."
    kill "$BRIDGE_PID"
    # Wait up to 5 seconds for clean shutdown
    for i in $(seq 1 10); do
      if ! kill -0 "$BRIDGE_PID" 2>/dev/null; then
        break
      fi
      sleep 0.5
    done
    # Force kill if still running
    if kill -0 "$BRIDGE_PID" 2>/dev/null; then
      kill -9 "$BRIDGE_PID"
    fi
    echo "Bridge stopped"
  else
    echo "Bridge not running (stale PID file)"
  fi
  rm -f "$PID_FILE"
}

case "${1:-}" in
  check)
    check_env
    ;;
  start)
    start_bridge
    ;;
  stop)
    stop_bridge
    ;;
  *)
    echo "Usage: $0 {check|start|stop}"
    exit 1
    ;;
esac
