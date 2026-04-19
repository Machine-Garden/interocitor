/**
 * interocitor — encrypted local-first CRDT sync over cloud storage
 *
 * Core type definitions
 */

// ─── Device & Identity ───────────────────────────────────────────────

/**
 * Stable identity metadata for a client device participating in a mesh.
 */
export interface DeviceInfo {
  deviceId: string;
  userId?: string;
  name?: string;
}

// ─── Hybrid Logical Clock ────────────────────────────────────────────

/**
 * Hybrid logical clock state used to order CRDT writes across devices.
 */
export interface HLC {
  ts: number;
  counter: number;
  nodeId: string;
}

// ─── Change Log ──────────────────────────────────────────────────────

export type ColumnValue = string | number | boolean | null | object;

/**
 * CRDT cell value paired with the HLC timestamp that last wrote it.
 */
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

/**
 * Serialized batch of CRDT operations written to a device-specific change log.
 */
export interface ChangeEntry {
  id: string;
  ts: number;
  device: string;
  user?: string;
  hlc: string;
  ops: Op[];
}

// ─── Row (as stored in local DB) ─────────────────────────────────────

/**
 * Row representation as stored in the local CRDT cache.
 *
 * Public table APIs usually return plain objects rather than this internal
 * metadata-rich shape.
 */
export interface Row {
  _table: string;
  _rowId: string;
  _deleted: boolean;
  _deletedHlc?: string;
  _schemaVersion: number;
  [column: string]: ColumnEntry | string | boolean | number | undefined;
}

// ─── Schema / Indexes ─────────────────────────────────────────────────

export interface TableIndexDefinition {
  /** Stable index id used for migration and diagnostics. */
  name: string;
  /** Top-level column name to index (plain row field, e.g. "status"). */
  field: string;
  unique?: boolean;
}

// ─── Merge Strategies ─────────────────────────────────────────────────

/**
 * Built-in column merge strategies (git-style):
 *
 * - `'remote-wins'` — Like git `--theirs`. Remote always overwrites local. Default.
 * - `'lww'`         — Last-Writer-Wins. Highest HLC wins.
 * - `'local-wins'`  — Like git `--ours`. Keep local value on conflict.
 */
export type BuiltinMergeStrategy = 'lww' | 'local-wins' | 'remote-wins';

/**
 * Custom merge function. Receives the local and incoming column entries
 * plus context, returns the winning entry.
 *
 * Called only when both local and remote have a value for the column.
 * Return `local` to keep, `remote` to accept, or a new ColumnEntry to
 * produce a merged result.
 */
export type MergeFunction = (
  local: ColumnEntry,
  remote: ColumnEntry,
  context: MergeContext,
) => ColumnEntry;

export interface MergeContext {
  table: string;
  rowId: string;
  field: string;
}

/** Per-column merge strategy — builtin name or custom function. */
export type MergeStrategy = BuiltinMergeStrategy | MergeFunction;

/**
 * Table-level merge config.
 *
 * - Set `strategy` for a table-wide default.
 * - Set `fields` to override per column (like `.gitattributes` per file).
 *
 * Unspecified = inherits from {@link DatabaseSchemaDefinition.mergeStrategy},
 * which itself defaults to `'remote-wins'`.
 */
export interface TableMergeConfig {
  /** Default strategy for all fields in this table. */
  strategy?: MergeStrategy;
  /** Per-field overrides. */
  fields?: Record<string, MergeStrategy>;
}

// ─── Schema / Field Types ─────────────────────────────────────────────

export type SchemaFieldKind = 'string' | 'number' | 'boolean' | 'date' | 'json' | 'enum';

export type IndexableSchemaFieldKind = Exclude<SchemaFieldKind, 'json'>;

/** A field descriptor — carries kind, optional index flags, and a phantom TS type. */
export interface SchemaField<T = unknown, K extends SchemaFieldKind = SchemaFieldKind> {
  readonly kind: K;
  readonly index?: boolean;
  readonly unique?: boolean;
  /** Optional field in app-level typing. Omitted fields are allowed. */
  readonly optional?: true;
  /** @internal phantom — never exists at runtime; typed as T to preserve inference */
  readonly _type: T;
}

export type OptionalSchemaField<T = unknown, K extends SchemaFieldKind = SchemaFieldKind> =
  SchemaField<T, K> & { readonly optional: true; readonly __optional: true };

/** Narrows kind to the set that IndexedDB can use as a key. */
export type IndexableSchemaField<T = unknown> = SchemaField<T, IndexableSchemaFieldKind>;


/**
 * Schema metadata for a single table, including field kinds and local indexes.
 *
 * @typeParam T — plain record type for rows in this table, e.g.
 *   `{ title: string; status: 'open' | 'done' }`.
 *   When omitted, defaults to `Record<string, unknown>` (untyped).
 */
export interface TableSchemaDefinition<T extends Record<string, unknown> = Record<string, unknown>> {
  /**
   * Production style: define field kind + index intent in one place.
   * Keys must match keys of T; values carry the phantom TS type via SchemaField<T[K]>.
   */
  fields?: { [K in keyof T]?: SchemaField<T[K]> } & Record<string, SchemaField>;
  /** Legacy style: kept for compatibility. */
  indexes?: TableIndexDefinition[];
  /** Merge strategy for this table. Overrides the database-level default. */
  merge?: MergeStrategy | TableMergeConfig;
}

/**
 * Versioned schema definition used for local index planning and migrations.
 *
 * @typeParam S — database shape: `{ tableName: { fieldName: FieldType } }`.
 *   Inferred automatically when you pass a schema literal to `SyncConfig`.
 *   Omit for untyped usage.
 *
 * @example
 * const schema = {
 *   version: 1,
 *   tables: {
 *     tasks: { fields: { title: types.string, status: types.enum('open', 'done') } },
 *   },
 * } satisfies DatabaseSchemaDefinition;
 * // → DatabaseSchemaDefinition<{ tasks: { title: string; status: 'open' | 'done' } }>
 */
export interface DatabaseSchemaDefinition<
  S extends Record<string, Record<string, unknown>> = Record<string, Record<string, unknown>>,
> {
  /** Increment when index/table metadata changes. */
  version: number;
  tables: { [K in keyof S]: TableSchemaDefinition<S[K]> } & Record<string, TableSchemaDefinition>;
  /** Default merge strategy for all tables. Default: `'remote-wins'`. */
  mergeStrategy?: MergeStrategy;
}

/**
 * Extracts the TS type encoded in a `SchemaField`'s `_type` phantom.
 * Falls back to `unknown` for untyped fields.
 * @internal
 */
export type InferFieldType<F> = F extends SchemaField<infer T> ? T : unknown;

/**
 * Extracts the row type for a single `TableSchemaDefinition`-shaped object.
 * Works on literal `typeof table` shapes — no generic parameter needed.
 * @internal
 */
type OptionalFieldKeys<F> = {
  [K in keyof F]-?: F[K] extends { optional: true } ? K : never
}[keyof F];

type RequiredFieldKeys<F> = Exclude<keyof F, OptionalFieldKeys<F>>;

export type InferTableShape<T> =
  T extends { fields: infer F }
    ? ({ [K in RequiredFieldKeys<F>]: InferFieldType<F[K]> } &
       { [K in OptionalFieldKeys<F>]?: InferFieldType<F[K]> })
    : Record<string, unknown>;

/**
 * Extracts the full database shape from a `DatabaseSchemaDefinition`-shaped literal.
 *
 * Works directly on `typeof schema` — no manual type annotation needed.
 *
 * @example
 * const schema = {
 *   version: 1,
 *   tables: { tasks: { fields: { title: types.string, status: types.enum('open', 'done') } } },
 * } satisfies DatabaseSchemaDefinition;
 *
 * type DB = InferSchemaType<typeof schema>;
 * // → { tasks: { title: string; status: 'open' | 'done' } }
 *
 * type TaskRow = InferTableType<typeof schema, 'tasks'>;
 * // → { title: string; status: 'open' | 'done' }
 */
export type InferSchemaType<D extends DatabaseSchemaDefinition> =
  D extends { tables: infer Tables }
    ? { [K in keyof Tables]: InferTableShape<Tables[K]> }
    : Record<string, Record<string, unknown>>;

/**
 * Extracts the row type for a single table `K` from a `DatabaseSchemaDefinition`.
 */
export type InferTableType<
  D extends DatabaseSchemaDefinition,
  K extends keyof InferSchemaType<D> & string,
> = InferSchemaType<D>[K];

export type WherePrimitive = string | number | boolean | Date;

export type WhereOperator =
  | 'equals'
  | 'above'
  | 'aboveOrEqual'
  | 'below'
  | 'belowOrEqual'
  | 'between'
  | 'startsWith'
  | 'anyOf';

/**
 * Dexie-style predicate description used by {@link Table.where} and
 * {@link Interocitor.queryWhere}.
 */
export interface WhereClause {
  field: string;
  op: WhereOperator;
  value?: WherePrimitive;
  values?: WherePrimitive[];
  lower?: WherePrimitive;
  upper?: WherePrimitive;
  lowerOpen?: boolean;
  upperOpen?: boolean;
}

// ─── Snapshot ────────────────────────────────────────────────────────

/**
 * Compacted mesh snapshot containing the full row set at a given epoch.
 */
export interface Snapshot {
  snapshotId: string;
  timestamp: string;
  hlc: string;
  epoch: number;
  schemaVersion: number;
  tables: Record<string, Record<string, Row>>;
}

export interface MeshChangePayload {
  meshId: string;
  kind: 'change';
  entry: ChangeEntry;
}

export interface MeshSnapshotPayload {
  meshId: string;
  kind: 'snapshot';
  snapshot: Snapshot;
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

/**
 * Authoritative mesh manifest describing the latest generation and snapshot state.
 */
export interface Manifest {
  generation: number;
  parentGeneration: number;
  writtenBy: string;
  writtenAt: string;
  contentHash: string;

  version: number;
  meshId: string;
  schema: number;
  encrypted: boolean;
  server: ServerConfig;
  createdAt: string;

  /** Compaction epoch — incremented on each snapshot. */
  epoch: number;
  /** HLC watermark — all data ≤ this HLC is captured in the snapshot. */
  watermarkHlc: string;
  /** Cloud path to the latest snapshot file, or null before first compaction. */
  snapshotPath: string | null;
  /** Reserved for future delta-based catch-up. */
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

/** Global change-folder head — monotonic HLC hint for fast poll skipping. */
export interface ChangesHead {
  latestHlc: string;
}

// ─── Storage Adapter ─────────────────────────────────────────────────

/**
 * Normalized remote file metadata returned by a storage adapter.
 */
export interface FileEntry {
  name: string;
  path: string;
  size: number;
  modifiedTime: string;
  etag?: string;
  revision?: string;
}

/**
 * Contract implemented by remote backends such as WebDAV, Google Drive,
 * Cloudflare, or in-memory test adapters.
 */
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

  /**
   * Return an opaque config string describing how to reach this backend,
   * suitable for embedding in a handshake QR code payload.
   *
   * Must NOT include credentials (passwords, tokens, OAuth secrets).
   * The scanner uses this to configure their own adapter instance before
   * starting the ECDH relay exchange.
   *
   * Returns undefined for adapters where the backend address is already
   * baked into the app (e.g. a fixed Cloudflare Worker URL known to all
   * app users). In that case the scanner configures their adapter independently.
   *
   * The returned string should be treated as opaque by the handshake layer;
   * only the same adapter class knows how to parse it.
   */
  getHandshakeConfig?(): string;
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
  queryWhere(table: string, clause: WhereClause): Promise<Row[]>;
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

// ─── Replica ─────────────────────────────────────────────────────────

/** Write-only replica adapter for backup. */
export interface ReplicaConfig {
  adapter: StorageAdapter;
  /** Override remotePath for this replica. Defaults to the primary remotePath. */
  remotePath?: string;
}

// ─── Sync Engine Config ──────────────────────────────────────────────

/**
 * Configuration for a {@link Interocitor} instance.
 *
 * Supports both fully local startup and immediate sync with a remote adapter.
 */
export interface SyncConfig<
  S extends Record<string, Record<string, unknown>> = Record<string, Record<string, unknown>>,
> {
  /** Cloud folder path prefix, e.g. "/Interocitor" */
  remotePath: string;
  /**
   * Base58 passphrase for mesh encryption.
   * When set, the engine derives the AES-256 key internally and persists
   * it via the credential store. Implies encrypted = true.
   */
  passphrase?: string;
  /**
   * Encryption is on by default. Set to false to opt out.
   * When enabled without a passphrase, the engine generates a fresh key
   * on first init (retrieve via getPassphrase()).
   */
  encrypted?: boolean;
  /**
   * Override the auto-generated device ID.
   * Primarily for tests. In production, omit — the engine generates
   * and persists a unique ID per origin automatically.
   */
  deviceId?: string;
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
   * Local database name for this engine's local cache.
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
  /** Optional table/index metadata for local query planning and migrations. */
  schema?: DatabaseSchemaDefinition<S>;

  /**
   * Called once after the engine has fully initialized (local store open,
   * encryption resolved, local state loaded). Use for migrations.
   * You do not need to call `engine.init()` — it is called internally.
   *
   * @example
   * onInit: async (engine) => {
   *   await migrateLegacyData(engine);
   * }
   */
  onInit?: (engine: import('./sync-engine.ts').InterocitorInitContext<S>) => Promise<void>;
  /**
   * Write-only replica adapters for backup.
   * Flush writes to primary + all replicas. Pull reads primary only.
   * Replica failures are emitted as 'replica:error' events but do not
   * fail the primary flush.
   */
  replicas?: ReplicaConfig[];
  /**
   * Credential store for persisting key material (passphrase + device ID).
   *
   * Default: auto-detecting store that tries WebAuthn largeBlob (OS keychain,
   * survives Safari ITP) and falls back to localStorage.
   *
   * Pass a custom `CredentialStore` implementation or `null` to disable
   * credential persistence entirely.
   */
  credentialStore?: import('../storage/credential-store.ts').CredentialStore | null;

  /**
   * Human-readable app name shown in biometric prompts (Touch ID / Face ID)
   * and OS keychain entries. Used by the default credential store.
   */
  appName: string;
}

// ─── Events ──────────────────────────────────────────────────────────

/**
 * Union of lifecycle, sync, auth, and replication events emitted by the engine.
 */
export type SyncEvent =
  | { type: 'sync:start' }
  | { type: 'sync:complete'; entriesMerged: number }
  | { type: 'sync:error'; error: Error }
  | { type: 'remote:poisoned'; error: Error; path?: string }
  | { type: 'flush:start'; entryCount: number }
  | { type: 'flush:complete' }
  | { type: 'flush:error'; error: Error }
  | { type: 'change'; table: string; rowId: string; row: Row }
  | { type: 'delete'; table: string; rowId: string }
  | { type: 'rehydrate:start' }
  | { type: 'rehydrate:complete'; rowCount: number }
  | { type: 'auth:required' }
  | { type: 'auth:complete' }
  | { type: 'schema:mismatch'; local: number; remote: number }
  | { type: 'replica:error'; adapter: string; error: Error };

/**
 * Listener callback registered with {@link Interocitor.on}.
 */
export type SyncEventListener = (event: SyncEvent) => void;

/**
 * Event emitted by table-level subscriptions.
 */
export type TableEvent<T> =
  | { type: 'change'; rowId: string; row: T }
  | { type: 'delete'; rowId: string };

/**
 * Listener callback for table-level subscriptions.
 */
export type TableEventListener<T> = (event: TableEvent<T>) => void;
