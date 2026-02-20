# Plan: Wire MCP Server to Runtime

## Context

The MCP server (`src/mcp/server.ts`) is fully built and tested with 3 tools (`upload_file`, `open_tunnel`, `serve_file_browser`), but it's completely disconnected from the runtime. Backends never receive MCP config, adapters don't implement callbacks, and there's no entry point script for backends to spawn. The user wants everything wired up so they can test the full system end-to-end in one pass.

## Architecture

The MCP server runs as a grandchild process: bridge → backend (Claude Code/Codex) → MCP server. The MCP server needs to communicate back to the bridge for actions (upload files, post messages, open tunnels).

**Solution: Local HTTP IPC.** The bridge starts a localhost HTTP server on a random port. The MCP entry script makes HTTP calls back to it. No new deps needed — just `node:http` and `fetch()`.

```
Bridge Process
  ├── IPC Server (localhost:<random-port>)
  │     POST /upload-file, /open-tunnel, /serve-file-browser, /post-message
  ├── Router → backend.start({ projectDir, mcpConfig })
  └── Adapters (Slack/Discord) ← called by IPC handler

Backend Process (Claude Code / Codex)
  └── MCP Server (src/mcp/entry.ts, stdio transport)
        └── On tool call → HTTP POST to localhost:<port>
```

## Implementation Steps

### 1. Schema migration: add `platform` column to projects
**Files:** `src/store.ts`, `src/adapters/slack.ts`, `src/adapters/discord.ts`

- Add migration v2: `ALTER TABLE projects ADD COLUMN platform TEXT NOT NULL DEFAULT 'unknown'`
- Update `Project` interface: add `platform: string`
- Update `createProject()`: accept `platform` parameter
- Update both adapters' `createProject` calls to pass `'slack'` or `'discord'`

### 2. IPC server for MCP callbacks
**File:** `src/mcp/ipc-server.ts` (new)

- `startIpcServer(handler)` → creates `http.createServer` on `127.0.0.1:0`
- 4 POST routes: `/upload-file`, `/open-tunnel`, `/serve-file-browser`, `/post-message`
- Auth via `OPENBRIDGE_IPC_SECRET` header (random UUID per bridge run)
- Returns `{ port, secret, close() }`

### 3. MCP entry point script
**File:** `src/mcp/entry.ts` (new)

- Parses args: `--channel`, `--thread`, `--project-dir`, `--platform`
- Reads `OPENBRIDGE_IPC_PORT` and `OPENBRIDGE_IPC_SECRET` from env
- Creates `BridgeCallbacks` that use `fetch()` to POST to IPC server
- Calls `startMcpServer(context, callbacks)` for stdio transport

### 4. Tunnel manager
**File:** `src/mcp/tunnel.ts` (new)

- `openTunnel(port, ttl)` → returns `{ url, close() }`
- Uses `detectTunnelTools()` from `src/cli/init.ts` (reuse existing)
- Cloudflared: spawn `cloudflared tunnel --url http://localhost:<port>`, parse URL from stderr
- Ngrok: spawn `ngrok http <port>`, query `localhost:4040/api/tunnels` for URL
- TTL enforcement via `setTimeout` → auto-close
- Track active tunnels in a Map for shutdown cleanup

### 5. File browser HTTP server
**File:** `src/mcp/file-browser.ts` (new)

- `startFileBrowser(directory)` → returns `{ port, close() }`
- Minimal `node:http` server on port 0
- Directory requests → HTML listing of files/subdirs
- File requests → stream content with Content-Type

### 6. Adapter `uploadFile()` methods
**Files:** `src/adapters/slack.ts`, `src/adapters/discord.ts`

- Slack: `client.files.uploadV2({ channel_id, thread_ts, file, filename })`
- Discord: `channel.send({ files: [{ attachment: filePath, name }] })`

### 7. Callback handler (glue layer)
**File:** `src/mcp/callbacks.ts` (new)

- `createCallbackHandler()` → returns `IpcCallbackHandler`
- Routes `uploadFile`/`postMessage` to correct adapter based on platform field in request
- Routes `openTunnel` to tunnel manager
- Routes `serveFileBrowser` → start file browser + tunnel it

### 8. Router passes mcpConfig
**File:** `src/router.ts`

- Add `mcpConfigFactory?` to `RouterOptions`
- In `send()` line 122 and `respond()` line 195: call factory to get mcpConfig, pass to `backend.start()`
- Update `getMcpConfig()` in `server.ts` to include `--platform` arg and IPC env vars

### 9. Wire everything in start.ts
**File:** `src/cli/start.ts`

- Start IPC server before adapters
- Create `mcpConfigFactory` using `getMcpConfig()` + IPC port/secret
- Pass factory to Router via options
- Register adapters with callback handler after construction
- Shutdown: close IPC server, stop tunnels, stop file browsers

### 10. Tests for each step
- Each step gets tests alongside its implementation
- Integration test: mock backend triggers MCP tool → IPC → adapter method called

## Verification

1. `npm run build` succeeds
2. All existing 389 tests still pass
3. New tests pass for each component
4. Manual: run `node dist/cli.js start`, send message in Slack, agent can call MCP tools
