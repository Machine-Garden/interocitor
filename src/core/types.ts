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
  tables: Record<string, Record<string, Row>>;
}

// ─── Manifest ────────────────────────────────────────────────────────

export interface ServerConfig {
  managed: boolean;
  relayUrl: string | null;
  serverId: string;
}

export interface ManifestPointer {
  currentGeneration: number;
  file: string;
}

export interface Manifest {
  generation: number;
  parentGeneration: number;
  writtenBy: string;
  writtenAt: string;
  contentHash: string;

  version: number;
  meshId: string;
  schema: number;
  lensVersion: number;
  encrypted: boolean;
  channels: string[];
  channelNames: Record<string, string>;
  defaultChannel: string;
  server: ServerConfig;
  createdAt: string;
}

export interface ChannelManifest {
  generation: number;
  parentGeneration: number;
  writtenBy: string;
  writtenAt: string;
  contentHash: string;

  channelId: string;
  epoch: number;
  watermarkHlc: string;
  snapshotPath: string | null;
  deltaPath: string | null;
}

export interface DeviceMetadata extends DeviceInfo {
  registeredAt: string;
  lastSeenAt: string;
  retired?: boolean;
}

export interface DeviceHead {
  device: string;
  latestHlc: string;
  latestDate: string;
  fileCount: number;
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
  listFolders(path: string): Promise<string[]>;

  // File CRUD
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  deleteFile(path: string): Promise<void>;

  // Metadata
  getFileMetadata(path: string): Promise<FileEntry | null>;
}

// ─── Local Storage Adapter ───────────────────────────────────────────

/**
 * Contract every local store implementation must satisfy.
 * Implement this interface to plug in a custom local backend
 * (e.g. in-memory for tests, SQLite via OPFS, etc.).
 */
export interface LocalStoreAdapter {
  open(): Promise<void>;
  close(): void;

  getRow(table: string, rowId: string): Promise<Row | undefined>;
  putRow(row: Row): Promise<void>;
  putRows(rows: Row[]): Promise<void>;
  getTable(table: string): Promise<Row[]>;
  getAllRows(): Promise<Row[]>;
  clearRows(): Promise<void>;
  getTableNames(): Promise<string[]>;

  pushOutbox(entry: ChangeEntry): Promise<void>;
  drainOutbox(): Promise<ChangeEntry[]>;
  outboxSize(): Promise<number>;

  getCursor(deviceId: string): Promise<number>;
  setCursor(deviceId: string, offset: number): Promise<void>;
  getAllCursors(): Promise<Record<string, number>>;

  getMeta(key: string): Promise<unknown>;
  setMeta(key: string, value: unknown): Promise<void>;
  clearAll(): Promise<void>;
}

/** Factory that creates a local store instance for this engine. */
export type LocalStoreFactory = () => LocalStoreAdapter;

// ─── Sync Engine Config ──────────────────────────────────────────────

export interface SyncConfig {
  /** Cloud folder path prefix, e.g. "/Interocitor" */
  remotePath: string;
  /** Opaque channel id in storage, e.g. "c1" */
  channelId?: string;
  /** If true, only serverId may publish manifests/compaction */
  serverManaged?: boolean;
  /** Authorized writer identity when serverManaged=true */
  serverId?: string;
  /** Polling interval in ms (default 30000) */
  pollInterval?: number;
  /** Flush debounce in ms (default 2000) */
  flushDebounce?: number;
  /** Max pending ops before forced flush (default 50) */
  flushThreshold?: number;
  /**
   * IndexedDB database name for this engine's local cache.
   * Use distinct names to isolate multiple engine instances on the same origin.
   * Default: "interocitor"
   */
  dbName?: string;
  /**
   * Factory that produces the local store for this engine.
   * When provided, dbName is ignored — the factory is fully responsible
   * for constructing the store.
   */
  localStoreFactory?: LocalStoreFactory;
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
  | { type: 'auth:required' }
  | { type: 'auth:complete' }
  | { type: 'schema:mismatch'; local: number; remote: number };

export type SyncEventListener = (event: SyncEvent) => void;
