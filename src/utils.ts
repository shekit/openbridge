/**
 * Shared utility functions for OpenBridge.
 */

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
