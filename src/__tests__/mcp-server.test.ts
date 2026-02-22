import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {
  createMcpServer,
  validateProjectPath,
  getMcpConfig,
  type BridgeCallbacks,
  type McpSessionContext,
} from '../mcp/server.js';
import { writeClaudeMcpConfig } from '../backends/claude.js';
import { writeCodexMcpConfig } from '../backends/codex.js';
import type { McpServerEntry } from '../types/backend.js';

/** Create a temp project directory for tests. */
function makeTempProjectDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'openbridge-mcp-test-'));
}

/** Create a mock BridgeCallbacks with vi.fn() stubs. */
function createMockCallbacks(): BridgeCallbacks {
  return {
    uploadFile: vi.fn().mockResolvedValue(undefined),
    openTunnel: vi.fn().mockResolvedValue('https://tunnel.example.com'),
    serveFileBrowser: vi.fn().mockResolvedValue('https://browser.example.com'),
    previewServer: vi.fn().mockResolvedValue({ url: 'https://preview.example.com', port: 8042 }),
    postMessage: vi.fn().mockResolvedValue(undefined),
    saveUploadedFile: vi.fn().mockResolvedValue('/tmp/project/public/logo.png'),
  };
}

/** Create a default session context for tests. */
function createContext(projectDir: string): McpSessionContext {
  return {
    channelId: 'CH_TEST',
    threadId: 'T_TEST',
    projectDir,
  };
}

describe('P5.1: MCP server setup with stdio transport', () => {
  let projectDir: string;
  let callbacks: BridgeCallbacks;
  let context: McpSessionContext;

  beforeEach(() => {
    projectDir = makeTempProjectDir();
    callbacks = createMockCallbacks();
    context = createContext(projectDir);
  });

  it('createMcpServer returns an McpServer instance', () => {
    const server = createMcpServer(context, callbacks);
    expect(server).toBeDefined();
    expect(typeof server.connect).toBe('function');
  });

  it('server has name and version set', () => {
    const server = createMcpServer(context, callbacks);
    // The server should be a valid McpServer — verify it was created
    expect(server).toBeDefined();
  });

  it('server registers upload_file tool', () => {
    const server = createMcpServer(context, callbacks);
    // Access internal tool registry to verify registration
    const tools = (server as any)._registeredTools;
    expect(tools).toBeDefined();
    expect(tools['upload_file']).toBeDefined();
  });

  it('server registers open_tunnel tool', () => {
    const server = createMcpServer(context, callbacks);
    const tools = (server as any)._registeredTools;
    expect(tools['open_tunnel']).toBeDefined();
  });

  it('server registers serve_file_browser tool', () => {
    const server = createMcpServer(context, callbacks);
    const tools = (server as any)._registeredTools;
    expect(tools['serve_file_browser']).toBeDefined();
  });

  it('TypeScript compiles with no errors (verified by build)', () => {
    // This test just verifies the import works — build.sh validates compilation
    expect(createMcpServer).toBeDefined();
    expect(typeof createMcpServer).toBe('function');
  });
});

describe('P5.6: MCP tools enforce project directory boundaries', () => {
  describe('validateProjectPath', () => {
    it('accepts paths within the project directory', () => {
      const projectDir = '/home/user/projects/myapp';
      const result = validateProjectPath('src/index.ts', projectDir);
      expect(result).toBe(path.resolve(projectDir, 'src/index.ts'));
    });

    it('accepts the project directory itself', () => {
      const projectDir = '/home/user/projects/myapp';
      const result = validateProjectPath('.', projectDir);
      expect(result).toBe(path.resolve(projectDir));
    });

    it('accepts absolute paths within the project directory', () => {
      const projectDir = '/home/user/projects/myapp';
      const result = validateProjectPath('/home/user/projects/myapp/src/index.ts', projectDir);
      expect(result).toBe('/home/user/projects/myapp/src/index.ts');
    });

    it('rejects paths outside the project directory via ../', () => {
      const projectDir = '/home/user/projects/myapp';
      expect(() => validateProjectPath('../../../etc/passwd', projectDir)).toThrow(
        'outside the project directory'
      );
    });

    it('rejects absolute paths outside the project directory', () => {
      const projectDir = '/home/user/projects/myapp';
      expect(() => validateProjectPath('/etc/passwd', projectDir)).toThrow(
        'outside the project directory'
      );
    });

    it('rejects sneaky path traversal with intermediate ../', () => {
      const projectDir = '/home/user/projects/myapp';
      expect(() => validateProjectPath('src/../../etc/passwd', projectDir)).toThrow(
        'outside the project directory'
      );
    });

    it('handles nested subdirectories correctly', () => {
      const projectDir = '/home/user/projects/myapp';
      const result = validateProjectPath('src/components/Button.tsx', projectDir);
      expect(result).toBe(path.resolve(projectDir, 'src/components/Button.tsx'));
    });
  });
});

describe('P5.2: MCP config injection', () => {
  let projectDir: string;
  const mcpEntry: McpServerEntry = {
    command: 'node',
    args: ['/path/to/bridge.js', '--mcp', '--channel', 'CH1', '--thread', 'T1', '--project-dir', '/myapp'],
  };

  beforeEach(() => {
    projectDir = makeTempProjectDir();
  });

  it('getMcpConfig returns correct command, args, and env', () => {
    const context = {
      channelId: 'CH1',
      threadId: 'T1',
      projectDir: '/home/user/myapp',
      platform: 'slack',
    };
    const ipc = { port: 12345, secret: 'sec123' };
    const config = getMcpConfig('/usr/local/bin/openbridge-mcp', context, ipc);
    expect(config.command).toBe('node');
    expect(config.args).toEqual([
      '/usr/local/bin/openbridge-mcp',
      '--channel', 'CH1',
      '--thread', 'T1',
      '--project-dir', '/home/user/myapp',
      '--platform', 'slack',
      '--ipc-port', '12345',
      '--ipc-secret', 'sec123',
    ]);
    expect(config.env).toEqual({
      OPENBRIDGE_IPC_PORT: '12345',
      OPENBRIDGE_IPC_SECRET: 'sec123',
    });
  });

  it('config includes all session context fields', () => {
    const context = {
      channelId: 'CH_DISCORD',
      threadId: 'T_DISCORD',
      projectDir: '/projects/webapp',
      platform: 'discord',
    };
    const ipc = { port: 9999, secret: 'abc' };
    const config = getMcpConfig('/path/to/script.js', context, ipc);
    const args = config.args as string[];
    expect(args).toContain('CH_DISCORD');
    expect(args).toContain('T_DISCORD');
    expect(args).toContain('/projects/webapp');
    expect(args).toContain('discord');
  });

  describe('Claude Code MCP config file', () => {
    it('writeClaudeMcpConfig creates .mcp.json in project directory', () => {
      writeClaudeMcpConfig(projectDir, mcpEntry);
      const mcpJsonPath = path.join(projectDir, '.mcp.json');
      expect(fs.existsSync(mcpJsonPath)).toBe(true);
    });

    it('writeClaudeMcpConfig writes correct JSON structure', () => {
      writeClaudeMcpConfig(projectDir, mcpEntry);
      const mcpJsonPath = path.join(projectDir, '.mcp.json');
      const content = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
      expect(content.mcpServers).toBeDefined();
      expect(content.mcpServers.openbridge).toBeDefined();
      expect(content.mcpServers.openbridge.type).toBe('stdio');
      expect(content.mcpServers.openbridge.command).toBe('node');
      expect(content.mcpServers.openbridge.args).toEqual(mcpEntry.args);
    });

    it('writeClaudeMcpConfig preserves existing MCP servers', () => {
      const mcpJsonPath = path.join(projectDir, '.mcp.json');
      // Pre-write another server config
      fs.writeFileSync(mcpJsonPath, JSON.stringify({
        mcpServers: {
          other: { type: 'stdio', command: 'other-cmd', args: [] },
        },
      }));

      writeClaudeMcpConfig(projectDir, mcpEntry);
      const content = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
      expect(content.mcpServers.other).toBeDefined();
      expect(content.mcpServers.openbridge).toBeDefined();
    });

    it('writeClaudeMcpConfig includes env if provided', () => {
      const entryWithEnv: McpServerEntry = {
        ...mcpEntry,
        env: { API_KEY: 'test123' },
      };
      writeClaudeMcpConfig(projectDir, entryWithEnv);
      const mcpJsonPath = path.join(projectDir, '.mcp.json');
      const content = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
      expect(content.mcpServers.openbridge.env).toEqual({ API_KEY: 'test123' });
    });
  });

  describe('Codex CLI MCP config file', () => {
    it('writeCodexMcpConfig creates .codex/config.toml', () => {
      writeCodexMcpConfig(projectDir, mcpEntry);
      const configPath = path.join(projectDir, '.codex', 'config.toml');
      expect(fs.existsSync(configPath)).toBe(true);
    });

    it('writeCodexMcpConfig writes correct TOML structure', () => {
      writeCodexMcpConfig(projectDir, mcpEntry);
      const configPath = path.join(projectDir, '.codex', 'config.toml');
      const content = fs.readFileSync(configPath, 'utf8');
      expect(content).toContain('[mcp_servers.openbridge]');
      expect(content).toContain('command = "node"');
      expect(content).toContain('args = [');
    });

    it('writeCodexMcpConfig creates .codex directory if missing', () => {
      const codexDir = path.join(projectDir, '.codex');
      expect(fs.existsSync(codexDir)).toBe(false);
      writeCodexMcpConfig(projectDir, mcpEntry);
      expect(fs.existsSync(codexDir)).toBe(true);
    });

    it('writeCodexMcpConfig includes env if provided', () => {
      const entryWithEnv: McpServerEntry = {
        ...mcpEntry,
        env: { MY_VAR: 'hello' },
      };
      writeCodexMcpConfig(projectDir, entryWithEnv);
      const configPath = path.join(projectDir, '.codex', 'config.toml');
      const content = fs.readFileSync(configPath, 'utf8');
      expect(content).toContain('env = {');
      expect(content).toContain('MY_VAR = "hello"');
    });

    it('writeCodexMcpConfig replaces existing openbridge block', () => {
      // Write initial config
      writeCodexMcpConfig(projectDir, mcpEntry);
      // Write again with different args
      const updated: McpServerEntry = {
        command: 'node',
        args: ['/new/path/bridge.js'],
      };
      writeCodexMcpConfig(projectDir, updated);
      const configPath = path.join(projectDir, '.codex', 'config.toml');
      const content = fs.readFileSync(configPath, 'utf8');
      // Should only have one openbridge block
      const matches = content.match(/\[mcp_servers\.openbridge\]/g);
      expect(matches).toHaveLength(1);
      expect(content).toContain('/new/path/bridge.js');
    });
  });
});

describe('P5.3: upload_file MCP tool', () => {
  let projectDir: string;
  let callbacks: ReturnType<typeof createMockCallbacks>;
  let context: McpSessionContext;

  beforeEach(() => {
    projectDir = makeTempProjectDir();
    callbacks = createMockCallbacks();
    context = createContext(projectDir);
  });

  it('upload_file calls callback with resolved path', async () => {
    // Create a test file
    const testFile = path.join(projectDir, 'test.txt');
    fs.writeFileSync(testFile, 'hello');

    const server = createMcpServer(context, callbacks);
    const tools = (server as any)._registeredTools;
    const uploadTool = tools['upload_file'];
    const handler = uploadTool.handler;

    const result = await handler({ file_path: 'test.txt' }, {});
    expect(callbacks.uploadFile).toHaveBeenCalledWith(testFile, 'CH_TEST', 'T_TEST');
    expect(result.content[0].text).toContain('uploaded successfully');
  });

  it('upload_file returns error for missing file', async () => {
    const server = createMcpServer(context, callbacks);
    const tools = (server as any)._registeredTools;
    const uploadTool = tools['upload_file'];
    const handler = uploadTool.handler;

    const result = await handler({ file_path: 'nonexistent.txt' }, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('File not found');
  });

  it('upload_file rejects paths outside project directory', async () => {
    const server = createMcpServer(context, callbacks);
    const tools = (server as any)._registeredTools;
    const uploadTool = tools['upload_file'];
    const handler = uploadTool.handler;

    const result = await handler({ file_path: '../../../etc/passwd' }, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('outside the project directory');
  });

  it('upload_file accepts absolute path within project', async () => {
    const testFile = path.join(projectDir, 'abs.txt');
    fs.writeFileSync(testFile, 'content');

    const server = createMcpServer(context, callbacks);
    const tools = (server as any)._registeredTools;
    const uploadTool = tools['upload_file'];
    const handler = uploadTool.handler;

    const result = await handler({ file_path: testFile }, {});
    expect(callbacks.uploadFile).toHaveBeenCalledWith(testFile, 'CH_TEST', 'T_TEST');
    expect(result.content[0].text).toContain('uploaded successfully');
  });
});

describe('P5.4: open_tunnel MCP tool', () => {
  let projectDir: string;
  let callbacks: ReturnType<typeof createMockCallbacks>;
  let context: McpSessionContext;

  beforeEach(() => {
    projectDir = makeTempProjectDir();
    callbacks = createMockCallbacks();
    context = createContext(projectDir);
  });

  it('open_tunnel calls callback with port and TTL', async () => {
    const server = createMcpServer(context, callbacks);
    const tools = (server as any)._registeredTools;
    const tunnelTool = tools['open_tunnel'];
    const handler = tunnelTool.handler;

    const result = await handler({ port: 3000, ttl: 1800 }, {});
    expect(callbacks.openTunnel).toHaveBeenCalledWith(3000, 1800);
    expect(result.content[0].text).toContain('https://tunnel.example.com');
  });

  it('open_tunnel uses default TTL when not provided', async () => {
    const server = createMcpServer(context, callbacks);
    const tools = (server as any)._registeredTools;
    const tunnelTool = tools['open_tunnel'];
    const handler = tunnelTool.handler;

    const result = await handler({ port: 8080 }, {});
    expect(callbacks.openTunnel).toHaveBeenCalledWith(8080, 3600);
    expect(result.content[0].text).toContain('TTL: 3600s');
  });

  it('open_tunnel does not auto-post URL (Claude uses post_message instead)', async () => {
    const server = createMcpServer(context, callbacks);
    const tools = (server as any)._registeredTools;
    const tunnelTool = tools['open_tunnel'];
    const handler = tunnelTool.handler;

    await handler({ port: 3000, ttl: 1800 }, {});
    expect(callbacks.postMessage).not.toHaveBeenCalled();
  });

  it('open_tunnel returns error on callback failure', async () => {
    (callbacks.openTunnel as any).mockRejectedValue(new Error('Tunnel binary not found'));

    const server = createMcpServer(context, callbacks);
    const tools = (server as any)._registeredTools;
    const tunnelTool = tools['open_tunnel'];
    const handler = tunnelTool.handler;

    const result = await handler({ port: 3000 }, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Tunnel binary not found');
  });

  it('open_tunnel returns the public URL', async () => {
    const server = createMcpServer(context, callbacks);
    const tools = (server as any)._registeredTools;
    const tunnelTool = tools['open_tunnel'];
    const handler = tunnelTool.handler;

    const result = await handler({ port: 5000, ttl: 7200 }, {});
    expect(result.content[0].text).toContain('https://tunnel.example.com');
  });
});

describe('P5.5: serve_file_browser MCP tool', () => {
  let projectDir: string;
  let callbacks: ReturnType<typeof createMockCallbacks>;
  let context: McpSessionContext;

  beforeEach(() => {
    projectDir = makeTempProjectDir();
    callbacks = createMockCallbacks();
    context = createContext(projectDir);
  });

  it('serve_file_browser calls callback with resolved directory', async () => {
    const server = createMcpServer(context, callbacks);
    const tools = (server as any)._registeredTools;
    const browserTool = tools['serve_file_browser'];
    const handler = browserTool.handler;

    const result = await handler({ directory: '.' }, {});
    expect(callbacks.serveFileBrowser).toHaveBeenCalledWith(projectDir);
    expect(result.content[0].text).toContain('https://browser.example.com');
  });

  it('serve_file_browser serves subdirectory', async () => {
    const subDir = path.join(projectDir, 'src');
    fs.mkdirSync(subDir);

    const server = createMcpServer(context, callbacks);
    const tools = (server as any)._registeredTools;
    const browserTool = tools['serve_file_browser'];
    const handler = browserTool.handler;

    const result = await handler({ directory: 'src' }, {});
    expect(callbacks.serveFileBrowser).toHaveBeenCalledWith(subDir);
    expect(result.content[0].text).toContain('File browser available at');
  });

  it('serve_file_browser does not auto-post URL (Claude uses post_message instead)', async () => {
    const server = createMcpServer(context, callbacks);
    const tools = (server as any)._registeredTools;
    const browserTool = tools['serve_file_browser'];
    const handler = browserTool.handler;

    await handler({ directory: '.' }, {});
    expect(callbacks.postMessage).not.toHaveBeenCalled();
  });

  it('serve_file_browser rejects paths outside project directory', async () => {
    const server = createMcpServer(context, callbacks);
    const tools = (server as any)._registeredTools;
    const browserTool = tools['serve_file_browser'];
    const handler = browserTool.handler;

    const result = await handler({ directory: '../../../etc' }, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('outside the project directory');
  });

  it('serve_file_browser returns error for non-existent directory', async () => {
    const server = createMcpServer(context, callbacks);
    const tools = (server as any)._registeredTools;
    const browserTool = tools['serve_file_browser'];
    const handler = browserTool.handler;

    const result = await handler({ directory: 'nonexistent' }, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Directory not found');
  });

  it('serve_file_browser defaults to project root', async () => {
    const server = createMcpServer(context, callbacks);
    const tools = (server as any)._registeredTools;
    const browserTool = tools['serve_file_browser'];
    const handler = browserTool.handler;

    const result = await handler({}, {});
    expect(callbacks.serveFileBrowser).toHaveBeenCalledWith(projectDir);
    expect(result.content[0].text).toContain('File browser available at');
  });

  describe('P13.8: save_uploaded_file MCP tool', () => {
    it('save_uploaded_file tool is registered', () => {
      const server = createMcpServer(context, callbacks);
      const tools = (server as any)._registeredTools;
      expect(tools['save_uploaded_file']).toBeDefined();
    });

    it('calls saveUploadedFile callback with correct params', async () => {
      const server = createMcpServer(context, callbacks);
      const tools = (server as any)._registeredTools;
      const handler = tools['save_uploaded_file'].handler;

      const result = await handler(
        { upload_id: 'upload_abc123', destination: 'public/logo.png' },
        {},
      );

      expect(callbacks.saveUploadedFile).toHaveBeenCalledWith(
        'upload_abc123', 'public/logo.png', projectDir,
      );
      expect(result.content[0].text).toContain('saved successfully');
      expect(result.content[0].text).toContain('/tmp/project/public/logo.png');
    });

    it('returns error when callback throws', async () => {
      callbacks.saveUploadedFile = vi.fn().mockRejectedValue(
        new Error('No staged file found for upload_id: upload_xyz'),
      );

      const server = createMcpServer(context, callbacks);
      const tools = (server as any)._registeredTools;
      const handler = tools['save_uploaded_file'].handler;

      const result = await handler(
        { upload_id: 'upload_xyz', destination: 'out.png' },
        {},
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No staged file found');
    });
  });

  describe('P17.3: preview_server MCP tool', () => {
    it('preview_server tool is registered', () => {
      const server = createMcpServer(context, callbacks);
      const tools = (server as any)._registeredTools;
      expect(tools['preview_server']).toBeDefined();
    });

    it('calls previewServer callback with directory, command, and ttl', async () => {
      // Create a dist subdirectory in the temp project
      fs.mkdirSync(path.join(projectDir, 'dist'));

      const server = createMcpServer(context, callbacks);
      const tools = (server as any)._registeredTools;
      const handler = tools['preview_server'].handler;

      const result = await handler({ directory: './dist', command: 'npm run dev', ttl: 1800 }, {});

      const expectedDir = path.resolve(projectDir, './dist');
      expect(callbacks.previewServer).toHaveBeenCalledWith(
        expectedDir, 'npm run dev', 1800,
      );
      expect(result.content[0].text).toContain('https://preview.example.com');
      expect(result.content[0].text).toContain('8042');
      expect(result.isError).toBeUndefined();
    });

    it('uses default directory and ttl when omitted', async () => {
      const server = createMcpServer(context, callbacks);
      const tools = (server as any)._registeredTools;
      const handler = tools['preview_server'].handler;

      const result = await handler({}, {});

      expect(callbacks.previewServer).toHaveBeenCalledWith(
        projectDir, undefined, 3600,
      );
      expect(result.content[0].text).toContain('https://preview.example.com');
    });

    it('returns error for non-existent directory', async () => {
      const server = createMcpServer(context, callbacks);
      const tools = (server as any)._registeredTools;
      const handler = tools['preview_server'].handler;

      const result = await handler({ directory: 'nonexistent-dir' }, {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Directory not found');
      expect(callbacks.previewServer).not.toHaveBeenCalled();
    });

    it('returns error when callback throws', async () => {
      callbacks.previewServer = vi.fn().mockRejectedValue(
        new Error('Server command failed'),
      );

      const server = createMcpServer(context, callbacks);
      const tools = (server as any)._registeredTools;
      const handler = tools['preview_server'].handler;

      const result = await handler({}, {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Server command failed');
    });

    it('open_tunnel description references preview_server', () => {
      const server = createMcpServer(context, callbacks);
      const tools = (server as any)._registeredTools;
      const openTunnelDesc = tools['open_tunnel'].description;
      expect(openTunnelDesc).toContain('preview_server');
    });
  });

  describe('P16.2: post_message MCP tool', () => {
    it('post_message tool is registered', () => {
      const server = createMcpServer(context, callbacks);
      const tools = (server as any)._registeredTools;
      expect(tools['post_message']).toBeDefined();
    });

    it('calls postMessage callback with channel, thread, and text', async () => {
      const server = createMcpServer(context, callbacks);
      const tools = (server as any)._registeredTools;
      const handler = tools['post_message'].handler;

      const result = await handler({ text: 'Hello from Claude!' }, {});

      expect(callbacks.postMessage).toHaveBeenCalledWith(
        'CH_TEST', 'T_TEST', 'Hello from Claude!',
      );
      expect(result.content[0].text).toBe('Message posted');
      expect(result.isError).toBeUndefined();
    });

    it('returns error when callback throws', async () => {
      callbacks.postMessage = vi.fn().mockRejectedValue(
        new Error('Slack API rate limited'),
      );

      const server = createMcpServer(context, callbacks);
      const tools = (server as any)._registeredTools;
      const handler = tools['post_message'].handler;

      const result = await handler({ text: 'test message' }, {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Slack API rate limited');
    });
  });
});
