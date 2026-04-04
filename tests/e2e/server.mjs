import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const PORT = 4173;
const ROOT = process.cwd();

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.ts': 'application/typescript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const clean = decoded === '/' ? '/tests/e2e/fixtures/harness.html' : decoded;
  const normalized = normalize(clean).replace(/^\/+/, '');
  if (normalized.includes('..')) return null;
  return join(ROOT, normalized);
}

const server = createServer(async (req, res) => {
  const absolutePath = safePath(req.url || '/');
  if (!absolutePath) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  try {
    const fileStat = await stat(absolutePath);
    if (fileStat.isDirectory()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const ext = extname(absolutePath);
    const contentType = contentTypes[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });
    createReadStream(absolutePath).pipe(res);
  } catch {
    try {
      const data = await readFile(join(ROOT, 'tests/e2e/fixtures/harness.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  }
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`e2e server listening on http://127.0.0.1:${PORT}\n`);
});

