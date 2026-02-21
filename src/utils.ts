/**
 * Shared utility functions for OpenBridge.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';

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
  const safeName = path.basename(originalFilename) || 'image.png';
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
