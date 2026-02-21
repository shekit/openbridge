#!/usr/bin/env bash
# Test the MCP server locally by sending JSON-RPC requests via stdin.
# Usage: ./scripts/test-mcp.sh
#
# Starts a mock IPC server (simple echo), then runs the MCP entry point
# and sends initialization + tool list requests to verify the server works.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== MCP Server Local Test ==="
echo ""

# Start a tiny HTTP server that echoes back success for any POST
# (simulates the IPC server)
MOCK_IPC_PORT=0
MOCK_PID=""

start_mock_ipc() {
  node -e "
    const http = require('http');
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        console.error('[mock-ipc] ' + req.method + ' ' + req.url + ' body=' + body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // Return mock responses based on the route
        if (req.url === '/open-tunnel') {
          res.end(JSON.stringify({ url: 'https://mock-tunnel.example.com' }));
        } else if (req.url === '/serve-file-browser') {
          res.end(JSON.stringify({ url: 'https://mock-browser.example.com' }));
        } else {
          res.end(JSON.stringify({ ok: true }));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      console.log('PORT:' + port);
    });
  " 2>&1 &
  MOCK_PID=$!

  # Wait for PORT line
  sleep 1
  # Read the port from the process (hacky but works for a test script)
}

cleanup() {
  if [ -n "$MOCK_PID" ]; then
    kill "$MOCK_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "Starting mock IPC server..."
# Start mock IPC in background and capture port
MOCK_OUTPUT=$(mktemp)
node -e "
  const http = require('http');
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      process.stderr.write('[mock-ipc] ' + req.method + ' ' + req.url + ' body=' + body + '\n');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/open-tunnel') {
        res.end(JSON.stringify({ url: 'https://mock-tunnel.example.com' }));
      } else if (req.url === '/serve-file-browser') {
        res.end(JSON.stringify({ url: 'https://mock-browser.example.com' }));
      } else {
        res.end(JSON.stringify({ ok: true }));
      }
    });
  });
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    process.stdout.write(String(port));
    process.stdout.write('\n');
  });
" > "$MOCK_OUTPUT" 2>&1 &
MOCK_PID=$!
sleep 0.5
MOCK_IPC_PORT=$(head -1 "$MOCK_OUTPUT")
echo "Mock IPC server running on port $MOCK_IPC_PORT"
echo ""

# Build JSON-RPC messages
INIT_REQUEST='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test-client","version":"1.0.0"}}}'
INIT_NOTIFICATION='{"jsonrpc":"2.0","method":"notifications/initialized"}'
LIST_TOOLS='{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
CALL_TUNNEL='{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"open_tunnel","arguments":{"port":3000}}}'

echo "Sending JSON-RPC requests to MCP server..."
echo ""

# Run MCP entry with the requests piped in
RESULT=$(echo -e "${INIT_REQUEST}\n${INIT_NOTIFICATION}\n${LIST_TOOLS}\n${CALL_TUNNEL}" | \
  OPENBRIDGE_IPC_PORT="$MOCK_IPC_PORT" \
  OPENBRIDGE_IPC_SECRET="test-secret" \
  node "$ROOT_DIR/dist/mcp/entry.js" \
    --channel C_TEST \
    --thread T_TEST \
    --project-dir /tmp \
    --platform slack \
  2>"$MOCK_OUTPUT.stderr" || true)

echo "=== MCP Server stdout ==="
echo "$RESULT" | node -e "
  const lines = require('fs').readFileSync('/dev/stdin','utf8').trim().split('\n');
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      console.log(JSON.stringify(obj, null, 2));
    } catch {
      console.log(line);
    }
  }
"
echo ""
echo "=== MCP Server stderr ==="
cat "$MOCK_OUTPUT.stderr"
echo ""
echo "=== Mock IPC logs ==="
cat "$MOCK_OUTPUT"
echo ""
echo "=== Test complete ==="
