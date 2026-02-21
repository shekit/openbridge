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
 * Download a URL to a base64 string. Returns null on failure.
 * Uses Node 18+ built-in fetch.
 */
export async function downloadToBase64(
  url: string,
  headers?: Record<string, string>,
): Promise<{ base64: string; mediaType: string } | null> {
  try {
    const response = await fetch(url, { headers });
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    const mediaType = (response.headers.get('content-type') || 'application/octet-stream')
      .split(';')[0].trim();
    return { base64: buffer.toString('base64'), mediaType };
  } catch {
    return null;
  }
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
    } catch { /* file may already be gone */ }
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
  const downloaded = await downloadToBase64(url, authHeaders);
  if (!downloaded) return null;

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
