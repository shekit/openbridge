/**
 * Session JSONL scanner for OpenBridge.
 *
 * Reads Claude Code session files from ~/.claude/projects/<project-dir>/,
 * filters to sessions from other machines (laptop), and returns
 * metadata for the session resume picker.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/** Metadata for a single Claude Code session. */
export interface SessionInfo {
  /** Claude Code session UUID. */
  sessionId: string;
  /** File modification time (epoch ms). */
  mtimeMs: number;
  /** Last user message text (truncated). */
  lastMessage: string;
  /** Relative time label (e.g. "5min ago", "2hr ago", "yesterday"). */
  relativeTime: string;
}

/** Page size for the session resume picker. */
export const RESUME_PAGE_SIZE = 3;

/**
 * Convert a project directory path to Claude Code's directory name format.
 * Claude Code replaces path separators with hyphens and prepends a hyphen.
 * e.g. /home/user/projects/myapp → -home-user-projects-myapp
 */
export function projectDirToClaudeDir(projectDir: string): string {
  return '-' + projectDir.split('/').filter(Boolean).join('-');
}

/**
 * Get the Claude Code projects directory.
 * Defaults to ~/.claude/projects/
 */
export function getClaudeProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Format a timestamp as a relative time string.
 */
export function formatRelativeTime(mtimeMs: number, now?: number): string {
  const nowMs = now ?? Date.now();
  const diffMs = nowMs - mtimeMs;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHr / 24);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}min ago`;
  if (diffHr < 24) return `${diffHr}hr ago`;
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return `${Math.floor(diffDays / 7)}w ago`;
}

/**
 * Truncate text to a maximum length, adding ellipsis if needed.
 */
export function truncateText(text: string, maxLen: number = 40): string {
  // Normalize whitespace (replace newlines with spaces)
  const clean = text.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen - 1) + '…';
}

/**
 * Check if a session file comes from a different machine (i.e. the laptop).
 *
 * When sessions are synced via Mutagen, laptop sessions live in directories
 * named after the laptop's path (e.g. -Users-abhishek-Documents-bigmac-openbridge)
 * while VPS sessions live in the local path (e.g. -home-openbridge-bigmac-openbridge).
 *
 * A session is "from another machine" if its parent directory name does NOT match
 * the exact Claude dir name for the current project path.
 */
export function isRemoteSession(filePath: string, localProjectDir: string): boolean {
  const parentDirName = path.basename(path.dirname(filePath));
  const localDirName = projectDirToClaudeDir(localProjectDir);
  return parentDirName !== localDirName;
}

/**
 * Extract the last user message from a session JSONL file.
 * Reads the file from the end to find the most recent user message.
 */
export async function getLastUserMessage(filePath: string): Promise<string> {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim());

    // Scan from end to find last user message
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === 'user' && entry.message?.role === 'user') {
          const contentArr = entry.message.content;
          if (Array.isArray(contentArr)) {
            // Find first text content block
            const textBlock = contentArr.find(
              (b: any) => b.type === 'text' && typeof b.text === 'string',
            );
            if (textBlock) {
              // Strip context metadata prefix lines (e.g. [Current time: ...], [Source: ...])
              let text = textBlock.text as string;
              const lines = text.split('\n');
              const firstNonMeta = lines.findIndex(
                (l: string) => !l.startsWith('[') || !l.includes(']'),
              );
              if (firstNonMeta > 0) {
                text = lines.slice(firstNonMeta).join('\n').trim();
              }
              return text;
            }
          }
          if (typeof contentArr === 'string') {
            return contentArr;
          }
        }
      } catch {
        continue;
      }
    }
  } catch {
    // File read error
  }
  return '(no message)';
}

/**
 * Find all Claude project directories that match a given project path.
 *
 * Because laptop and VPS have different home directories, the same project
 * produces different Claude dir names:
 *   Laptop: /Users/abhishek/Documents/bigmac/openbridge → -Users-abhishek-Documents-bigmac-openbridge
 *   VPS:    /home/openbridge/bigmac/openbridge          → -home-openbridge-bigmac-openbridge
 *
 * We match by suffix: extract the last 2 path segments (e.g. "bigmac-openbridge")
 * and find all directories ending with that suffix.
 */
export function findMatchingProjectDirs(claudeDir: string, projectDir: string): string[] {
  if (!fs.existsSync(claudeDir)) return [];

  // Extract last 2 path segments as suffix for matching
  const segments = projectDir.split('/').filter(Boolean);
  const suffix = segments.length >= 2
    ? '-' + segments.slice(-2).join('-')
    : '-' + segments.slice(-1).join('-');

  try {
    return fs.readdirSync(claudeDir)
      .filter((d) => {
        // Match exact dir name OR dirs ending with the same suffix
        const fullPath = path.join(claudeDir, d);
        try {
          if (!fs.statSync(fullPath).isDirectory()) return false;
        } catch { return false; }
        return d === projectDirToClaudeDir(projectDir) || d.endsWith(suffix);
      })
      .map((d) => path.join(claudeDir, d));
  } catch {
    return [];
  }
}

/**
 * Scan for laptop-only Claude Code sessions for a given project directory.
 *
 * Returns all matching sessions sorted by mtime descending (most recent first).
 * Caller can paginate with offset/limit.
 */
export async function scanSessions(
  projectDir: string,
  options?: { claudeProjectsDir?: string },
): Promise<SessionInfo[]> {
  const claudeDir = options?.claudeProjectsDir ?? getClaudeProjectsDir();

  // Find all matching project dirs (handles laptop vs VPS path differences)
  const matchingDirs = findMatchingProjectDirs(claudeDir, projectDir);

  if (matchingDirs.length === 0) {
    return [];
  }

  // Collect *.jsonl files from all matching directories
  let jsonlFiles: string[] = [];
  for (const dir of matchingDirs) {
    try {
      const files = fs.readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => path.join(dir, f));
      jsonlFiles = jsonlFiles.concat(files);
    } catch {
      continue;
    }
  }

  if (jsonlFiles.length === 0) {
    return [];
  }

  // Get file stats and sort by mtime descending
  const filesWithStats = jsonlFiles
    .map((f) => {
      try {
        const stat = fs.statSync(f);
        return { path: f, mtimeMs: stat.mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((f): f is { path: string; mtimeMs: number } => f !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  // Filter to sessions from other machines (laptop) — exclude local VPS sessions
  const sessions: SessionInfo[] = [];
  const now = Date.now();

  for (const file of filesWithStats) {
    if (!isRemoteSession(file.path, projectDir)) continue;

    const sessionId = path.basename(file.path, '.jsonl');
    const lastMsg = await getLastUserMessage(file.path);

    sessions.push({
      sessionId,
      mtimeMs: file.mtimeMs,
      lastMessage: truncateText(lastMsg),
      relativeTime: formatRelativeTime(file.mtimeMs, now),
    });
  }

  return sessions;
}

/**
 * Get a page of sessions for the resume picker.
 */
export async function getSessionPage(
  projectDir: string,
  offset: number = 0,
  options?: { claudeProjectsDir?: string },
): Promise<{ sessions: SessionInfo[]; total: number; hasMore: boolean }> {
  const all = await scanSessions(projectDir, options);
  const page = all.slice(offset, offset + RESUME_PAGE_SIZE);
  return {
    sessions: page,
    total: all.length,
    hasMore: offset + RESUME_PAGE_SIZE < all.length,
  };
}
