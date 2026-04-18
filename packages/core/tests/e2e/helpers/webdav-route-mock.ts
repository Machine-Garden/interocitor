import type { BrowserContext, Request, Route } from '@playwright/test';

const encoder = new TextEncoder();

interface WebDavFile {
  data: Uint8Array;
  modifiedTime: string;
  etag: string;
}

export interface WebDavRouteState {
  files: Map<string, WebDavFile>;
  folders: Set<string>;
}

export function createWebDavRouteState(): WebDavRouteState {
  return {
    files: new Map(),
    folders: new Set(['/']),
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function toHttpDate(iso: string): string {
  return new Date(iso).toUTCString();
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function encodePath(path: string): string {
  return path
    .split('/')
    .filter(Boolean)
    .map(segment => encodeURIComponent(segment))
    .join('/');
}

function parseDavPath(request: Request, prefix: string): string | null {
  const url = new URL(request.url());
  if (!url.pathname.startsWith(prefix)) return null;

  const raw = url.pathname.slice(prefix.length) || '/';
  const normalized = `/${raw}`.replaceAll(/\/+/g, '/');
  const clean = normalized.length > 1 && normalized.endsWith('/')
    ? normalized.slice(0, -1)
    : normalized;

  return decodeURIComponent(clean);
}

function makeResponseNode(prefix: string, params: {
  hrefPath: string;
  size: number;
  modifiedIso: string;
  etag: string;
  isCollection: boolean;
}): string {
  const href = params.isCollection
    ? `${prefix}/${encodePath(params.hrefPath)}/`
    : `${prefix}/${encodePath(params.hrefPath)}`;
  const contentLength = params.isCollection ? '' : `<d:getcontentlength>${params.size}</d:getcontentlength>`;
  const resourceType = params.isCollection ? '<d:collection/>' : '';

  return `<d:response>
  <d:href>${escapeXml(href)}</d:href>
  <d:propstat>
    <d:prop>
      ${contentLength}
      <d:getlastmodified>${escapeXml(toHttpDate(params.modifiedIso))}</d:getlastmodified>
      <d:resourcetype>${resourceType}</d:resourcetype>
      <d:getetag>${escapeXml(params.etag)}</d:getetag>
    </d:prop>
    <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
</d:response>`;
}

function makePropfindXml(nodes: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<d:multistatus xmlns:d="DAV:">\n${nodes.join('\n')}\n</d:multistatus>`;
}

async function handleRoute(route: Route, request: Request, state: WebDavRouteState, prefix: string): Promise<void> {
  const path = parseDavPath(request, prefix);
  if (!path) {
    await route.continue();
    return;
  }

  const method = request.method().toUpperCase();

  if (method === 'PROPFIND') {
    const depth = request.headerValue('depth') ?? '0';

    if (depth === '0') {
      if (state.folders.has(path)) {
        const body = makePropfindXml([
          makeResponseNode(prefix, {
            hrefPath: path,
            size: 0,
            modifiedIso: nowIso(),
            etag: '',
            isCollection: true,
          }),
        ]);
        await route.fulfill({ status: 207, body, headers: { 'content-type': 'application/xml' } });
        return;
      }

      const file = state.files.get(path);
      if (!file) {
        await route.fulfill({ status: 404, body: '' });
        return;
      }

      const body = makePropfindXml([
        makeResponseNode(prefix, {
          hrefPath: path,
          size: file.data.length,
          modifiedIso: file.modifiedTime,
          etag: file.etag,
          isCollection: false,
        }),
      ]);
      await route.fulfill({ status: 207, body, headers: { 'content-type': 'application/xml' } });
      return;
    }

    if (!state.folders.has(path)) {
      await route.fulfill({ status: 404, body: '' });
      return;
    }

    const nodes: string[] = [
      makeResponseNode(prefix, {
        hrefPath: path,
        size: 0,
        modifiedIso: nowIso(),
        etag: '',
        isCollection: true,
      }),
    ];

    for (const [filePath, file] of state.files) {
      if (!filePath.startsWith(`${path}/`)) continue;
      const remainder = filePath.slice(path.length + 1);
      if (remainder.includes('/')) continue;

      nodes.push(makeResponseNode(prefix, {
        hrefPath: filePath,
        size: file.data.length,
        modifiedIso: file.modifiedTime,
        etag: file.etag,
        isCollection: false,
      }));
    }

    // Include immediate child folders as collection entries
    for (const folder of state.folders) {
      if (!folder.startsWith(`${path}/`)) continue;
      const remainder = folder.slice(path.length + 1);
      if (!remainder || remainder.includes('/')) continue;

      nodes.push(makeResponseNode(prefix, {
        hrefPath: folder,
        size: 0,
        modifiedIso: nowIso(),
        etag: '',
        isCollection: true,
      }));
    }

    const body = makePropfindXml(nodes);
    await route.fulfill({ status: 207, body, headers: { 'content-type': 'application/xml' } });
    return;
  }

  if (method === 'MKCOL') {
    // Return 201 for already-existing folders (idempotent, not 405).
    // Avoids browser console errors when multiple devices create shared paths.
    if (state.folders.has(path)) {
      await route.fulfill({ status: 201, body: '' });
      return;
    }

    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) || '/' : '/';
    if (!state.folders.has(parent)) {
      await route.fulfill({ status: 409, body: '' });
      return;
    }

    state.folders.add(path);
    await route.fulfill({ status: 201, body: '' });
    return;
  }

  if (method === 'PUT') {
    const body = request.postDataBuffer();
    const bytes = body ? new Uint8Array(body) : encoder.encode('');
    const existed = state.files.has(path);
    state.files.set(path, {
      data: bytes,
      modifiedTime: nowIso(),
      etag: `"etag-${Math.random().toString(16).slice(2)}"`,
    });
    await route.fulfill({ status: existed ? 204 : 201, body: '' });
    return;
  }

  if (method === 'GET') {
    const file = state.files.get(path);
    if (!file) {
      await route.fulfill({ status: 404, body: '' });
      return;
    }

    await route.fulfill({ status: 200, body: Buffer.from(file.data) });
    return;
  }

  if (method === 'DELETE') {
    // File deletion
    if (state.files.delete(path)) {
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    // Collection (folder) deletion — recursive
    if (state.folders.has(path)) {
      for (const [filePath] of state.files) {
        if (filePath.startsWith(`${path}/`)) state.files.delete(filePath);
      }
      for (const folder of state.folders) {
        if (folder.startsWith(`${path}/`)) state.folders.delete(folder);
      }
      state.folders.delete(path);
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    await route.fulfill({ status: 404, body: '' });
    return;
  }

  await route.fulfill({ status: 405, body: '' });
}

export async function attachWebDavRouteMock(
  context: BrowserContext,
  state: WebDavRouteState,
  prefix = '/__webdav__'
): Promise<void> {
  const handler = async (route: Route, request: Request) => {
    await handleRoute(route, request, state, prefix);
  };

  await context.route(`**${prefix}`, handler);
  await context.route(`**${prefix}/**`, handler);
}

