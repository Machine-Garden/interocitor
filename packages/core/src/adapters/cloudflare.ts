/**
 * Cloudflare Worker + D1 Storage Adapter (Interocitor-native protocol)
 *
 * This adapter is a perfect-fit backend for Interocitor only.
 * It does NOT parse XML and does NOT depend on WebDAV compatibility.
 *
 * Base URL shape:
 *   https://<worker>/io/<address>
 *
 * The adapter derives:
 *   wss://<worker>/notify/<address>  (WebSocket invalidations via InterocitorRelay DO)
 */

import type {
  StorageAdapter,
  FileEntry,
  RemoteInvalidationPayload,
  RemoteInvalidationHooks,
  StoredFileMetadata,
  StoredFileWriteOptions,
} from "../core/types.ts";

export interface CloudflareAdapterConfig {
  /** Worker IO base URL that includes a mesh address, e.g. https://worker/io/main */
  baseUrl: string;
  /** Optional bearer passed to the Worker with I/O and relay requests. */
  token?: string;
  /** Disable relay/WebSocket invalidations for this client. */
  relayEnabled?: boolean;
  /** Recovery endpoint, e.g. https://worker.example/sync/recovery. Required for phrase recovery. */
  recoveryBaseUrl?: string;
  /** Bearer forwarded to the recovery endpoint. Defaults to `token`. */
  recoveryToken?: string;
}

interface IoFileMeta {
  name: string;
  path: string;
  size: number;
  modifiedTime: string;
  etag?: string;
  uploadedByDeviceId?: string;
  uploadedAt?: string;
  lastAccessedAt?: string;
  useCount?: number;
  plaintextSize?: number;
  storedSize?: number;
  contentType?: string;
  taint?: string;
}

/**
 * Interocitor-native Cloudflare adapter for Worker + D1 based deployments.
 *
 * Use this when you want a purpose-fit backend with optional WebSocket-driven
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
/** Config shape embedded in QR payloads for CloudflareAdapter. Credentials excluded. */
export interface CloudflareHandshakeConfig {
  /** Worker IO base URL including the `/io/<address>` path segment. */
  baseUrl: string;
}

export class CloudflareAdapter implements StorageAdapter {
  readonly name = "cloudflare";

  private readonly config: CloudflareAdapterConfig;
  private authenticated = false;
  // Per-session cache of folders we have already ensured. Cloudflare's
  // /ensure-folder is idempotent but a POST per folder per connect is
  // pure round-trip overhead — Interocitor.connect re-runs the same
  // 4-folder loop on every reload. Cache wipes via `resetFolderCache()`
  // (mesh swap / poison) or process exit.
  private ensuredFolders: Set<string> = new Set();

  constructor(config: CloudflareAdapterConfig) {
    this.config = {
      ...config,
      baseUrl: config.baseUrl.replace(/\/$/, ""),
      relayEnabled: config.relayEnabled ?? true,
    };
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const base: Record<string, string> = {};
    if (this.config.token) {
      base.Authorization = `Bearer ${this.config.token}`;
    }
    return { ...base, ...extra };
  }

  private parseBaseUrl(): URL {
    const base = /^https?:\/\//i.test(this.config.baseUrl)
      ? this.config.baseUrl
      : new URL(this.config.baseUrl, "http://interocitor").toString();
    const u = new URL(base);
    if (!u.pathname.includes("/io/")) {
      throw new Error("CloudflareAdapter baseUrl must include /io/<address>");
    }
    return u;
  }

  private get ioBaseUrl(): string {
    const u = this.parseBaseUrl();
    if (!/^https?:\/\//i.test(this.config.baseUrl)) {
      return `${u.pathname}${u.search}${u.hash}`.replace(/\/$/, "");
    }
    return u.toString().replace(/\/$/, "");
  }

  private get notifyUrl(): string {
    const u = this.parseBaseUrl();
    u.pathname = u.pathname.replace("/io/", "/notify/");
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    if (this.config.token) {
      u.searchParams.set("access_token", this.config.token);
    }
    if (!/^https?:\/\//i.test(this.config.baseUrl)) {
      return `${u.pathname}${u.search}${u.hash}`.replace(/\/$/, "");
    }
    return u.toString().replace(/\/$/, "");
  }

  private ioUrl(pathname: string): string {
    const clean = pathname.startsWith("/") ? pathname : `/${pathname}`;
    return `${this.ioBaseUrl}${clean}`;
  }

  private fileUrl(path: string): string {
    const u = new URL(this.ioUrl("/file"));
    u.searchParams.set("path", path);
    return u.toString();
  }

  private storedFileUrl(path: string): string {
    const u = new URL(this.ioUrl("/stored-file"));
    u.searchParams.set("path", path);
    return u.toString();
  }

  private recoveryUrl(locator: string): string {
    if (!this.config.recoveryBaseUrl) {
      throw new Error(
        "Cloudflare recovery requires recoveryBaseUrl (for example https://worker.example/sync/recovery)",
      );
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(locator)) throw new Error("Invalid recovery locator");
    return `${this.config.recoveryBaseUrl.replace(/\/$/, "")}/${locator}`;
  }

  private recoveryHeaders(): Record<string, string> {
    const token = this.config.recoveryToken ?? this.config.token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async authenticate(): Promise<void> {
    const res = await fetch(this.ioUrl("/health"), {
      method: "GET",
      headers: this.headers(),
    });

    if (res.ok) {
      this.authenticated = true;
      return;
    }

    if (res.status === 401 || res.status === 403) {
      throw new Error("Cloudflare Worker auth failed — check your access token");
    }

    throw new Error(`Cloudflare Worker unreachable: HTTP ${res.status}`);
  }

  /**
   * Returns the worker base URL (without credentials) for embedding in a QR payload.
   * The scanner uses this to point their CloudflareAdapter at the same worker shard.
   */
  getHandshakeConfig(): string {
    const cfg: CloudflareHandshakeConfig = { baseUrl: this.config.baseUrl };
    return JSON.stringify(cfg);
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  subscribeToInvalidations(
    onInvalidate: (payload: RemoteInvalidationPayload) => void,
    hooks?: RemoteInvalidationHooks,
  ): () => void {
    if (this.config.relayEnabled === false) {
      hooks?.onClose?.();
      return () => {};
    }
    if (typeof WebSocket === "undefined") {
      hooks?.onError?.(
        new Error("Cloudflare relay invalidations require a WebSocket implementation"),
      );
      hooks?.onClose?.();
      return () => {};
    }
    let ws: WebSocket | null = null;
    let cancelled = false;
    let backoffMs = 1000;
    const MAX_BACKOFF_MS = 30_000;
    // Attempts where the socket closed before ever opening (failed upgrade).
    // After MAX_FAILED_UPGRADES consecutive such failures we back off to a long
    // cooldown interval rather than hammering (e.g. DO free-tier exhaustion).
    // Once the cooldown elapses we try again — self-healing if the server recovers.
    let failedUpgradeStreak = 0;
    const MAX_FAILED_UPGRADES = 5;
    const COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

    const connect = () => {
      if (cancelled) return;
      let opened = false;
      try {
        ws = new WebSocket(this.notifyUrl);
      } catch (error) {
        hooks?.onError?.(error);
        failedUpgradeStreak++;
        scheduleReconnect();
        return;
      }

      ws.onopen = () => {
        opened = true;
        failedUpgradeStreak = 0;
        backoffMs = 1000;
        hooks?.onReady?.();
      };

      ws.onmessage = (e: MessageEvent) => {
        try {
          const msg = JSON.parse(e.data as string) as { type: string; path: string; ts: number };
          if (msg.type === "invalidation" || msg.type === "invalidate" || msg.type === "compact") {
            onInvalidate(msg);
          }
        } catch {
          onInvalidate({ type: "unknown", path: "/", ts: Date.now() });
        }
      };

      ws.onerror = (event) => {
        hooks?.onError?.(event);
      };

      ws.onclose = () => {
        if (!opened) {
          // The upgrade itself failed (server returned non-101, e.g. 500/503).
          failedUpgradeStreak++;
        }
        if (!cancelled) {
          hooks?.onClose?.();
          if (failedUpgradeStreak >= MAX_FAILED_UPGRADES) {
            // Back off to a long cooldown then try again — self-healing if the
            // server recovers (e.g. DO free-tier resets).
            failedUpgradeStreak = 0;
            backoffMs = 1000;
            setTimeout(() => connect(), COOLDOWN_MS);
            return;
          }
          scheduleReconnect();
        }
      };
    };

    const scheduleReconnect = () => {
      if (cancelled) return;
      setTimeout(() => connect(), backoffMs);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    };

    connect();

    return () => {
      cancelled = true;
      try {
        ws?.close(1000, "unsubscribed");
      } catch {}
      ws = null;
    };
  }

  async ensureFolder(path: string): Promise<void> {
    if (this.ensuredFolders.has(path)) return;

    const res = await fetch(this.ioUrl("/ensure-folder"), {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json; charset=utf-8" }),
      body: JSON.stringify({ path }),
    });

    if (!res.ok && res.status !== 405) {
      throw new Error(`Failed to ensure folder ${path}: HTTP ${res.status}`);
    }
    this.ensuredFolders.add(path);
  }

  /** Drop the per-session ensureFolder cache. Call after mesh swap, poison,
   *  or any state where a previous "this folder exists" observation must
   *  not be trusted. */
  resetFolderCache(): void {
    this.ensuredFolders.clear();
  }

  async listFiles(path: string): Promise<FileEntry[]> {
    const res = await fetch(this.ioUrl("/list-files"), {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json; charset=utf-8" }),
      body: JSON.stringify({ path }),
    });

    if (!res.ok) {
      throw new Error(`Failed to list files for ${path}: HTTP ${res.status}`);
    }

    const payload = (await res.json()) as { files?: IoFileMeta[] };
    return (payload.files ?? []).map((f) => ({
      name: f.name,
      path: f.path,
      size: f.size,
      modifiedTime: f.modifiedTime,
      etag: f.etag,
    }));
  }

  async listFolders(path: string): Promise<string[]> {
    const res = await fetch(this.ioUrl("/list-folders"), {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json; charset=utf-8" }),
      body: JSON.stringify({ path }),
    });

    if (!res.ok) {
      throw new Error(`Failed to list folders for ${path}: HTTP ${res.status}`);
    }

    const payload = (await res.json()) as { folders?: string[] };
    return payload.folders ?? [];
  }

  async readFile(path: string): Promise<Uint8Array> {
    const res = await fetch(this.fileUrl(path), {
      method: "GET",
      headers: this.headers(),
    });

    if (!res.ok) {
      throw new Error(`Failed to read ${path}: HTTP ${res.status}`);
    }

    return new Uint8Array(await res.arrayBuffer());
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;

    const res = await fetch(this.fileUrl(path), {
      method: "PUT",
      headers: this.headers({ "Content-Type": "application/octet-stream" }),
      body: bytes as unknown as BodyInit,
    });

    if (!res.ok && res.status !== 201 && res.status !== 204) {
      throw new Error(`Failed to write ${path}: HTTP ${res.status}`);
    }
  }

  async deleteFile(path: string): Promise<void> {
    const res = await fetch(this.fileUrl(path), {
      method: "DELETE",
      headers: this.headers(),
    });

    if (!res.ok && res.status !== 404 && res.status !== 405) {
      throw new Error(`Failed to delete ${path}: HTTP ${res.status}`);
    }
  }

  async getFileMetadata(path: string): Promise<FileEntry | null> {
    const res = await fetch(this.ioUrl("/metadata"), {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json; charset=utf-8" }),
      body: JSON.stringify({ path }),
    });

    if (res.status === 404) return null;
    if (!res.ok) return null;

    const payload = (await res.json()) as { file?: IoFileMeta | null };
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

  /**
   * Read a recovery wrapper from `recoveryBaseUrl` without a mesh ID.
   * Rejects an invalid locator, missing recovery URL, or non-2xx response.
   */
  async readRecoveryWrapper(locator: string): Promise<Uint8Array> {
    const res = await fetch(this.recoveryUrl(locator), {
      method: "GET",
      headers: this.recoveryHeaders(),
    });
    if (!res.ok) throw new Error(`Failed to read recovery wrapper: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * Publish a serialized recovery wrapper to `recoveryBaseUrl`.
   * Rejects an invalid locator, missing recovery URL, or non-2xx response.
   * The adapter sends bytes as supplied and does not inspect their contents.
   */
  async writeRecoveryWrapper(locator: string, data: Uint8Array): Promise<void> {
    const res = await fetch(this.recoveryUrl(locator), {
      method: "PUT",
      headers: this.recoveryHeaders(),
      body: data as unknown as BodyInit,
    });
    if (!res.ok) throw new Error(`Failed to write recovery wrapper: HTTP ${res.status}`);
  }

  async putStoredFile(
    path: string,
    data: Uint8Array | string,
    options: StoredFileWriteOptions = {},
  ): Promise<StoredFileMetadata> {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const res = await fetch(this.storedFileUrl(path), {
      method: "PUT",
      headers: this.headers({
        "Content-Type": options.contentType || "application/octet-stream",
        "X-Interocitor-Device-Id": options.uploadedByDeviceId || "",
        "X-Interocitor-Plaintext-Size": String(options.plaintextSize ?? bytes.byteLength),
        ...(options.taint ? { "X-Interocitor-Taint": options.taint } : {}),
      }),
      body: bytes as unknown as BodyInit,
    });
    if (!res.ok) throw new Error(`Failed to upload stored file ${path}: HTTP ${res.status}`);
    const payload = (await res.json()) as { file: StoredFileMetadata };
    return payload.file;
  }

  async getStoredFile(path: string): Promise<Uint8Array> {
    const res = await fetch(this.storedFileUrl(path), { method: "GET", headers: this.headers() });
    if (!res.ok) throw new Error(`Failed to read stored file ${path}: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async deleteStoredFile(path: string): Promise<void> {
    const res = await fetch(this.storedFileUrl(path), {
      method: "DELETE",
      headers: this.headers(),
    });
    if (!res.ok && res.status !== 404)
      throw new Error(`Failed to delete stored file ${path}: HTTP ${res.status}`);
  }

  async getStoredFileMetadata(path: string): Promise<StoredFileMetadata | null> {
    const res = await fetch(this.ioUrl("/stored-file-metadata"), {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json; charset=utf-8" }),
      body: JSON.stringify({ path }),
    });
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const payload = (await res.json()) as { file?: StoredFileMetadata | null };
    return payload.file ?? null;
  }
}
