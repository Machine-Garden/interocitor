/**
 * In-Memory Storage Adapter
 *
 * For testing and development. No network, no persistence.
 * Also serves as a reference implementation for the StorageAdapter interface.
 */

import type { StorageAdapter, FileEntry, StoredFileMetadata, StoredFileWriteOptions } from '../core/types.ts';

/**
 * In-memory implementation of {@link StorageAdapter}.
 *
 * Useful for tests, demos, and local experiments where persistence is not
 * required.
 *
 * @example
 * ```ts
 * const adapter = new MemoryAdapter();
 * const engine = new Interocitor(adapter, { remotePath: '/Demo' });
 * ```
 */
export class MemoryAdapter implements StorageAdapter {
  readonly name = 'memory';

  private files: Map<string, { data: Uint8Array; modifiedTime: string }> = new Map();
  private storedFileMetadata: Map<string, StoredFileMetadata> = new Map();
  private folders: Set<string> = new Set();
  private authenticated = false;
  // Mirrors the cloud-adapter convention: cache "ensured" paths so a
  // re-`ensureFolder` is a no-op. Memory adapter is cheap, but keeping
  // the same shape lets tests assert call-count parity with the real
  // adapters (cloudflare, webdav).
  private ensuredFolders: Set<string> = new Set();

  async authenticate(): Promise<void> {
    this.authenticated = true;
  }

  /**
   * Memory adapter has no real backend — returns an empty config.
   * Only useful in tests where both sides share the same in-memory store.
   */
  getHandshakeConfig(): string {
    return JSON.stringify({});
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  async ensureFolder(path: string): Promise<void> {
    if (this.ensuredFolders.has(path)) return;
    this.folders.add(path);
    this.ensuredFolders.add(path);
  }

  /** Drop the per-session ensureFolder cache. Tests / mesh-swap callers. */
  resetFolderCache(): void {
    this.ensuredFolders.clear();
  }

  async listFiles(folderPath: string): Promise<FileEntry[]> {
    const prefix = folderPath.endsWith('/') ? folderPath : folderPath + '/';
    const entries: FileEntry[] = [];

    for (const [path, file] of this.files) {
      if (path.startsWith(prefix)) {
        const remaining = path.slice(prefix.length);
        // Only direct children (no nested slashes)
        if (!remaining.includes('/')) {
          entries.push({
            name: remaining,
            path,
            size: file.data.length,
            modifiedTime: file.modifiedTime,
          });
        }
      }
    }

    return entries;
  }

  /** List immediate subfolder names under a path. */
  async listFolders(folderPath: string): Promise<string[]> {
    const prefix = folderPath.endsWith('/') ? folderPath : folderPath + '/';
    const names = new Set<string>();
    for (const path of this.files.keys()) {
      if (path.startsWith(prefix)) {
        const remaining = path.slice(prefix.length);
        const slash = remaining.indexOf('/');
        if (slash > 0) {
          names.add(remaining.slice(0, slash));
        }
      }
    }
    for (const folder of this.folders) {
      if (folder.startsWith(prefix)) {
        const remaining = folder.slice(prefix.length);
        if (remaining && !remaining.includes('/')) {
          names.add(remaining);
        }
      }
    }
    return [...names];
  }

  async readFile(path: string): Promise<Uint8Array> {
    const file = this.files.get(path);
    if (!file) throw new Error(`Object not found: ${path}`);
    return file.data;
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    const bytes = typeof data === 'string'
      ? new TextEncoder().encode(data)
      : data;
    this.files.set(path, {
      data: bytes,
      modifiedTime: new Date().toISOString(),
    });
  }

  async deleteFile(path: string): Promise<void> {
    this.files.delete(path);
  }

  async getFileMetadata(path: string): Promise<FileEntry | null> {
    const file = this.files.get(path);
    if (!file) return null;
    const name = path.split('/').pop() || path;
    return {
      name,
      path,
      size: file.data.length,
      modifiedTime: file.modifiedTime,
    };
  }

  async putStoredFile(path: string, data: Uint8Array | string, options: StoredFileWriteOptions = {}): Promise<StoredFileMetadata> {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    await this.writeFile(path, bytes);
    const now = new Date().toISOString();
    const meta: StoredFileMetadata = {
      name: path.split('/').pop() || path,
      path,
      size: bytes.byteLength,
      modifiedTime: now,
      uploadedAt: now,
      uploadedByDeviceId: options.uploadedByDeviceId,
      plaintextSize: options.plaintextSize,
      storedSize: bytes.byteLength,
      contentType: options.contentType,
      lastAccessedAt: undefined,
      useCount: 0,
    };
    this.storedFileMetadata.set(path, meta);
    return { ...meta };
  }

  async getStoredFile(path: string): Promise<Uint8Array> {
    const bytes = await this.readFile(path);
    const meta = this.storedFileMetadata.get(path);
    if (meta) {
      const next = { ...meta, lastAccessedAt: new Date().toISOString(), useCount: (meta.useCount ?? 0) + 1 };
      this.storedFileMetadata.set(path, next);
    }
    return bytes;
  }

  async deleteStoredFile(path: string): Promise<void> {
    await this.deleteFile(path);
    this.storedFileMetadata.delete(path);
  }

  async getStoredFileMetadata(path: string): Promise<StoredFileMetadata | null> {
    const meta = this.storedFileMetadata.get(path);
    if (meta) return { ...meta };
    const file = await this.getFileMetadata(path);
    return file ? { ...file, storedSize: file.size } : null;
  }

  /** Test helper: dump all files for inspection. */
  dump(): Record<string, string> {
    const result: Record<string, string> = {};
    const decoder = new TextDecoder();
    for (const [path, file] of this.files) {
      result[path] = decoder.decode(file.data);
    }
    return result;
  }

  /** Test helper: reset all state. */
  reset(): void {
    this.files.clear();
    this.storedFileMetadata.clear();
    this.folders.clear();
  }
}
