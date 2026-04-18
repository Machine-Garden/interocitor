/**
 * Internal helpers shared across sync-engine modules.
 *
 * Not part of the public API.
 */

// ─── Cloud path layout ──────────────────────────────────────────────

export interface CloudPaths {
  manifestPointer: string;
  manifestFile: (generation: number) => string;
  devicesFolder: string;
  deviceFile: (deviceId: string) => string;
  mainlineFolder: string;
  changesFolder: string;
  changesHead: string;
  changeFile: (fileName: string) => string;
}

export function paths(root: string): CloudPaths {
  const changesFolder = `${root}/changes`;
  return {
    manifestPointer: `${root}/manifest.json`,
    manifestFile: (generation: number) => `${root}/manifest-${generation}.json`,
    devicesFolder: `${root}/devices`,
    deviceFile: (deviceId: string) => `${root}/devices/${deviceId}.json`,
    mainlineFolder: `${root}/mainline`,
    changesFolder,
    changesHead: `${changesFolder}/head.json`,
    changeFile: (fileName: string) => `${changesFolder}/${fileName}`,
  };
}

// ─── Logger ──────────────────────────────────────────────────────────

const LOG_PREFIX = '[interocitor]';

export function log(level: 'debug' | 'info' | 'warn' | 'error', ...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console[level](LOG_PREFIX, ...args);
}

// ─── ID generation ───────────────────────────────────────────────────

export function generateId(prefix: string): string {
  const rand = crypto.getRandomValues(new Uint8Array(8));
  const hex = Array.from(rand).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${hex}`;
}

export function getDeviceId(override?: string): string {
  if (override) return override;
  const KEY = 'interocitor-device-id';
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = generateId('dev');
    localStorage.setItem(KEY, id);
  }
  return id;
}

// ─── Encoding / Hashing ─────────────────────────────────────────────

export const textEncoder = new TextEncoder();
export const textDecoder = new TextDecoder();

export const ROW_META_KEYS = new Set(['_table', '_rowId', '_deleted', '_deletedHlc', '_schemaVersion']);

export function hexFromBytes(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function computeContentHash(payload: unknown): Promise<string> {
  const json = JSON.stringify(payload);
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(json));
  return `sha256:${hexFromBytes(new Uint8Array(digest))}`;
}
