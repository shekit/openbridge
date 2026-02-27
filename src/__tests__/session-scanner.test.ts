import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  projectDirToClaudeDir,
  findMatchingProjectDirs,
  formatRelativeTime,
  truncateText,
  isLaptopSession,
  getLastUserMessage,
  scanSessions,
  getSessionPage,
  RESUME_PAGE_SIZE,
} from '../session-scanner.js';

/** Create a temp directory for test session files. */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ob-session-test-'));
}

/** Helper: create a JSONL session file with the given entries. */
function writeSessionFile(dir: string, sessionId: string, entries: any[]): string {
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(filePath, content);
  return filePath;
}

/** Create a user message entry. */
function userMessage(text: string, userType: string = 'human'): any {
  return {
    type: 'user',
    userType,
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
    uuid: `msg-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
  };
}

/** Create an assistant message entry. */
function assistantMessage(text: string): any {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
    uuid: `msg-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
  };
}

describe('projectDirToClaudeDir', () => {
  it('converts absolute path to Claude dir format', () => {
    expect(projectDirToClaudeDir('/home/user/projects/myapp')).toBe(
      '-home-user-projects-myapp',
    );
  });

  it('handles paths with trailing slashes', () => {
    expect(projectDirToClaudeDir('/home/user/myapp/')).toBe(
      '-home-user-myapp',
    );
  });
});

describe('formatRelativeTime', () => {
  const now = Date.now();

  it('returns "just now" for very recent times', () => {
    expect(formatRelativeTime(now - 30 * 1000, now)).toBe('just now');
  });

  it('returns minutes for times < 1 hour', () => {
    expect(formatRelativeTime(now - 5 * 60 * 1000, now)).toBe('5min ago');
  });

  it('returns hours for times < 1 day', () => {
    expect(formatRelativeTime(now - 3 * 60 * 60 * 1000, now)).toBe('3hr ago');
  });

  it('returns "yesterday" for times 1 day ago', () => {
    expect(formatRelativeTime(now - 36 * 60 * 60 * 1000, now)).toBe('yesterday');
  });

  it('returns days for times < 1 week', () => {
    expect(formatRelativeTime(now - 4 * 24 * 60 * 60 * 1000, now)).toBe('4d ago');
  });

  it('returns weeks for times >= 1 week', () => {
    expect(formatRelativeTime(now - 14 * 24 * 60 * 60 * 1000, now)).toBe('2w ago');
  });
});

describe('truncateText', () => {
  it('returns short text unchanged', () => {
    expect(truncateText('hello world')).toBe('hello world');
  });

  it('truncates long text with ellipsis', () => {
    const long = 'a'.repeat(50);
    const result = truncateText(long, 40);
    expect(result.length).toBe(40);
    expect(result.endsWith('…')).toBe(true);
  });

  it('normalizes newlines to spaces', () => {
    expect(truncateText('hello\nworld')).toBe('hello world');
  });

  it('collapses multiple spaces', () => {
    expect(truncateText('hello   world')).toBe('hello world');
  });
});

describe('isLaptopSession', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns true for human (laptop) sessions', async () => {
    const filePath = writeSessionFile(tmpDir, 'sess-human', [
      { type: 'queue-operation', operation: 'enqueue' },
      userMessage('fix the auth bug', 'human'),
    ]);
    expect(await isLaptopSession(filePath)).toBe(true);
  });

  it('returns false for external (OpenBridge) sessions', async () => {
    const filePath = writeSessionFile(tmpDir, 'sess-external', [
      { type: 'queue-operation', operation: 'enqueue' },
      userMessage('fix the auth bug', 'external'),
    ]);
    expect(await isLaptopSession(filePath)).toBe(false);
  });

  it('returns true when userType is missing (defaults to laptop)', async () => {
    const filePath = writeSessionFile(tmpDir, 'sess-no-type', [
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      },
    ]);
    expect(await isLaptopSession(filePath)).toBe(true);
  });

  it('returns false for non-existent files', async () => {
    expect(await isLaptopSession('/nonexistent/file.jsonl')).toBe(false);
  });
});

describe('getLastUserMessage', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('extracts the last user message from a session', async () => {
    const filePath = writeSessionFile(tmpDir, 'sess-1', [
      userMessage('first message'),
      assistantMessage('got it'),
      userMessage('second message'),
      assistantMessage('done'),
    ]);
    expect(await getLastUserMessage(filePath)).toBe('second message');
  });

  it('strips context metadata prefix lines', async () => {
    const filePath = writeSessionFile(tmpDir, 'sess-2', [
      userMessage(
        '[Current time: Friday, February 27, 2026]\n[Source: slack]\n[You are responding in a chat thread.]\n\nfix the auth bug',
      ),
    ]);
    expect(await getLastUserMessage(filePath)).toBe('fix the auth bug');
  });

  it('returns "(no message)" for empty files', async () => {
    const filePath = path.join(tmpDir, 'empty.jsonl');
    fs.writeFileSync(filePath, '');
    expect(await getLastUserMessage(filePath)).toBe('(no message)');
  });
});

describe('scanSessions', () => {
  let tmpDir: string;
  let projectDir: string;
  let sessionsDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    projectDir = '/home/user/myapp';
    sessionsDir = path.join(tmpDir, projectDirToClaudeDir(projectDir));
    fs.mkdirSync(sessionsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns only laptop sessions, excluding external ones', async () => {
    writeSessionFile(sessionsDir, 'laptop-1', [userMessage('laptop task', 'human')]);
    writeSessionFile(sessionsDir, 'bridge-1', [userMessage('bridge task', 'external')]);
    writeSessionFile(sessionsDir, 'laptop-2', [userMessage('another laptop task', 'human')]);

    const sessions = await scanSessions(projectDir, { claudeProjectsDir: tmpDir });
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.sessionId).sort()).toEqual(['laptop-1', 'laptop-2']);
  });

  it('sorts sessions by mtime descending (most recent first)', async () => {
    const file1 = writeSessionFile(sessionsDir, 'old-sess', [userMessage('old')]);
    const file2 = writeSessionFile(sessionsDir, 'new-sess', [userMessage('new')]);

    // Set different mtimes
    const oldTime = new Date('2026-01-01');
    const newTime = new Date('2026-02-27');
    fs.utimesSync(file1, oldTime, oldTime);
    fs.utimesSync(file2, newTime, newTime);

    const sessions = await scanSessions(projectDir, { claudeProjectsDir: tmpDir });
    expect(sessions[0].sessionId).toBe('new-sess');
    expect(sessions[1].sessionId).toBe('old-sess');
  });

  it('returns empty array when no sessions exist', async () => {
    const sessions = await scanSessions('/no/such/project', { claudeProjectsDir: tmpDir });
    expect(sessions).toEqual([]);
  });

  it('returns empty array when only external sessions exist', async () => {
    writeSessionFile(sessionsDir, 'bridge-only', [userMessage('bridge task', 'external')]);

    const sessions = await scanSessions(projectDir, { claudeProjectsDir: tmpDir });
    expect(sessions).toEqual([]);
  });

  it('truncates last message to 40 chars', async () => {
    const longMsg = 'this is a very long message that should definitely be truncated because it is way too long';
    writeSessionFile(sessionsDir, 'long-msg', [userMessage(longMsg)]);

    const sessions = await scanSessions(projectDir, { claudeProjectsDir: tmpDir });
    expect(sessions[0].lastMessage.length).toBe(40);
    expect(sessions[0].lastMessage.endsWith('…')).toBe(true);
  });

  it('finds laptop sessions from a different machine path (cross-machine sync)', async () => {
    // VPS project dir: /home/openbridge/bigmac/openbridge
    const vpsProjectDir = '/home/openbridge/bigmac/openbridge';

    // Laptop sessions synced via Mutagen end up with the laptop path format
    const laptopDir = path.join(tmpDir, '-Users-abhishek-Documents-bigmac-openbridge');
    fs.mkdirSync(laptopDir, { recursive: true });
    writeSessionFile(laptopDir, 'laptop-sess-1', [userMessage('laptop task', 'human')]);

    // VPS sessions have the VPS path format
    const vpsDir = path.join(tmpDir, '-home-openbridge-bigmac-openbridge');
    fs.mkdirSync(vpsDir, { recursive: true });
    writeSessionFile(vpsDir, 'vps-sess-1', [userMessage('vps task', 'external')]);

    // Scanning with the VPS path should find laptop sessions from the synced laptop dir
    const sessions = await scanSessions(vpsProjectDir, { claudeProjectsDir: tmpDir });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('laptop-sess-1');
  });
});

describe('findMatchingProjectDirs', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('matches exact VPS path', () => {
    const dir = path.join(tmpDir, '-home-openbridge-bigmac-openbridge');
    fs.mkdirSync(dir);
    const matches = findMatchingProjectDirs(tmpDir, '/home/openbridge/bigmac/openbridge');
    expect(matches).toHaveLength(1);
  });

  it('matches laptop path by suffix', () => {
    const laptopDir = path.join(tmpDir, '-Users-abhishek-Documents-bigmac-openbridge');
    fs.mkdirSync(laptopDir);
    const matches = findMatchingProjectDirs(tmpDir, '/home/openbridge/bigmac/openbridge');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toContain('-Users-abhishek');
  });

  it('matches both laptop and VPS dirs', () => {
    fs.mkdirSync(path.join(tmpDir, '-home-openbridge-bigmac-openbridge'));
    fs.mkdirSync(path.join(tmpDir, '-Users-abhishek-Documents-bigmac-openbridge'));
    const matches = findMatchingProjectDirs(tmpDir, '/home/openbridge/bigmac/openbridge');
    expect(matches).toHaveLength(2);
  });

  it('does not match unrelated projects', () => {
    fs.mkdirSync(path.join(tmpDir, '-home-user-other-project'));
    const matches = findMatchingProjectDirs(tmpDir, '/home/openbridge/bigmac/openbridge');
    expect(matches).toHaveLength(0);
  });
});

describe('getSessionPage', () => {
  let tmpDir: string;
  let projectDir: string;
  let sessionsDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    projectDir = '/home/user/myapp';
    sessionsDir = path.join(tmpDir, projectDirToClaudeDir(projectDir));
    fs.mkdirSync(sessionsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns first page of 3 sessions', async () => {
    for (let i = 0; i < 7; i++) {
      const file = writeSessionFile(sessionsDir, `sess-${i}`, [userMessage(`task ${i}`)]);
      // Stagger mtimes so ordering is deterministic
      const time = new Date(Date.now() - i * 60 * 1000);
      fs.utimesSync(file, time, time);
    }

    const result = await getSessionPage(projectDir, 0, { claudeProjectsDir: tmpDir });
    expect(result.sessions).toHaveLength(RESUME_PAGE_SIZE);
    expect(result.total).toBe(7);
    expect(result.hasMore).toBe(true);
  });

  it('returns subsequent pages with offset', async () => {
    for (let i = 0; i < 7; i++) {
      const file = writeSessionFile(sessionsDir, `sess-${i}`, [userMessage(`task ${i}`)]);
      const time = new Date(Date.now() - i * 60 * 1000);
      fs.utimesSync(file, time, time);
    }

    const page2 = await getSessionPage(projectDir, 3, { claudeProjectsDir: tmpDir });
    expect(page2.sessions).toHaveLength(3);
    expect(page2.hasMore).toBe(true);

    const page3 = await getSessionPage(projectDir, 6, { claudeProjectsDir: tmpDir });
    expect(page3.sessions).toHaveLength(1);
    expect(page3.hasMore).toBe(false);
  });

  it('returns empty result when no sessions exist', async () => {
    const result = await getSessionPage('/no/such/project', 0, { claudeProjectsDir: tmpDir });
    expect(result.sessions).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.hasMore).toBe(false);
  });
});
