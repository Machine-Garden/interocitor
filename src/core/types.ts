/**
 * interocitor — encrypted local-first CRDT sync over cloud storage
 *
 * Core type definitions
 */

// ─── Device & Identity ───────────────────────────────────────────────

export interface DeviceInfo {
  deviceId: string;
  userId?: string;
  name?: string;
}

// ─── Hybrid Logical Clock ────────────────────────────────────────────

export interface HLC {
  ts: number;
  counter: number;
  nodeId: string;
}

// ─── Change Log ──────────────────────────────────────────────────────

export type ColumnValue = string | number | boolean | null | object;

export interface ColumnEntry {
  value: ColumnValue;
  hlc: string; // serialized HLC
}

export interface UpsertOp {
  type: 'upsert';
  table: string;
  rowId: string;
  columns: Record<string, ColumnEntry>;
}

export interface DeleteOp {
  type: 'delete';
  table: string;
  rowId: string;
  hlc: string;
}

export type Op = UpsertOp | DeleteOp;

export interface ChangeEntry {
  id: string;
  ts: number;
  device: string;
  user?: string;
  hlc: string;
  ops: Op[];
}

// ─── Row (as stored in local DB) ─────────────────────────────────────

export interface Row {
  _table: string;
  _rowId: string;
  _deleted: boolean;
  _deletedHlc?: string;
  _schemaVersion: number;
  [column: string]: ColumnEntry | string | boolean | number | undefined;
}

// ─── Snapshot ────────────────────────────────────────────────────────

export interface Snapshot {
  snapshotId: string;
  timestamp: string;
  hlc: string;
  epoch: number;
  schemaVersion: number;
  cursors: Record<string, number>; // deviceId → byte offset
  tables: Record<string, Record<string, Row>>;
}

// ─── Manifest ────────────────────────────────────────────────────────

export interface Manifest {
  version: number;
  meshId: string;
  schema: number;
  encrypted: boolean;
  epoch: number;
  devices: Record<string, DeviceInfo>;
  createdAt: string;
  updatedAt: string;
}

// ─── Storage Adapter ─────────────────────────────────────────────────

export interface FileEntry {
  name: string;
  path: string;
  size: number;
  modifiedTime: string;
  etag?: string;
  revision?: string;
}

export interface StorageAdapter {
  readonly name: string;

  // Auth
  authenticate(): Promise<void>;
  isAuthenticated(): boolean;

  // Folder
  ensureFolder(path: string): Promise<void>;
  listFiles(path: string): Promise<FileEntry[]>;

  // File CRUD
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  deleteFile(path: string): Promise<void>;

  // Metadata
  getFileMetadata(path: string): Promise<FileEntry | null>;
}

// ─── Sync Engine Config ──────────────────────────────────────────────

export interface SyncConfig {
  /** Cloud folder path prefix, e.g. "/Interocitor" */
  rootPath: string;
  /** Polling interval in ms (default 30000) */
  pollInterval?: number;
  /** Flush debounce in ms (default 2000) */
  flushDebounce?: number;
  /** Max pending ops before forced flush (default 50) */
  flushThreshold?: number;
  /** Compaction trigger: total change log bytes (default 1MB) */
  compactionThreshold?: number;
}

// ─── Events ──────────────────────────────────────────────────────────

export type SyncEvent =
  | { type: 'sync:start' }
  | { type: 'sync:complete'; entriesMerged: number }
  | { type: 'sync:error'; error: Error }
  | { type: 'flush:start'; entryCount: number }
  | { type: 'flush:complete' }
  | { type: 'flush:error'; error: Error }
  | { type: 'change'; table: string; rowId: string; row: Row }
  | { type: 'delete'; table: string; rowId: string }
  | { type: 'rehydrate:start' }
  | { type: 'rehydrate:complete'; rowCount: number }
  | { type: 'compact:start' }
  | { type: 'compact:complete'; epoch: number }
  | { type: 'auth:required' }
  | { type: 'auth:complete' }
  | { type: 'schema:mismatch'; local: number; remote: number };

export type SyncEventListener = (event: SyncEvent) => void;
