/**
 * In-Memory Storage Adapter
 *
 * For testing and development. No network, no persistence.
 * Also serves as a reference implementation for the StorageAdapter interface.
 */

import type { StorageAdapter, FileEntry } from '../core/types.ts';

/**
 * In-memory implementation of {@link StorageAdapter}.
 *
 * Useful for tests, demos, and local experiments where persistence is not
 * required.
 *
 * @example
 * ```ts
 * const adapter = new MemoryAdapter();
 * const engine = new SyncEngine(adapter, { remotePath: '/Demo' });
 * ```
 */
export class MemoryAdapter implements StorageAdapter {
  readonly name = 'memory';

  private files: Map<string, { data: Uint8Array; modifiedTime: string }> = new Map();
  private folders: Set<string> = new Set();
  private authenticated = false;

  async authenticate(): Promise<void> {
    this.authenticated = true;
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  async ensureFolder(path: string): Promise<void> {
    this.folders.add(path);
  }

  async listFiles(folderPath: string): Promise<FileEntry[]> {
    const prefix = folderPath.endsWith('/') ? folderPath : folderPath + '/';
    const entries: FileEntry[] = [];

    for (const [path, file] of this.files) {
      if (path.startsWith(prefix)) {
        const remaining = path.substring(prefix.length);
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
        const remaining = path.substring(prefix.length);
        const slash = remaining.indexOf('/');
        if (slash > 0) {
          names.add(remaining.substring(0, slash));
        }
      }
    }
    for (const folder of this.folders) {
      if (folder.startsWith(prefix)) {
        const remaining = folder.substring(prefix.length);
        if (remaining && !remaining.includes('/')) {
          names.add(remaining);
        }
      }
    }
    return [...names];
  }

  async readFile(path: string): Promise<Uint8Array> {
    const file = this.files.get(path);
    if (!file) throw new Error(`File not found: ${path}`);
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
    this.folders.clear();
  }
}
