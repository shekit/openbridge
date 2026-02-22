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
 * Convert standard Markdown to Slack mrkdwn format.
 *
 * Handles: bold, italic, strikethrough, links, headers.
 * Does NOT handle tables — those pass through as-is.
 */
export function markdownToSlackMrkdwn(text: string): string {
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

    // Bold: **text** → placeholder to protect from italic pass
    const boldSlots: string[] = [];
    converted = converted.replace(/\*\*(.+?)\*\*/g, (_m, content) => {
      boldSlots.push(content);
      return `\x01BOLD${boldSlots.length - 1}\x01`;
    });

    // Italic: *text* → _text_ (now safe — bold markers are placeholders)
    converted = converted.replace(/\*([^*]+?)\*/g, '_$1_');

    // Restore bold placeholders as Slack bold *text*
    converted = converted.replace(/\x01BOLD(\d+)\x01/g, (_m, idx) => `*${boldSlots[parseInt(idx, 10)]}*`);

    // Strikethrough: ~~text~~ → ~text~
    converted = converted.replace(/~~(.+?)~~/g, '~$1~');

    // Links: [text](url) → <url|text>
    converted = converted.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');

    result.push(converted);
  }

  return result.join('\n');
}

/**
 * Convert standard Markdown to Discord-compatible format.
 *
 * Discord supports most standard Markdown natively (bold, italic,
 * strikethrough, headers, code blocks). Only links need conversion
 * since Discord bot messages don't render [text](url) as clickable.
 */
export function markdownToDiscord(text: string): string {
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
