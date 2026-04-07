const DAV_PREFIX = '/dav';
const EVENTS_PREFIX = '/events';
const EXECUTE_PATH = '/__interocitor__/execute';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'OPTIONS, PROPFIND, MKCOL, PUT, GET, DELETE, POST',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': 'ETag',
};

function withCors(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function preflightResponse() {
  return new Response('', {
    status: 200,
    headers: CORS_HEADERS,
  });
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function isAppendOnlyMode(env) {
  return String(env?.INTEROCITOR_APPEND_ONLY ?? '1') !== '0';
}

function hasExecuteToken(request, env) {
  const expected = env?.INTEROCITOR_EXEC_TOKEN;
  if (!expected) return false;
  const actual = request.headers.get('x-interocitor-token') || '';
  return actual === expected;
}

function requestWithPrefix(url, request, prefix) {
  const headers = new Headers(request.headers);
  headers.set('x-dav-prefix', prefix);
  const init = {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
  };
  return new Request(url, init);
}

function normalizePath(rawPath) {
  const withLeadingSlash = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  const compact = withLeadingSlash.replace(/\/+/g, '/');
  if (compact === '/') return '/';
  return compact.endsWith('/') ? compact.slice(0, -1) : compact;
}

function normalizeRemoteRoot(path) {
  const normalized = normalizePath(path || '/');
  return normalized === '/' ? '' : normalized;
}

function parentPath(path) {
  if (path === '/') return null;
  const idx = path.lastIndexOf('/');
  if (idx <= 0) return '/';
  return path.slice(0, idx);
}

function fileName(path) {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

function changeHlc(file) {
  const idx = file.lastIndexOf('-chg_');
  if (idx <= 0) return null;
  return file.slice(0, idx);
}

function nowIso() {
  return new Date().toISOString();
}

function httpDate(iso) {
  return new Date(iso).toUTCString();
}

function xmlEscape(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function encodeHref(path, isCollection) {
  const encoded = path
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  if (!encoded) return '/';
  return isCollection ? `/${encoded}/` : `/${encoded}`;
}

function etag() {
  return `"etag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}"`;
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'string') return new TextEncoder().encode(value);
  return new Uint8Array();
}

function responseNode({ href, size, modifiedIso, itemEtag, isCollection }) {
  const resourceType = isCollection ? '<d:collection/>' : '';
  const contentLength = isCollection ? '' : `<d:getcontentlength>${size}</d:getcontentlength>`;
  return `<d:response>
  <d:href>${xmlEscape(href)}</d:href>
  <d:propstat>
    <d:prop>
      ${contentLength}
      <d:getlastmodified>${xmlEscape(httpDate(modifiedIso))}</d:getlastmodified>
      <d:resourcetype>${resourceType}</d:resourcetype>
      <d:getetag>${xmlEscape(itemEtag || '')}</d:getetag>
    </d:prop>
    <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
</d:response>`;
}

function propfindBody(nodes) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<d:multistatus xmlns:d="DAV:">\n${nodes.join('\n')}\n</d:multistatus>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return preflightResponse();
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      return withCors(new Response('todo-cloudflare-do worker is running\n', { status: 200 }));
    }

    if (url.pathname.startsWith(`${EVENTS_PREFIX}/`)) {
      const prefix = decodeURIComponent(url.pathname.slice(`${EVENTS_PREFIX}/`.length));
      if (!prefix) {
        return withCors(new Response('Missing durable object prefix', { status: 400 }));
      }
      const id = env.TODO_DAV.idFromName(prefix);
      const stub = env.TODO_DAV.get(id);
      const eventsRequest = requestWithPrefix('https://session.internal/__events', request, prefix);
      return withCors(await stub.fetch(eventsRequest));
    }

    if (!url.pathname.startsWith(`${DAV_PREFIX}/`)) {
      return withCors(new Response('Not found', { status: 404 }));
    }

    const decodedPath = decodeURIComponent(url.pathname.slice(`${DAV_PREFIX}/`.length));
    const [prefix, ...rest] = decodedPath.split('/').filter(Boolean);
    if (!prefix) {
      return withCors(new Response('Path must start with /dav/<prefix>', { status: 400 }));
    }

    const objectPath = rest.length > 0 ? `/${rest.join('/')}` : '/';
    const id = env.TODO_DAV.idFromName(prefix);
    const stub = env.TODO_DAV.get(id);

    const forwardRequest = requestWithPrefix(`https://session.internal${objectPath}`, request, prefix);
    return withCors(await stub.fetch(forwardRequest));
  },
};

export class TodoDavSession {
  constructor(state) {
    this.state = state;
    this.clients = new Map();
  }

  async fetch(request, env) {
    if (!env?.TODO_DB) {
      return new Response('Missing D1 binding TODO_DB', { status: 500 });
    }

    const url = new URL(request.url);
    const path = normalizePath(url.pathname);
    const method = request.method.toUpperCase();
    const prefix = (request.headers.get('x-dav-prefix') || '').trim();

    if (!prefix) {
      return new Response('Missing durable object prefix', { status: 400 });
    }

    if (url.pathname === '/__events') {
      return this.handleEvents(request);
    }

    if (method === 'OPTIONS') {
      return new Response('', {
        status: 200,
        headers: {
          Allow: 'OPTIONS, PROPFIND, MKCOL, PUT, GET, DELETE, POST',
          DAV: '1',
        },
      });
    }

    if (method === 'POST' && path === EXECUTE_PATH) {
      return this.handleExecute(prefix, request, env.TODO_DB, env);
    }

    if (method === 'PROPFIND') {
      return this.handlePropfind(prefix, path, request.headers.get('Depth') || '0', env.TODO_DB);
    }

    if (method === 'MKCOL') {
      const status = await this.ensureFolder(prefix, path, env.TODO_DB);
      if (status === 201 || status === 405) {
        await this.broadcast({ type: 'folder', path, ts: Date.now() });
      }
      return new Response('', { status });
    }

    if (method === 'PUT') {
      const bytes = new Uint8Array(await request.arrayBuffer());
      const status = await this.putFile(prefix, path, bytes, env.TODO_DB, env);
      if (status === 201 || status === 204) {
        await this.broadcast({ type: 'file', path, ts: Date.now() });
      }
      return new Response('', { status });
    }

    if (method === 'GET') {
      const file = await this.getFile(prefix, path, env.TODO_DB);
      if (!file) return new Response('', { status: 404 });
      return new Response(toUint8Array(file.content), {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          ETag: file.etag,
        },
      });
    }

    if (method === 'DELETE') {
      if (isAppendOnlyMode(env)) {
        return new Response('DELETE disabled in append-only mode', { status: 405 });
      }
      const existed = await this.deletePath(prefix, path, env.TODO_DB);
      if (existed) {
        await this.broadcast({ type: 'delete', path, ts: Date.now() });
      }
      return new Response('', { status: existed ? 204 : 404 });
    }

    return new Response('Method not allowed', { status: 405 });
  }

  async handleExecute(prefix, request, db, env) {
    if (!hasExecuteToken(request, env)) {
      return new Response('Forbidden', { status: 403 });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response('Invalid JSON body', { status: 400 });
    }

    const op = String(payload?.op || '');
    if (op !== 'compact') {
      return new Response('Unsupported execute op', { status: 400 });
    }

    const remotePath = normalizePath(String(payload?.remotePath || '/'));
    const watermarkHlc = String(payload?.watermarkHlc || '');
    if (!watermarkHlc) {
      return new Response('Missing watermarkHlc', { status: 400 });
    }

    const result = await this.compactChanges(prefix, remotePath, watermarkHlc, db);

    const commandPath = `${normalizeRemoteRoot(remotePath)}/.interocitor/commands/cmd-${Date.now().toString(36)}.json`;
    await this.ensureFolderTree(prefix, `${normalizeRemoteRoot(remotePath)}/.interocitor/commands`, db);
    await this.putOrOverwrite(prefix, commandPath, new TextEncoder().encode(JSON.stringify({
      op: 'compact',
      remotePath,
      watermarkHlc,
      pruned: result.pruned,
      totalCandidates: result.totalCandidates,
      ts: nowIso(),
    }, null, 2)), db);

    await this.broadcast({ type: 'compact', path: remotePath, ts: Date.now(), pruned: result.pruned });
    return jsonResponse({ ok: true, ...result, commandPath });
  }

  async compactChanges(prefix, remotePath, watermarkHlc, db) {
    const root = normalizeRemoteRoot(remotePath);
    const changesRoot = `${root}/changes`;
    const likePattern = `${changesRoot}/%`;

    const list = await db
      .prepare('SELECT path FROM files WHERE prefix = ?1 AND path LIKE ?2')
      .bind(prefix, likePattern)
      .all();

    const rows = list.results || [];
    const toDelete = [];
    for (const row of rows) {
      const path = String(row.path || '');
      const name = fileName(path);
      if (name === 'head.json') continue;
      const hlc = changeHlc(name);
      if (!hlc) continue;
      if (hlc <= watermarkHlc) {
        toDelete.push(path);
      }
    }

    for (const path of toDelete) {
      await db
        .prepare('DELETE FROM files WHERE prefix = ?1 AND path = ?2')
        .bind(prefix, path)
        .run();
    }

    return {
      remotePath,
      watermarkHlc,
      totalCandidates: rows.length,
      pruned: toDelete.length,
    };
  }

  async handleEvents(request) {
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();
    const clientId = crypto.randomUUID();

    this.clients.set(clientId, writer);
    await writer.write(this.encodeSse('ready', { ts: Date.now() }));

    const closeClient = async () => {
      this.clients.delete(clientId);
      try {
        await writer.close();
      } catch {
        // Writer already closed.
      }
    };

    request.signal.addEventListener('abort', () => {
      void closeClient();
    });

    return new Response(stream.readable, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  }

  encodeSse(type, payload) {
    return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  }

  async broadcast(payload) {
    const dead = [];
    const message = this.encodeSse('invalidate', payload);

    for (const [id, writer] of this.clients.entries()) {
      try {
        await writer.write(message);
      } catch {
        dead.push(id);
      }
    }

    for (const id of dead) {
      const writer = this.clients.get(id);
      this.clients.delete(id);
      if (writer) {
        try {
          await writer.close();
        } catch {
          // Ignore close failures.
        }
      }
    }
  }

  async folderExists(prefix, path, db) {
    if (path === '/') return true;
    const row = await db
      .prepare('SELECT 1 FROM folders WHERE prefix = ?1 AND path = ?2 LIMIT 1')
      .bind(prefix, path)
      .first();
    return Boolean(row);
  }

  async ensureFolder(prefix, path, db) {
    if (path === '/') {
      return 201;
    }

    if (await this.folderExists(prefix, path, db)) {
      return 405;
    }

    const parent = parentPath(path);
    if (!parent || !(await this.folderExists(prefix, parent, db))) {
      return 409;
    }

    await db
      .prepare('INSERT INTO folders (prefix, path, created_at) VALUES (?1, ?2, ?3)')
      .bind(prefix, path, nowIso())
      .run();
    return 201;
  }

  async putFile(prefix, path, bytes, db, env) {
    const parent = parentPath(path);
    if (!parent || !(await this.folderExists(prefix, parent, db))) {
      return 409;
    }

    const existed = Boolean(
      await db
        .prepare('SELECT 1 FROM files WHERE prefix = ?1 AND path = ?2 LIMIT 1')
        .bind(prefix, path)
        .first(),
    );

    if (isAppendOnlyMode(env) && existed) {
      return 409;
    }

    return this.putOrOverwrite(prefix, path, bytes, db, existed);
  }

  async putOrOverwrite(prefix, path, bytes, db, existedOverride) {
    const existed = typeof existedOverride === 'boolean'
      ? existedOverride
      : Boolean(
        await db
          .prepare('SELECT 1 FROM files WHERE prefix = ?1 AND path = ?2 LIMIT 1')
          .bind(prefix, path)
          .first(),
      );

    await db
      .prepare(
        `INSERT INTO files (prefix, path, content, size, modified_time, etag)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(prefix, path) DO UPDATE SET
           content = excluded.content,
           size = excluded.size,
           modified_time = excluded.modified_time,
           etag = excluded.etag`,
      )
      .bind(prefix, path, bytes, bytes.byteLength, nowIso(), etag())
      .run();

    return existed ? 204 : 201;
  }

  async ensureFolderTree(prefix, targetPath, db) {
    const normalized = normalizePath(targetPath);
    if (normalized === '/' || normalized === '') return;
    const segments = normalized.split('/').filter(Boolean);
    let current = '';
    for (const segment of segments) {
      current += `/${segment}`;
      await db
        .prepare('INSERT OR IGNORE INTO folders (prefix, path, created_at) VALUES (?1, ?2, ?3)')
        .bind(prefix, current, nowIso())
        .run();
    }
  }

  async getFile(prefix, path, db) {
    return db
      .prepare('SELECT content, size, modified_time, etag FROM files WHERE prefix = ?1 AND path = ?2 LIMIT 1')
      .bind(prefix, path)
      .first();
  }

  async deletePath(prefix, path, db) {
    if (path === '/') {
      await db.prepare('DELETE FROM files WHERE prefix = ?1').bind(prefix).run();
      await db.prepare('DELETE FROM folders WHERE prefix = ?1').bind(prefix).run();
      return true;
    }

    const file = await this.getFile(prefix, path, db);
    if (file) {
      await db
        .prepare('DELETE FROM files WHERE prefix = ?1 AND path = ?2')
        .bind(prefix, path)
        .run();
      return true;
    }

    if (!(await this.folderExists(prefix, path, db))) {
      return false;
    }

    const descendant = `${path}/%`;
    await db
      .prepare('DELETE FROM files WHERE prefix = ?1 AND (path = ?2 OR path LIKE ?3)')
      .bind(prefix, path, descendant)
      .run();
    await db
      .prepare('DELETE FROM folders WHERE prefix = ?1 AND (path = ?2 OR path LIKE ?3)')
      .bind(prefix, path, descendant)
      .run();
    return true;
  }

  async listFiles(prefix, path, db) {
    const pattern = path === '/' ? '/%' : `${path}/%`;
    const result = await db
      .prepare('SELECT path, size, modified_time, etag FROM files WHERE prefix = ?1 AND path LIKE ?2')
      .bind(prefix, pattern)
      .all();

    const rows = result.results || [];
    const files = [];

    for (const row of rows) {
      const filePath = String(row.path || '');
      const remainder = filePath.slice(path.length + 1);
      if (remainder.includes('/')) continue;
      files.push({
        path: filePath,
        file: {
          size: Number(row.size || 0),
          modified_time: String(row.modified_time || nowIso()),
          etag: String(row.etag || ''),
        },
      });
    }

    return files;
  }

  async listFolders(prefix, path, db) {
    const pattern = path === '/' ? '/%' : `${path}/%`;
    const result = await db
      .prepare('SELECT path FROM folders WHERE prefix = ?1 AND path LIKE ?2')
      .bind(prefix, pattern)
      .all();

    const rows = result.results || [];
    const folders = [];

    for (const row of rows) {
      const folderPath = String(row.path || '');
      const remainder = folderPath.slice(path.length + 1);
      if (!remainder || remainder.includes('/')) continue;
      folders.push(folderPath);
    }

    return folders;
  }

  async handlePropfind(prefix, path, depth, db) {
    if (depth === '0') {
      if (await this.folderExists(prefix, path, db)) {
        const body = propfindBody([
          responseNode({
            href: encodeHref(path, true),
            size: 0,
            modifiedIso: nowIso(),
            itemEtag: '',
            isCollection: true,
          }),
        ]);
        return new Response(body, {
          status: 207,
          headers: { 'Content-Type': 'application/xml; charset=utf-8' },
        });
      }

      const file = await this.getFile(prefix, path, db);
      if (!file) {
        return new Response('', { status: 404 });
      }

      const body = propfindBody([
        responseNode({
          href: encodeHref(path, false),
          size: Number(file.size || 0),
          modifiedIso: String(file.modified_time || nowIso()),
          itemEtag: String(file.etag || ''),
          isCollection: false,
        }),
      ]);

      return new Response(body, {
        status: 207,
        headers: { 'Content-Type': 'application/xml; charset=utf-8' },
      });
    }

    if (!(await this.folderExists(prefix, path, db))) {
      return new Response('', { status: 404 });
    }

    const nodes = [
      responseNode({
        href: encodeHref(path, true),
        size: 0,
        modifiedIso: nowIso(),
        itemEtag: '',
        isCollection: true,
      }),
    ];

    const [files, folders] = await Promise.all([this.listFiles(prefix, path, db), this.listFolders(prefix, path, db)]);

    for (const { path: filePath, file } of files) {
      nodes.push(
        responseNode({
          href: encodeHref(filePath, false),
          size: file.size,
          modifiedIso: file.modified_time,
          itemEtag: file.etag,
          isCollection: false,
        }),
      );
    }

    for (const folderPath of folders) {
      nodes.push(
        responseNode({
          href: encodeHref(folderPath, true),
          size: 0,
          modifiedIso: nowIso(),
          itemEtag: '',
          isCollection: true,
        }),
      );
    }

    return new Response(propfindBody(nodes), {
      status: 207,
      headers: { 'Content-Type': 'application/xml; charset=utf-8' },
    });
  }
}


