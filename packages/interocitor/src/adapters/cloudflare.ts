/**
 * Cloudflare Worker + D1 Storage Adapter (Interocitor-native protocol)
 *
 * This adapter is a perfect-fit backend for Interocitor only.
 * It does NOT parse XML and does NOT depend on WebDAV compatibility.
 *
 * Base URL shape:
 *   https://<worker>/io/<prefix>
 *
 * The adapter derives:
 *   https://<worker>/events/<prefix>  (SSE invalidations)
 */

import type { StorageAdapter, FileEntry } from '../core/types.ts';

export interface CloudflareAdapterConfig {
  /** Worker IO base URL that includes prefix, e.g. https://worker/io/team-a */
  baseUrl: string;
  /** Optional bearer for server/cost protection (INTEROCITOR_ACCESS_TOKEN). */
  token?: string;
}

interface IoFileMeta {
  name: string;
  path: string;
  size: number;
  modifiedTime: string;
  etag?: string;
}

/**
 * Interocitor-native Cloudflare adapter for Worker + D1 based deployments.
 *
 * Use this when you want a purpose-fit backend with optional SSE-driven
 * invalidation instead of a generic file protocol like WebDAV.
 *
 * @example
 * ```ts
 * const adapter = new CloudflareAdapter({
 *   baseUrl: 'https://example.com/io/team-a',
 *   token: 'optional-bearer-token',
 * });
 * ```
 */
export class CloudflareAdapter implements StorageAdapter {
  readonly name = 'cloudflare';

  private readonly config: CloudflareAdapterConfig;
  private authenticated = false;

  constructor(config: CloudflareAdapterConfig) {
    this.config = { ...config, baseUrl: config.baseUrl.replace(/\/$/, '') };
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const base: Record<string, string> = {};
    if (this.config.token) {
      base.Authorization = `Bearer ${this.config.token}`;
    }
    return { ...base, ...extra };
  }

  private get ioBaseUrl(): string {
    const u = new URL(this.config.baseUrl);
    if (!u.pathname.includes('/io/')) {
      throw new Error('CloudflareAdapter baseUrl must include /io/<prefix>');
    }
    return u.toString().replace(/\/$/, '');
  }

  private get eventsUrl(): string {
    const u = new URL(this.config.baseUrl);
    if (!u.pathname.includes('/io/')) {
      throw new Error('CloudflareAdapter baseUrl must include /io/<prefix>');
    }
    u.pathname = u.pathname.replace('/io/', '/events/');
    if (this.config.token) {
      u.searchParams.set('access_token', this.config.token);
    }
    return u.toString().replace(/\/$/, '');
  }

  private ioUrl(pathname: string): string {
    const clean = pathname.startsWith('/') ? pathname : `/${pathname}`;
    return `${this.ioBaseUrl}${clean}`;
  }

  private fileUrl(path: string): string {
    const u = new URL(this.ioUrl('/file'));
    u.searchParams.set('path', path);
    return u.toString();
  }

  async authenticate(): Promise<void> {
    const res = await fetch(this.ioUrl('/health'), {
      method: 'GET',
      headers: this.headers(),
    });

    if (res.ok) {
      this.authenticated = true;
      return;
    }

    if (res.status === 401 || res.status === 403) {
      throw new Error('Cloudflare Worker auth failed — check your access token');
    }

    throw new Error(`Cloudflare Worker unreachable: HTTP ${res.status}`);
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  subscribeToInvalidations(
    onInvalidate: (payload: { type: string; path: string; ts: number }) => void,
    hooks?: { onReady?: () => void; onError?: () => void },
  ): () => void {
    const source = new EventSource(this.eventsUrl);

    const handler = (e: Event) => {
      try {
        onInvalidate(JSON.parse((e as MessageEvent).data));
      } catch {
        onInvalidate({ type: 'unknown', path: '/', ts: Date.now() });
      }
    };
    const readyHandler = () => {
      hooks?.onReady?.();
    };
    const errorHandler = () => {
      hooks?.onError?.();
    };

    source.addEventListener('ready', readyHandler);
    source.addEventListener('invalidate', handler);
    source.addEventListener('compact', handler);
    source.addEventListener('error', errorHandler);

    return () => {
      source.removeEventListener('ready', readyHandler);
      source.removeEventListener('invalidate', handler);
      source.removeEventListener('compact', handler);
      source.removeEventListener('error', errorHandler);
      source.close();
    };
  }

  async ensureFolder(path: string): Promise<void> {
    const res = await fetch(this.ioUrl('/ensure-folder'), {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json; charset=utf-8' }),
      body: JSON.stringify({ path }),
    });

    if (!res.ok && res.status !== 405) {
      throw new Error(`Failed to ensure folder ${path}: HTTP ${res.status}`);
    }
  }

  async listFiles(path: string): Promise<FileEntry[]> {
    const res = await fetch(this.ioUrl('/list-files'), {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json; charset=utf-8' }),
      body: JSON.stringify({ path }),
    });

    if (!res.ok) {
      throw new Error(`Failed to list files for ${path}: HTTP ${res.status}`);
    }

    const payload = await res.json() as { files?: IoFileMeta[] };
    return (payload.files ?? []).map((f) => ({
      name: f.name,
      path: f.path,
      size: f.size,
      modifiedTime: f.modifiedTime,
      etag: f.etag,
    }));
  }

  async listFolders(path: string): Promise<string[]> {
    const res = await fetch(this.ioUrl('/list-folders'), {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json; charset=utf-8' }),
      body: JSON.stringify({ path }),
    });

    if (!res.ok) {
      throw new Error(`Failed to list folders for ${path}: HTTP ${res.status}`);
    }

    const payload = await res.json() as { folders?: string[] };
    return payload.folders ?? [];
  }

  async readFile(path: string): Promise<Uint8Array> {
    const res = await fetch(this.fileUrl(path), {
      method: 'GET',
      headers: this.headers(),
    });

    if (!res.ok) {
      throw new Error(`Failed to read ${path}: HTTP ${res.status}`);
    }

    return new Uint8Array(await res.arrayBuffer());
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;

    const res = await fetch(this.fileUrl(path), {
      method: 'PUT',
      headers: this.headers({ 'Content-Type': 'application/octet-stream' }),
      body: bytes as unknown as BodyInit,
    });

    if (!res.ok && res.status !== 201 && res.status !== 204) {
      throw new Error(`Failed to write ${path}: HTTP ${res.status}`);
    }
  }

  async deleteFile(path: string): Promise<void> {
    const res = await fetch(this.fileUrl(path), {
      method: 'DELETE',
      headers: this.headers(),
    });

    if (!res.ok && res.status !== 404 && res.status !== 405) {
      throw new Error(`Failed to delete ${path}: HTTP ${res.status}`);
    }
  }

  async getFileMetadata(path: string): Promise<FileEntry | null> {
    const res = await fetch(this.ioUrl('/metadata'), {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json; charset=utf-8' }),
      body: JSON.stringify({ path }),
    });

    if (res.status === 404) return null;
    if (!res.ok) return null;

    const payload = await res.json() as { file?: IoFileMeta | null };
    const f = payload.file;
    if (!f) return null;

    return {
      name: f.name,
      path: f.path,
      size: f.size,
      modifiedTime: f.modifiedTime,
      etag: f.etag,
    };
  }
}

