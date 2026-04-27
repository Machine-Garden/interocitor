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
 * CRDT row metadata. Lives under `Row._meta` and is fully isolated from
 * user payload. Engine never reads or writes user-controlled fields here.
 */
export interface RowMeta {
  table: string;
  rowId: string;
  deleted: boolean;
  deletedHlc?: string;
  schemaVersion: number;
  /** Device ID that last wrote this row. Set automatically on every write. */
  owner?: string;
  /** Composite IndexedDB key. Computed by local-store on putRow. */
  key?: string;
}

/**
 * Row representation as stored in the local CRDT cache.
 *
 * Two namespaces:
 *  - `_meta` — engine-owned metadata. Reserved.
 *  - `payload` — user columns, each wrapped in a `ColumnEntry` ({value, hlc}).
 *
 * Public table APIs return plain typed objects (see `rowToTyped` in table.ts);
 * this shape is for internal consumers (CRDT merge, flush, compaction, events).
 */
export interface Row {
  _meta: RowMeta;
  payload: Record<string, ColumnEntry>;
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

export interface QueryOrderBy {
  field: string;
  dir: 'asc' | 'desc';
}

export interface QueryDescriptor {
  table: string;
  clause?: WhereClause;
  orderBy?: QueryOrderBy;
}

/** Identity of a single-row read. Lives next to QueryDescriptor on purpose. */
export interface RowDescriptor {
  table: string;
  rowId: string;
}

export interface RowCacheSnapshot {
  status: 'empty' | 'pending' | 'ready' | 'error';
  promise: Promise<Row | undefined> | null;
  /** `null` means "loaded, row absent/deleted". `undefined` means "no rows yet". */
  row?: Row | null;
  error?: Error;
}

export interface RowCacheOwner {
  getRowCacheKey(descriptor: RowDescriptor): string;
  loadRow(descriptor: RowDescriptor, options?: QueryExecutionOptions): Promise<Row | undefined>;
  readRowCache(descriptor: RowDescriptor): RowCacheSnapshot;
}

export interface QueryExecutionOptions {
  bypassCache?: boolean;
}

export interface QueryCacheSnapshot {
  status: 'empty' | 'pending' | 'ready' | 'error';
  promise: Promise<Row[]> | null;
  rows?: Row[];
  error?: Error;
}

export interface QueryCacheOwner {
  getQueryCacheKey(descriptor: QueryDescriptor): string;
  loadQueryRows(descriptor: QueryDescriptor, options?: QueryExecutionOptions): Promise<Row[]>;
  readQueryCache(descriptor: QueryDescriptor): QueryCacheSnapshot;
}

export interface ReadinessAwareQueryExecutor extends QueryCacheOwner, RowCacheOwner {
  isReady(): boolean;
}

export type QueryExecutionMode = 'default' | 'cache-first' | 'bypass-cache';

export interface QueryExecutionPolicy {
  mode?: QueryExecutionMode;
}

export interface QueryMetadata {
  descriptor: QueryDescriptor;
  cacheKey: string;
}

export interface QueryReadable<T extends Record<string, unknown>> {
  load(options?: QueryExecutionOptions): Promise<T[]>;
  peekCache(): T[] | undefined;
  readonly metadata: QueryMetadata;
}

export interface QueryReadyReadable<T extends Record<string, unknown>> extends QueryReadable<T> {
  readForRender(policy?: QueryExecutionPolicy): Promise<T[]> | T[];
}

export interface QueryRuntime<T extends Record<string, unknown>> {
  owner: QueryCacheOwner;
  metadata: QueryMetadata;
  load: (options?: QueryExecutionOptions) => Promise<T[]>;
}

export interface QueryReadyRuntime<T extends Record<string, unknown>> extends QueryRuntime<T> {
  owner: ReadinessAwareQueryExecutor;
  readForRender: (policy?: QueryExecutionPolicy) => Promise<T[]> | T[];
}

export interface QuerySubscriber {
  subscribe(cb: TableEventListener<any>): () => void;
}

export type QueryLifecycle<T extends Record<string, unknown>> = QueryRuntime<T> & QuerySubscriber;
export type ReadyQueryLifecycle<T extends Record<string, unknown>> = QueryReadyRuntime<T> & QuerySubscriber;

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

export type DeviceType = 'web' | 'ios' | 'android' | 'worker' | 'desktop' | 'tv';

export interface DeviceMetadata extends DeviceInfo {
  registeredAt: string;
  lastSeenAt: string;
  /** Human-readable device name, e.g. "Anton's laptop" */
  displayName?: string;
  /** Device class */
  deviceType?: DeviceType;
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

export interface RemoteInvalidationPayload {
  type: string;
  path: string;
  ts: number;
  op?: string;
  pathType?: string;
}

export interface RemoteInvalidationHooks {
  onReady?: () => void;
  onError?: (error?: unknown) => void;
  onClose?: () => void;
}

export interface RemoteInvalidationStorageAdapter {
  subscribeToInvalidations(
    onInvalidate: (payload: RemoteInvalidationPayload) => void,
    hooks?: RemoteInvalidationHooks,
  ): () => void;
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

  /**
   * Drop the per-session ensureFolder cache. Implementers cache "ensured"
   * paths to avoid round-tripping a MKCOL/POST per connect; the engine
   * calls this on mesh swap, transport teardown, and remote poison so the
   * next connect re-validates folder presence on the new backend.
   *
   * Optional. Adapters that do no caching can omit it.
   */
  resetFolderCache?(): void;
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
  pushOutboxEntries(entries: ChangeEntry[]): Promise<void>;
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
export interface SyncInitialState {
  remotePath?: string;
  passphrase?: string | null;
  encrypted?: boolean;
  deviceId?: string;
}

export type LogLevel = import('./internals.ts').LogLevel;

export interface SyncConfig<
  S extends Record<string, Record<string, unknown>> = Record<string, Record<string, unknown>>,
> {
  /** Cloud folder path prefix, e.g. "/Interocitor" */
  remotePath?: string;
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
  /** Human-readable device name, e.g. "Anton's laptop", "Val's phone" */
  deviceName?: string;
  /** Device class — used in device manifest for peer discovery */
  deviceType?: DeviceType;
  /** If true, only serverId may publish manifests/compaction */
  serverManaged?: boolean;
  /** Authorized writer identity when serverManaged=true */
  serverId?: string;
  /** Polling interval in ms (default 30000) */
  pollInterval?: number;
  /** Per-engine log threshold. Default: 'info'. */
  logLevel?: LogLevel;
  /** Flush debounce in ms (default 2000) */
  flushDebounce?: number;
  /** Max pending ops before forced flush (default 50) */
  flushThreshold?: number;
  /** Warn once queued local changes reach this count (default 50). */
  compactWarnThreshold?: number;
  /** Consider auto-compaction once queued local changes reach this count (default 50). */
  compactAutoThreshold?: number;
  /** Sampling numerator for the immediate auto-compact path. Chance = numerator / estimated device count. Default 10. */
  compactAutoSampleNumerator?: number;
  /** Estimated device count used to scale the immediate auto-compact sampling. Default 1. */
  compactAutoDeviceCount?: number;
  /** Enable automatic compact scheduling after large churn. Default true. */
  autoCompact?: boolean;
  /** First auto-compact delay base in ms (default 10m). Jittered by ± firstCompactDelayJitterMs. */
  firstCompactDelayMs?: number;
  /** First auto-compact delay jitter in ms (default 5m). */
  firstCompactDelayJitterMs?: number;
  /** Second auto-compact delay base in ms (default 15m). Jittered by ± secondCompactDelayJitterMs. */
  secondCompactDelayMs?: number;
  /** Second auto-compact delay jitter in ms (default 5m). */
  secondCompactDelayJitterMs?: number;
  /** Minimum remote change-file count required before the second delay starts (default 2). */
  compactRemoteChangeThreshold?: number;
  /** Implicit batch window in ms. All local writes inside the window join one ChangeEntry. Default 1000. */
  batchWindowMs?: number;
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
   * Optional browser-owned bootstrap hook.
   * Runs during init() before persisted credentials are restored.
   * Returned values override constructor defaults; persisted storage fills blanks only.
   */
  resolveInitialState?: () => SyncInitialState | Promise<SyncInitialState | null> | null;

  /**
   * Called once after the engine has fully initialized (local store open,
   * encryption resolved, local state loaded). Use for migrations.
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
  | { type: 'credentials:restored'; source: 'silent-store' | 'biometric'; deviceIdChanged: boolean; hadPassphrase: boolean }
  | { type: 'remote:poisoned'; error: Error; path?: string; context?: Record<string, unknown> }
  | { type: 'decode:error'; error: Error; path?: string; context?: Record<string, unknown> }
  | { type: 'credentials:conflict'; storedDeviceId: string; activeDeviceId: string; dbName: string; remotePath?: string }
  | { type: 'credentials:meshMismatch'; dbName: string; remotePath?: string; storedMeshId: string; activeMeshId: string }
  | { type: 'credentials:persisted'; dbName: string; remotePath?: string; deviceId: string; encrypted: boolean }
  | { type: 'encryption:resolved'; strategy: 'passphrase' | 'existing-key' | 'generated'; dbName: string; remotePath?: string; encrypted: boolean }
  | { type: 'mesh:configured'; dbName: string; remotePath?: string; deviceId: string; encrypted: boolean; hadPassphrase: boolean }
  | { type: 'connect:state'; dbName: string; remotePath?: string; deviceId: string; localEpoch?: number; remoteEpoch?: number; meshId?: string; encrypted: boolean }
  | { type: 'connect:noop'; dbName: string; remotePath?: string; deviceId: string; reason: 'already-connected' }
  | { type: 'connect:error'; error: Error; stage: string; dbName: string; remotePath?: string; deviceId: string }
  | { type: 'transport:teardown'; dbName: string; remotePath?: string; deviceId?: string; reason: 'switch-adapter' | 'disconnect' | 'detach' }
  | { type: 'relay:subscribe'; adapter: string; remotePath?: string; deviceId: string }
  | { type: 'relay:ready'; adapter: string }
  | { type: 'relay:message'; adapter: string; payload: RemoteInvalidationPayload }
  | { type: 'relay:error'; adapter: string; error: Error }
  | { type: 'relay:closed'; adapter: string }
  | { type: 'relay:unavailable'; adapter: string; reason: 'adapter-unsupported' }
  | { type: 'flush:start'; entryCount: number }
  | { type: 'flush:complete' }
  | { type: 'flush:error'; error: Error }
  | { type: 'compact:warning'; queuedChangeCount: number; threshold: number; autoCompactThreshold: number; remotePath?: string; deviceId: string }
  | { type: 'compact:auto:start'; queuedChangeCount: number; threshold: number; sampleRoll?: number; sampleWindow?: number; remoteChangeFileCount?: number; trigger: 'immediate' | 'delayed'; remotePath?: string; deviceId: string }
  | { type: 'compact:auto:skip'; queuedChangeCount: number; threshold: number; sampleRoll?: number; sampleWindow?: number; trigger: 'immediate' | 'delayed'; remotePath?: string; deviceId: string; reason: 'sampling' | 'disabled' | 'not-connected' | 'already-running' | 'poisoned' | 'missing-remote' | 'below-remote-threshold' | 'superseded' }
  | { type: 'compact:auto:complete'; queuedChangeCount: number; threshold: number; trigger: 'immediate' | 'delayed'; remoteChangeFileCount?: number; remotePath?: string; deviceId: string }
  | { type: 'compact:auto:error'; queuedChangeCount: number; threshold: number; trigger: 'immediate' | 'delayed'; remoteChangeFileCount?: number; remotePath?: string; deviceId: string; error: Error }
  | { type: 'compact:delayed:scheduled'; queuedChangeCount: number; delayMs: number; phase: 'check' | 'compact'; remotePath?: string; deviceId: string }
  | { type: 'compact:delayed:check'; queuedChangeCount: number; remoteChangeFileCount: number; threshold: number; remotePath?: string; deviceId: string }
  | { type: 'change'; table: string; rowId: string; row: Row }
  | { type: 'delete'; table: string; rowId: string }
  | { type: 'rehydrate:start' }
  | { type: 'rehydrate:complete'; rowCount: number }
  | { type: 'auth:required' }
  | { type: 'auth:complete' }
  | { type: 'schema:mismatch'; local: number; remote: number }
  | { type: 'replica:error'; adapter: string; error: Error }
  // ── Trace events ───────────────────────────────────────────────
  // High-volume diagnostics. NOT a public API contract; consumers
  // (devtools, tests) opt in. Engine fires these unconditionally.
  // Use to answer "why is my head/manifest being rewritten?".
  | {
      type: 'trace:manifest';
      op: 'read' | 'write' | 'cache-hit' | 'bootstrap-create';
      reason: string;            // free-form caller tag, e.g. 'connect', 'flush', 'pull', 'compact'
      generation?: number;
      path?: string;
      cached?: boolean;          // true when a read was served from in-memory cache
    }
  | {
      type: 'trace:head';
      op: 'read' | 'write' | 'skip-no-change';
      reason: string;            // 'flush', 'pull-fast-path'
      path?: string;
      priorHlc?: string | null;  // HLC currently in head.json (or local cache)
      nextHlc?: string | null;   // HLC about to be written
      regressed?: boolean;       // true when caller tried to write an HLC older than priorHlc (BUG signal)
    };

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
