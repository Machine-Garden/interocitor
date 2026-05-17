/**
 * Sync Engine
 *
 * Orchestrates:
 *  - Local writes → outbox → flush to cloud (primary + replicas)
 *  - Cloud poll → download → decrypt → CRDT merge → local DB
 *  - Rehydration from manifest-authoritative snapshot
 *
 * Network is never required for reads or local writes.
 * All data operations hit IndexedDB first; cloud sync is async.
 */

import type {
  StorageAdapter,
  SyncConfig,
  LocalStoreAdapter,
  ChangeEntry,
  Manifest,
  Row,
  Op,
  ColumnEntry,
  SyncEvent,
  SyncEventListener,
  DatabaseSchemaDefinition,
  WhereClause,
  ReplicaConfig,
  LocalStoreFactory,
  SyncInitialState,
  LogLevel,
  QueryDescriptor,
  QueryExecutionOptions,
  QueryCacheSnapshot,
  ReadinessAwareQueryExecutor,
  RowDescriptor,
  RowCacheSnapshot,
  RemoteInvalidationPayload,
  RemoteInvalidationStorageAdapter,
  StoredFileMetadata,
  ImageInput,
  PutImageOptions,
  StoredImage,
  StoredImageBlobUrl,
  StoredImageMetadata,
} from './types.ts';

import type { HLC } from './types.ts';
import { hlcInit, hlcNow, hlcSerialize, hlcParse, hlcCompareStr } from './hlc.ts';
import { Table, computeCacheKey } from './table.ts';
import { readColumn } from './crdt.ts';
import { createResilientLocalStore } from '../storage/resilient-store.ts';

// Extracted modules
import { paths, logAtLevel, normalizeLogLevel, generateId, getDeviceId } from './internals.ts';
import type { CodecState } from './codec.ts';
import { loadOrCreateManifest, upsertDeviceMetadata } from './manifest.ts';
import { decryptBytes, encryptBytes, generateKey, keyToPassphrase, passphraseToKey } from '../crypto/encryption.ts';
import { MeshCredentialMismatchError } from './errors.ts';
import { ConnectStageTimeoutError, DEFAULT_CONNECT_STAGE_TIMEOUT_MS, withDeadline } from './with-deadline.ts';
import { createCredentialStore, type CredentialStore } from '../storage/credential-store.ts';
import type { ManifestContext } from './manifest.ts';
import { flushToAdapter } from './flush.ts';
import {
  LocalStoreConnectedStoresApi,
  type ConnectedStoresApi,
} from './connected-stores.ts';
import { pull as doPull } from './pull.ts';
import { compact as doCompact, rehydrate as doRehydrate } from './compaction.ts';

// ─── Config ──────────────────────────────────────────────────────────

type ResolvedSyncConfig<S extends Record<string, Record<string, unknown>>> = {
  remotePath?: string;
  serverManaged: boolean;
  serverId: string;
  pollInterval: number;
  flushDebounce: number;
  flushThreshold: number;
  compactWarnThreshold: number;
  compactAutoThreshold: number;
  compactAutoSampleNumerator: number;
  compactAutoDeviceCount: number;
  autoCompact: boolean;
  firstCompactDelayMs: number;
  firstCompactDelayJitterMs: number;
  secondCompactDelayMs: number;
  secondCompactDelayJitterMs: number;
  compactRemoteChangeThreshold: number;
  offlineGraceMs: number;
  batchWindowMs: number;
  dbName: string;
  localStoreFactory: LocalStoreFactory;
  schema?: DatabaseSchemaDefinition<S>;
  replicas: ReplicaConfig[];
  onInit?: SyncConfig<S>['onInit'];
  resolveInitialState?: SyncConfig<S>['resolveInitialState'];
  deviceName?: string;
  deviceType?: import('./types.ts').DeviceType;
  relayEnabled: boolean;
  relayHealthyPollInterval: number;
  connectStageTimeoutMs: number;
  onConnectStalled?: SyncConfig<S>['onConnectStalled'];
};

const DEFAULT_COMPACT_WARNING_THRESHOLD = 50;
const POLL_BACKGROUND_MULTIPLIER = 10;
const DEFAULT_COMPACT_AUTO_THRESHOLD = 50;
const DEFAULT_COMPACT_AUTO_SAMPLE_NUMERATOR = 10;
const DEFAULT_COMPACT_AUTO_DEVICE_COUNT = 1;
const DEFAULT_FIRST_COMPACT_DELAY_MS = 10 * 60_000;
const DEFAULT_FIRST_COMPACT_DELAY_JITTER_MS = 5 * 60_000;
const DEFAULT_SECOND_COMPACT_DELAY_MS = 15 * 60_000;
const DEFAULT_SECOND_COMPACT_DELAY_JITTER_MS = 5 * 60_000;
const DEFAULT_COMPACT_REMOTE_CHANGE_THRESHOLD = 2;
const DEFAULT_OFFLINE_GRACE_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_BATCH_WINDOW_MS = 1_000;

// ─── Sync Engine ─────────────────────────────────────────────────────

/**
 * Typed sync engine. `S` is your database shape — inferred automatically
 * from `InferSchemaType<typeof schema>`. No default: either typed or `any`.
 *
 * Initialization is automatic — just construct and use. No `await engine.init()` needed.
 *
 * @example
 * const schema = { tables: { tasks: { fields: { title: types.string } } } }
 *   satisfies DatabaseSchemaDefinition;
 *
 * type DB = InferSchemaType<typeof schema>;
 *
 * // Local-only (no adapter):
 * const db = new Interocitor<DB>({ schema, dbName: 'myapp', appName: 'My App' });
 * const tasks = await db.table('tasks').query(); // ready immediately
 *
 * // With remote sync:
 * const db = new Interocitor<DB>(adapter, { schema, remotePath: '/App', appName: 'App' });
 * await db.connect(); // authenticate + sync
 *
 * db.table('other'); // TS error — 'other' is not keyof DB
 */
export interface InterocitorInitContext<S extends Record<string, Record<string, unknown>>>
  extends ReadinessAwareQueryExecutor {
  put<K extends keyof S & string>(table: K, rowId: string, columns: Partial<S[K]>, userId?: string): Promise<S[K]>;
  delete<K extends keyof S & string>(table: K, rowId: string, userId?: string): Promise<void>;
  query<K extends keyof S & string>(table: K): Promise<S[K][]>;
  queryWhere<K extends keyof S & string>(table: K, clause: WhereClause): Promise<S[K][]>;
  table<K extends keyof S & string>(name: K): Table<S[K]>;
  on(listener: SyncEventListener): () => void;
  getDeviceId(): string;
  getMeshId(): string | undefined;
  isEncrypted(): boolean;
}

/**
 * In-memory async query cache. Keyed by `QueryDescriptor.cacheKey`.
 *
 * Lives in core because cache identity is a core concern. React (or any other
 * binding) only reads/subscribes; it does not own keys, fetches, or
 * invalidation rules.
 *
 * Behavior:
 *  - first request for a key starts a load and stores the in-flight promise
 *    so concurrent requests dedupe to one fetch
 *  - resolved rows are kept until invalidation
 *  - any local change/delete on the descriptor's table marks all entries for
 *    that table stale and triggers background revalidation; old rows stay
 *    visible until the new load resolves (no "flash of absent data")
 *  - bypassCache forces a fresh load and replaces the snapshot when ready
 */
type QueryCacheEntry = {
  descriptor: QueryDescriptor;
  status: 'pending' | 'ready' | 'error';
  rows?: Row[];
  error?: Error;
  promise?: Promise<Row[]>;
};

type RowCacheEntry = {
  descriptor: RowDescriptor;
  status: 'pending' | 'ready' | 'error';
  /** `null` means loaded-but-absent. `undefined` means never loaded. */
  row?: Row | null;
  error?: Error;
  promise?: Promise<Row | undefined>;
};

export class Interocitor<S extends Record<string, Record<string, unknown>>>
  implements ReadinessAwareQueryExecutor {
  declare readonly InitContext: InterocitorInitContext<S>;
  private adapter: StorageAdapter | null;
  private config: ResolvedSyncConfig<S>;
  private serverId: string;
  private local: LocalStoreAdapter;
  private deviceId: string;
  private hlc: HLC;
  private encryptionKey: CryptoKey | null = null;
  private encrypted = false;
  private passphrase: string | null = null;

  // In-memory CRDT merge cache — lazily populated on writes and pulls.
  private tables: Record<string, Record<string, Row>> = {};
  private manifest: Manifest | null = null;
  private remotePoisonError: Error | null = null;

  // Known table names (populated from IDB index on init, updated on writes)
  private knownTables: Set<string> = new Set();

  // Flush management
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingCount = 0;
  private compactWarningEmitted = false;
  private compactInFlight: Promise<void> | null = null;
  private compactScheduleVersion = 0;
  private compactCheckTimer: ReturnType<typeof setTimeout> | null = null;
  private compactRunTimer: ReturnType<typeof setTimeout> | null = null;
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingBatch: ChangeEntry | null = null;

  // Poll / push invalidation management
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollBaseIntervalMs = 0;
  private pollCurrentIntervalMs = 0;
  private pollGeneration: object = {};
  private visibilityChangeListener: (() => void) | null = null;
  private unsubscribeRemoteInvalidations: (() => void) | null = null;
  private remoteInvalidationPullPromise: Promise<void> | null = null;
  private remoteInvalidationPullQueued = false;
  private remoteInvalidationCooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private remoteInvalidationCooldownQueued = false;

  // Lifecycle state
  private initialized = false;
  private connected = false;
  private connectionStatus: import('./types.ts').ConnectionStatus = 'offline';
  private initPromise: Promise<void> | null = null;
  // In-flight connect dedupe. Concurrent callers (React StrictMode double-
  // mount, dual auto-reconnect resolves) share the same execution instead of
  // both running the full connect() pipeline (manifest create, pull, flush,
  // startPolling) twice in parallel — which doubles every flushed change file
  // and stacks polling timers.
  private connectPromise: Promise<void> | null = null;
  private readonly logLevel: LogLevel;

  // Event listeners
  private listeners: Set<SyncEventListener> = new Set();
  private readonly schema?: DatabaseSchemaDefinition<S>;
  private readonly credentialStore: CredentialStore | null;
  private readonly dbName: string;
  private connectedStoresApi: ConnectedStoresApi | null = null;

  // Async query cache. cacheKey -> entry. See QueryCacheEntry doc above.
  private queryCache: Map<string, QueryCacheEntry> = new Map();
  // table name -> set of cache keys whose descriptors target that table.
  private queryCacheByTable: Map<string, Set<string>> = new Map();

  // Single-row cache. Mirrors queryCache 1:1 in shape and lifecycle.
  // key = `r=table|id=rowId`. Same emit() chokepoint invalidates.
  private rowCache: Map<string, RowCacheEntry> = new Map();
  private rowCacheByTable: Map<string, Set<string>> = new Map();

  /**
   * Create a sync engine.
   *
   * Pass a remote adapter up front for immediate sync support, or pass only
   * config to start fully local and attach a remote later with
   * {@link setRemoteStorage}.
   *
   * The schema type `S` is inferred automatically from the `schema` field in
   * config — no manual type parameter needed:
   *
   * @example
   * const engine = new Interocitor(adapter, { schema, remotePath: '/App', appName: 'App' });
   * const tasks = engine.table('tasks'); // Table<{ title: string; status: 'open' | 'done' }>
   */
  constructor(config: SyncConfig<S>);
  constructor(adapter: StorageAdapter | null, config: SyncConfig<S>);
  constructor(adapterOrConfig: StorageAdapter | SyncConfig<S> | null, maybeConfig?: SyncConfig<S>) {
    const config = (maybeConfig ?? adapterOrConfig) as SyncConfig<S>;
    const adapter = (maybeConfig ? adapterOrConfig : null) as StorageAdapter | null;

    this.schema = config.schema;
    this.credentialStore = config.credentialStore === null
      ? null
      : config.credentialStore ?? createCredentialStore(config.dbName ?? 'interocitor', config.appName);
    this.adapter = adapter;
    this.config = {
      remotePath: config.remotePath,
      serverManaged: config.serverManaged ?? false,
      serverId: config.serverId ?? 'server_relay_1',
      pollInterval: config.pollInterval ?? 30_000,
      flushDebounce: config.flushDebounce ?? 2_000,
      flushThreshold: config.flushThreshold ?? 50,
      compactWarnThreshold: config.compactWarnThreshold ?? DEFAULT_COMPACT_WARNING_THRESHOLD,
      compactAutoThreshold: config.compactAutoThreshold ?? DEFAULT_COMPACT_AUTO_THRESHOLD,
      compactAutoSampleNumerator: config.compactAutoSampleNumerator ?? DEFAULT_COMPACT_AUTO_SAMPLE_NUMERATOR,
      compactAutoDeviceCount: Math.max(1, Math.floor(config.compactAutoDeviceCount ?? DEFAULT_COMPACT_AUTO_DEVICE_COUNT)),
      autoCompact: config.autoCompact ?? true,
      firstCompactDelayMs: config.firstCompactDelayMs ?? DEFAULT_FIRST_COMPACT_DELAY_MS,
      firstCompactDelayJitterMs: config.firstCompactDelayJitterMs ?? DEFAULT_FIRST_COMPACT_DELAY_JITTER_MS,
      secondCompactDelayMs: config.secondCompactDelayMs ?? DEFAULT_SECOND_COMPACT_DELAY_MS,
      secondCompactDelayJitterMs: config.secondCompactDelayJitterMs ?? DEFAULT_SECOND_COMPACT_DELAY_JITTER_MS,
      compactRemoteChangeThreshold: config.compactRemoteChangeThreshold ?? DEFAULT_COMPACT_REMOTE_CHANGE_THRESHOLD,
      offlineGraceMs: config.offlineGraceMs ?? DEFAULT_OFFLINE_GRACE_MS,
      batchWindowMs: config.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS,
      dbName: config.dbName ?? 'interocitor',
      localStoreFactory: config.localStoreFactory ?? (() => createResilientLocalStore({
        dbName: config.dbName,
        schema: config.schema,
        openTimeoutMs: config.localOpenTimeoutMs,
        onDegraded: config.onLocalDegraded,
      })),
      schema: config.schema,
      replicas: config.replicas ?? [],
      onInit: config.onInit,
      resolveInitialState: config.resolveInitialState,
      relayEnabled: config.relayEnabled ?? true,
      relayHealthyPollInterval: config.relayHealthyPollInterval ?? Math.max(config.pollInterval ?? 30_000, 300_000),
      connectStageTimeoutMs: config.connectStageTimeoutMs ?? DEFAULT_CONNECT_STAGE_TIMEOUT_MS,
      onConnectStalled: config.onConnectStalled,
    };
    this.serverId = this.config.serverId;
    this.dbName = this.config.dbName;
    this.logLevel = normalizeLogLevel(config.logLevel);
    this.local = this.config.localStoreFactory();
    this.deviceId = getDeviceId(config.deviceId);
    this.hlc = hlcInit(this.deviceId);

    // Encryption on by default. Opt out with encrypted: false.
    if (config.encrypted === false) {
      this.encrypted = false;
    } else if (config.passphrase) {
      this.passphrase = config.passphrase;
      this.encrypted = true;
    } else {
      this.encrypted = true;
      // Will generate key in doInit() if no persisted key found
    }

  }

  private log(level: LogLevel, ...args: unknown[]): void {
    logAtLevel(this.logLevel, level, ...args);
  }

  private supportsRemoteInvalidations(adapter: StorageAdapter): adapter is StorageAdapter & RemoteInvalidationStorageAdapter {
    return typeof (adapter as Partial<RemoteInvalidationStorageAdapter>).subscribeToInvalidations === 'function';
  }

  /** Await this before any storage operation. Returns the shared init promise. */
  private ensureReady(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    if (!this.initPromise) this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async putNow<K extends keyof S & string>(
    table: K,
    rowId: string,
    columns: Partial<S[K]>,
    _userId?: string,
  ): Promise<S[K]> {
    const tableName = table as string;
    const current = await this.local.getRow(tableName, rowId);
    const isResurrection = current?._meta.deleted === true;
    // Clone row with namespaced shape. New rows and resurrected tombstones start
    // with empty payload so a partial insert after delete cannot republish
    // pre-delete columns.
    const row: Row = current
      ? { _meta: { ...current._meta }, payload: isResurrection ? {} : { ...current.payload } }
      : {
          _meta: { table: tableName, rowId, deleted: false, schemaVersion: this.schema?.version ?? 0 },
          payload: {},
        };

    const nextHlc = hlcNow(this.hlc);
    this.hlc = nextHlc;
    const stamp = hlcSerialize(nextHlc);

    // User payload is fully isolated. Any key — including names like
    // `_table`, `_rowId`, `_meta`, `payload` — is safe; meta is a separate
    // namespace and cannot be reached by user input.
    for (const [key, value] of Object.entries(columns as Record<string, unknown>)) {
      row.payload[key] = { value: value === undefined ? null : value, hlc: stamp };
    }
    row._meta.deleted = false;
    row._meta.deletedHlc = undefined;
    row._meta.owner = this.deviceId;

    await this.local.putRow(row);
    const op = this.rowToSyncOp(row);
    const hlc = this.getRowHlc(row);
    if (op && hlc) await this.queueOpForBatchedFlush(op, hlc);
    this.knownTables.add(tableName);

    this.emit({ type: 'change', table: tableName, rowId, row });
    return row as unknown as S[K];
  }

  private async deleteNow<K extends keyof S & string>(table: K, rowId: string, _userId?: string): Promise<void> {
    const tableName = table as string;
    const current = await this.local.getRow(tableName, rowId);
    if (!current || current._meta.deleted) return;

    const nextHlc = hlcNow(this.hlc);
    this.hlc = nextHlc;
    current._meta.deleted = true;
    current._meta.deletedHlc = hlcSerialize(nextHlc);
    current._meta.owner = this.deviceId;
    // Tombstones carry only deletion metadata. Payload is no longer needed for
    // CRDT conflict checks and should not retain deleted user data.
    current.payload = {};
    await this.local.putRow(current);
    const op = this.rowToSyncOp(current);
    const hlc = this.getRowHlc(current);
    if (op && hlc) await this.queueOpForBatchedFlush(op, hlc);
    this.emit({ type: 'delete', table: tableName, rowId });
  }

  /**
   * Append the op to the in-flight batch. If we are inside a `batch()` block,
   * the op stays buffered until the block ends. Otherwise it joins an
   * implicit window of `batchWindowMs`. Either way the result is one
   * ChangeEntry per batch instead of one per write.
   */
  private async queueOpForBatchedFlush(op: Op, hlc: string): Promise<void> {
    this.appendOpToPendingBatch(op, hlc);
    if (this.isBatching()) return;
    if (this.config.batchWindowMs <= 0) {
      await this.flushPendingBatch();
      return;
    }
    this.armImplicitBatchTimer();
  }

  private async queryNow<K extends keyof S & string>(table: K): Promise<S[K][]> {
    return this.local.getTable(table as string) as unknown as S[K][];
  }

  private async queryWhereNow<K extends keyof S & string>(table: K, clause: WhereClause): Promise<S[K][]> {
    return this.local.queryWhere(table as string, clause) as unknown as S[K][];
  }

  // ── Query cache (async-only, descriptor-keyed) ─────────────────────

  /** Public readiness signal. Used by render-time consumers to decide
   *  between sync cache reads and awaiting a load. */
  isReady(): boolean {
    return this.initialized;
  }

  getConnectionStatus(): import('./types.ts').ConnectionStatus {
    return this.connectionStatus;
  }

  getConnectionStatusDetails(): import('./types.ts').ConnectionStatusDetails {
    const solo = !this.config.remotePath;
    return {
      status: this.getConnectionStatus(),
      solo,
      ready: this.initialized,
      connected: this.connected,
      remotePath: this.config.remotePath,
      meshId: this.manifest?.meshId,
      deviceId: this.deviceId,
    };
  }

  private setConnectionStatus(status: import('./types.ts').ConnectionStatus): void {
    if (this.connectionStatus === status) {
      this.emit({ type: 'connection:status', status: this.getConnectionStatus() });
      return;
    }
    this.connectionStatus = status;
    this.emit({ type: 'connection:status', status: this.getConnectionStatus() });
  }

  /** Stable cache key for a descriptor. Owned by core. */
  getQueryCacheKey(descriptor: QueryDescriptor): string {
    return computeCacheKey(descriptor);
  }

  /** Sync cache snapshot. Never starts a load. Empty/pending/ready/error. */
  readQueryCache(descriptor: QueryDescriptor): QueryCacheSnapshot {
    const key = this.getQueryCacheKey(descriptor);
    const entry = this.queryCache.get(key);
    if (!entry) return { status: 'empty', promise: null };
    return {
      status: entry.status,
      promise: entry.promise ?? null,
      rows: entry.rows,
      error: entry.error,
    };
  }

  /**
   * Load rows through the cache.
   *
   * - If a snapshot exists and `bypassCache` is not set, dedupes to the
   *   in-flight promise (when pending) or starts a refresh that keeps the
   *   stale rows visible until it resolves.
   * - When the engine is not yet ready, falls through `ensureReady()`; if
   *   `bypassCache` is set, never returns the cached rows.
   */
  loadQueryRows(descriptor: QueryDescriptor, options?: QueryExecutionOptions): Promise<Row[]> {
    const key = this.getQueryCacheKey(descriptor);
    const existing = this.queryCache.get(key);

    if (!options?.bypassCache && existing?.status === 'pending' && existing.promise) {
      return existing.promise;
    }
    if (!options?.bypassCache && existing?.status === 'ready' && existing.rows) {
      // Fast-path: hand back resolved rows without re-fetch.
      // Callers that want freshness pass `bypassCache: true`.
      return Promise.resolve(existing.rows);
    }

    return this.runQuery(descriptor, key);
  }

  private runQuery(descriptor: QueryDescriptor, key: string): Promise<Row[]> {
    const promise = (async () => {
      await this.ensureReady();
      const rows = descriptor.clause
        ? await this.local.queryWhere(descriptor.table, descriptor.clause)
        : await this.local.getTable(descriptor.table);
      // Apply deterministic orderBy from descriptor, so cache stores already-
      // ordered rows. Sync-only `.sort(compareFn)` derivations stay outside
      // and run after the cache hand-off.
      if (!descriptor.orderBy) return rows;
      const { field, dir } = descriptor.orderBy;
      // eslint-disable-next-line unicorn/no-array-sort -- package target/browser tests do not provide Array.prototype.toSorted.
      const sorted = [...rows].sort((a, b) => {
        const av = readColumn(a, field);
        const bv = readColumn(b, field);
        if (av === bv) return 0;
        const lt = (av as any) < (bv as any) ? -1 : 1;
        return dir === 'asc' ? lt : -lt;
      });
      return sorted;
    })();

    const previous = this.queryCache.get(key);
    const entry: QueryCacheEntry = {
      descriptor,
      status: 'pending',
      rows: previous?.rows, // keep stale rows visible while refreshing
      promise,
    };
    this.queryCache.set(key, entry);
    this.indexCacheByTable(descriptor.table, key);

    promise.then(rows => {
      const current = this.queryCache.get(key);
      if (current?.promise !== promise) return; // superseded
      this.queryCache.set(key, { descriptor, status: 'ready', rows });
    }).catch(err => {
      const current = this.queryCache.get(key);
      if (current?.promise !== promise) return;
      this.queryCache.set(key, {
        descriptor,
        status: 'error',
        error: err instanceof Error ? err : new Error(String(err)),
        rows: current.rows,
      });
    });

    return promise;
  }

  private indexCacheByTable(table: string, key: string): void {
    let set = this.queryCacheByTable.get(table);
    if (!set) {
      set = new Set();
      this.queryCacheByTable.set(table, set);
    }
    set.add(key);
  }

  /**
   * Mark all cached queries against `table` as stale and refresh them in the
   * background. Stale rows stay visible. Called from local mutations.
   */
  private invalidateQueryCacheForTable(table: string): void {
    const keys = this.queryCacheByTable.get(table);
    if (!keys || keys.size === 0) return;
    for (const key of keys) {
      const entry = this.queryCache.get(key);
      if (!entry) continue;
      void this.runQuery(entry.descriptor, key).catch(() => {
        // runQuery already updates cache state to error; avoid unhandled rejections
      });
    }
  }

  // ── Row cache (async-only, descriptor-keyed) ───────────────────────
  // Same shape and semantics as the query cache. Kept as a separate map so
  // single-row reads don't compete with table scans.

  /** Stable cache key for a row descriptor. Owned by core. */
  getRowCacheKey(descriptor: RowDescriptor): string {
    return `r=${descriptor.table}|id=${descriptor.rowId}`;
  }

  /** Sync row cache snapshot. Never starts a load. */
  readRowCache(descriptor: RowDescriptor): RowCacheSnapshot {
    const key = this.getRowCacheKey(descriptor);
    const entry = this.rowCache.get(key);
    if (!entry) return { status: 'empty', promise: null };
    return {
      status: entry.status,
      promise: entry.promise ?? null,
      row: entry.row,
      error: entry.error,
    };
  }

  /**
   * Load a row through the cache. Same dedupe + stale-while-revalidate
   * semantics as `loadQueryRows`.
   */
  loadRow(descriptor: RowDescriptor, options?: QueryExecutionOptions): Promise<Row | undefined> {
    const key = this.getRowCacheKey(descriptor);
    const existing = this.rowCache.get(key);

    if (!options?.bypassCache && existing?.status === 'pending' && existing.promise) {
      return existing.promise;
    }
    if (!options?.bypassCache && existing?.status === 'ready') {
      return Promise.resolve(existing.row ?? undefined);
    }

    return this.runRow(descriptor, key);
  }

  private runRow(descriptor: RowDescriptor, key: string): Promise<Row | undefined> {
    const promise = (async () => {
      await this.ensureReady();
      const row = await this.local.getRow(descriptor.table, descriptor.rowId);
      if (!row || row._meta.deleted) return;
      return row;
    })();

    const previous = this.rowCache.get(key);
    const entry: RowCacheEntry = {
      descriptor,
      status: 'pending',
      row: previous?.row, // keep stale row visible while refreshing
      promise,
    };
    this.rowCache.set(key, entry);
    this.indexRowCacheByTable(descriptor.table, key);

    promise.then(row => {
      const current = this.rowCache.get(key);
      if (current?.promise !== promise) return;
      this.rowCache.set(key, { descriptor, status: 'ready', row: row ?? null });
    }).catch(err => {
      const current = this.rowCache.get(key);
      if (current?.promise !== promise) return;
      this.rowCache.set(key, {
        descriptor,
        status: 'error',
        error: err instanceof Error ? err : new Error(String(err)),
        row: current.row,
      });
    });

    return promise;
  }

  private indexRowCacheByTable(table: string, key: string): void {
    let set = this.rowCacheByTable.get(table);
    if (!set) {
      set = new Set();
      this.rowCacheByTable.set(table, set);
    }
    set.add(key);
  }

  /**
   * Refresh all cached rows for a table. Called from emit() alongside the
   * query cache invalidation. Keeps prior row visible while in-flight.
   *
   * Table-wide invalidation is intentional: Interocitor targets rare-update
   * workloads, not realtime state streams. The over-fetch on a write is a
   * fixed-cost reload of cached rows for that one table — cheap, simple,
   * and matches the query cache strategy. Finer-grained per-rowId
   * invalidation can be added later without changing this contract.
   */
  private invalidateRowCacheForTable(table: string): void {
    const keys = this.rowCacheByTable.get(table);
    if (!keys || keys.size === 0) return;
    for (const key of keys) {
      const entry = this.rowCache.get(key);
      if (!entry) continue;
      this.runRow(entry.descriptor, key);
    }
  }

  private get initContext(): InterocitorInitContext<S> {
    let context: InterocitorInitContext<S>;
    context = {
      put: this.putNow.bind(this),
      delete: this.deleteNow.bind(this),
      // Cache APIs (ReadinessAwareQueryExecutor). Init-time tables need them
      // because Table constructors and Table.row()/Table.query() resolve
      // through engine.getQueryCacheKey / readQueryCache / loadQueryRows
      // (and row equivalents). Without these, onInit handlers calling
      // ctx.table(x).row(id) crash at construction time.
      isReady: this.isReady.bind(this),
      getQueryCacheKey: this.getQueryCacheKey.bind(this),
      readQueryCache: this.readQueryCache.bind(this),
      loadQueryRows: this.loadQueryRows.bind(this),
      getRowCacheKey: this.getRowCacheKey.bind(this),
      readRowCache: this.readRowCache.bind(this),
      loadRow: this.loadRow.bind(this),
      query: this.queryNow.bind(this),
      queryWhere: this.queryWhereNow.bind(this),
      table: <K extends keyof S & string>(name: K) => new Table(context as any, name),
      on: this.on.bind(this),
      getDeviceId: this.getDeviceId.bind(this),
      getMeshId: this.getMeshId.bind(this),
      isEncrypted: this.isEncrypted.bind(this),
    };
    return context;
  }

  // ── Internal accessors ─────────────────────────────────────────────

  private requireAdapter(operation: string): StorageAdapter {
    if (this.remotePoisonError) throw this.remotePoisonError;
    if (!this.adapter) {
      throw new Error(`No remote storage adapter configured. Call setRemoteStorage() before ${operation}.`);
    }
    return this.adapter;
  }

  private requireRemotePath(operation: string): string {
    if (!this.config.remotePath) throw new Error(`${operation} requires remotePath; configure mesh before connecting`);
    return this.config.remotePath;
  }

  private storedFilePath(path: string): string {
    const remotePath = this.requireRemotePath('file storage');
    const clean = path.split('/').filter(Boolean).join('/');
    if (!clean) throw new Error('File path must not be empty');
    return `${remotePath.replace(/\/$/, '')}/files/${clean}`;
  }

  private async encodeStoredFile(data: Uint8Array | string): Promise<{ stored: Uint8Array; plaintextSize: number }> {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    if (!this.encrypted) return { stored: bytes, plaintextSize: bytes.byteLength };
    if (!this.encryptionKey) await this.resolveEncryption();
    if (!this.encryptionKey) throw new Error('File storage requires an encryption key');
    return { stored: await encryptBytes(this.encryptionKey, bytes), plaintextSize: bytes.byteLength };
  }

  private async decodeStoredFile(data: Uint8Array): Promise<Uint8Array> {
    if (!this.encrypted) return data;
    if (!this.encryptionKey) await this.resolveEncryption();
    if (!this.encryptionKey) throw new Error('File storage requires an encryption key');
    return decryptBytes(this.encryptionKey, data);
  }

  private inferImageContentType(path: string, explicit?: string | null): string {
    if (explicit) {
      if (!explicit.toLowerCase().startsWith('image/')) throw new Error(`Image content type must start with image/: ${explicit}`);
      return explicit;
    }
    const ext = path.split('?')[0]?.split('#')[0]?.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg';
      case 'png':
        return 'image/png';
      case 'gif':
        return 'image/gif';
      case 'webp':
        return 'image/webp';
      case 'svg':
        return 'image/svg+xml';
      case 'avif':
        return 'image/avif';
      case 'bmp':
        return 'image/bmp';
      case 'ico':
        return 'image/x-icon';
      default:
        return 'image/png';
    }
  }

  private parseImageDataUrl(dataUrl: string): { data: Uint8Array; contentType?: string } | null {
    const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
    if (!match) return null;
    const contentType = match[1] || undefined;
    const isBase64 = Boolean(match[2]);
    const payload = match[3] ?? '';
    if (isBase64) {
      const binary = atob(payload.replace(/\s+/g, ''));
      const data = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) data[i] = binary.charCodeAt(i);
      return { data, contentType };
    }
    return { data: new TextEncoder().encode(decodeURIComponent(payload)), contentType };
  }

  private async encodeImageInput(input: ImageInput, path: string, contentType?: string): Promise<{ data: Uint8Array; contentType: string }> {
    if (typeof Blob !== 'undefined' && input instanceof Blob) {
      const type = this.inferImageContentType(path, contentType || input.type || undefined);
      return { data: new Uint8Array(await input.arrayBuffer()), contentType: type };
    }
    if (typeof input === 'string') {
      const parsed = this.parseImageDataUrl(input);
      if (parsed) return { data: parsed.data, contentType: this.inferImageContentType(path, contentType || parsed.contentType) };
      return { data: new TextEncoder().encode(input), contentType: this.inferImageContentType(path, contentType || 'image/svg+xml') };
    }
    if (input instanceof Uint8Array) return { data: input, contentType: this.inferImageContentType(path, contentType) };
    if (input instanceof ArrayBuffer) return { data: new Uint8Array(input), contentType: this.inferImageContentType(path, contentType) };
    throw new Error('Unsupported image input in this runtime');
  }

  private coerceImageMetadata(meta: StoredFileMetadata | null, contentType: string): StoredImageMetadata | null {
    if (!meta) return null;
    return { ...meta, contentType: this.inferImageContentType(meta.path, meta.contentType || contentType) };
  }

  private async rebuildOutboxFromLocalState(): Promise<void> {
    const rows = await this.local.getAllRows();
    const entries: ChangeEntry[] = [];
    for (const row of rows) {
      const op = this.rowToSyncOp(row);
      const hlc = this.getRowHlc(row);
      if (!op || !hlc) continue;
      entries.push({
        id: generateId('chg'),
        ts: Date.now(),
        device: this.deviceId,
        hlc,
        ops: [op],
      });
    }
    if (entries.length === 0) return;
    await this.local.pushOutboxEntries(entries);
    this.pendingCount = await this.local.outboxSize();
  }

  private get codecState(): CodecState {
    return {
      encryptionKey: this.encryptionKey,
      encrypted: this.encrypted,
      manifest: this.manifest,
    };
  }

  private get manifestContext(): ManifestContext {
    return {
      adapter: this.requireAdapter('manifest'),
      remotePath: this.requireRemotePath('manifest'),
      serverId: this.serverId,
      serverManaged: this.config.serverManaged,
      deviceId: this.deviceId,
      encrypted: this.encrypted,
      schema: this.schema,
      emit: (e) => this.emit(e),
    };
  }

  private async acknowledgeManifest(): Promise<void> {
    if (!this.adapter || !this.config.remotePath || !this.manifest) return;
    // Before the first compaction there is no canonical watermark/floor to
    // acknowledge. Initial connect already writes device presence metadata;
    // avoid an extra no-op device write/read on every bootstrap/reconnect.
    if (!this.manifest.watermarkHlc && !this.manifest.gcFloorHlc && this.manifest.epoch === 0) return;
    await upsertDeviceMetadata(this.adapter, this.config.remotePath, this.deviceId, {
      displayName: this.config.deviceName,
      deviceType: this.config.deviceType,
      observedManifestGeneration: this.manifest.generation,
      observedEpoch: this.manifest.epoch,
      observedWatermarkHlc: this.manifest.watermarkHlc,
      observedGcFloorHlc: this.manifest.gcFloorHlc,
      skipTouchIfUnchanged: true,
    });
    await this.local.setMeta('gcFloorHlc', this.manifest.gcFloorHlc ?? '');
    await this.local.setMeta('gcEpoch', this.manifest.gcEpoch ?? 0);
  }

  // ── Flush / poll timers ────────────────────────────────────────────

  private clearScheduledFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private clearCompactTimers(): void {
    if (this.compactCheckTimer) clearTimeout(this.compactCheckTimer);
    if (this.compactRunTimer) clearTimeout(this.compactRunTimer);
    this.compactCheckTimer = null;
    this.compactRunTimer = null;
    this.compactScheduleVersion += 1;
  }

  private jitterDelay(baseMs: number, jitterMs: number): number {
    if (jitterMs <= 0) return Math.max(0, baseMs);
    const min = Math.max(0, baseMs - jitterMs);
    const max = baseMs + jitterMs;
    return Math.floor(min + Math.random() * (max - min + 1));
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.pollGeneration = {}; // invalidate any in-flight pull's generation
    this.pollBaseIntervalMs = 0;
  }

  private startPolling(intervalMs = this.config.pollInterval): void {
    this.stopPolling();
    this.pollBaseIntervalMs = intervalMs;
    this.pollCurrentIntervalMs = intervalMs;
    // Each startPolling call gets its own generation token so that in-flight
    // pulls from a previous polling session don't reschedule after stopPolling.
    const generation = {};
    this.pollGeneration = generation;
    const schedule = (): void => {
      this.pollTimer = setTimeout(() => {
        this.pollTimer = null;
        this.pull().catch(() => {}).finally(() => {
          if (this.pollGeneration === generation) {
            schedule();
          }
        });
      }, this.pollCurrentIntervalMs);
    };
    schedule();
  }

  /** Called by emit() to adapt the poll interval based on pull activity. */
  private adaptPollInterval(entriesMerged: number): void {
    if (!this.pollBaseIntervalMs) return; // not polling
    const MAX_POLL_INTERVAL_MS = 60_000;
    if (entriesMerged > 0) {
      // Activity — reset to base interval.
      if (this.pollCurrentIntervalMs !== this.pollBaseIntervalMs) {
        this.pollCurrentIntervalMs = this.pollBaseIntervalMs;
        this.log('debug', '[interocitor:poll] activity detected, poll interval reset', { intervalMs: this.pollCurrentIntervalMs });
      }
    } else if (this.pollCurrentIntervalMs < MAX_POLL_INTERVAL_MS) {
      // Idle — back off toward max.
      this.pollCurrentIntervalMs = Math.min(this.pollCurrentIntervalMs * 2, MAX_POLL_INTERVAL_MS);
      this.log('debug', '[interocitor:poll] idle, poll interval backed off', { intervalMs: this.pollCurrentIntervalMs });
    }
  }

  private stopRemoteInvalidations(): void {
    if (this.unsubscribeRemoteInvalidations) {
      try { this.unsubscribeRemoteInvalidations(); } catch {}
      this.unsubscribeRemoteInvalidations = null;
    }
    if (this.remoteInvalidationCooldownTimer) {
      clearTimeout(this.remoteInvalidationCooldownTimer);
      this.remoteInvalidationCooldownTimer = null;
    }
    this.remoteInvalidationCooldownQueued = false;
    this.remoteInvalidationPullQueued = false;
    this.remoteInvalidationPullPromise = null;
  }

  private startRemoteInvalidations(adapter: StorageAdapter): void {
    this.stopRemoteInvalidations();
    if (!this.supportsRemoteInvalidations(adapter) || this.config.relayEnabled === false) {
      this.startPolling(this.config.pollInterval);
      this.log('debug', '[interocitor:relay] adapter has no invalidation subscription', { adapter: adapter.name, relayEnabled: this.config.relayEnabled });
      this.emit({ type: 'relay:unavailable', adapter: adapter.name, reason: this.config.relayEnabled === false ? 'disabled' : 'adapter-unsupported' });
      return;
    }

    const INVALIDATION_PULL_COOLDOWN_MS = 1_000;

    const runInvalidationPull = (): void => {
      if (!this.connected) return;
      if (this.remoteInvalidationPullPromise) {
        this.remoteInvalidationPullQueued = true;
        this.log('debug', '[interocitor:relay] pull already in flight; queueing one replay', { adapter: adapter.name });
        return;
      }

      const run = async (): Promise<void> => {
        try {
          await this.pull();
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          this.log('warn', '[interocitor:relay] pull after invalidation failed', err);
          this.emit({ type: 'relay:error', adapter: adapter.name, error: err });
        } finally {
          this.remoteInvalidationPullPromise = null;
          if (this.remoteInvalidationPullQueued && this.connected) {
            this.remoteInvalidationPullQueued = false;
            scheduleInvalidationPull();
          }
        }
      };

      this.remoteInvalidationPullPromise = run();
    };

    const scheduleInvalidationPull = (): void => {
      if (!this.connected) return;
      if (this.remoteInvalidationCooldownTimer) {
        this.remoteInvalidationCooldownQueued = true;
        this.log('debug', '[interocitor:relay] cooldown active; collapsing invalidation into queued replay', { adapter: adapter.name });
        return;
      }
      this.remoteInvalidationCooldownQueued = false;
      this.remoteInvalidationCooldownTimer = setTimeout(() => {
        this.remoteInvalidationCooldownTimer = null;
        const rerun = this.remoteInvalidationCooldownQueued;
        this.remoteInvalidationCooldownQueued = false;
        runInvalidationPull();
        if (rerun && this.connected) {
          scheduleInvalidationPull();
        }
      }, INVALIDATION_PULL_COOLDOWN_MS);
    };

    this.log('info', '[interocitor:relay] subscribing', { adapter: adapter.name, remotePath: this.config.remotePath, deviceId: this.deviceId });
    this.emit({ type: 'relay:subscribe', adapter: adapter.name, remotePath: this.config.remotePath, deviceId: this.deviceId });
    this.unsubscribeRemoteInvalidations = adapter.subscribeToInvalidations(
      (payload: RemoteInvalidationPayload) => {
        this.log('info', '[interocitor:relay] invalidation received', payload);
        this.emit({ type: 'relay:message', adapter: adapter.name, payload });
        scheduleInvalidationPull();
      },
      {
        onReady: () => {
          this.startPolling(this.config.relayHealthyPollInterval);
          this.log('info', '[interocitor:relay] ready', { adapter: adapter.name, pollInterval: this.config.relayHealthyPollInterval });
          this.emit({ type: 'relay:ready', adapter: adapter.name });
        },
        onError: (error?: unknown) => {
          this.startPolling(this.config.pollInterval);
          const err = error instanceof Error ? error : new Error(error ? String(error) : 'Remote invalidation subscription error');
          this.log('warn', '[interocitor:relay] subscription error', err);
          this.emit({ type: 'relay:error', adapter: adapter.name, error: err });
        },
        onClose: () => {
          this.startPolling(this.config.pollInterval);
          this.log('warn', '[interocitor:relay] closed', { adapter: adapter.name, pollInterval: this.config.pollInterval });
          this.emit({ type: 'relay:closed', adapter: adapter.name });
        },
      },
    );
  }

  // ── State helpers ──────────────────────────────────────────────────

  private getRowHlc(row: Row): string {
    let latest = row._meta.deletedHlc ?? '';
    for (const entry of Object.values(row.payload)) {
      if (!entry?.hlc) continue;
      if (!latest || hlcCompareStr(entry.hlc, latest) > 0) latest = entry.hlc;
    }
    return latest;
  }

  private rowToSyncOp(row: Row): Op | null {
    if (row._meta.deleted) {
      const hlc = row._meta.deletedHlc ?? this.getRowHlc(row);
      if (!hlc) return null;
      return { type: 'delete', table: row._meta.table, rowId: row._meta.rowId, hlc };
    }
    const columns: Record<string, ColumnEntry> = {};
    for (const [key, entry] of Object.entries(row.payload)) {
      if (!entry?.hlc) continue;
      columns[key] = entry;
    }
    if (Object.keys(columns).length === 0) return null;
    return { type: 'upsert', table: row._meta.table, rowId: row._meta.rowId, columns };
  }

  private async loadLocalState(): Promise<void> {
    this.tables = {};
    this.knownTables = new Set();
    const savedHlc = await this.local.getMeta('hlc') as string | undefined;
    if (savedHlc) {
      this.hlc = hlcParse(savedHlc);
      this.hlc.nodeId = this.deviceId;
    }
    for (const name of await this.local.getTableNames()) {
      this.knownTables.add(name);
    }
  }

  private async ensureRowsCached(ops: Op[]): Promise<void> {
    for (const op of ops) {
      if (this.tables[op.table]?.[op.rowId] !== undefined) continue;
      const existing = await this.local.getRow(op.table, op.rowId);
      if (existing) {
        if (!this.tables[op.table]) this.tables[op.table] = {};
        this.tables[op.table][op.rowId] = existing;
      }
    }
  }

  private async poisonRemote(error: unknown, path?: string): Promise<Error> {
    const poisoned = error instanceof Error ? error : new Error(String(error));
    if (!this.remotePoisonError) {
      this.remotePoisonError = poisoned;
      this.stopPolling();
      this.clearScheduledFlush();
      this.connected = false;
      this.connectPromise = null;
      // Drop the adapter's "ensured folders" cache. After poison we don't
      // know whether the structure on disk is intact (corrupt manifest may
      // have been minted while folders were partially created), so the
      // next connect must re-validate every folder.
      this.adapter?.resetFolderCache?.();
      this.log('error', 'remote:poisoned — sync halted', {
        dbName: this.dbName,
        remotePath: this.config.remotePath,
        deviceId: this.deviceId,
        path,
        message: poisoned.message,
      });
    }
    this.emit({
      type: 'remote:poisoned',
      error: poisoned,
      path,
      context: {
        dbName: this.dbName,
        remotePath: this.config.remotePath,
        deviceId: this.deviceId,
        meshId: this.manifest?.meshId,
        encrypted: this.encrypted,
      },
    });
    return poisoned;
  }

  // ── Events ─────────────────────────────────────────────────────────

  on(listener: SyncEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: SyncEvent): void {
    // Single chokepoint for cache invalidation. Local mutations and remote
    // pull both flow through emit(); both invalidate query cache for the
    // affected table the same way. Local mutations also pre-invalidate so
    // synchronous reads after `put`/`delete` see fresh data.
    if (event.type === 'change' || event.type === 'delete') {
      this.invalidateQueryCacheForTable(event.table);
      this.invalidateRowCacheForTable(event.table);
    }
    if (event.type === 'sync:complete') {
      this.adaptPollInterval(event.entriesMerged);
    }
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* don't let listener errors break sync */ }
    }
  }

  // ── Encryption ─────────────────────────────────────────────────────

  private async persistCredentials(): Promise<void> {
    if (!this.credentialStore || !this.passphrase) return;
    try {
      // Bind the persisted record to the active meshId when known.
      // The store keeps ONE record per dbName; meshId lets the engine
      // detect "wrong mesh" on the next load instead of silently reusing
      // the previous mesh's key.
      //
      // Crucial: do NOT clobber an existing stored meshId when the
      // engine's manifest has not been loaded yet (e.g. persist runs
      // during init before connect()). Read-modify-write preserves the
      // marker so `assertCredentialMeshParity` can still detect a stale
      // record on the upcoming connect.
      let meshId = this.manifest?.meshId;
      if (!meshId) {
        try {
          const existing = await this.credentialStore.load();
          if (existing?.meshId) meshId = existing.meshId;
        } catch { /* best-effort merge */ }
      }
      await this.credentialStore.save({
        passphrase: this.passphrase,
        deviceId: this.deviceId,
        ...(meshId ? { meshId } : {}),
      });
      this.log('debug', 'persistCredentials() — saved', { dbName: this.dbName, deviceId: this.deviceId, meshId });
      this.emit({
        type: 'credentials:persisted',
        dbName: this.dbName,
        remotePath: this.config.remotePath,
        deviceId: this.deviceId,
        encrypted: this.encrypted,
      });
    } catch (err) {
      this.log('error', 'persistCredentials() — failed', err);
      // Persistence failure must not break local writes; surface via log only.
    }
  }

  /**
   * Compare the persisted credential record against the live meshId.
   *
   * Throws `MeshCredentialMismatchError` (and emits `credentials:meshMismatch`)
   * when the credential store has a record under this `dbName` whose meshId
   * disagrees with `manifest.meshId`. The remote is NOT poisoned — the local
   * credential store has stale data from a previous mesh that shared the
   * same dbName.
   */
  private async assertCredentialMeshParity(): Promise<void> {
    const activeMeshId = this.manifest?.meshId;
    if (!activeMeshId || !this.credentialStore) return;
    let stored: { meshId?: string } | null = null;
    try {
      stored = await this.credentialStore.load();
    } catch {
      return; // load failures already surface elsewhere; do not block connect
    }
    if (!stored?.meshId) return; // legacy/no-meshId record: nothing to assert
    if (stored.meshId === activeMeshId) return;

    this.emit({
      type: 'credentials:meshMismatch',
      dbName: this.dbName,
      remotePath: this.config.remotePath,
      storedMeshId: stored.meshId,
      activeMeshId,
    });
    throw new MeshCredentialMismatchError(this.dbName, stored.meshId, activeMeshId);
  }

  private async loadPersistedCredentials(): Promise<{ passphrase: string; deviceId: string; meshId?: string } | null> {
    if (!this.credentialStore) return null;
    return this.credentialStore.load();
  }

  private async clearPersistedCredentials(): Promise<void> {
    if (!this.credentialStore) return;
    await this.credentialStore.clear();
  }

  private async resolveEncryption(): Promise<void> {
    console.log('[interocitor:cred] resolveEncryption() — entry', {
      dbName: this.dbName,
      encrypted: this.encrypted,
      hasPassphrase: !!this.passphrase,
      hasKey: !!this.encryptionKey,
      passphraseFingerprint: this.passphrase ? `len=${this.passphrase.length} head=${this.passphrase.slice(0, 8)} tail=${this.passphrase.slice(-4)}` : null,
    });
    if (!this.encrypted) {
      this.log('debug', 'resolveEncryption() — encryption disabled');
      return;
    }

    // 1. Have passphrase (from config, setPassphrase(), or restoreCredentials())
    if (this.passphrase && !this.encryptionKey) {
      this.encryptionKey = await passphraseToKey(this.passphrase);
      try {
        const raw = await crypto.subtle.exportKey('raw', this.encryptionKey);
        const hash = await crypto.subtle.digest('SHA-256', raw);
        const bytes = new Uint8Array(hash);
        const hex = Array.from(bytes.slice(0, 6)).map(b => b.toString(16).padStart(2, '0')).join('');
        console.log('[interocitor:cred] resolveEncryption() — derived key', { dbName: this.dbName, keyFingerprint: `sha256-${hex}` });
      } catch { /* ignore */ }
      await this.persistCredentials();
      this.log('info', 'resolveEncryption() — derived key from passphrase', { dbName: this.dbName });
      this.emit({ type: 'encryption:resolved', strategy: 'passphrase', dbName: this.dbName, remotePath: this.config.remotePath, encrypted: true });
      return;
    }

    // 2. Already have a key (set via setPassphrase before init)
    if (this.encryptionKey) {
      await this.persistCredentials();
      this.log('info', 'resolveEncryption() — using preset key', { dbName: this.dbName });
      this.emit({ type: 'encryption:resolved', strategy: 'existing-key', dbName: this.dbName, remotePath: this.config.remotePath, encrypted: true });
      return;
    }

    // 3. Generate fresh key (first-time open)
    const key = await generateKey();
    this.encryptionKey = key;
    this.passphrase = await keyToPassphrase(key);
    await this.persistCredentials();
    this.log('warn', 'resolveEncryption() — generated fresh key (first-time open). Lose credentials => lose data.', { dbName: this.dbName });
    this.emit({ type: 'encryption:resolved', strategy: 'generated', dbName: this.dbName, remotePath: this.config.remotePath, encrypted: true });
  }

  private applyInitialState(state: SyncInitialState | null | undefined): void {
    if (!state) return;
    if (state.deviceId) {
      this.deviceId = state.deviceId;
      this.hlc.nodeId = state.deviceId;
    }
    if (state.remotePath !== undefined) {
      this.config.remotePath = state.remotePath;
    }
    if (state.encrypted !== undefined) {
      this.encrypted = state.encrypted;
      if (!state.encrypted) {
        this.passphrase = null;
        this.encryptionKey = null;
      }
    }
    if (state.passphrase !== undefined) {
      this.passphrase = state.passphrase;
      this.encryptionKey = null;
      if (state.passphrase !== null) this.encrypted = true;
    }
  }

  configureMesh(state: SyncInitialState): void {
    if (this.connected) throw new Error('Cannot configure mesh while connected');
    if (this.initialized) throw new Error('Cannot configure mesh after init(); create a new engine or configure before connect');
    this.applyInitialState(state);
    this.emit({
      type: 'mesh:configured',
      dbName: this.dbName,
      remotePath: this.config.remotePath,
      deviceId: this.deviceId,
      encrypted: this.encrypted,
      hadPassphrase: this.passphrase !== null,
    });
  }

  /**
   * Set or replace the mesh encryption passphrase before connecting.
   *
   * Apps may call this before init(), after init(), or after credentials
   * arrive from pairing. It intentionally does not rebuild the engine or
   * change remotePath/deviceId; it only invalidates the derived key so the
   * next connect/flush uses the new passphrase.
   */
  setPassphrase(passphrase: string): void {
    if (this.connected) throw new Error('Cannot set passphrase while connected; disconnect first');
    this.passphrase = passphrase;
    this.encryptionKey = null;
    this.encrypted = true;
    this.emit({
      type: 'mesh:configured',
      dbName: this.dbName,
      remotePath: this.config.remotePath,
      deviceId: this.deviceId,
      encrypted: this.encrypted,
      hadPassphrase: true,
    });
  }

  /**
   * Get the current mesh passphrase.
   * Returns null if the mesh is unencrypted.
   * Call after init() to ensure key derivation is complete.
   */
  getPassphrase(): string | null {
    return this.passphrase;
  }

  /**
   * Persist credentials to the OS keychain via biometrics.
   * Call after pairing, or from a "Secure my keys" UI action.
   * Returns true if saved, false if unavailable or user cancelled.
   */
  async secureWithBiometrics(): Promise<boolean> {
    return this.credentialStore?.secureWithBiometrics?.() ?? false;
  }

  /**
   * Explicit restore path for wiped / returning users.
   * Call only from intentional app UI: "try restore purchases",
   * "restore access", etc.
   *
   * On success:
   *  - restores passphrase + device ID from OS keychain
   *  - re-populates silent local storage
   *  - derives encryption key
   *
   * Returns true if restore succeeded.
   */
  async restoreWithBiometrics(): Promise<boolean> {
    let restored: { passphrase: string; deviceId: string } | null = null;
    try {
      restored = await (this.credentialStore?.restoreWithBiometrics?.() ?? Promise.resolve(null));
    } catch (err) {
      this.log('warn', 'restoreWithBiometrics() — failed', err);
      return false;
    }
    if (!restored) return false;

    const deviceIdChanged = restored.deviceId !== this.deviceId;
    this.deviceId = restored.deviceId;
    this.hlc.nodeId = restored.deviceId;
    this.passphrase = restored.passphrase;

    if (this.encrypted) {
      this.encryptionKey = await passphraseToKey(restored.passphrase);
    }
    this.log('info', 'restoreWithBiometrics() — restored', { dbName: this.dbName, deviceIdChanged });
    this.emit({
      type: 'credentials:restored',
      source: 'biometric',
      deviceIdChanged,
      hadPassphrase: true,
    });
    return true;
  }

  /**
   * Clear persisted credentials for this mesh.
   * Warning: lost key = lost data. No recovery.
   */
  async clearCredentials(): Promise<void> {
    await this.clearPersistedCredentials();
    this.encryptionKey = null;
    this.passphrase = null;
    this.encrypted = false;
  }

  /**
   * @deprecated Use setPassphrase() instead. Will be removed.
   */
  setEncryptionKey(key: CryptoKey): void {
    this.encryptionKey = key;
    this.encrypted = true;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  async init(): Promise<void> {
    await this.ensureReady();
  }

  private async doInit(): Promise<void> {
    this.log('debug', 'init() — opening local store', { dbName: this.config.dbName, encrypted: this.encrypted, remotePath: this.config.remotePath });
    try {
      await this.local.open();
      if (this.schema?.version !== undefined) {
        await this.local.setMeta('schema:version', this.schema.version);
      }

      const initialState = await this.config.resolveInitialState?.();
      this.applyInitialState(initialState ?? null);

      // Recover credentials from the silent primary store only.
      // No biometric prompt during normal init.
      await this.restoreCredentials();

      // Resolve encryption: derive key from passphrase, load persisted, or generate.
      await this.resolveEncryption();

      this.log('debug', 'init() — loading local state (table names, HLC)');
      await this.loadLocalState();
      this.log('debug', 'init() — complete', { knownTables: Array.from(this.knownTables) });
      this.initialized = true;
      this.setConnectionStatus('offline');
      if (this.config.onInit) {
        await this.config.onInit(this.initContext);
      }
    } catch (err) {
      this.log('error', 'init() — failed', err);
      this.initPromise = null;
      throw err;
    }
  }

  /**
   * Silent credential restore from the primary store only.
   * Used during normal init(). No biometric prompt.
   */
  private async restoreCredentials(): Promise<void> {
    console.log('[interocitor:cred] restoreCredentials() — entry', {
      dbName: this.dbName,
      activeDeviceId: this.deviceId,
      activePassphraseFingerprint: this.passphrase ? `len=${this.passphrase.length} head=${this.passphrase.slice(0, 8)} tail=${this.passphrase.slice(-4)}` : null,
      hasKey: !!this.encryptionKey,
      encrypted: this.encrypted,
    });
    let stored: { passphrase: string; deviceId: string; meshId?: string } | null = null;
    try {
      stored = await this.loadPersistedCredentials();
    } catch (err) {
      console.log('[interocitor:cred] restoreCredentials() — store load failed', { dbName: this.dbName, err: err instanceof Error ? err.message : String(err) });
      this.log('warn', 'restoreCredentials() — silent load failed', err);
      return;
    }
    console.log('[interocitor:cred] restoreCredentials() — store loaded', {
      dbName: this.dbName,
      hasStored: !!stored,
      storedDeviceId: stored?.deviceId,
      storedMeshId: stored?.meshId,
      storedPassphraseFingerprint: stored?.passphrase ? `len=${stored.passphrase.length} head=${stored.passphrase.slice(0, 8)} tail=${stored.passphrase.slice(-4)}` : null,
    });
    if (!stored) {
      this.log('debug', 'restoreCredentials() — no persisted credentials', { dbName: this.dbName });
      return;
    }

    // Mesh-id parity check.
    //
    // The credential store keeps ONE record per dbName. If the stored
    // record names a meshId and the local store already knows a different
    // meshId for this dbName (typical: user clicked "create new mesh"
    // under the same dbName, then reloaded), the persisted passphrase is
    // for the OLD mesh and silently adopting it would either fail
    // decryption or poison the new remote.
    //
    // The connect-time post-manifest check below covers the case where
    // the local-store meshId is empty (fresh install + stale cred record).
    if (stored.meshId) {
      const localMeshIdRaw = await this.local.getMeta('meshId');
      const localMeshId = typeof localMeshIdRaw === 'string' ? localMeshIdRaw : '';
      if (localMeshId && localMeshId !== stored.meshId) {
        this.log('error', 'restoreCredentials() — meshId mismatch, refusing to adopt stored credentials', {
          dbName: this.dbName,
          storedMeshId: stored.meshId,
          activeMeshId: localMeshId,
        });
        this.emit({
          type: 'credentials:meshMismatch',
          dbName: this.dbName,
          remotePath: this.config.remotePath,
          storedMeshId: stored.meshId,
          activeMeshId: localMeshId,
        });
        throw new MeshCredentialMismatchError(this.dbName, stored.meshId, localMeshId);
      }
    }

    let deviceIdChanged = false;
    if (stored.deviceId && stored.deviceId !== this.deviceId) {
      // The local device-id global is shared across meshes on this origin.
      // If the persisted dbName-scoped store has a different device-id than
      // the global, the user is straddling two meshes and we are about to
      // self-poison their HLC. Surface it so the UI can intervene before
      // any writes happen.
      this.log('warn', 'restoreCredentials() — device-id mismatch, restoring stored id', {
        dbName: this.dbName,
        storedDeviceId: stored.deviceId,
        activeDeviceId: this.deviceId,
      });
      this.emit({
        type: 'credentials:conflict',
        storedDeviceId: stored.deviceId,
        activeDeviceId: this.deviceId,
        dbName: this.dbName,
        remotePath: this.config.remotePath,
      });
      this.deviceId = stored.deviceId;
      this.hlc.nodeId = stored.deviceId;
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem('interocitor-device-id', stored.deviceId);
      } catch { /* ok */ }
      deviceIdChanged = true;
    }

    let hadPassphrase = false;
    if (this.encrypted && stored.passphrase) {
      if (!this.passphrase) {
        this.passphrase = stored.passphrase;
        hadPassphrase = true;
      } else if (this.passphrase !== stored.passphrase) {
        // Caller passed a different passphrase than the one persisted under
        // dbName. This is the classic "self-sabotage": same dbName, two keys.
        // Local rows were written with one key; new flushes will use another;
        // every reload after this will start poisoning remote files.
        this.log('error', 'restoreCredentials() — passphrase conflict! Caller-provided passphrase differs from persisted. Refusing to silently swap.', {
          dbName: this.dbName,
          remotePath: this.config.remotePath,
        });
        // Keep caller-provided passphrase; the conflict event lets UI prompt
        // the user to either clearCredentials() or correct the passphrase.
        this.emit({
          type: 'credentials:conflict',
          storedDeviceId: stored.deviceId,
          activeDeviceId: this.deviceId,
          dbName: this.dbName,
          remotePath: this.config.remotePath,
        });
        // Reset the local cursor so the upcoming pull cannot use the
        // skip-listing fast-path. Without this, doFlush()'s post-write
        // cursor advance under the OLD key hides remote change files
        // from the new (mismatched) key — the engine would never decode
        // them and never surface the decode failure that proves the
        // passphrase is wrong. Conflict surfaces via decode:error +
        // remote:poisoned on the next pull, instead of silently going.
        try { await this.local.setMeta('cursor', ''); } catch { /* best-effort */ }
      }
    }

    this.emit({
      type: 'credentials:restored',
      source: 'silent-store',
      deviceIdChanged,
      hadPassphrase,
    });
  }

  async connect(): Promise<void> {
    console.log('[interocitor:connect] connect() — entry', {
      dbName: this.dbName,
      remotePath: this.config.remotePath,
      deviceId: this.deviceId,
      adapter: this.adapter?.name ?? null,
      encrypted: this.encrypted,
      hasPassphrase: !!this.passphrase,
      hasKey: !!this.encryptionKey,
      meshId: this.manifest?.meshId,
      connected: this.connected,
      hasInFlight: !!this.connectPromise,
    });
    await this.ensureReady();
    if (this.encrypted && !this.encryptionKey) await this.resolveEncryption();
    if (!this.config.remotePath) throw new Error('connect() requires remotePath; configure mesh before connecting');
    this.setConnectionStatus('connecting');

    // Idempotent. If we are already connected to a live mesh on this
    // adapter+remotePath, don't restart the session — restart was the root
    // cause of the "observer" reload bug, where polling/flush timers and
    // adapter sessions stacked across UI reloads and started corrupting
    // the local cursor + remote files.
    if (this.connected && !this.remotePoisonError) {
      this.log('debug', 'connect() — already connected, no-op', {
        dbName: this.dbName,
        remotePath: this.config.remotePath,
        deviceId: this.deviceId,
      });
      this.emit({
        type: 'connect:noop',
        dbName: this.dbName,
        remotePath: this.config.remotePath,
        deviceId: this.deviceId,
        reason: 'already-connected',
      });
      return;
    }

    // Concurrent-callers dedupe. The `connected` flag flips true only after
    // the full pipeline (manifest, pull, doFlush, startPolling) resolves;
    // a second caller arriving before that would re-enter and double every
    // flushed change file. Share the in-flight promise instead.
    if (this.connectPromise) {
      this.log('debug', 'connect() — join in-flight connect', {
        dbName: this.dbName,
        remotePath: this.config.remotePath,
        deviceId: this.deviceId,
      });
      this.emit({
        type: 'connect:noop',
        dbName: this.dbName,
        remotePath: this.config.remotePath,
        deviceId: this.deviceId,
        reason: 'already-connected',
      });
      return this.connectPromise;
    }

    this.connectPromise = this.doConnect().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private async tryConnectFastPath(adapter: StorageAdapter): Promise<boolean> {
    // Fast-path is only safe when we have a locally cached manifest whose
    // encryption mode matches the current engine config. If it does not match,
    // fall through to full connect so MeshEncryptionMismatchError is raised.
    if (!this.manifest) {
      const cached = await this.local.getMeta('manifestCache') as Manifest | undefined;
      if (!cached || cached.encrypted !== this.encrypted) return false;
      this.manifest = cached;
    }
    const cursorRaw = await this.local.getMeta('cursor');
    const cursor = typeof cursorRaw === 'string' ? cursorRaw : '';
    if (!cursor) return false;
    if (await this.local.outboxSize() > 0) return false;

    const remotePath = this.requireRemotePath('connect() fast-path');
    const p = paths(remotePath);
    try {
      const headRaw = await adapter.readFile(p.changesHead);
      const head = JSON.parse(new TextDecoder().decode(headRaw)) as { latestHlc?: string };
      this.emit({
        type: 'trace:head',
        op: 'read',
        reason: 'connect-fast-path',
        path: p.changesHead,
        priorHlc: head.latestHlc ?? null,
      });
      if (head.latestHlc && hlcCompareStr(head.latestHlc, cursor) <= 0) {
        this.emit({
          type: 'trace:head',
          op: 'skip-no-change',
          reason: 'connect-fast-path',
          path: p.changesHead,
          priorHlc: head.latestHlc,
          nextHlc: cursor,
        });
        this.emit({
          type: 'connect:state',
          dbName: this.dbName,
          remotePath: this.config.remotePath,
          deviceId: this.deviceId,
          meshId: this.manifest?.meshId,
          encrypted: this.encrypted,
        });
        this.emit({ type: 'sync:complete', entriesMerged: 0 });
        this.startPolling(this.config.pollInterval);
        this.startRemoteInvalidations(adapter);
        this.connected = true;
        this.setConnectionStatus('idle');
        return true;
      }
    } catch {
      // Missing or malformed head means this is not a safe fast path.
      // Fall back to the full connect pipeline, which validates manifest,
      // folders, credentials, epoch, and then pulls.
    }
    return false;
  }

  /**
   * Wrap a connect-stage operation in a bounded-progress deadline. On stall,
   * the engine enters offline-ready mode: it does not throw, does not mark
   * itself connected, and does fire the optional onConnectStalled callback.
   * Returns `null` when the stage stalled; otherwise the stage's result.
   */
  private async runConnectStage<T>(name: string, op: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
    try {
      const value = await withDeadline(name, op, this.config.connectStageTimeoutMs);
      return { ok: true, value };
    } catch (error) {
      if (error instanceof ConnectStageTimeoutError) {
        this.log('warn', `connect() — stage stalled: ${name}`, { timeoutMs: error.timeoutMs });
        this.emit({
          type: 'connect:error',
          error,
          stage: name,
          dbName: this.dbName,
          remotePath: this.config.remotePath,
          deviceId: this.deviceId,
        });
        if (this.config.onConnectStalled) {
          try {
            this.config.onConnectStalled({ stage: name, timeoutMs: error.timeoutMs, error });
          } catch {
            // Never let a consumer hook stop the engine.
          }
        }
        this.setConnectionStatus('offline');
        return { ok: false, error };
      }
      return { ok: false, error };
    }
  }

  private async doConnect(): Promise<void> {
    const adapter = this.requireAdapter('connect()');
    console.log('[interocitor:connect] doConnect() — start', {
      dbName: this.dbName,
      remotePath: this.config.remotePath,
      deviceId: this.deviceId,
      adapter: adapter.name,
      meshIdBefore: this.manifest?.meshId,
    });
    const stage = (s: string, err: unknown): Error => {
      const e = err instanceof Error ? err : new Error(String(err));
      console.log('[interocitor:connect] doConnect() — STAGE FAIL', { stage: s, dbName: this.dbName, deviceId: this.deviceId, err: e.message });
      this.emit({
        type: 'connect:error',
        error: e,
        stage: s,
        dbName: this.dbName,
        remotePath: this.config.remotePath,
        deviceId: this.deviceId,
      });
      return e;
    };
    const stageOk = (s: string, extra?: Record<string, unknown>) => {
      console.log('[interocitor:connect] doConnect() — stage ok', { stage: s, dbName: this.dbName, deviceId: this.deviceId, ...extra });
    };

    this.log('debug', 'connect() — authenticating with adapter', { adapter: adapter.name });
    if (!adapter.isAuthenticated()) {
      this.emit({ type: 'auth:required' });
      const authResult = await this.runConnectStage('authenticate', () => adapter.authenticate());
      if (!authResult.ok) {
        if (authResult.error instanceof ConnectStageTimeoutError) return; // offline-ready degrade
        this.log('error', 'connect() — authentication failed', authResult.error);
        throw stage('authenticate', authResult.error);
      }
      this.emit({ type: 'auth:complete' });
    }

    // Reload steady-state fast path: local IDB has a cursor, there is no
    // pending outbox, and remote head has not advanced. In that case the
    // client has nothing to publish or merge. After the minimal auth check,
    // probe head and stop — no folder creation, manifest reads, device
    // metadata writes, listFiles, or change-file reads. This covers clients
    // that recreate the adapter on reload before calling setRemoteStorage().
    if (await this.tryConnectFastPath(adapter)) return;

    const remotePath = this.requireRemotePath('connect()');
    const p = paths(remotePath);
    this.log('debug', 'connect() — ensuring remote folders', { remotePath, deviceId: this.deviceId });
    for (const folder of [remotePath, p.devicesFolder, p.mainlineFolder, p.changesFolder]) {
      const folderResult = await this.runConnectStage('ensureFolder', () => adapter.ensureFolder(folder));
      if (!folderResult.ok) {
        if (folderResult.error instanceof ConnectStageTimeoutError) return; // offline-ready degrade
        this.log('error', 'connect() — ensureFolder failed', folder, folderResult.error);
        throw stage('ensureFolder', folderResult.error);
      }
      this.log('debug', 'connect() — ensureFolder ok', folder);
    }

    this.log('debug', 'connect() — loading/creating manifest');
    let bootstrapped = false;
    const manifestResult = await this.runConnectStage('loadOrCreateManifest', () => this.doLoadOrCreateManifest('connect', true));
    if (!manifestResult.ok) {
      if (manifestResult.error instanceof ConnectStageTimeoutError) return; // offline-ready degrade
      this.log('error', 'connect() — loadOrCreateManifest failed', manifestResult.error);
      throw stage('loadOrCreateManifest', manifestResult.error);
    }
    bootstrapped = manifestResult.value.bootstrapped;
    stageOk('loadOrCreateManifest', { bootstrapped, meshId: this.manifest?.meshId, generation: this.manifest?.generation });

    // Post-manifest credential check.
    //
    // We now know the live meshId. Compare it to the meshId attached to
    // the persisted credential record. If they disagree, the persisted
    // record is for a different mesh that happened to share the same
    // dbName (e.g. user clicked "create new mesh" twice). Refuse to
    // proceed — silently using the wrong key would poison the remote.
    //
    // The restoreCredentials() check covers reloads where the local
    // store already remembers the active meshId; this branch covers the
    // first connect after a fresh install.
    try {
      await this.assertCredentialMeshParity();
      stageOk('credentialMeshParity', { meshId: this.manifest?.meshId });
    } catch (err) {
      this.log('error', 'connect() — credential mesh parity failed', err);
      throw stage('credentialMeshParity', err);
    }

    // Anchor credentials to the live meshId now that parity is known
    // good. First-connect of a fresh mesh has no meshId in the
    // credential record yet; on reconnect this is a no-op write that
    // keeps the record fresh.
    await this.persistCredentials();
    stageOk('persistCredentialsPostManifest');

    const deviceMetadataResult = await this.runConnectStage('upsertDeviceMetadata', () => upsertDeviceMetadata(adapter, remotePath, this.deviceId, {
      displayName: this.config.deviceName,
      deviceType: this.config.deviceType,
      // Skip the read-merge GET when we just minted the manifest in this
      // same connect cycle — no prior device record can possibly exist.
      bootstrap: bootstrapped,
      skipTouchIfUnchanged: !bootstrapped,
    }));
    if (!deviceMetadataResult.ok) {
      if (deviceMetadataResult.error instanceof ConnectStageTimeoutError) return;
      throw stage('upsertDeviceMetadata', deviceMetadataResult.error);
    }
    stageOk('upsertDeviceMetadata');

    const localEpochRaw = await this.local.getMeta('epoch');
    const localEpoch = typeof localEpochRaw === 'number' ? localEpochRaw : 0;
    const remoteEpoch = this.manifest?.epoch ?? 0;
    this.log('debug', 'connect() — epoch check', { localEpoch, remoteEpoch });
    this.emit({
      type: 'connect:state',
      dbName: this.dbName,
      remotePath: this.config.remotePath,
      deviceId: this.deviceId,
      localEpoch,
      remoteEpoch,
      meshId: this.manifest?.meshId,
      encrypted: this.encrypted,
    });

    if (localEpoch < remoteEpoch) {
      this.log('debug', 'connect() — epoch advanced, rehydrating from snapshot');
      const rehydrateResult = await this.runConnectStage('rehydrate', () => this.rehydrate());
      if (!rehydrateResult.ok) {
        if (rehydrateResult.error instanceof ConnectStageTimeoutError) return;
        throw stage('rehydrate', rehydrateResult.error);
      }
    } else {
      this.log('debug', 'connect() — running initial pull');
      const pullResult = await this.runConnectStage('pull', () => this.pull());
      if (!pullResult.ok) {
        if (pullResult.error instanceof ConnectStageTimeoutError) return;
        throw stage('pull', pullResult.error);
      }
    }
    if (bootstrapped) {
      await this.rebuildOutboxFromLocalState();
    }
    const flushResult = await this.runConnectStage('flush', () => this.doFlush());
    if (!flushResult.ok) {
      if (flushResult.error instanceof ConnectStageTimeoutError) return;
      throw stage('flush', flushResult.error);
    }

    this.startPolling(this.config.pollInterval);
    this.startRemoteInvalidations(adapter);
    this.connected = true;
    this.setConnectionStatus('idle');
    this.log('info', 'connect() — connected', { remotePath: this.config.remotePath, deviceId: this.deviceId, pollInterval: this.config.pollInterval });

    this.startVisibilityTracking();
  }

  private startVisibilityTracking(): void {
    this.stopVisibilityTracking();
    if (typeof document === 'undefined') return;
    const listener = () => {
      if (document.visibilityState === 'hidden') {
        // Tab backgrounded: flush pending writes and slow down polling 10×.
        this.doFlush().catch(() => {});
        if (this.pollBaseIntervalMs) {
          this.pollCurrentIntervalMs = Math.min(
            this.pollCurrentIntervalMs * POLL_BACKGROUND_MULTIPLIER,
            this.pollBaseIntervalMs * POLL_BACKGROUND_MULTIPLIER,
          );
          this.log('debug', '[interocitor:poll] tab hidden, poll interval slowed', { intervalMs: this.pollCurrentIntervalMs });
        }
      } else {
        // Tab foregrounded: pull immediately then reset to base interval.
        this.log('debug', '[interocitor:poll] tab visible, forcing pull and resetting interval');
        if (this.pollBaseIntervalMs) {
          this.pollCurrentIntervalMs = this.pollBaseIntervalMs;
        }
        if (this.connected) {
          this.pull().catch(() => {});
        }
      }
    };
    this.visibilityChangeListener = listener;
    document.addEventListener('visibilitychange', listener);
  }

  private stopVisibilityTracking(): void {
    if (this.visibilityChangeListener) {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', this.visibilityChangeListener);
      }
      this.visibilityChangeListener = null;
    }
  }

  async disconnect(): Promise<void> {
    await this.ensureReady();
    // Hard tear-down. Order matters: stop timers first so no in-flight
    // poll/push/flush touches the adapter while we are killing the session.
    this.stopPolling();
    this.stopRemoteInvalidations();
    this.stopVisibilityTracking();
    this.clearScheduledFlush();
    this.clearCompactTimers();
    this.clearBatchTimer();
    await this.flushPendingBatch();
    if (!this.remotePoisonError) {
      try { await this.doFlush(); } catch (err) {
        this.log('warn', 'disconnect() — flush before close failed (continuing)', err);
      }
    }
    this.emit({
      type: 'transport:teardown',
      dbName: this.dbName,
      remotePath: this.config.remotePath,
      deviceId: this.deviceId,
      reason: 'disconnect',
    });
    this.local.close();
    this.connected = false;
    this.initialized = false;
    this.connectionStatus = 'offline';
    this.emit({ type: 'connection:status', status: this.getConnectionStatus() });
    this.initPromise = null;
    this.connectPromise = null;
    this.remotePoisonError = null;
  }

  async setRemoteStorage(adapter: StorageAdapter | null): Promise<void> {
    console.log('[interocitor:share] setRemoteStorage() — entry', {
      dbName: this.dbName,
      newAdapter: adapter?.name ?? null,
      currentAdapter: this.adapter?.name ?? null,
      sameByRef: adapter === this.adapter,
      remotePath: this.config.remotePath,
      deviceId: this.deviceId,
      connected: this.connected,
      meshId: this.manifest?.meshId,
    });
    await this.ensureReady();
    this.log('debug', 'setRemoteStorage()', { adapter: adapter?.name ?? null, remotePath: this.config.remotePath });
    const wasConnected = this.connected;
    const hadAdapter = this.adapter !== null;
    const switching = adapter !== this.adapter;
    console.log('[interocitor:share] setRemoteStorage() — decision', { wasConnected, hadAdapter, switching });

    // Same-adapter no-op. Callers (auto-reconnect, React StrictMode, etc.)
    // commonly re-attach the same adapter on every reload. Without this
    // guard we would tear down the live transport, reset cursor/epoch/meshId,
    // re-queue every IDB row into the outbox via rebuildOutboxFromLocalState,
    // then reconnect — which re-flushes the entire dataset as a fresh batch
    // of change files on every reload.
    if (!switching) {
      this.log('debug', 'setRemoteStorage() — same adapter, no-op');
      return;
    }

    if (wasConnected && hadAdapter && !this.remotePoisonError) {
      try { await this.pull(); } catch (err) {
        this.log('warn', 'setRemoteStorage() — final pull before swap failed (continuing)', err);
      }
    }

    // Hard tear-down of the previous transport before swapping.
    // Without this, polling timers + outbox flush can race against the
    // newly-attached adapter and re-write the *new* mesh with files signed
    // for the old mesh — i.e. self-poison the remote on adapter switch.
    this.stopPolling();
    this.stopRemoteInvalidations();
    this.clearScheduledFlush();
    this.connected = false;

    if (switching && hadAdapter) {
      // Drop the OLD adapter's folder cache before we let go of it.
      // Belt-and-braces: if the old adapter is reattached later, we cannot
      // trust prior "this folder exists" observations against a potentially
      // different mesh layout.
      this.adapter?.resetFolderCache?.();
      this.emit({
        type: 'transport:teardown',
        dbName: this.dbName,
        remotePath: this.config.remotePath,
        deviceId: this.deviceId,
        reason: adapter ? 'switch-adapter' : 'detach',
      });
    }

    if (this.initialized) {
      // Transport swaps are not semantic local-state resets. Preserve cursor,
      // epoch, meshId, rows, and any genuine unsent outbox entries. The next
      // connect will re-read/validate the manifest for the newly attached
      // adapter and pull only if its head is ahead of the preserved cursor.
      //
      // The previous code called resetRemoteSyncState() and then
      // rebuildOutboxFromLocalState(), which converted every canonical local
      // row back into a pending outbound write. That made reload/adapter attach
      // self-feed: already-synced rows became fresh change files for no reason.
      this.manifest = null;
      this.remotePoisonError = null;
      this.connected = false;
      this.pendingCount = await this.local.outboxSize();
    } else {
      this.manifest = null;
    }

    this.adapter = adapter;
    this.remotePoisonError = null;

    if (wasConnected && adapter) await this.connect();
  }

  async setLocalStorage(local: LocalStoreAdapter): Promise<void> {
    await this.ensureReady();
    const wasConnected = this.connected;
    if (wasConnected) await this.doFlush();

    this.clearScheduledFlush();
    this.pendingCount = 0;

    this.local.close();
    this.local = local;
    await this.local.open();
    await this.loadLocalState();
    this.initialized = true;

    if (!wasConnected) return;
    await this.pull();
    await this.doFlush();
  }

  // ── Manifest (delegated) ───────────────────────────────────────────

  /**
   * Load the mesh manifest, optionally short-circuiting via the in-memory
   * cache.
   *
   * `reason` is a free-form caller tag used by `trace:manifest` events so
   * developers can answer "why is my manifest being re-read every flush?".
   *
   * `force=true` bypasses the cache. Required after poison, after compaction
   * advances generation, or whenever the caller explicitly needs disk state.
   * Cached path emits `trace:manifest { op: 'cache-hit' }` so test/devtools
   * can assert that the steady-state pipeline does ZERO GETs on flush/pull.
   */
  /**
   * Returns whether the manifest was bootstrapped (freshly minted) on this
   * call. Callers (connect()) use this to skip the device-metadata GET when
   * we know no prior device record can exist.
   */
  private async doLoadOrCreateManifest(
    reason: string = 'unknown',
    force: boolean = false,
  ): Promise<{ bootstrapped: boolean }> {
    if (!force && this.manifest && !this.remotePoisonError) {
      this.emit({
        type: 'trace:manifest',
        op: 'cache-hit',
        reason,
        generation: this.manifest.generation,
        cached: true,
      });
      return { bootstrapped: false };
    }
    const { manifest, bootstrapped } = await loadOrCreateManifest(
      this.manifestContext,
      this.codecState,
      this.local,
      (err, path) => this.poisonRemote(err, path),
      reason,
    );
    this.manifest = manifest;
    this.encrypted = manifest.encrypted || this.encrypted;
    await this.local.setMeta('manifestCache', manifest);
    await this.local.setMeta('remoteGcFloorHlc', manifest.gcFloorHlc ?? '');
    await this.local.setMeta('remoteGcEpoch', manifest.gcEpoch ?? 0);
    return { bootstrapped };
  }

  // ── Local writes ───────────────────────────────────────────────────

  async put<K extends keyof S & string>(
    table: K,
    rowId: string,
    columns: Partial<S[K]>,
    userId?: string,
  ): Promise<S[K]> {
    await this.ensureReady();
    return this.putNow(table, rowId, columns, userId);
  }

  async delete<K extends keyof S & string>(table: K, rowId: string, userId?: string): Promise<void> {
    await this.ensureReady();
    return this.deleteNow(table, rowId, userId);
  }


  async query<K extends keyof S & string>(table: K): Promise<S[K][]> {
    await this.ensureReady();
    return this.queryNow(table);
  }

  async queryWhere<K extends keyof S & string>(table: K, clause: WhereClause): Promise<S[K][]> {
    await this.ensureReady();
    return this.queryWhereNow(table, clause);
  }

  async tableNames(): Promise<string[]> {
    await this.ensureReady();
    return Array.from(this.knownTables);
  }

  table<K extends keyof S & string>(name: K): Table<S[K]> {
    return new Table(this, name);
  }

  // ── Batched writes ─────────────────────────────────────────────────
  // All writes performed inside `fn` are merged into ONE ChangeEntry.
  // Implicit batching also happens automatically: writes within the
  // configured batchWindowMs window are flushed into a single ChangeEntry.

  private batchDepth = 0;

  /**
   * Group a sequence of writes into a single ChangeEntry. The entry
   * carries every op as one atomic unit, producing one remote file
   * instead of one per write.
   *
   * Nested batch() calls join the outer batch.
   */
  async batch<R>(fn: () => Promise<R> | R): Promise<R> {
    await this.ensureReady();
    this.batchDepth += 1;
    try {
      const result = await fn();
      return result;
    } finally {
      this.batchDepth -= 1;
      if (this.batchDepth === 0) await this.flushPendingBatch();
    }
  }

  private isBatching(): boolean {
    return this.batchDepth > 0;
  }

  private clearBatchTimer(): void {
    if (!this.batchTimer) return;
    clearTimeout(this.batchTimer);
    this.batchTimer = null;
  }

  private appendOpToPendingBatch(op: Op, hlc: string): void {
    if (this.pendingBatch) {
      this.pendingBatch.ops.push(op);
      // Carry the highest HLC seen in this batch
      if (hlcCompareStr(hlc, this.pendingBatch.hlc) > 0) this.pendingBatch.hlc = hlc;
      return;
    }

    this.pendingBatch = {
      id: generateId('chg'),
      ts: Date.now(),
      device: this.deviceId,
      hlc,
      ops: [op],
    };
  }

  private armImplicitBatchTimer(): void {
    if (this.isBatching()) return;
    if (this.batchTimer) return;
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      void this.flushPendingBatch();
    }, this.config.batchWindowMs);
  }

  private async flushPendingBatch(): Promise<void> {
    const pending = this.pendingBatch;
    this.pendingBatch = null;
    this.clearBatchTimer();
    if (!pending) return;
    await this.local.pushOutbox(pending);
    this.scheduleFlush();
  }

  // ── Flush (local → cloud) ──────────────────────────────────────────

  private scheduleFlush(): void {
    this.pendingCount++;
    this.maybeEmitCompactWarning();
    this.armDelayedCompactAfterChange();
    if (this.pendingCount >= this.config.flushThreshold) {
      this.doFlush().catch(err => this.emit({ type: 'flush:error', error: err }));
      return;
    }
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.doFlush().catch(err => this.emit({ type: 'flush:error', error: err }));
    }, this.config.flushDebounce);
  }

  private maybeEmitCompactWarning(): void {
    if (this.compactWarningEmitted) return;
    if (this.pendingCount < this.config.compactWarnThreshold) return;
    this.compactWarningEmitted = true;
    this.emit({
      type: 'compact:warning',
      queuedChangeCount: this.pendingCount,
      threshold: this.config.compactWarnThreshold,
      autoCompactThreshold: this.config.compactAutoThreshold,
      remotePath: this.config.remotePath,
      deviceId: this.deviceId,
    });
  }

  private resetCompactWarning(): void {
    if (this.pendingCount !== 0) return;
    this.compactWarningEmitted = false;
  }

  private async maybeAutoCompact(triggerQueuedChangeCount: number): Promise<void> {
    if (triggerQueuedChangeCount < this.config.compactAutoThreshold) return;

    const sampleWindow = Math.max(1, Math.floor(this.config.compactAutoDeviceCount / Math.max(1, this.config.compactAutoSampleNumerator)));
    const sampleRoll = Math.floor(Math.random() * sampleWindow);
    const baseEvent = {
      queuedChangeCount: triggerQueuedChangeCount,
      threshold: this.config.compactAutoThreshold,
      sampleRoll,
      sampleWindow,
      trigger: 'immediate' as const,
      remotePath: this.config.remotePath,
      deviceId: this.deviceId,
    };

    if (!this.config.autoCompact) {
      this.emit({ type: 'compact:auto:skip', ...baseEvent, reason: 'disabled' });
      return;
    }
    if (!this.adapter || !this.config.remotePath) {
      this.emit({ type: 'compact:auto:skip', ...baseEvent, reason: 'missing-remote' });
      return;
    }
    if (!this.connected) {
      this.emit({ type: 'compact:auto:skip', ...baseEvent, reason: 'not-connected' });
      return;
    }
    if (this.remotePoisonError) {
      this.emit({ type: 'compact:auto:skip', ...baseEvent, reason: 'poisoned' });
      return;
    }
    if (this.compactInFlight) {
      this.emit({ type: 'compact:auto:skip', ...baseEvent, reason: 'already-running' });
      return;
    }
    if (sampleRoll !== 0) {
      this.emit({ type: 'compact:auto:skip', ...baseEvent, reason: 'sampling' });
      return;
    }

    this.emit({ type: 'compact:auto:start', ...baseEvent });
    const run = this.compact().then(() => {
      this.emit({
        type: 'compact:auto:complete',
        queuedChangeCount: triggerQueuedChangeCount,
        threshold: this.config.compactAutoThreshold,
        trigger: 'immediate',
        remotePath: this.config.remotePath,
        deviceId: this.deviceId,
      });
    }).catch((error: Error) => {
      this.emit({
        type: 'compact:auto:error',
        queuedChangeCount: triggerQueuedChangeCount,
        threshold: this.config.compactAutoThreshold,
        trigger: 'immediate',
        remotePath: this.config.remotePath,
        deviceId: this.deviceId,
        error,
      });
    }).finally(() => {
      if (this.compactInFlight === run) this.compactInFlight = null;
    });
    this.compactInFlight = run;
    await run;
  }

  // ── Delayed compact support (secondary path) ────────────────────────
  // Independent from the immediate sampled auto-compact above. Both paths
  // can co-exist: any single compact() call is deduped via compactInFlight.
  // Helps lazy clients eventually compact even when sampling never fires.

  private armDelayedCompactAfterChange(): void {
    if (!this.config.autoCompact) return;
    if (!this.config.remotePath) return;

    const delayMs = this.jitterDelay(this.config.firstCompactDelayMs, this.config.firstCompactDelayJitterMs);
    this.compactScheduleVersion += 1;
    const version = this.compactScheduleVersion;

    if (this.compactCheckTimer) clearTimeout(this.compactCheckTimer);
    this.emit({
      type: 'compact:delayed:scheduled',
      queuedChangeCount: this.pendingCount,
      delayMs,
      phase: 'check',
      remotePath: this.config.remotePath,
      deviceId: this.deviceId,
    });
    this.compactCheckTimer = setTimeout(() => {
      this.compactCheckTimer = null;
      this.runDelayedCompactCheck(version).catch(() => {});
    }, delayMs);
  }

  private async runDelayedCompactCheck(version: number): Promise<void> {
    if (version !== this.compactScheduleVersion) return;
    if (!this.config.autoCompact || !this.connected || !this.adapter || !this.config.remotePath) return;
    if (this.remotePoisonError) return;

    let remoteChangeFileCount = 0;
    try {
      const adapter = this.adapter;
      const remoteRoot = this.config.remotePath;
      const list = await adapter.listFiles(`${remoteRoot}/changes`).catch(() => [] as { path: string }[]);
      remoteChangeFileCount = list.filter(f => /\/changes\/[^/]+-chg_[^/]+\.json$/.test(f.path)).length;
    } catch { /* best-effort */ }

    this.emit({
      type: 'compact:delayed:check',
      queuedChangeCount: this.pendingCount,
      remoteChangeFileCount,
      threshold: this.config.compactRemoteChangeThreshold,
      remotePath: this.config.remotePath,
      deviceId: this.deviceId,
    });

    if (remoteChangeFileCount <= this.config.compactRemoteChangeThreshold) {
      this.emit({
        type: 'compact:auto:skip',
        queuedChangeCount: this.pendingCount,
        threshold: this.config.compactAutoThreshold,
        trigger: 'delayed',
        remotePath: this.config.remotePath,
        deviceId: this.deviceId,
        reason: 'below-remote-threshold',
      });
      return;
    }

    const delayMs = this.jitterDelay(this.config.secondCompactDelayMs, this.config.secondCompactDelayJitterMs);
    if (this.compactRunTimer) clearTimeout(this.compactRunTimer);
    this.emit({
      type: 'compact:delayed:scheduled',
      queuedChangeCount: this.pendingCount,
      delayMs,
      phase: 'compact',
      remotePath: this.config.remotePath,
      deviceId: this.deviceId,
    });
    const triggerQueuedChangeCount = this.pendingCount;
    this.compactRunTimer = setTimeout(() => {
      this.compactRunTimer = null;
      this.runDelayedCompact(version, triggerQueuedChangeCount, remoteChangeFileCount).catch(() => {});
    }, delayMs);
  }

  private async runDelayedCompact(version: number, queuedChangeCount: number, remoteChangeFileCount: number): Promise<void> {
    if (version !== this.compactScheduleVersion) {
      this.emit({
        type: 'compact:auto:skip',
        queuedChangeCount,
        threshold: this.config.compactAutoThreshold,
        trigger: 'delayed',
        remotePath: this.config.remotePath,
        deviceId: this.deviceId,
        reason: 'superseded',
      });
      return;
    }
    if (!this.config.autoCompact || !this.connected || !this.adapter || !this.config.remotePath) {
      this.emit({
        type: 'compact:auto:skip',
        queuedChangeCount,
        threshold: this.config.compactAutoThreshold,
        trigger: 'delayed',
        remotePath: this.config.remotePath,
        deviceId: this.deviceId,
        reason: this.connected ? (this.config.autoCompact ? 'missing-remote' : 'disabled') : 'not-connected',
      });
      return;
    }
    if (this.remotePoisonError) {
      this.emit({
        type: 'compact:auto:skip',
        queuedChangeCount,
        threshold: this.config.compactAutoThreshold,
        trigger: 'delayed',
        remotePath: this.config.remotePath,
        deviceId: this.deviceId,
        reason: 'poisoned',
      });
      return;
    }
    if (this.compactInFlight) {
      this.emit({
        type: 'compact:auto:skip',
        queuedChangeCount,
        threshold: this.config.compactAutoThreshold,
        trigger: 'delayed',
        remotePath: this.config.remotePath,
        deviceId: this.deviceId,
        reason: 'already-running',
      });
      return;
    }

    this.emit({
      type: 'compact:auto:start',
      queuedChangeCount,
      threshold: this.config.compactAutoThreshold,
      trigger: 'delayed',
      remoteChangeFileCount,
      remotePath: this.config.remotePath,
      deviceId: this.deviceId,
    });

    const run = this.compact().then(() => {
      this.emit({
        type: 'compact:auto:complete',
        queuedChangeCount,
        threshold: this.config.compactAutoThreshold,
        trigger: 'delayed',
        remoteChangeFileCount,
        remotePath: this.config.remotePath,
        deviceId: this.deviceId,
      });
    }).catch((error: Error) => {
      this.emit({
        type: 'compact:auto:error',
        queuedChangeCount,
        threshold: this.config.compactAutoThreshold,
        trigger: 'delayed',
        remoteChangeFileCount,
        remotePath: this.config.remotePath,
        deviceId: this.deviceId,
        error,
      });
    });
    await run;
  }

  /** Public flush — waits for init. Safe to call from user code. */
  async flush(): Promise<void> {
    await this.ensureReady();
    // Drain any pending implicit batch first so its ops reach the outbox
    // before we read it. Without this, flush() called from user code right
    // after a write inside the batch window would skip those writes.
    await this.flushPendingBatch();
    return this.doFlush();
  }

  /** Internal flush — no ensureReady guard (called from connect, pull, doInit). */
  private hasPreFloorEntries(entries: ChangeEntry[]): boolean {
    const floor = this.manifest?.gcFloorHlc;
    if (!floor) return false;
    return entries.some(entry => entry.hlc && hlcCompareStr(entry.hlc, floor) <= 0);
  }

  private async doFlush(): Promise<void> {
    if (!this.adapter) {
      this.clearScheduledFlush();
      return;
    }

    const triggerQueuedChangeCount = this.pendingCount;
    const entries = await this.local.drainOutbox();
    if (entries.length === 0) {
      this.pendingCount = 0;
      this.resetCompactWarning();
      return;
    }

    // Reload manifest before deciding whether non-empty outbox entries
    // predate the current point-of-no-return. A long-sleeping client may have
    // a cached manifest from before another device compacted. Keep this after
    // the empty-outbox return so idle flushes and transport teardown do not
    // perform surprising remote reads or poison adapter switches.
    await this.doLoadOrCreateManifest('flush');

    // The manifest GC floor is a point of no return. If this local outbox
    // contains entries at/before the floor, the device missed the retention
    // window. Do not publish them; align from the canonical snapshot instead.
    if (this.hasPreFloorEntries(entries)) {
      this.clearScheduledFlush();
      if (this.manifest?.snapshotPath) {
        await this.rehydrate();
        this.pendingCount = 0;
        this.resetCompactWarning();
      } else {
        for (const entry of entries) await this.local.pushOutbox(entry);
        this.pendingCount = entries.length;
      }
      throw new Error(`Refusing to flush changes at or before gcFloorHlc ${this.manifest?.gcFloorHlc}; rehydrate required`);
    }

    this.log('debug', 'flush() — start', { entryCount: entries.length });
    this.emit({ type: 'flush:start', entryCount: entries.length });
    if (this.connected) this.setConnectionStatus('syncing');
    this.pendingCount = 0;
    this.resetCompactWarning();
    this.clearScheduledFlush();

    try {
      await flushToAdapter(this.adapter, this.requireRemotePath('flush()'), entries, true, this.codecState, this.deviceId, (e) => this.emit(e));

      for (const replica of this.config.replicas) {
        try {
          const replicaRoot = replica.remotePath ?? this.requireRemotePath('flush() replica');
          if (!replica.adapter.isAuthenticated()) await replica.adapter.authenticate();
          await flushToAdapter(replica.adapter, replicaRoot, entries, false, this.codecState, this.deviceId);
        } catch (err) {
          this.log('warn', 'flush() — replica write failed', { adapter: replica.adapter.name }, err);
          this.emit({ type: 'replica:error', adapter: replica.adapter.name, error: err as Error });
        }
      }

      // Advance the local cursor past our own just-flushed entries.
      // The cursor is the "we have already merged everything <= X"
      // marker that pull()'s fast-path uses to short-circuit listing
      // and reading change files. Without this, a page reload after a
      // local-only write storm re-lists the changes folder and re-GETs
      // every file we authored ourselves — re-decoding our own writes
      // through the CRDT path despite local IDB already being canonical.
      // Monotonic-forward only: never let cursor go backwards on disk.
      let highestFlushedHlc = '';
      for (const entry of entries) {
        if (!entry.hlc) continue;
        if (!highestFlushedHlc || hlcCompareStr(entry.hlc, highestFlushedHlc) > 0) {
          highestFlushedHlc = entry.hlc;
        }
      }
      if (highestFlushedHlc) {
        const cursorRaw = await this.local.getMeta('cursor');
        const cursor = typeof cursorRaw === 'string' ? cursorRaw : '';
        if (!cursor || hlcCompareStr(highestFlushedHlc, cursor) > 0) {
          await this.local.setMeta('cursor', highestFlushedHlc);
        }
      }

      this.log('debug', 'flush() — complete', { entryCount: entries.length });
      this.emit({ type: 'flush:complete' });
      if (this.connected) this.setConnectionStatus('idle');
      await this.maybeAutoCompact(triggerQueuedChangeCount);
    } catch (err) {
      if (this.connected) this.setConnectionStatus('idle');
      this.log('error', 'flush() — failed, re-queuing entries', err);
      for (const entry of entries) await this.local.pushOutbox(entry);
      this.pendingCount = entries.length;
      this.maybeEmitCompactWarning();
      throw err;
    }
  }

  // ── Pull (cloud → local) ──────────────────────────────────────────

  async pull(): Promise<void> {
    await this.ensureReady();
    const adapter = this.requireAdapter('pull()');
    if (this.connected) this.setConnectionStatus('syncing');
    try {
      this.hlc = await doPull({
        adapter,
        local: this.local,
        remotePath: this.requireRemotePath('pull()'),
        codecState: this.codecState,
        hlc: this.hlc,
        deviceId: this.deviceId,
        tables: this.tables,
        knownTables: this.knownTables,
        schema: this.schema,
        emit: (e) => this.emit(e),
        ensureRowsCached: (ops) => this.ensureRowsCached(ops),
        poisonRemote: (err, path) => this.poisonRemote(err, path),
        loadOrCreateManifest: async () => { await this.doLoadOrCreateManifest('pull'); },
      });
      await this.acknowledgeManifest();
    } finally {
      if (this.connected) this.setConnectionStatus('idle');
    }
  }

  // ── Rehydrate / Compact ────────────────────────────────────────────

  async rehydrate(): Promise<void> {
    await this.ensureReady();
    const adapter = this.requireAdapter('rehydrate()');
    this.hlc = await doRehydrate({
      adapter,
      local: this.local,
      codecState: this.codecState,
      manifest: this.manifest,
      hlc: this.hlc,
      deviceId: this.deviceId,
      tables: this.tables,
      knownTables: this.knownTables,
      emit: (e) => this.emit(e),
      poisonRemote: (err, path) => this.poisonRemote(err, path),
      pull: () => this.pull(),
    });
    await this.acknowledgeManifest();
  }

  async compact(): Promise<void> {
    await this.ensureReady();
    if (this.compactInFlight) return this.compactInFlight;
    const run = (async () => {
      const adapter = this.requireAdapter('compact()');
      if (!this.manifest) throw new Error('Engine is not connected');
      this.manifest = await doCompact({
        adapter,
        local: this.local,
        remotePath: this.requireRemotePath('compact()'),
        manifest: this.manifest,
        codecState: this.codecState,
        hlc: this.hlc,
        deviceId: this.deviceId,
        serverId: this.serverId,
        emit: (e) => this.emit(e),
        pull: () => this.pull(),
        offlineGraceMs: this.config.offlineGraceMs,
      });
      await this.local.setMeta('remoteGcFloorHlc', this.manifest.gcFloorHlc ?? '');
      await this.local.setMeta('remoteGcEpoch', this.manifest.gcEpoch ?? 0);
      await this.acknowledgeManifest();
    })().finally(() => {
      if (this.compactInFlight === run) this.compactInFlight = null;
    });
    this.compactInFlight = run;
    return run;
  }

  // ── Durable file storage ───────────────────────────────────────────

  /** Upload a durable application file. Files are encrypted with the mesh key and are never compacted or merged. */
  async putFile(path: string, data: Uint8Array | string, contentType?: string): Promise<StoredFileMetadata> {
    await this.ensureReady();
    const adapter = this.requireAdapter('putFile()');
    const filePath = this.storedFilePath(path);
    const { stored, plaintextSize } = await this.encodeStoredFile(data);
    const options = { uploadedByDeviceId: this.deviceId, plaintextSize, contentType };
    if (adapter.putStoredFile) return adapter.putStoredFile(filePath, stored, options);
    await adapter.ensureFolder(`${this.requireRemotePath('putFile()').replace(/\/$/, '')}/files`);
    await adapter.writeFile(filePath, stored);
    const meta = await adapter.getFileMetadata(filePath);
    return {
      name: meta?.name ?? filePath.split('/').pop() ?? filePath,
      path: filePath,
      size: meta?.size ?? stored.byteLength,
      modifiedTime: meta?.modifiedTime ?? new Date().toISOString(),
      etag: meta?.etag,
      uploadedByDeviceId: this.deviceId,
      plaintextSize,
      storedSize: stored.byteLength,
      contentType,
    };
  }

  /** Read and decrypt a durable application file. */
  async getFile(path: string): Promise<Uint8Array> {
    await this.ensureReady();
    const adapter = this.requireAdapter('getFile()');
    const filePath = this.storedFilePath(path);
    const stored = adapter.getStoredFile ? await adapter.getStoredFile(filePath) : await adapter.readFile(filePath);
    return this.decodeStoredFile(stored);
  }

  /** Delete a durable application file. Missing files are treated as already deleted. */
  async deleteFile(path: string): Promise<void> {
    await this.ensureReady();
    const adapter = this.requireAdapter('deleteFile()');
    const filePath = this.storedFilePath(path);
    if (adapter.deleteStoredFile) await adapter.deleteStoredFile(filePath);
    else await adapter.deleteFile(filePath);
  }

  /** Return metadata for a durable application file without downloading content. */
  async getFileMetadata(path: string): Promise<StoredFileMetadata | null> {
    await this.ensureReady();
    const adapter = this.requireAdapter('getFileMetadata()');
    const filePath = this.storedFilePath(path);
    if (adapter.getStoredFileMetadata) return adapter.getStoredFileMetadata(filePath);
    const meta = await adapter.getFileMetadata(filePath);
    return meta ? { ...meta, storedSize: meta.size } : null;
  }

  // ── First-class image storage ───────────────────────────────────────

  /** Encode and upload an image through durable encrypted file storage. */
  async putImage(path: string, image: ImageInput, options: PutImageOptions = {}): Promise<StoredImageMetadata> {
    const encoded = await this.encodeImageInput(image, path, options.contentType);
    const meta = await this.putFile(path, encoded.data, encoded.contentType);
    return { ...meta, contentType: encoded.contentType };
  }

  /** Read an image as decoded bytes plus a browser Blob. */
  async getImage(path: string): Promise<StoredImage> {
    const metadata = await this.getFileMetadata(path);
    const contentType = this.inferImageContentType(path, metadata?.contentType);
    const data = await this.getFile(path);
    const blob = new Blob([data as BlobPart], { type: contentType });
    return {
      path,
      data,
      blob,
      metadata: this.coerceImageMetadata(metadata, contentType),
      contentType,
    };
  }

  /** Read an image and return a revokable browser blob: URL for UI rendering. */
  async getImageBlobUrl(path: string): Promise<StoredImageBlobUrl> {
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
      throw new Error('Blob URLs are not available in this runtime');
    }
    const image = await this.getImage(path);
    const url = URL.createObjectURL(image.blob);
    return {
      path,
      url,
      blob: image.blob,
      metadata: image.metadata,
      contentType: image.contentType,
      revoke: () => URL.revokeObjectURL(url),
    };
  }

  // ── Mesh management ────────────────────────────────────────────────

  getManifest(): Manifest | null {
    return this.manifest ? { ...this.manifest } : null;
  }

  getDeviceId(): string {
    return this.deviceId;
  }

  /**
   * Credential vault for sub-stores derived from this Interocitor.
   *
   * Use `put / get / list / remove` to manage credentials. The engine never
   * constructs child engines — apps read these and build their own
   * Interocitor instances. Credentials are persisted inside this engine's
   * LocalStore; anyone with read access to this store inherits read access
   * to every sub-store's credentials.
   */
  get connectedStores(): ConnectedStoresApi {
    if (!this.connectedStoresApi) {
      const inner = new LocalStoreConnectedStoresApi(this.local);
      const ensure = () => this.ensureReady();
      this.connectedStoresApi = {
        list: async () => { await ensure(); return inner.list(); },
        get: async (id) => { await ensure(); return inner.get(id); },
        put: async (creds) => { await ensure(); return inner.put(creds); },
        remove: async (id) => { await ensure(); return inner.remove(id); },
      };
    }
    return this.connectedStoresApi;
  }

  getMeshId(): string | undefined {
    return this.manifest?.meshId;
  }

  isEncrypted(): boolean {
    return this.encrypted;
  }

  /**
   * Enable encryption on an existing unencrypted mesh.
   * @deprecated Use setPassphrase() or pass encrypted/passphrase in config.
   */
  async enableEncryption(key: CryptoKey): Promise<void> {
    this.encryptionKey = key;
    this.encrypted = true;
  }
}
