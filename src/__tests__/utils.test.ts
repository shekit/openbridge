import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  getUploadsDir,
  saveToStagingDir,
  cleanupStagingFiles,
  isImageMimeType,
  classifyMimeType,
  downloadAndStageFile,
  splitText,
  markdownToSlackMrkdwn,
  markdownToDiscord,
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

      expect(result.filename).toBe('file.dat');
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

  describe('classifyMimeType', () => {
    it('classifies image MIME types', () => {
      expect(classifyMimeType('image/png')).toBe('image');
      expect(classifyMimeType('image/jpeg')).toBe('image');
      expect(classifyMimeType('image/gif')).toBe('image');
      expect(classifyMimeType('image/webp')).toBe('image');
    });

    it('classifies PDF', () => {
      expect(classifyMimeType('application/pdf')).toBe('pdf');
    });

    it('classifies text/* MIME types', () => {
      expect(classifyMimeType('text/plain')).toBe('text');
      expect(classifyMimeType('text/csv')).toBe('text');
      expect(classifyMimeType('text/html')).toBe('text');
    });

    it('classifies application text types', () => {
      expect(classifyMimeType('application/json')).toBe('text');
      expect(classifyMimeType('application/xml')).toBe('text');
      expect(classifyMimeType('application/javascript')).toBe('text');
    });

    it('uses filename extension as fallback', () => {
      expect(classifyMimeType('application/octet-stream', 'data.csv')).toBe('text');
      expect(classifyMimeType('application/octet-stream', 'script.py')).toBe('text');
      expect(classifyMimeType('application/octet-stream', 'config.yaml')).toBe('text');
    });

    it('returns binary for unknown types', () => {
      expect(classifyMimeType('application/octet-stream')).toBe('binary');
      expect(classifyMimeType('application/zip')).toBe('binary');
      expect(classifyMimeType('video/mp4')).toBe('binary');
    });

    it('returns binary for null/undefined', () => {
      expect(classifyMimeType(null)).toBe('binary');
      expect(classifyMimeType(undefined)).toBe('binary');
    });

    it('handles MIME types with parameters', () => {
      expect(classifyMimeType('text/plain; charset=utf-8')).toBe('text');
      expect(classifyMimeType('image/png; name=logo.png')).toBe('image');
    });
  });

  describe('downloadAndStageFile', () => {
    const createdFiles: string[] = [];

    afterEach(() => {
      vi.restoreAllMocks();
      for (const f of createdFiles) {
        try { fs.unlinkSync(f); } catch { /* ignore */ }
      }
      createdFiles.length = 0;
    });

    it('downloads, classifies, and stages a file', async () => {
      const fakeData = Buffer.from('pdf content');
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(fakeData.buffer.slice(fakeData.byteOffset, fakeData.byteOffset + fakeData.byteLength)),
        headers: new Headers({ 'content-type': 'application/pdf' }),
      } as any);

      const result = await downloadAndStageFile('https://example.com/doc.pdf', 'doc.pdf', 'application/pdf');
      expect(result).not.toBeNull();
      createdFiles.push(result!.stagingPath!);

      expect(result!.kind).toBe('pdf');
      expect(result!.filename).toBe('doc.pdf');
      expect(result!.uploadId).toMatch(/^upload_[a-f0-9]{12}$/);
      expect(fs.existsSync(result!.stagingPath!)).toBe(true);
    });

    it('returns null on download failure', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 404,
      } as any);

      const result = await downloadAndStageFile('https://example.com/missing.pdf', 'missing.pdf', 'application/pdf');
      expect(result).toBeNull();
    });

    it('classifies text files correctly', async () => {
      const fakeData = Buffer.from('col1,col2\na,b');
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(fakeData.buffer.slice(fakeData.byteOffset, fakeData.byteOffset + fakeData.byteLength)),
        headers: new Headers({ 'content-type': 'text/csv' }),
      } as any);

      const result = await downloadAndStageFile('https://example.com/data.csv', 'data.csv', 'text/csv');
      expect(result).not.toBeNull();
      createdFiles.push(result!.stagingPath!);

      expect(result!.kind).toBe('text');
      expect(result!.mediaType).toBe('text/csv');
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

  describe('markdownToSlackMrkdwn', () => {
    it('converts bold **text** to *text*', () => {
      expect(markdownToSlackMrkdwn('This is **bold** text')).toBe('This is *bold* text');
    });

    it('converts italic *text* to _text_', () => {
      expect(markdownToSlackMrkdwn('This is *italic* text')).toBe('This is _italic_ text');
    });

    it('converts strikethrough ~~text~~ to ~text~', () => {
      expect(markdownToSlackMrkdwn('This is ~~deleted~~ text')).toBe('This is ~deleted~ text');
    });

    it('converts links [text](url) to text (url)', () => {
      expect(markdownToSlackMrkdwn('See [docs](https://example.com)'))
        .toBe('See docs (https://example.com)');
    });

    it('converts bold+italic ***text*** to *_text_*', () => {
      expect(markdownToSlackMrkdwn('This is ***important***')).toBe('This is *_important_*');
    });

    it('converts headers to bold', () => {
      expect(markdownToSlackMrkdwn('# Title')).toBe('*Title*');
      expect(markdownToSlackMrkdwn('## Subtitle')).toBe('*Subtitle*');
      expect(markdownToSlackMrkdwn('### Section')).toBe('*Section*');
    });

    it('preserves code blocks', () => {
      const input = '```\n**not bold**\n*not italic*\n```';
      expect(markdownToSlackMrkdwn(input)).toBe(input);
    });

    it('handles mixed formatting', () => {
      const input = '## Results\n\nThe **main** finding was *significant*.';
      const expected = '*Results*\n\nThe *main* finding was _significant_.';
      expect(markdownToSlackMrkdwn(input)).toBe(expected);
    });

    it('passes plain text through unchanged', () => {
      expect(markdownToSlackMrkdwn('Just plain text')).toBe('Just plain text');
    });
  });

  describe('markdownToDiscord', () => {
    it('converts links [text](url) to text (<url>)', () => {
      expect(markdownToDiscord('See [docs](https://example.com)'))
        .toBe('See docs (<https://example.com>)');
    });

    it('preserves bold, italic, strikethrough, headers', () => {
      const input = '## Title\n**bold** and *italic* and ~~strike~~';
      expect(markdownToDiscord(input)).toBe(input);
    });

    it('preserves code blocks', () => {
      const input = '```\n[not a link](http://example.com)\n```';
      expect(markdownToDiscord(input)).toBe(input);
    });
  });
});
