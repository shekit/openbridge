/**
 * Tests for the callback handler glue layer (src/mcp/callbacks.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Mock tunnel and file-browser modules
vi.mock('../mcp/tunnel.js', () => ({
  openTunnel: vi.fn(),
}));

vi.mock('../mcp/file-browser.js', () => ({
  startFileBrowser: vi.fn(),
}));

import { createCallbackHandler } from '../mcp/callbacks.js';
import { openTunnel } from '../mcp/tunnel.js';
import { startFileBrowser } from '../mcp/file-browser.js';
import type { Adapter } from '../types/adapter.js';

function createMockAdapter(): Adapter {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    postText: vi.fn(),
    postPermissionPrompt: vi.fn(),
    postUserQuestion: vi.fn(),
    postError: vi.fn(),
    uploadFile: vi.fn(),
    sendMessage: vi.fn(),
    renderTodoList: vi.fn(),
  } as unknown as Adapter;
}

describe('Callback Handler', () => {
  let slackAdapter: Adapter;
  let discordAdapter: Adapter;
  let adapters: Map<string, Adapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    slackAdapter = createMockAdapter();
    discordAdapter = createMockAdapter();
    adapters = new Map([
      ['slack', slackAdapter],
      ['discord', discordAdapter],
    ]);
  });

  it('routes uploadFile to the correct adapter', async () => {
    const handler = createCallbackHandler({ adapters });

    await handler.uploadFile('C1', 'T1', '/tmp/file.png', 'slack');
    expect(slackAdapter.uploadFile).toHaveBeenCalledWith('C1', 'T1', '/tmp/file.png');
    expect(discordAdapter.uploadFile).not.toHaveBeenCalled();

    await handler.uploadFile('D1', 'M1', '/tmp/file.png', 'discord');
    expect(discordAdapter.uploadFile).toHaveBeenCalledWith('D1', 'M1', '/tmp/file.png');
  });

  it('routes postMessage to the correct adapter', async () => {
    const handler = createCallbackHandler({ adapters });

    await handler.postMessage('C1', 'T1', 'hello', 'slack');
    expect(slackAdapter.sendMessage).toHaveBeenCalledWith('C1', 'T1', 'hello');

    await handler.postMessage('D1', 'M1', 'world', 'discord');
    expect(discordAdapter.sendMessage).toHaveBeenCalledWith('D1', 'M1', 'world');
  });

  it('throws for unknown platform', async () => {
    const handler = createCallbackHandler({ adapters });
    await expect(handler.uploadFile('C1', 'T1', '/tmp/f', 'teams')).rejects.toThrow(
      'No adapter registered for platform: teams'
    );
  });

  it('routes openTunnel to tunnel manager', async () => {
    vi.mocked(openTunnel).mockResolvedValue({
      url: 'https://tunnel.example.com',
      close: vi.fn(),
    });

    const handler = createCallbackHandler({ adapters });
    const url = await handler.openTunnel(3000, 600);

    expect(url).toBe('https://tunnel.example.com');
    expect(openTunnel).toHaveBeenCalledWith(3000, 600);
  });

  it('routes requestPermission to adapter.postPermissionPrompt with requestId', async () => {
    const handler = createCallbackHandler({ adapters });

    await handler.requestPermission!('C1', 'T1', 'Bash', { command: 'rm -rf' }, 'slack', 'req_abc');
    expect(slackAdapter.postPermissionPrompt).toHaveBeenCalledWith(
      'C1', 'T1',
      { toolName: 'Bash', toolInput: { command: 'rm -rf' }, requestId: 'req_abc' },
      null,
    );
  });

  it('routes serveFileBrowser to file browser + tunnel', async () => {
    vi.mocked(startFileBrowser).mockResolvedValue({
      port: 54321,
      close: vi.fn(),
    });
    vi.mocked(openTunnel).mockResolvedValue({
      url: 'https://browser.example.com',
      close: vi.fn(),
    });

    const handler = createCallbackHandler({ adapters });
    const url = await handler.serveFileBrowser('/tmp/project');

    expect(url).toBe('https://browser.example.com');
    expect(startFileBrowser).toHaveBeenCalledWith('/tmp/project');
    // Should tunnel the file browser's port
    expect(openTunnel).toHaveBeenCalledWith(54321, 3600);
  });

  describe('P13.7: saveUploadedFile callback', () => {
    let tmpProjectDir: string;
    let uploadsDir: string;

    beforeEach(() => {
      tmpProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-proj-'));
      // Create a fake uploads dir matching getUploadsDir() by mocking it
      uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-uploads-'));
    });

    afterEach(() => {
      fs.rmSync(tmpProjectDir, { recursive: true, force: true });
      fs.rmSync(uploadsDir, { recursive: true, force: true });
    });

    it('copies staging file to project destination', async () => {
      // Create a staged file
      const stagingFile = path.join(uploadsDir, 'upload_abc123def456-logo.png');
      fs.writeFileSync(stagingFile, 'fake image data');

      // We need to mock getUploadsDir to return our temp dir
      const utils = await import('../utils.js');
      const originalGetUploadsDir = utils.getUploadsDir;
      vi.spyOn(utils, 'getUploadsDir').mockReturnValue(uploadsDir);

      try {
        const handler = createCallbackHandler({ adapters });
        const savedPath = await handler.saveUploadedFile!(
          'upload_abc123def456', 'public/logo.png', tmpProjectDir,
        );

        expect(savedPath).toBe(path.resolve(tmpProjectDir, 'public/logo.png'));
        expect(fs.existsSync(savedPath)).toBe(true);
        expect(fs.readFileSync(savedPath, 'utf8')).toBe('fake image data');
        // Original staging file should still exist (copy, not move)
        expect(fs.existsSync(stagingFile)).toBe(true);
      } finally {
        vi.mocked(utils.getUploadsDir).mockRestore();
      }
    });

    it('rejects path traversal outside project dir', async () => {
      const stagingFile = path.join(uploadsDir, 'upload_abc-img.png');
      fs.writeFileSync(stagingFile, 'data');

      const utils = await import('../utils.js');
      vi.spyOn(utils, 'getUploadsDir').mockReturnValue(uploadsDir);

      try {
        const handler = createCallbackHandler({ adapters });
        await expect(
          handler.saveUploadedFile!('upload_abc', '../../../etc/malicious.png', tmpProjectDir),
        ).rejects.toThrow('outside the project directory');
      } finally {
        vi.mocked(utils.getUploadsDir).mockRestore();
      }
    });

    it('throws when upload ID not found', async () => {
      const utils = await import('../utils.js');
      vi.spyOn(utils, 'getUploadsDir').mockReturnValue(uploadsDir);

      try {
        const handler = createCallbackHandler({ adapters });
        await expect(
          handler.saveUploadedFile!('upload_nonexistent', 'out.png', tmpProjectDir),
        ).rejects.toThrow('No staged file found');
      } finally {
        vi.mocked(utils.getUploadsDir).mockRestore();
      }
    });

    it('creates parent directories if needed', async () => {
      const stagingFile = path.join(uploadsDir, 'upload_xyz-photo.jpg');
      fs.writeFileSync(stagingFile, 'jpeg data');

      const utils = await import('../utils.js');
      vi.spyOn(utils, 'getUploadsDir').mockReturnValue(uploadsDir);

      try {
        const handler = createCallbackHandler({ adapters });
        const savedPath = await handler.saveUploadedFile!(
          'upload_xyz', 'deep/nested/dir/photo.jpg', tmpProjectDir,
        );

        expect(fs.existsSync(savedPath)).toBe(true);
        expect(fs.readFileSync(savedPath, 'utf8')).toBe('jpeg data');
      } finally {
        vi.mocked(utils.getUploadsDir).mockRestore();
      }
    });
  });

  describe('renderTodos', () => {
    it('routes to the correct adapter renderTodoList', async () => {
      const handler = createCallbackHandler({ adapters });
      const todos = [
        { content: 'Task 1', status: 'completed', activeForm: 'Completing task 1' },
        { content: 'Task 2', status: 'in_progress', activeForm: 'Working on task 2' },
      ];
      await handler.renderTodos!('C1', 'T1', todos, 'slack');
      expect(slackAdapter.renderTodoList).toHaveBeenCalledWith('C1', 'T1', todos);
    });
  });
});
