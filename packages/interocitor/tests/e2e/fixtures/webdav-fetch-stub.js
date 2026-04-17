const PREFIX = '/__webdav__';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function nowIso() {
  return new Date().toISOString();
}

function toHttpDate(iso) {
  return new Date(iso).toUTCString();
}

function encodePath(path) {
  return path
    .split('/')
    .filter(Boolean)
    .map(segment => encodeURIComponent(segment))
    .join('/');
}

function escapeXml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function parseDavPath(input) {
  const url = new URL(input, location.origin);
  if (!url.pathname.startsWith(PREFIX)) {
    return null;
  }

  const raw = url.pathname.slice(PREFIX.length) || '/';
  const normalized = `/${raw}`.replaceAll(/\/+/g, '/');
  const clean = normalized.length > 1 && normalized.endsWith('/')
    ? normalized.slice(0, -1)
    : normalized;

  return decodeURIComponent(clean);
}

function makePropfindResponse(entries) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<d:multistatus xmlns:d="DAV:">
${entries.join('\n')}
</d:multistatus>`;
}

function makeResponseNode({ href, size, modifiedIso, etag, isCollection }) {
  const resourceType = isCollection ? '<d:collection/>' : '';
  const contentLength = isCollection ? '' : `<d:getcontentlength>${size}</d:getcontentlength>`;
  return `<d:response>
  <d:href>${escapeXml(href)}</d:href>
  <d:propstat>
    <d:prop>
      ${contentLength}
      <d:getlastmodified>${escapeXml(toHttpDate(modifiedIso))}</d:getlastmodified>
      <d:resourcetype>${resourceType}</d:resourcetype>
      <d:getetag>${escapeXml(etag || '')}</d:getetag>
    </d:prop>
    <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
</d:response>`;
}

function createStore() {
  const files = new Map();
  const folders = new Set(['/']);
  let forceUnauthorized = false;

  return {
    resetCloud() {
      files.clear();
      folders.clear();
      folders.add('/');
      forceUnauthorized = false;
    },
    setUnauthorized(enabled) {
      forceUnauthorized = Boolean(enabled);
    },
    async resetIndexedDb() {
      await new Promise((resolve, reject) => {
        const req = indexedDB.deleteDatabase('interocitor');
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('IndexedDB delete blocked'));
      });
    },
    dumpFiles() {
      const result = {};
      for (const [path, file] of files) {
        result[path] = decoder.decode(file.data);
      }
      return result;
    },
    hasFile(path) {
      return files.has(path);
    },
    async fetch(input, init = {}) {
      const method = (init.method || 'GET').toUpperCase();
      const path = parseDavPath(typeof input === 'string' ? input : input.url);
      if (!path) {
        return fetch(input, init);
      }

      if (forceUnauthorized) {
        return new Response('', { status: 401 });
      }

      if (method === 'PROPFIND') {
        const depth = init.headers && typeof init.headers === 'object'
          ? (init.headers.Depth || init.headers.depth || '0')
          : '0';

        if (depth === '0') {
          if (folders.has(path)) {
            const href = `${PREFIX}/${encodePath(path)}/`;
            const body = makePropfindResponse([
              makeResponseNode({
                href,
                size: 0,
                modifiedIso: nowIso(),
                etag: '',
                isCollection: true,
              }),
            ]);
            return new Response(body, { status: 207 });
          }

          const file = files.get(path);
          if (!file) return new Response('', { status: 404 });

          const href = `${PREFIX}/${encodePath(path)}`;
          const body = makePropfindResponse([
            makeResponseNode({
              href,
              size: file.data.length,
              modifiedIso: file.modifiedTime,
              etag: file.etag,
              isCollection: false,
            }),
          ]);
          return new Response(body, { status: 207 });
        }

        if (!folders.has(path)) {
          return new Response('', { status: 404 });
        }

        const baseHref = `${PREFIX}/${encodePath(path)}/`;
        const nodes = [
          makeResponseNode({
            href: baseHref,
            size: 0,
            modifiedIso: nowIso(),
            etag: '',
            isCollection: true,
          }),
        ];

        for (const [filePath, file] of files) {
          if (!filePath.startsWith(`${path}/`)) continue;
          const remainder = filePath.slice(path.length + 1);
          if (remainder.includes('/')) continue;

          nodes.push(makeResponseNode({
            href: `${PREFIX}/${encodePath(filePath)}`,
            size: file.data.length,
            modifiedIso: file.modifiedTime,
            etag: file.etag,
            isCollection: false,
          }));
        }

        // Include immediate child folders as collection entries
        for (const folder of folders) {
          if (!folder.startsWith(`${path}/`)) continue;
          const remainder = folder.slice(path.length + 1);
          if (!remainder || remainder.includes('/')) continue;

          nodes.push(makeResponseNode({
            href: `${PREFIX}/${encodePath(folder)}/`,
            size: 0,
            modifiedIso: nowIso(),
            etag: '',
            isCollection: true,
          }));
        }

        return new Response(makePropfindResponse(nodes), { status: 207 });
      }

      if (method === 'MKCOL') {
        // Return 201 for already-existing folders (idempotent, not 405).
        // Avoids browser console errors when multiple devices create shared paths.
        if (folders.has(path)) {
          return new Response('', { status: 201 });
        }

        const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) || '/' : '/';
        if (!folders.has(parent)) {
          return new Response('', { status: 409 });
        }

        folders.add(path);
        return new Response('', { status: 201 });
      }

      if (method === 'PUT') {
        const body = init.body;
        let bytes;

        if (body instanceof Uint8Array) {
          bytes = body;
        } else if (body instanceof ArrayBuffer) {
          bytes = new Uint8Array(body);
        } else if (typeof body === 'string') {
          bytes = encoder.encode(body);
        } else {
          const text = body === null || body === undefined ? '' : String(body);
          bytes = encoder.encode(text);
        }

        const existed = files.has(path);
        files.set(path, {
          data: bytes,
          modifiedTime: nowIso(),
          etag: `"etag-${Math.random().toString(16).slice(2)}"`,
        });
        return new Response(null, { status: existed ? 204 : 201 });
      }

      if (method === 'GET') {
        const file = files.get(path);
        if (!file) return new Response('', { status: 404 });
        return new Response(file.data, { status: 200 });
      }

      if (method === 'DELETE') {
        // File deletion
        if (files.delete(path)) {
          return new Response(null, { status: 204 });
        }
        // Collection (folder) deletion — recursive
        if (folders.has(path)) {
          for (const filePath of files.keys()) {
            if (filePath.startsWith(`${path}/`)) files.delete(filePath);
          }
          for (const folder of folders) {
            if (folder.startsWith(`${path}/`)) folders.delete(folder);
          }
          folders.delete(path);
          return new Response(null, { status: 204 });
        }
        return new Response(null, { status: 404 });
      }

      return new Response('', { status: 405 });
    },
  };
}

const store = createStore();
const originalFetch = window.fetch.bind(window);

window.__webdavMock = {
  resetCloud: () => store.resetCloud(),
  setUnauthorized: enabled => store.setUnauthorized(enabled),
  resetIndexedDb: () => store.resetIndexedDb(),
  dumpFiles: () => store.dumpFiles(),
  hasFile: path => store.hasFile(path),
  originalFetch,
};

window.fetch = (input, init) => store.fetch(input, init);

