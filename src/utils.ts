/**
 * Shared utility functions for OpenBridge.
 */

import * as os from 'node:os';
import * as path from 'node:path';

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
