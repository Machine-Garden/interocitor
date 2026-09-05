/**
 * interocitor — encrypted local-first CRDT sync over cloud storage
 *
 * Core type definitions
 */

import type { PairingCapabilities } from "../handshake/capabilities.ts";
import type { RemoteAccessError, RemoteAccessKind } from "./errors.ts";

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
  type: "upsert";
  table: string;
  rowId: string;
  columns: Record<string, ColumnEntry>;
}

export interface DeleteOp {
  type: "delete";
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

// ─── Change observation ──────────────────────────────────────────────

export type ChangeObservationSource = "local" | "remote";

export type RowChangeKind = "create" | "update" | "delete" | "resurrect";

/** One CRDT column transition caused by an observed change entry. */
export interface ColumnChangeEffect {
  before?: ColumnEntry;
  after?: ColumnEntry;
}

/**
 * Net effect of one change entry on one row in this endpoint's local state.
 *
 * A field is present when either its value or its CRDT timestamp changed.
 * Delete effects contain the removed columns as `before` values. A delete for
 * an unseen row can therefore have an empty `fields` object.
 */
export interface RowChangeEffect {
  table: string;
  rowId: string;
  kind: RowChangeKind;
  fields: Record<string, ColumnChangeEffect>;
}

/**
 * Live observation of one locally promoted or remotely decoded change entry.
 *
 * This is endpoint-relative, session-scoped evidence for diagnostics and
 * application-owned best-effort logs. It is not persisted, replayed, globally
 * complete, or authenticated by core. `fileName` is present only for remote
 * change files; local entries may not have been published when observed.
 */
export interface ChangeObservation {
  source: ChangeObservationSource;
  observedAt: number;
  fileName?: string;
  change: ChangeEntry;
  effects: RowChangeEffect[];
}

/** Listener registered with {@link Interocitor.observeChanges}. */
export type ChangeObservationListener = (observation: ChangeObservation) => void;

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
  /** Composite local key. Computed by the local store on putRow. */
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
 * Built-in replicated-column merge strategy.
 *
 * LWW compares the immutable HLCs carried by the conflicting mutations. It
 * therefore produces the same winner on every peer regardless of discovery
 * or publication order. Perspective-dependent "local" and "remote" policies
 * are intentionally not representable in a peer mesh.
 */
export type BuiltinMergeStrategy = "lww";

/**
 * Custom merge function. Receives the existing and incoming column entries
 * plus context, returns the winning entry.
 *
 * Called only when both entries have a value for the column. To preserve mesh
 * convergence this function must be deterministic, commutative, associative,
 * and idempotent. Return `existing`, `incoming`, or a new ColumnEntry.
 */
export type MergeFunction = (
  existing: ColumnEntry,
  incoming: ColumnEntry,
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
 * which itself defaults to `'lww'`.
 */
export interface TableMergeConfig {
  /** Default strategy for all fields in this table. */
  strategy?: MergeStrategy;
  /** Per-field overrides. */
  fields?: Record<string, MergeStrategy>;
}

// ─── Schema / Field Types ─────────────────────────────────────────────

export type SchemaFieldKind = "string" | "number" | "boolean" | "date" | "json" | "enum" | "file";

/** Kinds a local index can key on. `json` is opaque and `file` is a reference object. */
export type IndexableSchemaFieldKind = Exclude<SchemaFieldKind, "json" | "file">;

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

export type OptionalSchemaField<
  T = unknown,
  K extends SchemaFieldKind = SchemaFieldKind,
> = SchemaField<T, K> & {
  readonly optional: true;
  readonly __optional: true;
};

/** Narrows kind to the set that local indexes can use as a key. */
export type IndexableSchemaField<T = unknown> = SchemaField<T, IndexableSchemaFieldKind>;

/**
 * Schema metadata for a single table, including field kinds and local indexes.
 *
 * @typeParam T — plain record type for rows in this table, e.g.
 *   `{ title: string; status: 'open' | 'done' }`.
 *   When omitted, defaults to `Record<string, unknown>` (untyped).
 */
export interface TableSchemaDefinition<
  T extends Record<string, unknown> = Record<string, unknown>,
> {
  /**
   * Define field kind and index intent in one place.
   * Keys must match keys of T; values carry the phantom TS type via SchemaField<T[K]>.
   */
  fields?: { [K in keyof T]?: SchemaField<T[K]> } & Record<string, SchemaField>;
  /** Explicit local index declarations accepted by storage runtimes. */
  indexes?: TableIndexDefinition[];
  /** Merge strategy for this table. Overrides the database-level default. */
  merge?: MergeStrategy | TableMergeConfig;
}

/**
 * Schema definition used for local query planning and logical compatibility checks.
 *
 * @typeParam S — database shape: `{ tableName: { fieldName: FieldType } }`.
 *   Inferred automatically when you pass a schema literal to `SyncConfig`.
 *   Omit for untyped usage.
 *
 * @example
 * const schema = {
 *   tables: {
 *     tasks: { fields: { title: types.string, status: types.enum('open', 'done') } },
 *   },
 * } satisfies DatabaseSchemaDefinition;
 * // → DatabaseSchemaDefinition<{ tasks: { title: string; status: 'open' | 'done' } }>
 */
export interface DatabaseSchemaDefinition<
  S extends Record<string, Record<string, unknown>> = Record<string, Record<string, unknown>>,
> {
  /**
   * Optional transport-level compatibility marker for a mesh.
   *
   * Core records this value when it bootstraps a mesh, then requires clients
   * that supply a version to match the existing manifest exactly. It does not
   * run a migration, represent an application's data version, or advance the
   * manifest value of an existing mesh.
   */
  version?: number;
  tables: { [K in keyof S]: TableSchemaDefinition<S[K]> } & Record<string, TableSchemaDefinition>;
  /** Default merge strategy for all tables. Default: `'lww'`. */
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
  // `__optional` is the brand only `.optional` descriptors carry. Testing
  // `optional: true` would match every `types.*` helper, because each one
  // exposes its `.optional` variant under that same property name.
  [K in keyof F]-?: F[K] extends { __optional: true } ? K : never;
}[keyof F];

type RequiredFieldKeys<F> = Exclude<keyof F, OptionalFieldKeys<F>>;

export type InferTableShape<T> = T extends { fields: infer F }
  ? { [K in RequiredFieldKeys<F>]: InferFieldType<F[K]> } & {
      [K in OptionalFieldKeys<F>]?: InferFieldType<F[K]>;
    }
  : Record<string, unknown>;

/**
 * Extracts the full database shape from a `DatabaseSchemaDefinition`-shaped literal.
 *
 * Works directly on `typeof schema` — no manual type annotation needed.
 *
 * @example
 * const schema = {
 *   tables: { tasks: { fields: { title: types.string, status: types.enum('open', 'done') } } },
 * } satisfies DatabaseSchemaDefinition;
 *
 * type DB = InferSchemaType<typeof schema>;
 * // → { tasks: { title: string; status: 'open' | 'done' } }
 *
 * type TaskRow = InferTableType<typeof schema, 'tasks'>;
 * // → { title: string; status: 'open' | 'done' }
 */
export type InferSchemaType<D extends DatabaseSchemaDefinition> = D extends { tables: infer Tables }
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
  | "equals"
  | "above"
  | "aboveOrEqual"
  | "below"
  | "belowOrEqual"
  | "between"
  | "startsWith"
  | "anyOf";

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
  dir: "asc" | "desc";
}

export interface QueryDescriptor {
  table: string;
  clause?: WhereClause;
  orderBy?: QueryOrderBy;
}

/** Identity of a single-row read. */
export interface RowDescriptor {
  table: string;
  rowId: string;
}

export interface RowCacheSnapshot {
  status: "empty" | "pending" | "ready" | "error";
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
  status: "empty" | "pending" | "ready" | "error";
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

export type QueryExecutionMode = "default" | "cache-first" | "bypass-cache";

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
export type ReadyQueryLifecycle<T extends Record<string, unknown>> = QueryReadyRuntime<T> &
  QuerySubscriber;

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
  /** Exact immutable change files whose effects are included in this snapshot. */
  coveredChangeFiles?: string[];
  tables: Record<string, Record<string, Row>>;
}

export interface MeshChangePayload {
  meshId: string;
  kind: "change";
  entry: ChangeEntry;
}

export interface MeshSnapshotPayload {
  meshId: string;
  kind: "snapshot";
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
  /** Snapshot HLC for state order and acknowledgement; exact coverage is named by the snapshot. */
  watermarkHlc: string;
  /** Cloud path to the latest snapshot file, or null before first compaction. */
  snapshotPath: string | null;
  /** Reserved for future delta-based catch-up. */
  deltaPath: string | null;

  /** Finite mesh retention policy. Manifests without this field resolve to safe defaults. */
  retention?: RetentionPolicy;
}

/** User-controlled retention durations. Both values must be positive and finite. */
export interface RetentionPolicyInput {
  /** Oldest uploaded change age before compaction becomes mandatory. Default: 7 days. */
  compactAfterMs?: number;
  /** Longest absence after which queued writes are quarantined instead of published. Default: 30 days. */
  maxOfflineDurationMs?: number;
}

/** Fully resolved finite retention policy stored in new mesh manifests. */
export interface RetentionPolicy {
  compactAfterMs: number;
  maxOfflineDurationMs: number;
}

export interface QuarantinedOfflineChanges {
  expiredAt: string;
  lastSuccessfulSyncAt: string;
  maxOfflineDurationMs: number;
  entries: ChangeEntry[];
}

export type DeviceType = "web" | "ios" | "android" | "worker" | "desktop" | "tv";

export interface DeviceMetadata extends DeviceInfo {
  registeredAt: string;
  lastSeenAt: string;
  /** Human-readable device name, e.g. "Anton's laptop" */
  displayName?: string;
  /** Device class */
  deviceType?: DeviceType;
  retired?: boolean;

  /** Latest manifest generation this device has fully observed. */
  observedManifestGeneration?: number;
  /** Latest snapshot epoch this device has fully observed. */
  observedEpoch?: number;
  /** Latest manifest watermark this device has fully observed. */
  observedWatermarkHlc?: string;
  /** Timestamp of the observation acknowledgement. */
  observedAt?: string;
  /** Timestamp when this device was manually retired. */
  cutOffAt?: string;
  cutOffReason?: "manual-retire";
}

export interface DeviceHead {
  device: string;
  latestHlc: string;
  latestDate: string;
  fileCount: number;
}

/** Global change-folder head — monotonic diagnostic hint, never coverage proof. */
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

/** Metadata for durable application files stored beside a mesh. */
export interface StoredFileMetadata extends FileEntry {
  /** Device that uploaded the current object version. */
  uploadedByDeviceId?: string;
  /** ISO timestamp for the current object version upload. */
  uploadedAt?: string;
  /** Last successful read timestamp, when tracked by the backend. */
  lastAccessedAt?: string;
  /** Total successful reads, when tracked by the backend. */
  useCount?: number;
  /** Original plaintext byte length, when known. */
  plaintextSize?: number;
  /** Stored ciphertext/transport byte length. Defaults to size. */
  storedSize?: number;
  /** Application content type, if provided by the uploader. */
  contentType?: string;
  /** Optional human-readable label for bytes sealed with an extra key. */
  taint?: string;
  /**
   * Lowercase hex SHA-256 of the plaintext bytes. Always present on the
   * metadata `putFile` returns; present on later metadata reads only when the
   * backend persisted it.
   */
  digest?: string;
}

/**
 * A row column that names a durable file.
 *
 * The row is the offline-readable index; the bytes stay in durable file
 * storage and are fetched on demand. `digest` is what makes the reference
 * immutable: a later `putFile` to the same path yields a different digest, so
 * any cache keyed by `digest` (memory, IndexedDB, Cache API) never serves
 * stale bytes, and `getFile(ref)` verifies the bytes it opened against it.
 * Build one from a `putFile` result with `toFileRef`, and declare the column
 * with `types.file`.
 */
export interface FileRef {
  /** Durable file path as passed to `putFile`. */
  path: string;
  /** Lowercase hex SHA-256 of the plaintext bytes. */
  digest: string;
  /** Plaintext byte length. */
  size: number;
  /** Application content type, when the uploader supplied one. */
  contentType?: string;
  /** Taint label when the bytes are sealed with an extra key. */
  taint?: string;
}

export interface FileSeal {
  /** Human-readable label for the extra key used to seal this file. */
  taint: string;
  /** Extra key used instead of the mesh key for this file's bytes. */
  key: CryptoKey;
}

export interface SealedFile {
  /** Metadata returned by the adapter before plaintext is opened. */
  metadata: StoredFileMetadata;
  /** Optional human-readable label for bytes sealed with an extra key. */
  taint?: string;
  /** Decrypt the downloaded bytes. Tainted files require the matching extra key. */
  open(key?: CryptoKey): Promise<Uint8Array>;
}

export interface StoredFileWriteOptions {
  /** Device identity to persist for abuse controls/audit. */
  uploadedByDeviceId?: string;
  /** Plaintext byte length before encryption. */
  plaintextSize?: number;
  /** Application content type. */
  contentType?: string;
  /** Optional human-readable label for bytes sealed with an extra key. */
  taint?: string;
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

  // Object CRUD
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  deleteFile(path: string): Promise<void>;

  // Metadata
  getFileMetadata(path: string): Promise<FileEntry | null>;

  // Durable application file CRUD. When omitted, the engine falls back to the
  // regular file primitives.
  putStoredFile?(
    path: string,
    data: Uint8Array | string,
    options?: StoredFileWriteOptions,
  ): Promise<StoredFileMetadata>;
  getStoredFile?(path: string): Promise<Uint8Array>;
  deleteStoredFile?(path: string): Promise<void>;
  getStoredFileMetadata?(path: string): Promise<StoredFileMetadata | null>;

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
   * Advertise pairing features supported or required by this adapter route.
   * Missing capability metadata means pairing with no feature requirements.
   *
   * Per-call pairing capabilities are unioned with this profile and cannot
   * remove adapter requirements.
   */
  getPairingCapabilities?(): PairingCapabilities | null | Promise<PairingCapabilities | null>;

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

// ─── Local Store ─────────────────────────────────────────────────────

export type { LocalStore } from "../storage/local-store.ts";

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

/**
 * Policy for local data already present when this engine joins an existing
 * remote mesh whose identity differs from the local cache.
 *
 * - `'reset-to-remote'` (default): reset local state to the remote mesh. Clear
 *   local rows, queued writes, cursors, and stale mesh metadata before pulling.
 * - `'merge-with-remote'`: keep local data and queued writes, allowing normal
 *   CRDT merge/flush behavior to publish local rows into the joined mesh.
 */
export type JoinExistingMeshPolicy = "reset-to-remote" | "merge-with-remote";

export type ConnectionStatus = "offline" | "connecting" | "syncing" | "idle";

export interface ConnectionStatusDetails {
  /** Primitive status for UI gates and labels. */
  status: ConnectionStatus;
  /** True when the engine has no remote mesh path configured. */
  solo: boolean;
  /** Local store has initialized and local reads/writes are available. */
  ready: boolean;
  /** Remote sync is connected and polling/listening. */
  connected: boolean;
  /**
   * The access decision that paused remote sync, or `null`. Set when the
   * remote answered 401, 403, or a mesh-level 404; cleared by a successful
   * `connect()`, `disconnect()`, or `setRemoteStorage()`.
   */
  remoteAccess: RemoteAccessError | null;
  /** Current remote path, if configured. */
  remotePath?: string;
  /** Current mesh id, once known. */
  meshId?: string;
  /** Current device id. */
  deviceId: string;
}

export type LogLevel = import("./internals.ts").LogLevel;

export interface SyncConfig<
  S extends Record<string, Record<string, unknown>> = Record<string, Record<string, unknown>>,
> {
  /** Cloud folder path prefix, e.g. "/Interocitor" */
  remotePath?: string;
  /**
   * Primary mesh-key configuration.
   *
   * Use a `MeshKeySource` to describe how the final mesh key is obtained:
   * portable shared key, bound shared key, or another runtime-owned strategy.
   */
  keySource: import("../crypto/key-source.ts").MeshKeySource | null;
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
  /** Enable relay/WebSocket invalidations when supported. Default true. */
  relayEnabled?: boolean;
  /** Poll interval to use while relay is healthy. Default max(pollInterval, 300000). */
  relayHealthyPollInterval?: number;
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
  /**
   * Finite retention limits for uploaded history and offline writers.
   * Defaults to 7 days before mandatory compaction and 30 days of offline
   * write eligibility. `0`, negative values, `NaN`, and `Infinity` throw.
   */
  retention?: RetentionPolicyInput;
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
  /** Implicit batch period in ms. All local writes inside the period join one ChangeEntry. Default 1000. */
  batchWindowMs?: number;
  /**
   * Runtime-owned local persistence for rows, outbox, cursors, and metadata.
   * Core never creates a default local store.
   */
  localStore: import("../storage/local-store.ts").LocalStore;
  /**
   * Optional label used in diagnostics and credential-store namespacing.
   * It does not select or create a local backend.
   */
  dbName?: string;
  /**
   * What to do with existing local data when connect() joins an existing remote
   * mesh with a different mesh identity than this local cache.
   *
   * Default: `'reset-to-remote'` — reset local state to the remote mesh. Local
   * rows, queued writes, pending writes, cursors, and stale mesh metadata are
   * cleared before pulling remote data.
   *
   * Use `'merge-with-remote'` for flows that intentionally keep local rows and
   * queued writes and merge them into the joined mesh via normal CRDT sync.
   */
  joinExistingMeshPolicy?: JoinExistingMeshPolicy;
  /**
   * Per-stage timeout for cloud work performed during connect(). Each
   * connect stage (authenticate, ensureFolder, manifest, device metadata,
   * pull/rehydrate, first flush) must complete within this period or it
   * is treated as stalled. Default: 15 000 ms.
   *
   * When a stage stalls the engine enters an offline-ready state:
   *   - isReady() === true
   *   - local writes still queue to the outbox
   *   - connect() is safely re-callable
   *   - no `throw` escapes connect()
   * Applications can react via `onConnectStalled`.
   */
  connectStageTimeoutMs?: number;
  /**
   * Called when connect() degraded to offline-ready because a cloud stage
   * exceeded its deadline. Receives the stage name, the original error
   * (`ConnectStageTimeoutError` for deadline-driven stalls) and the
   * configured timeout. Hook must not throw — failures are swallowed
   * to preserve the "never stuck" guarantee.
   */
  onConnectStalled?: (info: { stage: string; timeoutMs: number; error: unknown }) => void;
  /** Optional table/index metadata for local query planning and compatibility checks. */
  schema?: DatabaseSchemaDefinition<S>;

  /**
   * Optional browser-owned bootstrap hook.
   * Runs during init() before persisted credentials are restored.
   * Returned values override constructor defaults; persisted storage fills blanks only.
   */
  resolveInitialState?: () => SyncInitialState | Promise<SyncInitialState | null> | null;

  /**
   * Called once per engine initialization after the local store opens,
   * encryption resolves, and local state loads. It runs before `connect()`.
   *
   * It may perform application-owned bootstrap work or local transformations,
   * but it sees only the current local cache. Core assigns no migration
   * semantics to this hook and does not coordinate it across devices.
   *
   * @example
   * onInit: async (engine) => {
   *   await normalizeApplicationData(engine);
   * }
   */
  onInit?: (engine: import("./sync-engine.ts").InterocitorInitContext<S>) => Promise<void>;
  /**
   * Write-only replica adapters for backup.
   * Flush writes to primary + all replicas. Pull reads primary only.
   * Replica failures are emitted as 'replica:error' events but do not
   * fail the primary flush.
   */
  replicas?: ReplicaConfig[];
}

// ─── Events ──────────────────────────────────────────────────────────

/**
 * Union of lifecycle, sync, auth, and replication events emitted by the engine.
 */
export type SyncEvent =
  | { type: "sync:start" }
  | { type: "sync:complete"; entriesMerged: number }
  | { type: "sync:error"; error: Error }
  | {
      type: "sync:late-change";
      writerId: string;
      changeHlc: string;
      fileName: string;
      relation: "behind-global-high-water" | "behind-writer-frontier";
      writerFrontierHlc?: string;
      legacyGlobalHighWaterHlc?: string;
    }
  | {
      type: "credentials:restored";
      source: "silent-store";
      deviceIdChanged: boolean;
      hadPassphrase: boolean;
    }
  | { type: "remote:poisoned"; error: Error; path?: string; context?: Record<string, unknown> }
  | { type: "decode:error"; error: Error; path?: string; context?: Record<string, unknown> }
  | {
      type: "credentials:conflict";
      storedDeviceId: string;
      activeDeviceId: string;
      dbName: string;
      remotePath?: string;
    }
  | {
      type: "credentials:meshMismatch";
      dbName: string;
      remotePath?: string;
      storedMeshId: string;
      activeMeshId: string;
    }
  | {
      type: "credentials:persisted";
      dbName: string;
      remotePath?: string;
      deviceId: string;
      encrypted: boolean;
    }
  | {
      type: "encryption:resolved";
      strategy: "passphrase" | "existing-key" | "generated" | string;
      dbName: string;
      remotePath?: string;
      encrypted: boolean;
    }
  | {
      type: "mesh:configured";
      dbName: string;
      remotePath?: string;
      deviceId: string;
      encrypted: boolean;
      hadPassphrase: boolean;
    }
  | { type: "connection:status"; status: ConnectionStatus }
  | {
      type: "connect:state";
      dbName: string;
      remotePath?: string;
      deviceId: string;
      localEpoch?: number;
      remoteEpoch?: number;
      meshId?: string;
      encrypted: boolean;
    }
  | {
      type: "join:existing-mesh";
      dbName: string;
      remotePath?: string;
      deviceId: string;
      previousMeshId?: string;
      nextMeshId: string;
      policy: JoinExistingMeshPolicy;
      localRowCount: number;
      queuedChangeCount: number;
    }
  | {
      type: "connect:noop";
      dbName: string;
      remotePath?: string;
      deviceId: string;
      reason: "already-connected";
    }
  | {
      type: "connect:error";
      error: Error;
      stage: string;
      dbName: string;
      remotePath?: string;
      deviceId: string;
    }
  | {
      type: "transport:teardown";
      dbName: string;
      remotePath?: string;
      deviceId?: string;
      reason: "switch-adapter" | "disconnect" | "detach";
    }
  | { type: "relay:subscribe"; adapter: string; remotePath?: string; deviceId: string }
  | { type: "relay:ready"; adapter: string }
  | { type: "relay:message"; adapter: string; payload: RemoteInvalidationPayload }
  | { type: "relay:error"; adapter: string; error: Error }
  | { type: "relay:closed"; adapter: string }
  | { type: "relay:unavailable"; adapter: string; reason: "adapter-unsupported" | "disabled" }
  | { type: "flush:start"; entryCount: number }
  | { type: "flush:complete" }
  | { type: "flush:error"; error: Error }
  | {
      type: "compact:warning";
      queuedChangeCount: number;
      threshold: number;
      autoCompactThreshold: number;
      remotePath?: string;
      deviceId: string;
    }
  | {
      type: "compact:auto:start";
      queuedChangeCount: number;
      threshold: number;
      sampleRoll?: number;
      sampleWindow?: number;
      remoteChangeFileCount?: number;
      trigger: "immediate" | "delayed";
      remotePath?: string;
      deviceId: string;
    }
  | {
      type: "compact:auto:skip";
      queuedChangeCount: number;
      threshold: number;
      sampleRoll?: number;
      sampleWindow?: number;
      trigger: "immediate" | "delayed";
      remotePath?: string;
      deviceId: string;
      reason:
        | "sampling"
        | "disabled"
        | "not-connected"
        | "already-running"
        | "poisoned"
        | "missing-remote"
        | "peer-mode"
        | "below-remote-threshold"
        | "superseded";
    }
  | {
      type: "compact:auto:complete";
      queuedChangeCount: number;
      threshold: number;
      trigger: "immediate" | "delayed";
      remoteChangeFileCount?: number;
      remotePath?: string;
      deviceId: string;
    }
  | {
      type: "compact:auto:error";
      queuedChangeCount: number;
      threshold: number;
      trigger: "immediate" | "delayed";
      remoteChangeFileCount?: number;
      remotePath?: string;
      deviceId: string;
      error: Error;
    }
  | {
      type: "compact:retention:scheduled";
      dueAt: string;
      oldestChangeAt?: string;
      remotePath?: string;
      deviceId: string;
    }
  | {
      type: "compact:retention:start";
      oldestChangeAt: string;
      ageMs: number;
      remotePath?: string;
      deviceId: string;
    }
  | {
      type: "compact:retention:complete";
      oldestChangeAt: string;
      ageMs: number;
      remotePath?: string;
      deviceId: string;
    }
  | {
      type: "compact:retention:error";
      oldestChangeAt?: string;
      error: Error;
      remotePath?: string;
      deviceId: string;
    }
  | {
      type: "compact:snapshot-cleanup";
      activeSnapshotPath: string;
      attempted: number;
      deleted: number;
      failedPaths: string[];
      error?: Error;
      remotePath?: string;
      deviceId: string;
    }
  | {
      type: "offline:retention-expired";
      expiredAt: string;
      lastSuccessfulSyncAt: string;
      maxOfflineDurationMs: number;
      quarantinedChangeCount: number;
      remotePath?: string;
      deviceId: string;
    }
  | {
      type: "compact:delayed:scheduled";
      queuedChangeCount: number;
      delayMs: number;
      phase: "check" | "compact";
      remotePath?: string;
      deviceId: string;
    }
  | {
      type: "compact:delayed:check";
      queuedChangeCount: number;
      remoteChangeFileCount: number;
      threshold: number;
      remotePath?: string;
      deviceId: string;
    }
  | { type: "change"; table: string; rowId: string; row: Row }
  | { type: "delete"; table: string; rowId: string }
  | { type: "rehydrate:start" }
  | { type: "rehydrate:complete"; rowCount: number }
  | { type: "auth:required" }
  | { type: "auth:complete" }
  | {
      /**
       * The remote answered a request with an access decision. When `paused`
       * is true the decision was negative (401, 403, mesh-level 404): the
       * engine stopped polling, relay, and publishing for this mesh and set
       * `connected` to false. Local reads and writes continue. The
       * application reacts (sign in, read-only view, leave the mesh) and then
       * calls `connect()` again. When `paused` is false the condition is
       * temporary (429, 503) and polling backs off without stopping.
       */
      type: "remote:access";
      error: RemoteAccessError;
      kind: RemoteAccessKind;
      status: number;
      adapter: string;
      operation: string;
      path?: string;
      stage: "connect" | "pull" | "flush" | "file" | "compact";
      paused: boolean;
    }
  | {
      /** `connect()` succeeded after a `remote:access` pause. */
      type: "remote:access:restored";
      adapter: string;
      previous: RemoteAccessError;
    }
  | { type: "schema:mismatch"; local: number; remote: number }
  | { type: "replica:error"; adapter: string; error: Error }
  // ── Trace events ───────────────────────────────────────────────
  // High-volume diagnostics. NOT a public API contract; consumers
  // (devtools, tests) opt in. Engine fires these unconditionally.
  // Use to answer "why is my head/manifest being rewritten?".
  | {
      type: "trace:manifest";
      op: "read" | "write" | "cache-hit" | "bootstrap-create";
      reason: string; // free-form caller tag, e.g. 'connect', 'flush', 'pull', 'compact'
      generation?: number;
      path?: string;
      cached?: boolean; // true when a read was served from in-memory cache
    }
  | {
      type: "trace:head";
      op: "read" | "write" | "skip-no-change";
      reason: string; // 'flush', 'pull-fast-path'
      path?: string;
      priorHlc?: string | null; // HLC currently in head.json (or local cache)
      nextHlc?: string | null; // HLC about to be written
      regressed?: boolean; // true when caller tried to write an HLC older than priorHlc (BUG signal)
    };

/**
 * Listener callback registered with {@link Interocitor.on}.
 */
export type SyncEventListener = (event: SyncEvent) => void;

/**
 * Event emitted by table-level subscriptions.
 */
export type TableEvent<T> =
  | { type: "change"; rowId: string; row: T }
  | { type: "delete"; rowId: string };

/**
 * Listener callback for table-level subscriptions.
 */
export type TableEventListener<T> = (event: TableEvent<T>) => void;
