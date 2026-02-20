/**
 * Minimal file browser HTTP server.
 *
 * Serves a directory listing as HTML. File requests stream the content
 * with a basic Content-Type header. Runs on localhost:0 (random port).
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface FileBrowser {
  port: number;
  close(): Promise<void>;
}

/** Common MIME types for file serving. */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/plain',
  '.ts': 'text/plain',
  '.tsx': 'text/plain',
  '.jsx': 'text/plain',
};

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

/** Escape HTML special characters. */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Generate an HTML directory listing. */
function renderDirectoryListing(dirPath: string, urlPath: string, rootDir: string): string {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const relativePath = path.relative(rootDir, dirPath) || '.';

  let html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Files: ${escapeHtml(relativePath)}</title>
<style>
  body { font-family: monospace; max-width: 800px; margin: 20px auto; padding: 0 20px; }
  a { text-decoration: none; color: #0066cc; }
  a:hover { text-decoration: underline; }
  .dir { font-weight: bold; }
  ul { list-style: none; padding: 0; }
  li { padding: 4px 0; }
</style>
</head><body>
<h2>${escapeHtml(relativePath)}</h2>
<ul>`;

  // Parent directory link
  if (urlPath !== '/') {
    const parent = urlPath.endsWith('/') ? urlPath.slice(0, -1) : urlPath;
    const parentUrl = parent.substring(0, parent.lastIndexOf('/')) || '/';
    html += `<li><a href="${escapeHtml(parentUrl)}">..</a></li>`;
  }

  // Sort: directories first, then files
  const dirs = entries.filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
  const files = entries.filter(e => e.isFile()).sort((a, b) => a.name.localeCompare(b.name));

  for (const dir of dirs) {
    const href = urlPath.endsWith('/') ? `${urlPath}${dir.name}` : `${urlPath}/${dir.name}`;
    html += `<li class="dir"><a href="${escapeHtml(href)}">${escapeHtml(dir.name)}/</a></li>`;
  }

  for (const file of files) {
    const href = urlPath.endsWith('/') ? `${urlPath}${file.name}` : `${urlPath}/${file.name}`;
    const stat = fs.statSync(path.join(dirPath, file.name));
    const size = stat.size < 1024 ? `${stat.size}B` : `${(stat.size / 1024).toFixed(1)}KB`;
    html += `<li><a href="${escapeHtml(href)}">${escapeHtml(file.name)}</a> <span style="color:#888">(${size})</span></li>`;
  }

  html += `</ul></body></html>`;
  return html;
}

/**
 * Start a file browser HTTP server for the given directory.
 * Returns the port and a close function.
 */
export function startFileBrowser(directory: string): Promise<FileBrowser> {
  const rootDir = path.resolve(directory);

  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url ?? '/');
    const filePath = path.resolve(rootDir, '.' + urlPath);

    // Prevent path traversal
    if (!filePath.startsWith(rootDir)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    try {
      const stat = fs.statSync(filePath);

      if (stat.isDirectory()) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderDirectoryListing(filePath, urlPath, rootDir));
      } else if (stat.isFile()) {
        res.writeHead(200, { 'Content-Type': getMimeType(filePath) });
        fs.createReadStream(filePath).pipe(res);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
      }
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  });

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to get file browser address'));
        return;
      }
      const port = addr.port;
      console.log(`[file-browser] serving ${rootDir} on 127.0.0.1:${port}`);

      resolve({
        port,
        close() {
          return new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          });
        },
      });
    });

    server.on('error', reject);
  });
}
