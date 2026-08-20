/**
 * WebDAV Storage Adapter
 *
 * For self-hosted clouds: Nextcloud, ownCloud, or any WebDAV server.
 * "My own cloud" option — user runs their own server.
 *
 * WebDAV is HTTP-based and works anywhere `fetch` is available.
 * Most implementations support Basic auth or Bearer tokens.
 */

import type { StorageAdapter, FileEntry, StoredFileMetadata, StoredFileWriteOptions } from '../core/types.ts';

export interface WebDAVConfig {
  /** Base URL of the WebDAV endpoint, e.g. "https://cloud.example.com/remote.php/dav/files/username" */
  baseUrl: string;
  /** Auth: either { username, password } for Basic auth, or { token } for Bearer */
  auth: { username: string; password: string } | { token: string };
}

/**
 * WebDAV adapter for Nextcloud, ownCloud, and compatible DAV servers.
 *
 * @example
 * ```ts
 * const adapter = new WebDAVAdapter({
 *   baseUrl: 'https://cloud.example.com/remote.php/dav/files/alice',
 *   auth: { username: 'alice', password: 'APP_PASSWORD' },
 * });
 * ```
 */
export class WebDAVAdapter implements StorageAdapter {
  readonly name = 'webdav';

  private config: WebDAVConfig;
  private authenticated = false;
  // Per-session cache of folders we have already MKCOL'd. WebDAV folders
  // are stable for the life of the mesh; a caller (Interocitor.connect)
  // re-runs the same 4-folder ensureFolder loop on every reload, which
  // costs 4 sequential MKCOL round-trips for no benefit. Cache wipes on
  // explicit `resetFolderCache()` (mesh swap / poison) or process exit.
  private ensuredFolders: Set<string> = new Set();

  constructor(config: WebDAVConfig) {
    this.config = config;
  }

  private url(path: string): string {
    const base = this.config.baseUrl.replace(/\/$/, '');
    const clean = path.startsWith('/') ? path : '/' + path;
    return base + clean;
  }

  private authHeader(): string {
    const auth = this.config.auth;
    if ('token' in auth) {
      return `Bearer ${auth.token}`;
    }
    return `Basic ${encodeBase64(`${auth.username}:${auth.password}`)}`;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: this.authHeader(),
      ...extra,
    };
  }

  async authenticate(): Promise<void> {
    // Verify credentials by doing a PROPFIND on root
    const res = await fetch(this.url('/'), {
      method: 'PROPFIND',
      headers: this.headers({ Depth: '0' }),
    });

    if (res.status === 207 || res.ok) {
      this.authenticated = true;
    } else if (res.status === 401) {
      throw new Error('WebDAV authentication failed');
    } else {
      throw new Error(`WebDAV error: ${res.status}`);
    }
  }

  /**
   * Returns the WebDAV base URL (without credentials) for embedding in a QR payload.
   * The scanner uses this to point their WebDAVAdapter at the same server.
   * Auth (username/password or token) must be configured separately by the user.
   */
  getHandshakeConfig(): string {
    return JSON.stringify({ baseUrl: this.config.baseUrl });
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  async ensureFolder(path: string): Promise<void> {
    if (this.ensuredFolders.has(path)) return;

    const parts = path.split('/').filter(Boolean);
    let current = '';

    for (const part of parts) {
      current += '/' + part;
      if (this.ensuredFolders.has(current)) continue; // ancestor cached
      const res = await fetch(this.url(current), {
        method: 'MKCOL',
        headers: this.headers(),
      });
      // 201 Created, 405 Already Exists — both fine
      if (!res.ok && res.status !== 405) {
        throw new Error(`Failed to create folder ${current}: ${res.status}`);
      }
      this.ensuredFolders.add(current);
    }
    this.ensuredFolders.add(path);
  }

  /** Drop the per-session ensureFolder cache. Call after mesh swap, poison,
   *  or any state where we cannot trust a previous "this folder exists"
   *  observation. */
  resetFolderCache(): void {
    this.ensuredFolders.clear();
  }

  async listFiles(folderPath: string): Promise<FileEntry[]> {
    const res = await fetch(this.url(folderPath), {
      method: 'PROPFIND',
      headers: this.headers({
        Depth: '1',
        'Content-Type': 'application/xml',
      }),
      body: `<?xml version="1.0" encoding="UTF-8"?>
        <d:propfind xmlns:d="DAV:">
          <d:prop>
            <d:getcontentlength/>
            <d:getlastmodified/>
            <d:resourcetype/>
            <d:getetag/>
          </d:prop>
        </d:propfind>`,
    });

    if (res.status !== 207) {
      throw new Error(`PROPFIND failed: ${res.status}`);
    }

    const xml = await res.text();
    return this.parsePropfindResponse(xml, folderPath);
  }

  private parsePropfindResponse(xml: string, basePath: string): FileEntry[] {
    const responses = parseDavResponses(xml);
    const entries: FileEntry[] = [];

    for (let i = 0; i < responses.length; i++) {
      const response = responses[i];
      const href = tagText(response, 'href') || '';

      // Skip the folder itself (first response)
      if (i === 0) continue;

      // Skip sub-folders
      if (hasTag(response, 'collection')) continue;

      const size = tagText(response, 'getcontentlength') || '0';
      const modified = tagText(response, 'getlastmodified') || '';
      const etag = tagText(response, 'getetag') || undefined;

      // Extract filename from href
      const name = decodeURIComponent(href.split('/').filter(Boolean).pop() || '');

      entries.push({
        name,
        path: `${basePath}/${name}`,
        size: parseInt(size, 10),
        modifiedTime: modified ? new Date(modified).toISOString() : '',
        etag,
      });
    }

    return entries;
  }

  async listFolders(folderPath: string): Promise<string[]> {
    const res = await fetch(this.url(folderPath), {
      method: 'PROPFIND',
      headers: this.headers({
        Depth: '1',
        'Content-Type': 'application/xml',
      }),
      body: `<?xml version="1.0" encoding="UTF-8"?>
        <d:propfind xmlns:d="DAV:">
          <d:prop>
            <d:resourcetype/>
          </d:prop>
        </d:propfind>`,
    });

    if (res.status !== 207) return [];

    const xml = await res.text();
    const responses = parseDavResponses(xml);
    const folders: string[] = [];

    for (let i = 1; i < responses.length; i++) {
      const response = responses[i];
      if (!hasTag(response, 'collection')) continue;
      const href = tagText(response, 'href') || '';
      const name = decodeURIComponent(href.split('/').filter(Boolean).pop() || '');
      if (name) folders.push(name);
    }

    return folders;
  }

  async readFile(path: string): Promise<Uint8Array> {
    const res = await fetch(this.url(path), {
      method: 'GET',
      headers: this.headers(),
    });

    if (!res.ok) throw new Error(`Failed to read ${path}: ${res.status}`);

    const buffer = await res.arrayBuffer();
    return new Uint8Array(buffer);
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    const body = typeof data === 'string'
      ? new TextEncoder().encode(data)
      : data;

    const res = await fetch(this.url(path), {
      method: 'PUT',
      headers: this.headers({ 'Content-Type': 'application/octet-stream' }),
      body: body as unknown as BodyInit,
    });

    if (!res.ok && res.status !== 201 && res.status !== 204) {
      throw new Error(`Failed to write ${path}: ${res.status}`);
    }
  }

  async deleteFile(path: string): Promise<void> {
    const res = await fetch(this.url(path), {
      method: 'DELETE',
      headers: this.headers(),
    });

    // 204 No Content or 404 Not Found — both acceptable
    if (!res.ok && res.status !== 404) {
      throw new Error(`Failed to delete ${path}: ${res.status}`);
    }
  }

  private parentDir(path: string): string {
    const clean = path.startsWith('/') ? path : `/${path}`;
    const idx = clean.lastIndexOf('/');
    return idx <= 0 ? '/' : clean.slice(0, idx);
  }

  private storedMetaPath(path: string): string {
    return `${path}.interocitor-meta.json`;
  }

  async putStoredFile(path: string, data: Uint8Array | string, options: StoredFileWriteOptions = {}): Promise<StoredFileMetadata> {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    await this.ensureFolder(this.parentDir(path));
    await this.writeFile(path, bytes);
    const file = await this.getFileMetadata(path);
    const now = new Date().toISOString();
    const meta: StoredFileMetadata = {
      name: file?.name ?? path.split('/').pop() ?? path,
      path,
      size: file?.size ?? bytes.byteLength,
      modifiedTime: file?.modifiedTime ?? now,
      etag: file?.etag,
      uploadedAt: now,
      uploadedByDeviceId: options.uploadedByDeviceId,
      plaintextSize: options.plaintextSize,
      storedSize: bytes.byteLength,
      contentType: options.contentType,
      taint: options.taint,
      useCount: 0,
    };
    await this.writeFile(this.storedMetaPath(path), JSON.stringify(meta));
    return meta;
  }

  async getStoredFile(path: string): Promise<Uint8Array> {
    const bytes = await this.readFile(path);
    const meta = await this.getStoredFileMetadata(path);
    if (meta) {
      await this.writeFile(this.storedMetaPath(path), JSON.stringify({
        ...meta,
        lastAccessedAt: new Date().toISOString(),
        useCount: (meta.useCount ?? 0) + 1,
      }));
    }
    return bytes;
  }

  async deleteStoredFile(path: string): Promise<void> {
    await this.deleteFile(path);
    try { await this.deleteFile(this.storedMetaPath(path)); } catch {}
  }

  async getStoredFileMetadata(path: string): Promise<StoredFileMetadata | null> {
    try {
      const raw = await this.readFile(this.storedMetaPath(path));
      return JSON.parse(new TextDecoder().decode(raw)) as StoredFileMetadata;
    } catch {
      const file = await this.getFileMetadata(path);
      return file ? { ...file, storedSize: file.size } : null;
    }
  }

  async getFileMetadata(path: string): Promise<FileEntry | null> {
    const res = await fetch(this.url(path), {
      method: 'PROPFIND',
      headers: this.headers({
        Depth: '0',
        'Content-Type': 'application/xml',
      }),
      body: `<?xml version="1.0" encoding="UTF-8"?>
        <d:propfind xmlns:d="DAV:">
          <d:prop>
            <d:getcontentlength/>
            <d:getlastmodified/>
            <d:getetag/>
          </d:prop>
        </d:propfind>`,
    });

    if (res.status === 404) return null;
    if (res.status !== 207) return null;

    const xml = await res.text();
    // PROPFIND with Depth:0 on a file returns one entry for itself
    // but the directory-listing parser skips index 0, so handle it directly.
    const response = parseDavResponses(xml)[0];
    if (!response) return null;

    const size = tagText(response, 'getcontentlength') || '0';
    const modified = tagText(response, 'getlastmodified') || '';
    const etag = tagText(response, 'getetag') || undefined;
    const name = path.split('/').filter(Boolean).pop() || '';

    return {
      name,
      path,
      size: parseInt(size, 10),
      modifiedTime: modified ? new Date(modified).toISOString() : '',
      etag,
    };
  }
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const browserEncode = (globalThis as { btoa?: (input: string) => string }).btoa;
  if (browserEncode) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCodePoint(byte);
    return browserEncode(binary);
  }

  const bufferCtor = (globalThis as {
    Buffer?: { from(input: Uint8Array): { toString(encoding: 'base64'): string } };
  }).Buffer;
  if (bufferCtor) return bufferCtor.from(bytes).toString('base64');

  throw new Error('No base64 encoder is available in this runtime');
}

function parseDavResponses(xml: string): string[] {
  return xml.match(/<(?:[\w.-]+:)?response\b[\s\S]*?<\/(?:[\w.-]+:)?response>/gi) ?? [];
}

function tagText(xml: string, localName: string): string | null {
  const escaped = localName.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<(?:[\\w.-]+:)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${escaped}>`, 'i').exec(xml);
  if (!match) return null;
  return decodeXml(match[1].replaceAll(/<[^>]+>/g, '').trim());
}

function hasTag(xml: string, localName: string): boolean {
  const escaped = localName.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<(?:[\\w.-]+:)?${escaped}\\b`, 'i').test(xml);
}

function decodeXml(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}
