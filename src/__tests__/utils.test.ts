import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  getUploadsDir,
  saveToStagingDir,
  cleanupStagingFiles,
  isImageMimeType,
  splitText,
} from '../utils.js';

describe('Utils', () => {
  describe('P13.1: Staging directory utilities', () => {
    const createdFiles: string[] = [];

    afterEach(() => {
      // Clean up any files created during tests
      for (const f of createdFiles) {
        try { fs.unlinkSync(f); } catch { /* ignore */ }
      }
      createdFiles.length = 0;
    });

    it('getUploadsDir returns path under config dir', () => {
      const dir = getUploadsDir();
      expect(dir).toMatch(/\.openbridge-ai[/\\]uploads$/);
    });

    it('saveToStagingDir creates a file with correct content', () => {
      const data = Buffer.from('hello world').toString('base64');
      const result = saveToStagingDir(data, 'image/png', 'test.png');
      createdFiles.push(result.stagingPath);

      expect(result.uploadId).toMatch(/^upload_[a-f0-9]{12}$/);
      expect(result.filename).toBe('test.png');
      expect(fs.existsSync(result.stagingPath)).toBe(true);

      const content = fs.readFileSync(result.stagingPath, 'utf8');
      expect(content).toBe('hello world');
    });

    it('saveToStagingDir sanitizes path traversal in filename', () => {
      const data = Buffer.from('img').toString('base64');
      const result = saveToStagingDir(data, 'image/png', '../../../etc/passwd');
      createdFiles.push(result.stagingPath);

      expect(result.filename).toBe('passwd');
      expect(result.stagingPath).toContain('passwd');
      expect(result.stagingPath).not.toContain('..');
    });

    it('saveToStagingDir uses default name for empty filename', () => {
      const data = Buffer.from('img').toString('base64');
      const result = saveToStagingDir(data, 'image/png', '');
      createdFiles.push(result.stagingPath);

      expect(result.filename).toBe('image.png');
    });

    it('saveToStagingDir generates unique upload IDs', () => {
      const data = Buffer.from('img').toString('base64');
      const r1 = saveToStagingDir(data, 'image/png', 'a.png');
      const r2 = saveToStagingDir(data, 'image/png', 'b.png');
      createdFiles.push(r1.stagingPath, r2.stagingPath);

      expect(r1.uploadId).not.toBe(r2.uploadId);
    });

    it('cleanupStagingFiles deletes files', () => {
      const data = Buffer.from('img').toString('base64');
      const r = saveToStagingDir(data, 'image/png', 'cleanup-test.png');

      expect(fs.existsSync(r.stagingPath)).toBe(true);
      cleanupStagingFiles([r.stagingPath]);
      expect(fs.existsSync(r.stagingPath)).toBe(false);
    });

    it('cleanupStagingFiles ignores missing files', () => {
      // Should not throw
      cleanupStagingFiles(['/nonexistent/path/file.png']);
    });
  });

  describe('isImageMimeType', () => {
    it('recognizes image types', () => {
      expect(isImageMimeType('image/png')).toBe(true);
      expect(isImageMimeType('image/jpeg')).toBe(true);
      expect(isImageMimeType('image/gif')).toBe(true);
      expect(isImageMimeType('image/webp')).toBe(true);
    });

    it('rejects non-image types', () => {
      expect(isImageMimeType('application/pdf')).toBe(false);
      expect(isImageMimeType('text/plain')).toBe(false);
    });

    it('handles null/undefined', () => {
      expect(isImageMimeType(null)).toBe(false);
      expect(isImageMimeType(undefined)).toBe(false);
    });
  });

  describe('splitText', () => {
    it('returns single chunk for short text', () => {
      expect(splitText('hello', 10)).toEqual(['hello']);
    });

    it('splits at word boundaries', () => {
      const chunks = splitText('hello world foo', 11);
      expect(chunks).toEqual(['hello world', 'foo']);
    });
  });
});
