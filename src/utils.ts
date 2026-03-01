/**
 * Shared utility functions for OpenBridge.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { FileAttachment, FileKind } from './types/backend.js';

/** Canonical config directory: ~/.openbridge-ai/ */
export function getConfigDir(): string {
  return path.join(os.homedir(), '.openbridge-ai');
}

export function getDbPath(): string {
  return path.join(getConfigDir(), 'bridge.db');
}

export function getEnvPath(): string {
  return path.join(getConfigDir(), '.env.local');
}

/** MIME types we recognize as images for passthrough to backends. */
const IMAGE_MIME_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
]);

/** Check if a MIME type is a supported image type. */
export function isImageMimeType(mimeType: string | undefined | null): boolean {
  if (!mimeType) return false;
  // Handle "image/png; charset=..." etc.
  const base = mimeType.split(';')[0].trim().toLowerCase();
  return IMAGE_MIME_TYPES.has(base);
}

/**
 * Download a URL to a base64 string. Throws on failure.
 * Uses Node 18+ built-in fetch.
 */
export async function downloadToBase64(
  url: string,
  headers?: Record<string, string>,
): Promise<{ base64: string; mediaType: string }> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status} ${response.statusText} for ${url}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const mediaType = (response.headers.get('content-type') || 'application/octet-stream')
    .split(';')[0].trim();
  return { base64: buffer.toString('base64'), mediaType };
}

/** Uploads staging directory: ~/.openbridge-ai/uploads/ */
export function getUploadsDir(): string {
  return path.join(getConfigDir(), 'uploads');
}

/**
 * Save image data to the staging directory for later retrieval by the
 * save_uploaded_file MCP tool. Returns the upload ID, sanitized filename,
 * and full staging path.
 */
export function saveToStagingDir(
  base64: string,
  mediaType: string,
  originalFilename: string,
): { uploadId: string; filename: string; stagingPath: string } {
  const uploadsDir = getUploadsDir();
  fs.mkdirSync(uploadsDir, { recursive: true });

  const uploadId = `upload_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const safeName = path.basename(originalFilename) || 'file.dat';
  const stagingPath = path.join(uploadsDir, `${uploadId}-${safeName}`);

  fs.writeFileSync(stagingPath, Buffer.from(base64, 'base64'));
  console.log(`[uploads] saved staging file: ${stagingPath}`);

  return { uploadId, filename: safeName, stagingPath };
}

/** Clean up staging files. Best-effort, ignores errors. */
export function cleanupStagingFiles(stagingPaths: string[]): void {
  for (const p of stagingPaths) {
    try {
      fs.unlinkSync(p);
      console.log(`[uploads] cleaned up staging file: ${p}`);
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        console.error(`[uploads] failed to clean up staging file ${p}: ${err.message}`);
      }
    }
  }
}

/** MIME types treated as text when extension-based detection isn't enough. */
const TEXT_APP_MIME_TYPES = new Set([
  'application/json', 'application/xml', 'application/javascript',
  'application/typescript', 'application/x-yaml', 'application/toml',
]);

/** File extensions we consider text, even with generic MIME types. */
const TEXT_EXTENSIONS = new Set([
  '.json', '.csv', '.md', '.txt', '.ts', '.js', '.jsx', '.tsx',
  '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp',
  '.yaml', '.yml', '.toml', '.xml', '.html', '.css', '.scss',
  '.sh', '.bash', '.zsh', '.sql', '.graphql', '.env', '.ini',
  '.cfg', '.conf', '.log', '.svg',
]);

/**
 * Classify a MIME type (and optionally filename) into a FileKind.
 * Used to determine how a file attachment is passed to backends.
 */
export function classifyMimeType(mimeType: string | undefined | null, filename?: string): FileKind {
  if (!mimeType) return 'binary';
  const base = mimeType.split(';')[0].trim().toLowerCase();

  if (IMAGE_MIME_TYPES.has(base)) return 'image';
  if (base === 'application/pdf') return 'pdf';
  if (base.startsWith('text/')) return 'text';
  if (TEXT_APP_MIME_TYPES.has(base)) return 'text';

  // Fallback: check extension for common text types with generic MIME
  if (filename) {
    const ext = path.extname(filename).toLowerCase();
    if (TEXT_EXTENSIONS.has(ext)) return 'text';
  }

  return 'binary';
}

/**
 * Download a file from a URL, classify it, and save to staging.
 * Returns a complete FileAttachment or null on download failure.
 * This is the shared DRY utility used by both adapters.
 */
export async function downloadAndStageFile(
  url: string,
  filename: string,
  mimeType: string | undefined,
  authHeaders?: Record<string, string>,
): Promise<FileAttachment | null> {
  let downloaded: { base64: string; mediaType: string };
  try {
    downloaded = await downloadToBase64(url, authHeaders);
  } catch (err: any) {
    console.error(`[uploads] failed to download file ${filename} from ${url}: ${err.message}`);
    return null;
  }

  const kind = classifyMimeType(downloaded.mediaType, filename);
  const staging = saveToStagingDir(downloaded.base64, downloaded.mediaType, filename);

  return {
    base64: downloaded.base64,
    mediaType: downloaded.mediaType,
    kind,
    uploadId: staging.uploadId,
    filename: staging.filename,
    stagingPath: staging.stagingPath,
  };
}

/** Split text into chunks at word boundaries, respecting a character limit. */
export function splitText(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    // Find the last space before the limit
    let splitAt = remaining.lastIndexOf(' ', limit);
    if (splitAt <= 0) {
      // No space found — split at limit
      splitAt = limit;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

/**
 * Wrap markdown tables in code blocks so they render with monospace alignment.
 *
 * Detects tables by finding separator rows (|---|---|), expands one line up
 * for the header and down as long as lines start with |. Skips tables that
 * are already inside code blocks.
 */
export function wrapTablesInCodeBlocks(text: string): string {
  const lines = text.split('\n');
  const separatorPattern = /^\|[\s\-:]+(\|[\s\-:]+)+\|?\s*$/;
  let inCodeBlock = false;

  // First pass: identify which lines belong to tables
  const tableLines = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    if (separatorPattern.test(lines[i])) {
      // Mark the separator line
      tableLines.add(i);

      // Expand up: header row (one line before separator)
      if (i > 0 && lines[i - 1].trimStart().startsWith('|')) {
        tableLines.add(i - 1);
      }

      // Expand down: data rows after separator
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trimStart().startsWith('|')) {
          tableLines.add(j);
        } else {
          break;
        }
      }
    }
  }

  if (tableLines.size === 0) return text;

  // Second pass: wrap contiguous table regions in code blocks
  const result: string[] = [];
  let inTable = false;
  for (let i = 0; i < lines.length; i++) {
    if (tableLines.has(i)) {
      if (!inTable) {
        result.push('```');
        inTable = true;
      }
      result.push(lines[i]);
    } else {
      if (inTable) {
        result.push('```');
        inTable = false;
      }
      result.push(lines[i]);
    }
  }
  if (inTable) {
    result.push('```');
  }

  return result.join('\n');
}

/**
 * Format tool input for human-readable display in permission prompts.
 * Extracts the most meaningful field for common tools instead of dumping raw JSON.
 */
export function formatToolInput(toolName: string, toolInput: Record<string, unknown>): string {
  // For Bash, show the command
  if (toolName === 'Bash' && typeof toolInput.command === 'string') {
    return toolInput.command;
  }

  // For file tools, show the path and a preview of the content
  if ((toolName === 'Edit' || toolName === 'Write') && typeof toolInput.file_path === 'string') {
    let summary = toolInput.file_path;
    if (toolName === 'Edit' && typeof toolInput.old_string === 'string') {
      summary += `\n- ${toolInput.old_string.slice(0, 100)}`;
      if (typeof toolInput.new_string === 'string') {
        summary += `\n+ ${toolInput.new_string.slice(0, 100)}`;
      }
    }
    return summary;
  }

  if (toolName === 'Read' && typeof toolInput.file_path === 'string') {
    return toolInput.file_path;
  }

  // Fallback: JSON dump
  const json = JSON.stringify(toolInput, null, 2);
  return json === '{}' ? '(no input)' : json;
}

/**
 * Convert standard Markdown to Slack mrkdwn format.
 *
 * Handles: bold, italic, strikethrough, links, headers, tables (wrapped in code blocks).
 */
export function markdownToSlackMrkdwn(text: string): string {
  // Wrap tables in code blocks before converting
  text = wrapTablesInCodeBlocks(text);
  // Process line by line to handle headers and preserve code blocks
  const lines = text.split('\n');
  let inCodeBlock = false;
  const result: string[] = [];

  for (const line of lines) {
    // Toggle code block state
    if (line.trimStart().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      result.push(line);
      continue;
    }

    // Don't transform inside code blocks
    if (inCodeBlock) {
      result.push(line);
      continue;
    }

    let converted = line;

    // Headers → bold (Slack has no header syntax)
    converted = converted.replace(/^(#{1,6})\s+(.+)$/, (_m, _hashes, content) => `**${content}**`);

    // Bold+italic: ***text*** → placeholder (must come before bold and italic)
    // Bold: **text** → placeholder to protect from italic pass
    const boldSlots: string[] = [];
    converted = converted.replace(/\*\*\*(.+?)\*\*\*/g, (_m, content) => {
      // For URLs, skip italic wrapping — it will also skip bold in the restore step
      boldSlots.push(/^https?:\/\/\S+$/.test(content) ? content : `_${content}_`);
      return `\x01BOLD${boldSlots.length - 1}\x01`;
    });
    converted = converted.replace(/\*\*(.+?)\*\*/g, (_m, content) => {
      boldSlots.push(content);
      return `\x01BOLD${boldSlots.length - 1}\x01`;
    });

    // Italic: *text* → _text_ (now safe — bold markers are placeholders)
    // Skip URLs — wrapping in underscores breaks Slack auto-linking
    converted = converted.replace(/\*([^*]+?)\*/g, (_m, content) =>
      /^https?:\/\/\S+$/.test(content) ? content : `_${content}_`
    );

    // Restore bold placeholders as Slack bold *text*
    // If the bold content is a URL, skip the bold wrapping — Slack's mrkdwn
    // parser can't bold raw URLs and the asterisks bleed into the link text.
    const urlRe = /^https?:\/\/\S+$/;
    converted = converted.replace(/\x01BOLD(\d+)\x01/g, (_m, idx) => {
      const content = boldSlots[parseInt(idx, 10)];
      return urlRe.test(content) ? content : `*${content}*`;
    });

    // Strikethrough: ~~text~~ → ~text~
    converted = converted.replace(/~~(.+?)~~/g, '~$1~');

    // Links: [text](url) → text (url) — Slack auto-links bare URLs
    converted = converted.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

    result.push(converted);
  }

  return result.join('\n');
}

/**
 * Convert standard Markdown to Discord-compatible format.
 *
 * Discord supports most standard Markdown natively (bold, italic,
 * strikethrough, headers, code blocks). Tables are wrapped in code blocks.
 * Only links need conversion since Discord bot messages don't render [text](url) as clickable.
 */
export function markdownToDiscord(text: string): string {
  // Wrap tables in code blocks before converting
  text = wrapTablesInCodeBlocks(text);

  // Process line by line to preserve code blocks
  const lines = text.split('\n');
  let inCodeBlock = false;
  const result: string[] = [];

  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      result.push(line);
      continue;
    }

    if (inCodeBlock) {
      result.push(line);
      continue;
    }

    // Links: [text](url) → text (<url>) — Discord doesn't render MD links from bots
    let converted = line.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 (<$2>)');

    result.push(converted);
  }

  return result.join('\n');
}
