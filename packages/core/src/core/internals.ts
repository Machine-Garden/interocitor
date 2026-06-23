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
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

function shouldLog(currentLevel: LogLevel, messageLevel: LogLevel): boolean {
  return LOG_LEVELS.indexOf(messageLevel) >= LOG_LEVELS.indexOf(currentLevel);
}

export function logAtLevel(currentLevel: LogLevel, level: LogLevel, ...args: unknown[]): void {
  if (!shouldLog(currentLevel, level)) return;
  // eslint-disable-next-line no-console
  console[level](LOG_PREFIX, ...args);
}

export function log(level: LogLevel, ...args: unknown[]): void {
  logAtLevel('debug', level, ...args);
}

export function normalizeLogLevel(level: string | null | undefined): LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(level ?? '') ? (level as LogLevel) : 'info';
}

export { LOG_LEVELS };


// ─── ID generation ───────────────────────────────────────────────────

import { uuidv7 } from './ids.ts';

/**
 * Generate a prefixed ID for internal use (change entries, snapshots, etc).
 * Uses UUIDv7 for sortability.
 */
export function generateId(prefix: string): string {
  return `${prefix}_${uuidv7()}`;
}

// ─── Encoding / Hashing ─────────────────────────────────────────────

export const textEncoder = new TextEncoder();
export const textDecoder = new TextDecoder();

export function hexFromBytes(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function computeContentHash(payload: unknown): Promise<string> {
  const json = JSON.stringify(payload);
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(json));
  return `sha256:${hexFromBytes(new Uint8Array(digest))}`;
}
