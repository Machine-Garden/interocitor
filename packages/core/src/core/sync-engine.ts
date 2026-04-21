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
} from './types.ts';

import type { HLC } from './types.ts';
import { hlcInit, hlcNow, hlcSerialize, hlcParse, hlcCompareStr } from './hlc.ts';
import { Table, computeCacheKey } from './table.ts';
import { readColumn } from './crdt.ts';
import { LocalStore } from '../storage/local-store.ts';

// Extracted modules
import { paths, logAtLevel, normalizeLogLevel, generateId, getDeviceId, ROW_META_KEYS } from './internals.ts';
import type { CodecState } from './codec.ts';
import { loadOrCreateManifest, upsertDeviceMetadata } from './manifest.ts';
import { generateKey, keyToPassphrase, passphraseToKey } from '../crypto/encryption.ts';
import { createCredentialStore, type CredentialStore } from '../storage/credential-store.ts';
import type { ManifestContext } from './manifest.ts';
import { flushToAdapter } from './flush.ts';
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
  dbName: string;
  localStoreFactory: LocalStoreFactory;
  schema?: DatabaseSchemaDefinition<S>;
  replicas: ReplicaConfig[];
  onInit?: SyncConfig<S>['onInit'];
  resolveInitialState?: SyncConfig<S>['resolveInitialState'];
  deviceName?: string;
  deviceType?: import('./types.ts').DeviceType;
};

// ─── Sync Engine ─────────────────────────────────────────────────────

/**
 * Typed sync engine. `S` is your database shape — inferred automatically
 * from `InferSchemaType<typeof schema>`. No default: either typed or `any`.
 *
 * Initialization is automatic — just construct and use. No `await engine.init()` needed.
 *
 * @example
 * const schema = { version: 1, tables: { tasks: { fields: { title: types.string } } } }
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

  // Poll management
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  // Lifecycle state
  private initialized = false;
  private connected = false;
  private initPromise: Promise<void> | null = null;
  private readonly logLevel: LogLevel;

  // Event listeners
  private listeners: Set<SyncEventListener> = new Set();
  private readonly schema?: DatabaseSchemaDefinition<S>;
  private readonly credentialStore: CredentialStore | null;

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
      dbName: config.dbName ?? 'interocitor',
      localStoreFactory: config.localStoreFactory ?? (() => new LocalStore(config.dbName, undefined, config.schema)),
      schema: config.schema,
      replicas: config.replicas ?? [],
      onInit: config.onInit,
      resolveInitialState: config.resolveInitialState,
    };
    this.serverId = this.config.serverId;
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
    const row: Row = current
      ? { ...current }
      : { _table: tableName, _rowId: rowId, _deleted: false, _schemaVersion: this.schema?.version ?? 0 };

    const nextHlc = hlcNow(this.hlc);
    this.hlc = nextHlc;

    for (const [key, value] of Object.entries(columns as Record<string, unknown>)) {
      row[key] = { value: value === undefined ? null : value, hlc: hlcSerialize(nextHlc) };
    }
    row._deleted = false;
    row._deletedHlc = undefined;
    row._owner = this.deviceId;

    await this.local.putRow(row);
    const op = this.rowToSyncOp(row);
    const hlc = this.getRowHlc(row);
    if (op && hlc) await this.local.pushOutbox(this.buildChangeEntry(op, hlc));
    this.knownTables.add(tableName);

    this.emit({ type: 'change', table: tableName, rowId, row });
    this.scheduleFlush();
    return row as unknown as S[K];
  }

  private async deleteNow<K extends keyof S & string>(table: K, rowId: string, _userId?: string): Promise<void> {
    const tableName = table as string;
    const current = await this.local.getRow(tableName, rowId);
    if (!current || current._deleted) return;

    const nextHlc = hlcNow(this.hlc);
    this.hlc = nextHlc;
    current._deleted = true;
    current._deletedHlc = hlcSerialize(nextHlc);
    await this.local.putRow(current);
    const op = this.rowToSyncOp(current);
    const hlc = this.getRowHlc(current);
    if (op && hlc) await this.local.pushOutbox(this.buildChangeEntry(op, hlc));
    this.emit({ type: 'delete', table: tableName, rowId });
    this.scheduleFlush();
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
      this.runQuery(entry.descriptor, key);
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
      if (!row || row._deleted) return undefined;
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
    return {
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
      table: <K extends keyof S & string>(name: K) => new Table(this.initContext as any, name),
      on: this.on.bind(this),
      getDeviceId: this.getDeviceId.bind(this),
      getMeshId: this.getMeshId.bind(this),
      isEncrypted: this.isEncrypted.bind(this),
    };
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

  // ── Flush / poll timers ────────────────────────────────────────────

  private clearScheduledFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      this.pull().catch(() => {});
    }, this.config.pollInterval);
  }

  // ── State helpers ──────────────────────────────────────────────────

  private async resetRemoteSyncState(): Promise<void> {
    this.manifest = null;
    this.remotePoisonError = null;
    this.connected = false;
    await this.local.setMeta('cursor', '');
    await this.local.setMeta('epoch', 0);
    await this.local.setMeta('meshId', '');
  }

  private getRowHlc(row: Row): string {
    let latest = row._deletedHlc ?? '';
    for (const [key, value] of Object.entries(row)) {
      if (ROW_META_KEYS.has(key)) continue;
      if (!value || typeof value !== 'object' || !('hlc' in value) || !('value' in value)) continue;
      const entryHlc = (value as ColumnEntry).hlc;
      if (!latest || hlcCompareStr(entryHlc, latest) > 0) latest = entryHlc;
    }
    return latest;
  }

  private rowToSyncOp(row: Row): Op | null {
    if (row._deleted) {
      const hlc = row._deletedHlc ?? this.getRowHlc(row);
      if (!hlc) return null;
      return { type: 'delete', table: row._table, rowId: row._rowId, hlc };
    }
    const columns: Record<string, ColumnEntry> = {};
    for (const [key, value] of Object.entries(row)) {
      if (ROW_META_KEYS.has(key)) continue;
      if (!value || typeof value !== 'object' || !('hlc' in value) || !('value' in value)) continue;
      columns[key] = value as ColumnEntry;
    }
    if (Object.keys(columns).length === 0) return null;
    return { type: 'upsert', table: row._table, rowId: row._rowId, columns };
  }

  private buildChangeEntry(op: Op, hlc: string): ChangeEntry {
    return {
      id: generateId('chg'),
      ts: Date.now(),
      device: this.deviceId,
      hlc,
      ops: [op],
    };
  }

  private async rebuildOutboxFromLocalState(): Promise<number> {
    await this.local.drainOutbox();
    const rows = await this.local.getAllRows();
    let queued = 0;
    for (const row of rows) {
      const op = this.rowToSyncOp(row);
      const hlc = this.getRowHlc(row);
      if (!op || !hlc) continue;
      await this.local.pushOutbox(this.buildChangeEntry(op, hlc));
      queued++;
    }
    this.pendingCount = queued;
    return queued;
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
    }
    this.emit({ type: 'remote:poisoned', error: poisoned, path });
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
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* don't let listener errors break sync */ }
    }
  }

  // ── Encryption ─────────────────────────────────────────────────────

  private async persistCredentials(): Promise<void> {
    if (!this.credentialStore || !this.passphrase) return;
    await this.credentialStore.save({ passphrase: this.passphrase, deviceId: this.deviceId });
  }

  private async loadPersistedCredentials(): Promise<{ passphrase: string; deviceId: string } | null> {
    if (!this.credentialStore) return null;
    return this.credentialStore.load();
  }

  private async clearPersistedCredentials(): Promise<void> {
    if (!this.credentialStore) return;
    await this.credentialStore.clear();
  }

  private async resolveEncryption(): Promise<void> {
    if (!this.encrypted) return;

    // 1. Have passphrase (from config, setPassphrase(), or restoreCredentials())
    if (this.passphrase && !this.encryptionKey) {
      this.encryptionKey = await passphraseToKey(this.passphrase);
      await this.persistCredentials();
      return;
    }

    // 2. Already have a key (set via setPassphrase before init)
    if (this.encryptionKey) {
      await this.persistCredentials();
      return;
    }

    // 3. Generate fresh key (first-time open)
    const key = await generateKey();
    this.encryptionKey = key;
    this.passphrase = await keyToPassphrase(key);
    await this.persistCredentials();
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
  }

  /**
   * Set the mesh encryption passphrase.
   * Call before init() or between disconnect() and init().
   */
  setPassphrase(passphrase: string): void {
    this.configureMesh({ passphrase, encrypted: true });
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
    const restored = await (this.credentialStore?.restoreWithBiometrics?.() ?? Promise.resolve(null));
    if (!restored) return false;

    this.deviceId = restored.deviceId;
    this.hlc.nodeId = restored.deviceId;
    this.passphrase = restored.passphrase;

    if (this.encrypted) {
      this.encryptionKey = await passphraseToKey(restored.passphrase);
    }
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
      if (this.schema) {
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
    const stored = await this.loadPersistedCredentials();
    if (!stored) return;

    if (stored.deviceId && stored.deviceId !== this.deviceId) {
      this.deviceId = stored.deviceId;
      this.hlc.nodeId = stored.deviceId;
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem('interocitor-device-id', stored.deviceId);
      } catch { /* ok */ }
    }

    if (this.encrypted && !this.passphrase && stored.passphrase) {
      this.passphrase = stored.passphrase;
    }
  }

  async connect(): Promise<void> {
    await this.ensureReady();
    if (!this.config.remotePath) throw new Error('connect() requires remotePath; configure mesh before connecting');

    const adapter = this.requireAdapter('connect()');

    this.log('debug', 'connect() — authenticating with adapter', { adapter: adapter.name });
    if (!adapter.isAuthenticated()) {
      this.emit({ type: 'auth:required' });
      try { await adapter.authenticate(); } catch (err) {
        this.log('error', 'connect() — authentication failed', err);
        throw err;
      }
      this.emit({ type: 'auth:complete' });
    }

    const p = paths(this.config.remotePath);
    this.log('debug', 'connect() — ensuring remote folders', { remotePath: this.config.remotePath, deviceId: this.deviceId });
    for (const folder of [this.config.remotePath, p.devicesFolder, p.mainlineFolder, p.changesFolder]) {
      try {
        await adapter.ensureFolder(folder);
        this.log('debug', 'connect() — ensureFolder ok', folder);
      } catch (err) {
        this.log('error', 'connect() — ensureFolder failed', folder, err);
        throw err;
      }
    }

    this.log('debug', 'connect() — loading/creating manifest');
    try {
      await this.doLoadOrCreateManifest();
    } catch (err) {
      this.log('error', 'connect() — loadOrCreateManifest failed', err);
      throw err;
    }

    await upsertDeviceMetadata(adapter, this.config.remotePath, this.deviceId, {
      displayName: this.config.deviceName,
      deviceType: this.config.deviceType,
    });

    const localEpochRaw = await this.local.getMeta('epoch');
    const localEpoch = typeof localEpochRaw === 'number' ? localEpochRaw : 0;
    const remoteEpoch = this.manifest?.epoch ?? 0;
    this.log('debug', 'connect() — epoch check', { localEpoch, remoteEpoch });

    if (localEpoch < remoteEpoch) {
      this.log('debug', 'connect() — epoch advanced, rehydrating from snapshot');
      await this.rehydrate();
    } else {
      this.log('debug', 'connect() — running initial pull');
      await this.pull();
    }
    await this.doFlush();

    this.startPolling();
    this.connected = true;
    this.log('info', 'connect() — connected', { remotePath: this.config.remotePath, deviceId: this.deviceId, pollInterval: this.config.pollInterval });

    if (typeof window !== 'undefined') {
      window.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          this.doFlush().catch(() => {});
        }
      });
    }
  }

  async disconnect(): Promise<void> {
    await this.ensureReady();
    this.stopPolling();
    this.clearScheduledFlush();
    if (!this.remotePoisonError) await this.doFlush();
    this.local.close();
    this.connected = false;
    this.initialized = false;
    this.initPromise = null;
    this.remotePoisonError = null;
  }

  async setRemoteStorage(adapter: StorageAdapter | null): Promise<void> {
    await this.ensureReady();
    this.log('debug', 'setRemoteStorage()', { adapter: adapter?.name ?? null, remotePath: this.config.remotePath });
    const wasConnected = this.connected;
    const hadAdapter = this.adapter !== null;

    if (wasConnected && hadAdapter && !this.remotePoisonError) await this.pull();

    this.stopPolling();
    this.clearScheduledFlush();

    if (this.initialized) {
      await this.resetRemoteSyncState();
      if (adapter) await this.rebuildOutboxFromLocalState();
    } else {
      this.manifest = null;
      this.connected = false;
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

  private async doLoadOrCreateManifest(): Promise<void> {
    const manifest = await loadOrCreateManifest(
      this.manifestContext,
      this.codecState,
      this.local,
      (err, path) => this.poisonRemote(err, path),
    );
    this.manifest = manifest;
    this.encrypted = manifest.encrypted || this.encrypted;
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

  // ── Flush (local → cloud) ──────────────────────────────────────────

  private scheduleFlush(): void {
    this.pendingCount++;
    if (this.pendingCount >= this.config.flushThreshold) {
      this.doFlush().catch(err => this.emit({ type: 'flush:error', error: err }));
      return;
    }
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.doFlush().catch(err => this.emit({ type: 'flush:error', error: err }));
    }, this.config.flushDebounce);
  }

  /** Public flush — waits for init. Safe to call from user code. */
  async flush(): Promise<void> {
    await this.ensureReady();
    return this.doFlush();
  }

  /** Internal flush — no ensureReady guard (called from connect, pull, doInit). */
  private async doFlush(): Promise<void> {
    if (!this.adapter) {
      this.clearScheduledFlush();
      return;
    }

    const entries = await this.local.drainOutbox();
    if (entries.length === 0) return;

    this.log('debug', 'flush() — start', { entryCount: entries.length });
    this.emit({ type: 'flush:start', entryCount: entries.length });
    this.pendingCount = 0;
    this.clearScheduledFlush();

    try {
      await this.doLoadOrCreateManifest();
      await flushToAdapter(this.adapter, this.requireRemotePath('flush()'), entries, true, this.codecState, this.deviceId);

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

      this.log('debug', 'flush() — complete', { entryCount: entries.length });
      this.emit({ type: 'flush:complete' });
    } catch (err) {
      this.log('error', 'flush() — failed, re-queuing entries', err);
      for (const entry of entries) await this.local.pushOutbox(entry);
      throw err;
    }
  }

  // ── Pull (cloud → local) ──────────────────────────────────────────

  async pull(): Promise<void> {
    await this.ensureReady();
    const adapter = this.requireAdapter('pull()');
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
      loadOrCreateManifest: () => this.doLoadOrCreateManifest(),
    });
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
  }

  async compact(): Promise<void> {
    await this.ensureReady();
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
    });
  }

  // ── Mesh management ────────────────────────────────────────────────

  getManifest(): Manifest | null {
    return this.manifest ? { ...this.manifest } : null;
  }

  getDeviceId(): string {
    return this.deviceId;
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
