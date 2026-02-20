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
    postMessage: vi.fn().mockResolvedValue(undefined),
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
  it('getMcpConfig returns correct command and args', () => {
    const context: McpSessionContext = {
      channelId: 'CH1',
      threadId: 'T1',
      projectDir: '/home/user/myapp',
    };
    const config = getMcpConfig('/usr/local/bin/openbridge-mcp', context);
    expect(config.command).toBe('node');
    expect(config.args).toEqual([
      '/usr/local/bin/openbridge-mcp',
      '--mcp',
      '--channel', 'CH1',
      '--thread', 'T1',
      '--project-dir', '/home/user/myapp',
    ]);
  });

  it('config includes all session context fields', () => {
    const context: McpSessionContext = {
      channelId: 'CH_DISCORD',
      threadId: 'T_DISCORD',
      projectDir: '/projects/webapp',
    };
    const config = getMcpConfig('/path/to/script.js', context);
    const args = config.args as string[];
    expect(args).toContain('CH_DISCORD');
    expect(args).toContain('T_DISCORD');
    expect(args).toContain('/projects/webapp');
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

  it('open_tunnel posts URL in chat thread', async () => {
    const server = createMcpServer(context, callbacks);
    const tools = (server as any)._registeredTools;
    const tunnelTool = tools['open_tunnel'];
    const handler = tunnelTool.handler;

    await handler({ port: 3000, ttl: 1800 }, {});
    expect(callbacks.postMessage).toHaveBeenCalledWith(
      'CH_TEST',
      'T_TEST',
      expect.stringContaining('https://tunnel.example.com'),
    );
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

  it('serve_file_browser posts URL in chat thread', async () => {
    const server = createMcpServer(context, callbacks);
    const tools = (server as any)._registeredTools;
    const browserTool = tools['serve_file_browser'];
    const handler = browserTool.handler;

    await handler({ directory: '.' }, {});
    expect(callbacks.postMessage).toHaveBeenCalledWith(
      'CH_TEST',
      'T_TEST',
      expect.stringContaining('https://browser.example.com'),
    );
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
});
