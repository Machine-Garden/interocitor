// compass: interocitor.mailbox-sync.sync-lifecycle
// compass: interocitor.durable-files.file-api
//
// Two coordinates by design: this file holds the connect/pull/flush lifecycle
// and the durable-file API, which belong to different blocks. Disposition
// recorded in .compass/interocitor/durable-files/file-api/README.md.

/**
 * Sync Engine
 *
 * Orchestrates:
 *  - Local writes → outbox → flush to cloud (primary + replicas)
 *  - Cloud poll → download → decrypt → CRDT merge → local DB
 *  - Rehydration from manifest-authoritative snapshot
 *
 * Network is never required for reads or local writes.
 * All data operations hit the configured local store first; cloud sync is async.
 */

import type {
  StorageAdapter,
  SyncConfig,
  LocalStore,
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
  SyncInitialState,
  JoinExistingMeshPolicy,
  EvictedMeshPolicy,
  MeshEvictionAttestation,
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
  StoredFileWriteOptions,
  FileRef,
  FileSeal,
  SealedFile,
  RetentionPolicy,
  QuarantinedOfflineChanges,
  ChangeObservation,
  ChangeObservationListener,
} from "./types.ts";

import type { HLC } from "./types.ts";
import type { RowRef } from "../storage/local-store.ts";
import { hlcInit, hlcNow, hlcSerialize, hlcParse, hlcCompareStr } from "./hlc.ts";
import { Table, computeCacheKey } from "./table.ts";
import { readColumn } from "./crdt.ts";

// Extracted modules
import { paths, logAtLevel, normalizeLogLevel, generateId } from "./internals.ts";
import type { CodecState } from "./codec.ts";
import {
  MESH_LINEAGE_META,
  loadOrCreateManifest,
  readJsonIfExists,
  resolveManifestLineage,
  upsertDeviceMetadata,
} from "./manifest.ts";
import {
  decryptBytes,
  encryptBytes,
  generateMeshKeyMaterial,
  passphraseToKey,
} from "../crypto/encryption.ts";
import { isMeshCredentialAccessError, MeshCredentialAccessError } from "../crypto/key-source.ts";
import type { MeshKeySource } from "../crypto/key-source.ts";
import {
  FileIntegrityError,
  CredentialReplacementRequiredError,
  CredentialPersistenceError,
  MeshKeySourceContractError,
  MeshCredentialMismatchError,
  RemoteAccessError,
  isCredentialPersistenceError,
  isMeshKeySourceContractError,
  isRemoteAccessError,
} from "./errors.ts";
import { expectedFileDigest, fileTargetPath, sha256Hex } from "./file-ref.ts";
import {
  cleanFilePath,
  decodeStoredFrame,
  deriveFilePathKey,
  encodeStoredFrame,
  hideFilePath,
  openStoredFrame,
  sealStoredFrame,
  type StoredFileHeader,
  deriveFileGuard,
} from "./stored-file.ts";
import {
  ConnectStageTimeoutError,
  DEFAULT_CONNECT_STAGE_TIMEOUT_MS,
  withDeadline,
} from "./with-deadline.ts";
import type { ManifestContext } from "./manifest.ts";
import { flushPrimary } from "./flush.ts";
import { LocalStoreConnectedStoresApi, type ConnectedStoresApi } from "./connected-stores.ts";
import { pull as doPull } from "./pull.ts";
import { ChangeObservationLedger } from "./change-observation.ts";
import {
  compact as doCompact,
  pruneSupersededSnapshots,
  rehydrate as doRehydrate,
} from "./compaction.ts";
import { createDeviceId } from "./ids.ts";
import { resolveRetentionPolicy } from "./retention.ts";
import { cloneChangeEntry, cloneRow, createRowChangeEffect } from "./change-effects.ts";
import { READER_MODE } from "./reader-mode.ts";

type InternalSyncConfig<S extends Record<string, Record<string, unknown>>> = SyncConfig<S> & {
  [READER_MODE]?: true;
};

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
  retention: RetentionPolicy;
  retentionConfigured: boolean;
  firstCompactDelayMs: number;
  firstCompactDelayJitterMs: number;
  secondCompactDelayMs: number;
  secondCompactDelayJitterMs: number;
  compactRemoteChangeThreshold: number;
  batchWindowMs: number;
  dbName: string;
  localStore: LocalStore;
  schema?: DatabaseSchemaDefinition<S>;
  replicas: ReplicaConfig[];
  onInit?: SyncConfig<S>["onInit"];
  resolveInitialState?: SyncConfig<S>["resolveInitialState"];
  deviceName?: string;
  deviceType?: import("./types.ts").DeviceType;
  relayEnabled: boolean;
  relayHealthyPollInterval: number;
  connectStageTimeoutMs: number;
  onConnectStalled?: SyncConfig<S>["onConnectStalled"];
  joinExistingMeshPolicy: JoinExistingMeshPolicy;
  evictedMeshPolicy: EvictedMeshPolicy;
};

const DEFAULT_COMPACT_WARNING_THRESHOLD = 50;
const DEFAULT_COMPACT_AUTO_THRESHOLD = 50;
const DEFAULT_COMPACT_AUTO_SAMPLE_NUMERATOR = 10;
const DEFAULT_COMPACT_AUTO_DEVICE_COUNT = 1;
const DEFAULT_FIRST_COMPACT_DELAY_MS = 10 * 60_000;
const DEFAULT_FIRST_COMPACT_DELAY_JITTER_MS = 5 * 60_000;
const DEFAULT_SECOND_COMPACT_DELAY_MS = 15 * 60_000;
const DEFAULT_SECOND_COMPACT_DELAY_JITTER_MS = 5 * 60_000;
const DEFAULT_COMPACT_REMOTE_CHANGE_THRESHOLD = 2;
const DEFAULT_BATCH_WINDOW_MS = 1_000;
const SYNC_STATE_LOCK = "sync-state";
const CREDENTIAL_STATE_LOCK = "credential-state";
const LAST_SUCCESSFUL_SYNC_AT_META = "lastSuccessfulSyncAt";
const OFFLINE_RETENTION_EXPIRED_AT_META = "offlineRetentionExpiredAt";
const QUARANTINED_OFFLINE_CHANGES_META = "quarantinedOfflineChanges";
const MAX_TIMER_DELAY_MS = 2_147_000_000;
const RETENTION_RETRY_DELAY_MS = 60 * 60_000;

/**
 * Let a background timer stop holding the host process open.
 *
 * Node's `setTimeout` returns a `Timeout` with `unref()`; the browser returns a
 * number and has no such concept, so this is a no-op there. Used only for the
 * engine's own maintenance schedules — polling and compaction — never for a
 * timer that stands in for pending user work such as a queued flush.
 *
 * Without it, a Node host that builds a mesh and never disconnects hangs at
 * exit forever behind a poll loop that reschedules itself, and behind a
 * retention check that can be days out.
 */
function unrefTimer<T>(timer: T): T {
  (timer as { unref?: () => void })?.unref?.();
  return timer;
}

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
 * const db = new Interocitor<DB>({
 *   schema,
 *   localStore: new MemoryLocalStore(),
 *   keySource: null,
 * });
 * const tasks = await db.table('tasks').query(); // ready immediately
 *
 * // With remote sync:
 * const db = new Interocitor<DB>(adapter, {
 *   schema,
 *   remotePath: '/App',
 *   localStore,
 *   keySource,
 * });
 * await db.connect(); // authenticate + sync
 *
 * db.table('other'); // TS error — 'other' is not keyof DB
 */
export interface InterocitorInitContext<
  S extends Record<string, Record<string, unknown>>,
> extends ReadinessAwareQueryExecutor {
  put<K extends keyof S & string>(
    table: K,
    rowId: string,
    columns: Partial<S[K]>,
    userId?: string,
  ): Promise<S[K]>;
  delete<K extends keyof S & string>(table: K, rowId: string, userId?: string): Promise<void>;
  query<K extends keyof S & string>(table: K): Promise<S[K][]>;
  queryWhere<K extends keyof S & string>(table: K, clause: WhereClause): Promise<S[K][]>;
  table<K extends keyof S & string>(name: K): Table<S[K]>;
  on(listener: SyncEventListener): () => void;
  observeChanges(listener: ChangeObservationListener): () => void;
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
  status: "pending" | "ready" | "error";
  rows?: Row[];
  error?: Error;
  promise?: Promise<Row[]>;
};

type RowCacheEntry = {
  descriptor: RowDescriptor;
  status: "pending" | "ready" | "error";
  /** `null` means loaded-but-absent. `undefined` means never loaded. */
  row?: Row | null;
  error?: Error;
  promise?: Promise<Row | undefined>;
};

type PendingLocalRowEffect = {
  table: string;
  rowId: string;
  before?: Row;
  after: Row;
};

/**
 * The local-first engine: rows, durable files, and one mailbox.
 *
 * @see {@link ../../docs/api-reference.md | Core API reference}
 *   — the whole public surface with its lifecycle and configuration
 *   boundaries.
 * @see {@link ../../docs/testing.md | Test an Interocitor product}
 *   — running an engine in a test without a server.
 */
export class Interocitor<
  S extends Record<string, Record<string, unknown>>,
> implements ReadinessAwareQueryExecutor {
  declare readonly InitContext: InterocitorInitContext<S>;
  private adapter: StorageAdapter | null;
  private config: ResolvedSyncConfig<S>;
  private serverId: string;
  private local: LocalStore;
  private deviceId: string;
  private hlc: HLC;
  private encryptionKey: CryptoKey | null = null;
  /** HMAC key that hides durable-file paths, derived from `encryptionKey`. */
  private filePathKey: { source: CryptoKey; key: CryptoKey } | null = null;
  private encrypted = false;
  private passphrase: string | null = null;
  private keySource: MeshKeySource | null = null;

  // In-memory CRDT merge cache — lazily populated on writes and pulls.
  private tables: Record<string, Record<string, Row>> = {};
  private manifest: Manifest | null = null;
  private remotePoisonError: Error | null = null;
  // Negative access decision (401/403/mesh 404) that paused remote sync.
  private remoteAccessError: RemoteAccessError | null = null;

  // Known table names (populated from the local store on init, updated on writes)
  private knownTables: Set<string> = new Set();

  // Flush management
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingCount = 0;
  private compactWarningEmitted = false;
  private compactInFlight: Promise<void> | null = null;
  private compactScheduleVersion = 0;
  private compactCheckTimer: ReturnType<typeof setTimeout> | null = null;
  private compactRunTimer: ReturnType<typeof setTimeout> | null = null;
  private compactRetentionTimer: ReturnType<typeof setTimeout> | null = null;
  private compactRetentionDueAt = 0;
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while the local store holds an unpromoted pending batch. */
  private pendingBatch = false;
  /** True once an eviction was reported under the `manual` policy. */
  private evictedMeshAwaitingRefill = false;

  // Poll / push invalidation management
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Polling is torn down and may not restart until the next connect().
   *
   * See {@link haltPolling} for why stopPolling() alone leaks a timer.
   */
  private pollingHalted = false;
  private pollBaseIntervalMs = 0;
  private pollCurrentIntervalMs = 0;
  private pollGeneration: object = {};
  private unsubscribeRemoteInvalidations: (() => void) | null = null;
  private remoteInvalidationPullPromise: Promise<void> | null = null;
  private remoteInvalidationPullQueued = false;
  private remoteInvalidationCooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private remoteInvalidationCooldownQueued = false;

  // Lifecycle state
  private initialized = false;
  private connected = false;
  private connectionStatus: import("./types.ts").ConnectionStatus = "offline";
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
  private changeObservationListeners: Set<ChangeObservationListener> = new Set();
  private pendingLocalEffects: Map<string, PendingLocalRowEffect> = new Map();
  private pendingLocalObservationListeners: Set<ChangeObservationListener> | null = null;
  private readonly schema?: DatabaseSchemaDefinition<S>;
  private readonly dbName: string;
  private readonly readerMode: boolean;
  private readerManifestFresh = false;
  private deviceIdConfigured = false;
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
   * const engine = new Interocitor(adapter, {
   *   schema,
   *   remotePath: '/App',
   *   localStore,
   *   keySource,
   * });
   * const tasks = engine.table('tasks'); // Table<{ title: string; status: 'open' | 'done' }>
   */
  constructor(config: SyncConfig<S>);
  constructor(adapter: StorageAdapter | null, config: SyncConfig<S>);
  constructor(adapterOrConfig: StorageAdapter | SyncConfig<S> | null, maybeConfig?: SyncConfig<S>) {
    const config = (maybeConfig ?? adapterOrConfig) as InternalSyncConfig<S>;
    const adapter = (maybeConfig ? adapterOrConfig : null) as StorageAdapter | null;

    if (!config.localStore) {
      throw new Error("SyncConfig.localStore is required");
    }

    const retention = resolveRetentionPolicy(config.retention);

    this.schema = config.schema;
    this.keySource = config.keySource;
    this.adapter = adapter;
    this.config = {
      remotePath: config.remotePath,
      serverManaged: config.serverManaged ?? false,
      serverId: config.serverId ?? "server_relay_1",
      pollInterval: config.pollInterval ?? 30_000,
      flushDebounce: config.flushDebounce ?? 2_000,
      flushThreshold: config.flushThreshold ?? 50,
      compactWarnThreshold: config.compactWarnThreshold ?? DEFAULT_COMPACT_WARNING_THRESHOLD,
      compactAutoThreshold: config.compactAutoThreshold ?? DEFAULT_COMPACT_AUTO_THRESHOLD,
      compactAutoSampleNumerator:
        config.compactAutoSampleNumerator ?? DEFAULT_COMPACT_AUTO_SAMPLE_NUMERATOR,
      compactAutoDeviceCount: Math.max(
        1,
        Math.floor(config.compactAutoDeviceCount ?? DEFAULT_COMPACT_AUTO_DEVICE_COUNT),
      ),
      autoCompact: config.autoCompact ?? true,
      retention,
      retentionConfigured: config.retention !== undefined,
      firstCompactDelayMs: config.firstCompactDelayMs ?? DEFAULT_FIRST_COMPACT_DELAY_MS,
      firstCompactDelayJitterMs:
        config.firstCompactDelayJitterMs ?? DEFAULT_FIRST_COMPACT_DELAY_JITTER_MS,
      secondCompactDelayMs: config.secondCompactDelayMs ?? DEFAULT_SECOND_COMPACT_DELAY_MS,
      secondCompactDelayJitterMs:
        config.secondCompactDelayJitterMs ?? DEFAULT_SECOND_COMPACT_DELAY_JITTER_MS,
      compactRemoteChangeThreshold:
        config.compactRemoteChangeThreshold ?? DEFAULT_COMPACT_REMOTE_CHANGE_THRESHOLD,
      batchWindowMs: config.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS,
      dbName: config.dbName ?? "interocitor",
      localStore: config.localStore,
      schema: config.schema,
      replicas: config.replicas ?? [],
      onInit: config.onInit,
      resolveInitialState: config.resolveInitialState,
      relayEnabled: config.relayEnabled ?? true,
      relayHealthyPollInterval:
        config.relayHealthyPollInterval ?? Math.max(config.pollInterval ?? 30_000, 300_000),
      connectStageTimeoutMs: config.connectStageTimeoutMs ?? DEFAULT_CONNECT_STAGE_TIMEOUT_MS,
      onConnectStalled: config.onConnectStalled,
      joinExistingMeshPolicy: config.joinExistingMeshPolicy ?? "reset-to-remote",
      evictedMeshPolicy: config.evictedMeshPolicy ?? "refill",
    };
    this.serverId = this.config.serverId;
    this.dbName = this.config.dbName;
    this.logLevel = normalizeLogLevel(config.logLevel);
    this.local = this.config.localStore;
    this.readerMode = config[READER_MODE] === true;
    this.deviceIdConfigured = this.readerMode || Boolean(config.deviceId);
    this.deviceId = this.readerMode ? "reader" : (config.deviceId ?? createDeviceId());
    this.hlc = hlcInit(this.deviceId);

    this.encrypted = this.keySource !== null;
  }

  private log(level: LogLevel, ...args: unknown[]): void {
    logAtLevel(this.logLevel, level, ...args);
  }

  private supportsRemoteInvalidations(
    adapter: StorageAdapter,
  ): adapter is StorageAdapter & RemoteInvalidationStorageAdapter {
    return (
      typeof (adapter as Partial<RemoteInvalidationStorageAdapter>).subscribeToInvalidations ===
      "function"
    );
  }

  /** Await this before any storage operation. Returns the shared init promise. */
  private ensureReady(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    if (!this.initPromise) this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async refreshHlcFromLocal(): Promise<void> {
    const saved = await this.local.getMeta("hlc");
    if (typeof saved !== "string" || hlcCompareStr(saved, hlcSerialize(this.hlc)) <= 0) return;
    this.hlc = hlcParse(saved);
    this.hlc.nodeId = this.deviceId;
  }

  private async putNow<K extends keyof S & string>(
    table: K,
    rowId: string,
    columns: Partial<S[K]>,
    _userId?: string,
  ): Promise<S[K]> {
    await this.refreshHlcFromLocal();
    const tableName = table as string;
    const current = await this.local.getRow(tableName, rowId);
    const captureObservation = this.shouldCaptureLocalObservation();
    const before = captureObservation && current ? cloneRow(current) : undefined;
    const isResurrection = current?._meta.deleted === true;
    // Clone row with namespaced shape. New rows and resurrected tombstones start
    // with empty payload so a partial insert after delete cannot republish
    // pre-delete columns.
    const row: Row = current
      ? { _meta: { ...current._meta }, payload: isResurrection ? {} : { ...current.payload } }
      : {
          _meta: {
            table: tableName,
            rowId,
            deleted: false,
            schemaVersion: this.schema?.version ?? 0,
          },
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

    const op = this.rowToSyncOp(row);
    const hlc = this.getRowHlc(row);
    if (op && hlc) {
      await this.commitLocalMutation(row, op, hlc, captureObservation, before);
    } else {
      await this.local.putRow(row);
      if (!this.pendingBatch) this.pendingLocalObservationListeners = null;
    }
    this.knownTables.add(tableName);

    this.emit({ type: "change", table: tableName, rowId, row });
    return row as unknown as S[K];
  }

  private async deleteNow<K extends keyof S & string>(
    table: K,
    rowId: string,
    _userId?: string,
  ): Promise<void> {
    await this.refreshHlcFromLocal();
    const tableName = table as string;
    const current = await this.local.getRow(tableName, rowId);
    if (!current || current._meta.deleted) return;
    const captureObservation = this.shouldCaptureLocalObservation();
    const before = captureObservation ? cloneRow(current) : undefined;

    const nextHlc = hlcNow(this.hlc);
    this.hlc = nextHlc;
    current._meta.deleted = true;
    current._meta.deletedHlc = hlcSerialize(nextHlc);
    current._meta.owner = this.deviceId;
    // Tombstones carry only deletion metadata. Payload is no longer needed for
    // CRDT conflict checks and should not retain deleted user data.
    current.payload = {};
    const op = this.rowToSyncOp(current);
    const hlc = this.getRowHlc(current);
    if (op && hlc) {
      await this.commitLocalMutation(current, op, hlc, captureObservation, before);
    } else {
      await this.local.putRow(current);
      if (!this.pendingBatch) this.pendingLocalObservationListeners = null;
    }
    this.emit({ type: "delete", table: tableName, rowId });
  }

  /**
   * Append the op to the in-flight batch. If we are inside a `batch()` block,
   * the op stays buffered until the block ends. Otherwise it joins an
   * implicit period of `batchWindowMs`. Either way the result is one
   * ChangeEntry per batch instead of one per write.
   */
  private async commitLocalMutation(
    row: Row,
    op: Op,
    hlc: string,
    captureObservation: boolean,
    before: Row | undefined,
  ): Promise<void> {
    try {
      await this.local.commitLocalMutation(row, {
        id: generateId("chg"),
        ts: Date.now(),
        device: this.deviceId,
        hlc,
        ops: [op],
      });
      this.pendingBatch = true;
    } catch (error) {
      if (!this.pendingBatch) this.pendingLocalObservationListeners = null;
      throw error;
    }
    if (captureObservation) {
      this.recordPendingLocalEffect(row._meta.table, row._meta.rowId, before, row);
    }
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

  private async queryWhereNow<K extends keyof S & string>(
    table: K,
    clause: WhereClause,
  ): Promise<S[K][]> {
    return this.local.queryWhere(table as string, clause) as unknown as S[K][];
  }

  // ── Query cache (async-only, descriptor-keyed) ─────────────────────

  /** Public readiness signal. Used by render-time consumers to decide
   *  between sync cache reads and awaiting a load. */
  isReady(): boolean {
    return this.initialized;
  }

  /** Return the current transport state: `offline`, `connecting`, `syncing`, or `idle`. */
  getConnectionStatus(): import("./types.ts").ConnectionStatus {
    return this.connectionStatus;
  }

  /**
   * Return a fuller connection snapshot for UI/bootstrap decisions.
   *
   * This extends `getConnectionStatus()` with local readiness, solo-mode, the
   * configured remote path, current mesh id, and current device id.
   */
  getConnectionStatusDetails(): import("./types.ts").ConnectionStatusDetails {
    const solo = !this.config.remotePath;
    return {
      status: this.getConnectionStatus(),
      solo,
      ready: this.initialized,
      connected: this.connected,
      remoteAccess: this.remoteAccessError,
      remotePath: this.config.remotePath,
      meshId: this.manifest?.meshId,
      deviceId: this.deviceId,
    };
  }

  private setConnectionStatus(status: import("./types.ts").ConnectionStatus): void {
    if (this.connectionStatus === status) {
      this.emit({ type: "connection:status", status: this.getConnectionStatus() });
      return;
    }
    this.connectionStatus = status;
    this.emit({ type: "connection:status", status: this.getConnectionStatus() });
  }

  /**
   * The negative access decision that paused remote sync, or `null`.
   * See the `remote:access` event. Cleared by a successful `connect()`,
   * `disconnect()`, or `setRemoteStorage()`.
   */
  getRemoteAccessError(): RemoteAccessError | null {
    return this.remoteAccessError;
  }

  /**
   * Classify a remote failure. Returns true when `err` is a
   * {@link RemoteAccessError} and has been reported through `remote:access`.
   *
   * A negative decision (401, 403, mesh-level 404) pauses the remote session:
   * polling, relay, and publishing stop, `connected` flips to false, and the
   * status becomes `offline`. Local reads and writes continue. The
   * application reacts (sign in, read-only view, leave the mesh) and calls
   * `connect()` again. Interocitor never retries a denied request on its own.
   *
   * A temporary condition (429, 503) is reported without pausing; polling
   * backs off, honouring `Retry-After` when supplied.
   */
  private handleRemoteAccessError(
    err: unknown,
    stage: "connect" | "pull" | "flush" | "file" | "compact",
  ): boolean {
    if (!isRemoteAccessError(err)) return false;
    const paused = err.denied;
    if (paused) {
      const wasPaused = this.remoteAccessError !== null;
      this.remoteAccessError = err;
      this.haltPolling();
      this.stopRemoteInvalidations();
      this.clearScheduledFlush();
      this.clearCompactTimers();
      this.connected = false;
      this.log("warn", "remote access denied — remote sync paused until connect()", {
        stage,
        kind: err.kind,
        status: err.status,
        adapter: err.adapter,
        operation: err.operation,
        path: err.path,
      });
      if (!wasPaused || this.connectionStatus !== "offline") this.setConnectionStatus("offline");
    } else if (this.pollBaseIntervalMs) {
      const MAX_ACCESS_BACKOFF_MS = 300_000;
      const doubled = Math.max(this.pollCurrentIntervalMs * 2, this.pollBaseIntervalMs);
      this.pollCurrentIntervalMs = Math.min(
        Math.max(doubled, err.retryAfterMs ?? 0),
        MAX_ACCESS_BACKOFF_MS,
      );
      this.log("warn", "remote access temporarily unavailable — polling backed off", {
        stage,
        kind: err.kind,
        status: err.status,
        pollIntervalMs: this.pollCurrentIntervalMs,
      });
    }
    this.emit({
      type: "remote:access",
      error: err,
      kind: err.kind,
      status: err.status,
      adapter: err.adapter,
      operation: err.operation,
      path: err.path,
      stage,
      paused,
    });
    return true;
  }

  private clearRemoteAccessPause(adapterName: string): void {
    const previous = this.remoteAccessError;
    if (!previous) return;
    this.remoteAccessError = null;
    this.emit({ type: "remote:access:restored", adapter: adapterName, previous });
  }

  /** Stable cache key for a descriptor. Owned by core. */
  getQueryCacheKey(descriptor: QueryDescriptor): string {
    return computeCacheKey(descriptor);
  }

  /** Sync cache snapshot. Never starts a load. Empty/pending/ready/error. */
  readQueryCache(descriptor: QueryDescriptor): QueryCacheSnapshot {
    const key = this.getQueryCacheKey(descriptor);
    const entry = this.queryCache.get(key);
    if (!entry) return { status: "empty", promise: null };
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

    if (!options?.bypassCache && existing?.status === "pending" && existing.promise) {
      return existing.promise;
    }
    if (!options?.bypassCache && existing?.status === "ready" && existing.rows) {
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
        return dir === "asc" ? lt : -lt;
      });
      return sorted;
    })();

    const previous = this.queryCache.get(key);
    const entry: QueryCacheEntry = {
      descriptor,
      status: "pending",
      rows: previous?.rows, // keep stale rows visible while refreshing
      promise,
    };
    this.queryCache.set(key, entry);
    this.indexCacheByTable(descriptor.table, key);

    promise
      .then((rows) => {
        const current = this.queryCache.get(key);
        if (current?.promise !== promise) return; // superseded
        this.queryCache.set(key, { descriptor, status: "ready", rows });
      })
      .catch((err) => {
        const current = this.queryCache.get(key);
        if (current?.promise !== promise) return;
        this.queryCache.set(key, {
          descriptor,
          status: "error",
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
    if (!entry) return { status: "empty", promise: null };
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

    if (!options?.bypassCache && existing?.status === "pending" && existing.promise) {
      return existing.promise;
    }
    if (!options?.bypassCache && existing?.status === "ready") {
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
      status: "pending",
      row: previous?.row, // keep stale row visible while refreshing
      promise,
    };
    this.rowCache.set(key, entry);
    this.indexRowCacheByTable(descriptor.table, key);

    promise
      .then((row) => {
        const current = this.rowCache.get(key);
        if (current?.promise !== promise) return;
        this.rowCache.set(key, { descriptor, status: "ready", row: row ?? null });
      })
      .catch((err) => {
        const current = this.rowCache.get(key);
        if (current?.promise !== promise) return;
        this.rowCache.set(key, {
          descriptor,
          status: "error",
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
      observeChanges: this.observeChanges.bind(this),
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
      throw new Error(
        `No remote storage adapter configured. Call setRemoteStorage() before ${operation}.`,
      );
    }
    return this.adapter;
  }

  private requireRemotePath(operation: string): string {
    if (!this.config.remotePath)
      throw new Error(`${operation} requires remotePath; configure mesh before connecting`);
    return this.config.remotePath;
  }

  /**
   * The remote object name for an application file path.
   *
   * On an encrypted mesh the name is a keyed hash of the path, so the remote
   * stores the file without learning what the application calls it. An
   * unencrypted mesh keeps the plain path.
   */
  private async storedFilePath(path: string): Promise<string> {
    const remotePath = this.requireRemotePath("file storage");
    const clean = cleanFilePath(path);
    const meshKey = await this.meshFileKey();
    const name = meshKey ? await hideFilePath(await this.pathKeyFor(meshKey), clean) : clean;
    return `${remotePath.replace(/\/$/, "")}/files/${name}`;
  }

  private async pathKeyFor(meshKey: CryptoKey): Promise<CryptoKey> {
    if (this.filePathKey?.source !== meshKey) {
      this.filePathKey = { source: meshKey, key: await deriveFilePathKey(meshKey) };
    }
    return this.filePathKey.key;
  }

  /** The mesh key that wraps stored frames, or null on an unencrypted mesh. */
  private async meshFileKey(): Promise<CryptoKey | null> {
    if (!this.encrypted) return null;
    if (!this.encryptionKey) await this.resolveEncryption();
    if (!this.encryptionKey) throw new Error("Object storage requires an encryption key");
    return this.encryptionKey;
  }

  /**
   * Build the stored object: a header naming the file for its readers, then
   * the body, framed and wrapped under the mesh key. A sealed file's body is
   * first enveloped under the caller's extra key.
   */
  private async encodeStoredFile(
    data: Uint8Array | string,
    contentType?: string,
    seal?: FileSeal,
  ): Promise<{ stored: Uint8Array; header: StoredFileHeader }> {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const header: StoredFileHeader = {
      size: bytes.byteLength,
      digest: await sha256Hex(bytes),
      ...(contentType ? { contentType } : {}),
      ...(seal ? { taint: seal.taint } : {}),
    };
    const body = seal ? await encryptBytes(seal.key, bytes) : bytes;
    const stored = await sealStoredFrame(await this.meshFileKey(), encodeStoredFrame(header, body));
    return { stored, header };
  }

  private async decodeStoredFile(
    stored: Uint8Array,
  ): Promise<{ header: StoredFileHeader; body: Uint8Array }> {
    return decodeStoredFrame(await openStoredFrame(await this.meshFileKey(), stored));
  }

  /** Merge what the frame header says about a file into adapter metadata. */
  private describeStoredFile(
    meta: StoredFileMetadata,
    header: StoredFileHeader,
  ): StoredFileMetadata {
    return {
      ...meta,
      plaintextSize: header.size,
      storedSize: meta.storedSize ?? meta.size,
      contentType: header.contentType,
      taint: header.taint,
      digest: header.digest,
    };
  }

  private async rebuildOutboxFromLocalState(): Promise<void> {
    const rows = await this.local.getAllRows();
    const entries: ChangeEntry[] = [];
    for (const row of rows) {
      const op = this.rowToSyncOp(row);
      const hlc = this.getRowHlc(row);
      if (!op || !hlc) continue;
      entries.push({
        id: generateId("chg"),
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
      adapter: this.requireAdapter("manifest"),
      remotePath: this.requireRemotePath("manifest"),
      serverId: this.serverId,
      serverManaged: this.config.serverManaged,
      deviceId: this.deviceId,
      encrypted: this.encrypted,
      schema: this.schema,
      retention: this.config.retention,
      emit: (e) => this.emit(e),
    };
  }

  private async acknowledgeManifest(): Promise<void> {
    if (this.readerMode) return;
    if (!this.adapter || !this.config.remotePath || !this.manifest) return;
    // Before the first compaction there is no canonical watermark to
    // acknowledge. Initial connect already writes device presence metadata;
    // avoid an extra no-op device write/read on every bootstrap/reconnect.
    if (!this.manifest.watermarkHlc && this.manifest.epoch === 0) return;
    await upsertDeviceMetadata(this.adapter, this.config.remotePath, this.deviceId, {
      displayName: this.config.deviceName,
      deviceType: this.config.deviceType,
      observedManifestGeneration: this.manifest.generation,
      observedEpoch: this.manifest.epoch,
      observedWatermarkHlc: this.manifest.watermarkHlc,
      skipTouchIfUnchanged: true,
    });
  }

  // ── Flush / poll timers ────────────────────────────────────────────

  private clearScheduledFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private clearRetentionCompactionTimer(): void {
    if (this.compactRetentionTimer) clearTimeout(this.compactRetentionTimer);
    this.compactRetentionTimer = null;
    this.compactRetentionDueAt = 0;
  }

  private clearCompactTimers(): void {
    if (this.compactCheckTimer) clearTimeout(this.compactCheckTimer);
    if (this.compactRunTimer) clearTimeout(this.compactRunTimer);
    this.clearRetentionCompactionTimer();
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

  /**
   * Stop polling *and* forbid it from restarting until the next connect().
   *
   * stopPolling() alone is not enough on a teardown path. startPolling() is
   * reachable from the relay subscription callbacks (`onReady`, `onError`,
   * `onClose`) and from the late continuation of a connect() that has already
   * rejected — an adapter that fires `onClose` while being unsubscribed hits
   * exactly that. Any of those re-arms the loop with a *fresh* generation
   * token, which nothing subsequently invalidates, so the timer reschedules
   * itself forever: the mesh is closed, and the poll keeps running.
   *
   * Every teardown site uses this; connect() is the only thing that lifts it.
   */
  private haltPolling(): void {
    this.stopPolling();
    this.pollingHalted = true;
  }

  private startPolling(intervalMs = this.config.pollInterval): void {
    if (this.pollingHalted) return;
    this.stopPolling();
    this.pollBaseIntervalMs = intervalMs;
    this.pollCurrentIntervalMs = intervalMs;
    // Each startPolling call gets its own generation token so that in-flight
    // pulls from a previous polling session don't reschedule after stopPolling.
    const generation = {};
    this.pollGeneration = generation;
    const schedule = (): void => {
      this.pollTimer = unrefTimer(
        setTimeout(() => {
          this.pollTimer = null;
          this.pull()
            .catch(() => {})
            .finally(() => {
              if (this.pollGeneration === generation) {
                schedule();
              }
            });
        }, this.pollCurrentIntervalMs),
      );
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
        this.log("debug", "[interocitor:poll] activity detected, poll interval reset", {
          intervalMs: this.pollCurrentIntervalMs,
        });
      }
    } else if (this.pollCurrentIntervalMs < MAX_POLL_INTERVAL_MS) {
      // Idle — back off toward max.
      this.pollCurrentIntervalMs = Math.min(this.pollCurrentIntervalMs * 2, MAX_POLL_INTERVAL_MS);
      this.log("debug", "[interocitor:poll] idle, poll interval backed off", {
        intervalMs: this.pollCurrentIntervalMs,
      });
    }
  }

  private stopRemoteInvalidations(): void {
    if (this.unsubscribeRemoteInvalidations) {
      try {
        this.unsubscribeRemoteInvalidations();
      } catch {}
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
      this.log("debug", "[interocitor:relay] adapter has no invalidation subscription", {
        adapter: adapter.name,
        relayEnabled: this.config.relayEnabled,
      });
      this.emit({
        type: "relay:unavailable",
        adapter: adapter.name,
        reason: this.config.relayEnabled === false ? "disabled" : "adapter-unsupported",
      });
      return;
    }

    const INVALIDATION_PULL_COOLDOWN_MS = 1_000;

    const runInvalidationPull = (): void => {
      if (!this.connected) return;
      if (this.remoteInvalidationPullPromise) {
        this.remoteInvalidationPullQueued = true;
        this.log("debug", "[interocitor:relay] pull already in flight; queueing one replay", {
          adapter: adapter.name,
        });
        return;
      }

      const run = async (): Promise<void> => {
        try {
          await this.pull();
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          this.log("warn", "[interocitor:relay] pull after invalidation failed", err);
          this.emit({ type: "relay:error", adapter: adapter.name, error: err });
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
        this.log(
          "debug",
          "[interocitor:relay] cooldown active; collapsing invalidation into queued replay",
          {
            adapter: adapter.name,
          },
        );
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

    this.log("info", "[interocitor:relay] subscribing", {
      adapter: adapter.name,
      remotePath: this.config.remotePath,
      deviceId: this.deviceId,
    });
    this.emit({
      type: "relay:subscribe",
      adapter: adapter.name,
      remotePath: this.config.remotePath,
      deviceId: this.deviceId,
    });
    this.unsubscribeRemoteInvalidations = adapter.subscribeToInvalidations(
      (payload: RemoteInvalidationPayload) => {
        this.log("info", "[interocitor:relay] invalidation received", payload);
        this.emit({ type: "relay:message", adapter: adapter.name, payload });
        if (payload.pathType === "change" || payload.path.includes("/changes/")) {
          this.scheduleRetentionCompactionCheck(0);
        }
        scheduleInvalidationPull();
      },
      {
        onReady: () => {
          this.startPolling(this.config.relayHealthyPollInterval);
          this.log("info", "[interocitor:relay] ready", {
            adapter: adapter.name,
            pollInterval: this.config.relayHealthyPollInterval,
          });
          this.emit({ type: "relay:ready", adapter: adapter.name });
        },
        onError: (error?: unknown) => {
          this.startPolling(this.config.pollInterval);
          const err =
            error instanceof Error
              ? error
              : new Error(error ? String(error) : "Remote invalidation subscription error");
          this.log("warn", "[interocitor:relay] subscription error", err);
          this.emit({ type: "relay:error", adapter: adapter.name, error: err });
        },
        onClose: () => {
          this.startPolling(this.config.pollInterval);
          this.log("warn", "[interocitor:relay] closed", {
            adapter: adapter.name,
            pollInterval: this.config.pollInterval,
          });
          this.emit({ type: "relay:closed", adapter: adapter.name });
        },
      },
    );
  }

  // ── State helpers ──────────────────────────────────────────────────

  private getRowHlc(row: Row): string {
    let latest = row._meta.deletedHlc ?? "";
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
      return { type: "delete", table: row._meta.table, rowId: row._meta.rowId, hlc };
    }
    const columns: Record<string, ColumnEntry> = {};
    for (const [key, entry] of Object.entries(row.payload)) {
      if (!entry?.hlc) continue;
      columns[key] = entry;
    }
    if (Object.keys(columns).length === 0) return null;
    return { type: "upsert", table: row._meta.table, rowId: row._meta.rowId, columns };
  }

  private async loadLocalState(): Promise<void> {
    this.tables = {};
    this.knownTables = new Set();
    this.pendingLocalEffects.clear();
    this.pendingLocalObservationListeners = null;
    this.pendingBatch = (await this.local.peekPendingBatch()) !== null;
    const savedHlc = (await this.local.getMeta("hlc")) as string | undefined;
    if (savedHlc) {
      this.hlc = hlcParse(savedHlc);
      this.hlc.nodeId = this.deviceId;
    }
    for (const name of await this.local.getTableNames()) {
      this.knownTables.add(name);
    }
  }

  private activeRetentionPolicy(): RetentionPolicy {
    return resolveRetentionPolicy(this.manifest?.retention ?? this.config.retention);
  }

  private async offlineRetentionState(now = Date.now()): Promise<{
    expired: boolean;
    lastSuccessfulSyncAt?: string;
    maxOfflineDurationMs: number;
  }> {
    const { maxOfflineDurationMs } = this.activeRetentionPolicy();
    const stored = await this.local.getMeta(LAST_SUCCESSFUL_SYNC_AT_META);
    if (typeof stored !== "string" || !stored) return { expired: false, maxOfflineDurationMs };
    const lastSuccessfulAtMs = Date.parse(stored);
    return {
      expired:
        !Number.isFinite(lastSuccessfulAtMs) || now - lastSuccessfulAtMs > maxOfflineDurationMs,
      lastSuccessfulSyncAt: stored,
      maxOfflineDurationMs,
    };
  }

  /**
   * Return local writes withheld because this device exceeded the mesh's
   * offline limit. They are never uploaded automatically; applications may
   * export or deliberately reapply them as fresh edits after reconnecting.
   */
  async getQuarantinedOfflineChanges(): Promise<QuarantinedOfflineChanges | null> {
    await this.ensureReady();
    const value = await this.local.getMeta(QUARANTINED_OFFLINE_CHANGES_META);
    return value && typeof value === "object" ? (value as QuarantinedOfflineChanges) : null;
  }

  /** Remove the locally retained expired-write quarantine after user review. */
  async clearQuarantinedOfflineChanges(): Promise<void> {
    await this.ensureReady();
    await this.local.setMeta(QUARANTINED_OFFLINE_CHANGES_META, null);
  }

  private async quarantineExpiredOfflineWrites(
    now = Date.now(),
  ): Promise<QuarantinedOfflineChanges | null> {
    const state = await this.offlineRetentionState(now);
    if (!state.expired || !state.lastSuccessfulSyncAt) return null;

    // Promote first so a completed implicit batch and the durable outbox are
    // fenced together. Persist the quarantine marker before acknowledgement;
    // a crash can then cause a harmless duplicate quarantine pass, never an
    // expired upload.
    await this.flushPendingBatch();
    const queued = await this.local.peekOutbox();
    const existingValue = await this.local.getMeta(QUARANTINED_OFFLINE_CHANGES_META);
    const existing =
      existingValue && typeof existingValue === "object"
        ? (existingValue as QuarantinedOfflineChanges)
        : null;
    const byId = new Map<string, ChangeEntry>();
    for (const entry of existing?.entries ?? []) byId.set(entry.id, entry);
    for (const entry of queued) byId.set(entry.id, entry);
    const expiredAt = new Date(now).toISOString();
    const quarantine: QuarantinedOfflineChanges = {
      expiredAt,
      lastSuccessfulSyncAt: state.lastSuccessfulSyncAt,
      maxOfflineDurationMs: state.maxOfflineDurationMs,
      entries: Array.from(byId.values()),
    };
    await this.local.setMeta(QUARANTINED_OFFLINE_CHANGES_META, quarantine);
    await this.local.setMeta(OFFLINE_RETENTION_EXPIRED_AT_META, expiredAt);
    await this.local.acknowledgeOutbox(queued.map((entry) => entry.id));
    this.pendingBatch = false;
    this.pendingCount = 0;
    this.clearScheduledFlush();
    this.resetCompactWarning();
    this.emit({
      type: "offline:retention-expired",
      expiredAt,
      lastSuccessfulSyncAt: state.lastSuccessfulSyncAt,
      maxOfflineDurationMs: state.maxOfflineDurationMs,
      quarantinedChangeCount: quarantine.entries.length,
      remotePath: this.config.remotePath,
      deviceId: this.deviceId,
    });
    return quarantine;
  }

  private async preservedRetentionMeta(): Promise<Record<string, unknown>> {
    return {
      [QUARANTINED_OFFLINE_CHANGES_META]: await this.local.getMeta(
        QUARANTINED_OFFLINE_CHANGES_META,
      ),
      [OFFLINE_RETENTION_EXPIRED_AT_META]: await this.local.getMeta(
        OFFLINE_RETENTION_EXPIRED_AT_META,
      ),
      [LAST_SUCCESSFUL_SYNC_AT_META]: await this.local.getMeta(LAST_SUCCESSFUL_SYNC_AT_META),
      meshId: await this.local.getMeta("meshId"),
      // The remembered lineage must survive a reset. A device that forgot it
      // would report the same eviction again on every later connect.
      [MESH_LINEAGE_META]: await this.local.getMeta(MESH_LINEAGE_META),
    };
  }

  private async resetExpiredClientFromRemote(): Promise<void> {
    const preservedMeta = await this.preservedRetentionMeta();
    if (this.manifest?.snapshotPath) {
      await this.rehydrateNow(preservedMeta);
      return;
    }
    await this.local.clearAll();
    for (const [key, value] of Object.entries(preservedMeta)) {
      if (value !== undefined) await this.local.setMeta(key, value);
    }
    this.tables = {};
    this.knownTables.clear();
    await this.pullNow();
  }

  private async markSuccessfulRemoteSync(now = Date.now()): Promise<void> {
    await this.local.setMeta(LAST_SUCCESSFUL_SYNC_AT_META, new Date(now).toISOString());
    await this.local.setMeta(OFFLINE_RETENTION_EXPIRED_AT_META, null);
  }

  /**
   * What this device last knew about the mesh it belongs to.
   *
   * A remembered lineage of `null` means this device has never recorded one,
   * which is every device that predates the field. Such a device detects
   * eviction by the missing manifest alone until its first connect fills this
   * in; it does not report an eviction it has no evidence of.
   */
  private async rememberedMeshIdentity(): Promise<{
    rememberedMeshId: string;
    rememberedLineage: number | null;
  }> {
    const meshId = await this.local.getMeta("meshId");
    const lineage = await this.local.getMeta(MESH_LINEAGE_META);
    return {
      rememberedMeshId: typeof meshId === "string" ? meshId : "",
      rememberedLineage:
        typeof lineage === "number" && Number.isInteger(lineage) && lineage > 0 ? lineage : null,
    };
  }

  /**
   * Read the host's eviction record, if it publishes one.
   *
   * Most backends — a bucket, a WebDAV share, a NAS — have no code to attest
   * anything, so this returns null far more often than not. A null result
   * means the host did not say, never that the mesh survived.
   */
  private async readEvictionAttestation(): Promise<MeshEvictionAttestation | null> {
    const remotePath = this.config.remotePath;
    const adapter = this.adapter;
    if (!remotePath || !adapter) return null;
    const record = await readJsonIfExists<MeshEvictionAttestation>(
      adapter,
      `${remotePath}/evicted.json`,
    );
    return record && record.evicted === true ? record : null;
  }

  /**
   * Decide whether the mesh this device belongs to has been evicted and has
   * started a new life, and act on the configured policy.
   *
   * Two things are authoritative, and both mean the same event. A manifest
   * that is missing while this device's local store still names the mesh is a
   * mesh the host no longer holds. A lineage other than the one this device
   * remembers is a mesh that was already recreated by somebody else. The
   * second is what reaches every device that did not happen to be the one
   * that recreated the manifest.
   *
   * @returns Whether this device should republish its local state.
   */
  private async applyMeshEvictionPolicy(input: {
    bootstrapped: boolean;
    rememberedMeshId: string;
    rememberedLineage: number | null;
  }): Promise<boolean> {
    const meshId = this.manifest?.meshId;
    if (!meshId) return false;
    const lineage = resolveManifestLineage(this.manifest?.lineage);

    let detectedBy: "missing-manifest" | "lineage-change" | null = null;
    if (input.rememberedMeshId === meshId) {
      if (input.bootstrapped) detectedBy = "missing-manifest";
      else if (input.rememberedLineage !== null && input.rememberedLineage !== lineage) {
        detectedBy = "lineage-change";
      }
    }

    // Remember the live lineage either way, so one eviction is reported once.
    await this.local.setMeta(MESH_LINEAGE_META, lineage);
    if (!detectedBy) return false;

    const policy = this.config.evictedMeshPolicy;
    const localRows = await this.local.getAllRows();
    const queuedChangeCount = (await this.local.outboxSize()) + (this.pendingBatch ? 1 : 0);
    const attestation = await this.readEvictionAttestation();

    this.log("warn", "connect() — mesh was evicted and is starting a new life", {
      dbName: this.dbName,
      remotePath: this.config.remotePath,
      meshId,
      detectedBy,
      previousLineage: input.rememberedLineage ?? Math.max(1, lineage - 1),
      lineage,
      localRowCount: localRows.length,
      policy,
    });
    this.emit({
      type: "mesh:evicted",
      dbName: this.dbName,
      remotePath: this.config.remotePath,
      deviceId: this.deviceId,
      meshId,
      detectedBy,
      attestation,
      previousLineage: input.rememberedLineage ?? Math.max(1, lineage - 1),
      lineage,
      localRowCount: localRows.length,
      queuedChangeCount,
      policy,
    });

    // A reader holds no writable claim on the mesh and cannot contribute to a
    // refill. Meshes whose remaining devices are all readers stay evicted.
    if (this.readerMode) return false;
    if (policy === "manual") {
      this.evictedMeshAwaitingRefill = true;
      return false;
    }
    return true;
  }

  /**
   * Republish this device's complete local row state into a mesh that was
   * evicted, when `evictedMeshPolicy` is `'manual'`.
   *
   * Every device must do this, not only the one that recreated the manifest.
   * No device holds the whole mesh — each holds what it observed — so the mesh
   * is restored by the union of the contributions, not by any one of them.
   * Republishing carries each row's original clocks, so it is idempotent under
   * last-writer-wins and safe to call more than once.
   */
  async refillEvictedMesh(): Promise<void> {
    await this.ensureReady();
    if (this.readerMode) {
      throw new Error("InterocitorReader cannot refill an evicted mesh");
    }
    this.evictedMeshAwaitingRefill = false;
    await this.rebuildOutboxFromLocalState();
    await this.flushQueued(true);
  }

  /** Whether an eviction was reported and is waiting on `refillEvictedMesh()`. */
  get awaitingEvictedMeshRefill(): boolean {
    return this.evictedMeshAwaitingRefill;
  }

  private async applyJoinExistingMeshPolicy(bootstrapped: boolean): Promise<void> {
    const nextMeshId = this.manifest?.meshId;
    if (!nextMeshId) return;
    // The client that creates a mesh must durably bind its local state to that
    // identity immediately. Otherwise its first reconnect looks like a join to
    // an unrelated mesh, and the default reset policy can erase queued work.
    if (bootstrapped) {
      await this.local.setMeta("meshId", nextMeshId);
      return;
    }

    const previousMeshIdRaw = await this.local.getMeta("meshId");
    const previousMeshId = typeof previousMeshIdRaw === "string" ? previousMeshIdRaw : "";
    if (previousMeshId === nextMeshId) return;

    const localRows = await this.local.getAllRows();
    const queuedChangeCount = (await this.local.outboxSize()) + (this.pendingBatch ? 1 : 0);
    if (localRows.length === 0 && queuedChangeCount === 0 && !previousMeshId) {
      await this.local.setMeta("meshId", nextMeshId);
      return;
    }

    const policy = this.config.joinExistingMeshPolicy;
    this.emit({
      type: "join:existing-mesh",
      dbName: this.dbName,
      remotePath: this.config.remotePath,
      deviceId: this.deviceId,
      ...(previousMeshId ? { previousMeshId } : {}),
      nextMeshId,
      policy,
      localRowCount: localRows.length,
      queuedChangeCount,
    });

    if (policy === "merge-with-remote") {
      await this.local.setMeta("meshId", nextMeshId);
      return;
    }

    this.log(
      "info",
      "connect() — joining existing mesh, resetting local state to remote before sync",
      {
        dbName: this.dbName,
        remotePath: this.config.remotePath,
        previousMeshId: previousMeshId || undefined,
        nextMeshId,
        localRowCount: localRows.length,
        queuedChangeCount,
      },
    );
    await this.local.withLock(SYNC_STATE_LOCK, async () => {
      this.clearBatchTimer();
      this.pendingBatch = false;
      this.pendingLocalEffects.clear();
      this.pendingLocalObservationListeners = null;
      await ChangeObservationLedger.clearAll(this.local);
      if (this.schema?.version !== undefined) {
        await this.local.setMeta("schema:version", this.schema.version);
      }
      await this.local.setMeta("meshId", nextMeshId);
      await this.loadLocalState();
      this.pendingCount = 0;
    });
  }

  private async ensureRowsCached(ops: Op[]): Promise<void> {
    const refs = new Map<string, RowRef>();
    for (const op of ops) refs.set(`${op.table}/${op.rowId}`, { table: op.table, rowId: op.rowId });
    if (refs.size === 0) return;
    const wanted = [...refs.values()];
    const existingRows = await this.local.getRows(wanted);
    for (let i = 0; i < wanted.length; i++) {
      const { table, rowId } = wanted[i]!;
      const existing = existingRows[i];
      if (existing) {
        if (!this.tables[table]) this.tables[table] = {};
        this.tables[table][rowId] = existing;
      } else if (this.tables[table]) {
        delete this.tables[table][rowId];
      }
    }
  }

  private async poisonRemote(error: unknown, path?: string): Promise<Error> {
    const poisoned = error instanceof Error ? error : new Error(String(error));
    if (!this.remotePoisonError) {
      this.remotePoisonError = poisoned;
      this.haltPolling();
      this.clearScheduledFlush();
      this.connected = false;
      this.connectPromise = null;
      // Drop the adapter's "ensured folders" cache. After poison we don't
      // know whether the structure on disk is intact (corrupt manifest may
      // have been minted while folders were partially created), so the
      // next connect must re-validate every folder.
      this.adapter?.resetFolderCache?.();
      this.log("error", "remote:poisoned — sync halted", {
        dbName: this.dbName,
        remotePath: this.config.remotePath,
        deviceId: this.deviceId,
        path,
        message: poisoned.message,
      });
    }
    this.emit({
      type: "remote:poisoned",
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

  /**
   * Observe locally promoted and remotely decoded change entries for this
   * engine session. Observations are endpoint-relative and best effort: core
   * does not persist, replay, authenticate, or globally order them.
   *
   * Errors thrown by a listener do not interrupt local writes or synchronization.
   */
  observeChanges(listener: ChangeObservationListener): () => void {
    this.changeObservationListeners.add(listener);
    return () => {
      this.changeObservationListeners.delete(listener);
      this.pendingLocalObservationListeners?.delete(listener);
    };
  }

  private emitChangeObservation(
    observation: ChangeObservation,
    listeners: ReadonlySet<ChangeObservationListener> = this.changeObservationListeners,
  ): void {
    for (const listener of listeners) {
      try {
        listener(structuredClone(observation));
      } catch {
        // Observation is deliberately outside the row/sync correctness path.
      }
    }
  }

  private recordPendingLocalEffect(
    table: string,
    rowId: string,
    before: Row | undefined,
    after: Row,
  ): void {
    const key = JSON.stringify([table, rowId]);
    const current = this.pendingLocalEffects.get(key);
    this.pendingLocalEffects.set(key, {
      table,
      rowId,
      before: current ? current.before : before ? cloneRow(before) : undefined,
      after: cloneRow(after),
    });
  }

  private shouldCaptureLocalObservation(): boolean {
    if (!this.pendingBatch && this.pendingLocalObservationListeners === null) {
      this.pendingLocalObservationListeners = new Set(this.changeObservationListeners);
    }
    return (this.pendingLocalObservationListeners?.size ?? 0) > 0;
  }

  private emit(event: SyncEvent): void {
    // Single chokepoint for cache invalidation. Local mutations and remote
    // pull both flow through emit(); both invalidate query cache for the
    // affected table the same way. Local mutations also pre-invalidate so
    // synchronous reads after `put`/`delete` see fresh data.
    if (event.type === "change" || event.type === "delete") {
      this.invalidateQueryCacheForTable(event.table);
      this.invalidateRowCacheForTable(event.table);
    }
    if (event.type === "sync:complete") {
      this.adaptPollInterval(event.entriesMerged);
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* don't let listener errors break sync */
      }
    }
  }

  // ── Encryption ─────────────────────────────────────────────────────

  private async persistCredentials(): Promise<void> {
    if (!this.keySource || !this.passphrase) return;
    try {
      let meshId = this.manifest?.meshId;
      if (!meshId) {
        const existing = await this.loadPersistedCredentials();
        if (existing?.meshId) meshId = existing.meshId;
      }
      await this.keySource.persist(
        {
          dbName: this.dbName,
          remotePath: this.config.remotePath,
          meshId,
          deviceId: this.deviceId,
        },
        {
          portableKey: this.passphrase,
          deviceId: this.deviceId,
          ...(meshId ? { meshId } : {}),
        },
      );
      this.log("debug", "persistCredentials() — saved", {
        dbName: this.dbName,
        deviceId: this.deviceId,
        meshId,
      });
      this.emit({
        type: "credentials:persisted",
        dbName: this.dbName,
        remotePath: this.config.remotePath,
        deviceId: this.deviceId,
        encrypted: this.encrypted,
      });
    } catch (err) {
      this.log("error", "persistCredentials() — failed", err);
      // Predicates, not `instanceof`: a key source living in another package
      // — or another copy of this one — throws these from its own class
      // identities, and re-wrapping one as a generic persistence failure
      // would lose the status a host needs to re-prompt instead of replacing
      // the record.
      if (
        isCredentialPersistenceError(err) ||
        isMeshKeySourceContractError(err) ||
        isMeshCredentialAccessError(err)
      ) {
        throw err;
      }
      throw new CredentialPersistenceError(this.dbName, "persist", err);
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
    if (!activeMeshId || !this.keySource) return;
    const stored = await this.loadPersistedCredentials();
    if (!stored?.meshId) return;
    if (stored.meshId === activeMeshId) return;

    this.emit({
      type: "credentials:meshMismatch",
      dbName: this.dbName,
      remotePath: this.config.remotePath,
      storedMeshId: stored.meshId,
      activeMeshId,
    });
    throw new MeshCredentialMismatchError(this.dbName, stored.meshId, activeMeshId);
  }

  private async loadPersistedCredentials(): Promise<{
    portableKey: string;
    deviceId: string;
    meshId?: string;
  } | null> {
    if (!this.keySource) return null;
    if (this.keySource.credentialPersistence === "none") return null;
    if (this.keySource.credentialPersistence !== "durable") {
      throw new MeshKeySourceContractError();
    }
    if (!this.keySource.loadPersistedCredentials) throw new MeshKeySourceContractError();
    try {
      return await this.keySource.loadPersistedCredentials();
    } catch (err) {
      // "Could not be read" is not "could not be inspected": the distinct
      // status is what lets a host re-prompt instead of forking the mesh.
      if (isMeshCredentialAccessError(err)) throw err;
      throw new CredentialPersistenceError(this.dbName, "inspect", err);
    }
  }

  private async clearPersistedCredentials(): Promise<void> {
    await this.keySource?.clear();
  }

  private setDeviceId(deviceId: string): void {
    this.deviceId = deviceId;
    this.hlc.nodeId = deviceId;
  }

  private async restoreDeviceIdFromLocalStore(): Promise<void> {
    if (this.deviceIdConfigured) return;
    const stored = await this.local.getMeta("deviceId");
    if (typeof stored === "string" && stored) {
      this.setDeviceId(stored);
    }
  }

  private async persistDeviceIdToLocalStore(): Promise<void> {
    await this.local.setMeta("deviceId", this.deviceId);
  }

  private async resolveEncryption(): Promise<void> {
    if (!this.encrypted) {
      this.log("debug", "resolveEncryption() — encryption disabled");
      return;
    }

    if (this.keySource) {
      const resolved = await this.keySource.load({
        dbName: this.dbName,
        remotePath: this.config.remotePath,
        meshId: this.manifest?.meshId,
        deviceId: this.deviceId,
      });
      // Fail closed before anything can generate a replacement key.
      //
      // A key source may report inaccessible credentials either by throwing
      // MeshCredentialAccessError (which propagates out of init on its own) or
      // by returning the status on the material. Both must reach the caller:
      // minting a fresh key here would fork the mesh into two halves that can
      // never merge, and the loss is silent until the user notices half their
      // data missing on the other device.
      const credentialStatus = resolved.credentialStatus;
      if (
        !resolved.key &&
        !resolved.portableKey &&
        (credentialStatus === "unavailable" || credentialStatus === "unreadable")
      ) {
        this.log("error", "resolveEncryption() — credentials not readable, refusing to generate", {
          dbName: this.dbName,
          status: credentialStatus,
        });
        throw new MeshCredentialAccessError(credentialStatus, { dbName: this.dbName });
      }

      this.encrypted = resolved.encrypted;
      this.encryptionKey = resolved.key;
      this.passphrase = resolved.portableKey ?? null;
      if (this.passphrase && !this.encryptionKey) {
        this.encryptionKey = await passphraseToKey(this.passphrase);
      }
      if (!this.encryptionKey && this.encrypted && this.readerMode) {
        throw new Error("InterocitorReader requires the existing mesh key; it never generates one");
      }
      if (!this.encryptionKey && this.encrypted) {
        const { key, portableKey } = await generateMeshKeyMaterial();
        this.encryptionKey = key;
        this.passphrase = portableKey;
      }
      return;
    }

    throw new Error("Encrypted meshes require a keySource");
  }

  private applyInitialState(state: SyncInitialState | null | undefined): void {
    if (!state) return;
    if (state.deviceId) {
      this.setDeviceId(state.deviceId);
      this.deviceIdConfigured = true;
    }
    if (state.remotePath !== undefined) {
      this.config.remotePath = state.remotePath;
    }
    if (state.encrypted !== undefined) {
      this.encrypted = state.encrypted;
      if (!state.encrypted) {
        this.passphrase = null;
        this.encryptionKey = null;
        this.filePathKey = null;
      }
    }
    if (state.passphrase !== undefined) {
      this.passphrase = state.passphrase;
      this.encryptionKey = null;
      if (state.passphrase !== null) this.encrypted = true;
    }
  }

  /**
   * Pin the mesh identity and key input before `init()`/`connect()`.
   *
   * Use this when the app learns `remotePath`, mesh credentials, or a chosen
   * mesh id after construction but before the first remote session starts.
   * Once initialized, create a new engine instead of reconfiguring in place.
   */
  configureMesh(state: SyncInitialState): void {
    if (this.connected) throw new Error("Cannot configure mesh while connected");
    if (this.initialized)
      throw new Error(
        "Cannot configure mesh after init(); create a new engine or configure before connect",
      );
    this.applyInitialState(state);
    this.emit({
      type: "mesh:configured",
      dbName: this.dbName,
      remotePath: this.config.remotePath,
      deviceId: this.deviceId,
      encrypted: this.encrypted,
      hadPassphrase: this.passphrase !== null,
    });
  }

  async clearCredentials(): Promise<void> {
    await this.clearPersistedCredentials();
    this.encryptionKey = null;
    this.passphrase = null;
    this.encrypted = false;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  /**
   * Open the local store and restore local credentials/state.
   *
   * This is the explicit "local-first ready" boundary. After `init()`, reads,
   * writes, hooks, and file APIs can operate against local state even if the
   * network is unavailable.
   */
  async init(): Promise<void> {
    await this.ensureReady();
  }

  private async doInit(): Promise<void> {
    this.log("debug", "init() — opening local store", {
      dbName: this.config.dbName,
      encrypted: this.encrypted,
      remotePath: this.config.remotePath,
    });
    try {
      await this.local.open();
      if (this.schema?.version !== undefined) {
        await this.local.setMeta("schema:version", this.schema.version);
      }

      const initialState = await this.config.resolveInitialState?.();
      this.applyInitialState(initialState ?? null);

      if (this.readerMode) {
        await this.resolveEncryption();
      } else {
        // Serialize first key generation and persistence across every wrapper
        // for this physical LocalStore. A sibling tab that enters second must
        // observe the first tab's durable key instead of minting another one.
        await this.local.withLock(CREDENTIAL_STATE_LOCK, async () => {
          await this.restoreDeviceIdFromLocalStore();
          await this.resolveEncryption();
          await this.restoreCredentials();
          await this.persistCredentials();
          await this.persistDeviceIdToLocalStore();
        });
      }

      if (this.encrypted && this.encryptionKey && this.keySource && !this.readerMode) {
        this.emit({
          type: "encryption:resolved",
          strategy: this.keySource.constructor.name,
          dbName: this.dbName,
          remotePath: this.config.remotePath,
          encrypted: true,
        });
      }

      this.log("debug", "init() — loading local state (table names, HLC)");
      await this.loadLocalState();
      this.log("debug", "init() — complete", { knownTables: Array.from(this.knownTables) });
      this.initialized = true;
      this.setConnectionStatus("offline");
      if (this.config.onInit) {
        await this.config.onInit(this.initContext);
      }
    } catch (err) {
      this.log("error", "init() — failed", err);
      this.initPromise = null;
      throw err;
    }
  }

  /**
   * Silent credential restore from the primary store only.
   * Used during normal init(). No biometric prompt.
   */
  private async restoreCredentials(): Promise<void> {
    let stored: { portableKey: string; deviceId: string; meshId?: string } | null = null;
    stored = await this.loadPersistedCredentials();
    if (!stored) {
      this.log("debug", "restoreCredentials() — no persisted credentials", { dbName: this.dbName });
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
      const localMeshIdRaw = await this.local.getMeta("meshId");
      const localMeshId = typeof localMeshIdRaw === "string" ? localMeshIdRaw : "";
      if (localMeshId && localMeshId !== stored.meshId) {
        this.log(
          "error",
          "restoreCredentials() — meshId mismatch, refusing to adopt stored credentials",
          {
            dbName: this.dbName,
            storedMeshId: stored.meshId,
            activeMeshId: localMeshId,
          },
        );
        this.emit({
          type: "credentials:meshMismatch",
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
      this.log("warn", "restoreCredentials() — device-id mismatch, restoring stored id", {
        dbName: this.dbName,
        storedDeviceId: stored.deviceId,
        activeDeviceId: this.deviceId,
      });
      this.emit({
        type: "credentials:conflict",
        storedDeviceId: stored.deviceId,
        activeDeviceId: this.deviceId,
        dbName: this.dbName,
        remotePath: this.config.remotePath,
      });
      this.setDeviceId(stored.deviceId);
      deviceIdChanged = true;
    }

    let restoredPortableKey = false;
    if (this.encrypted && stored.portableKey) {
      if (!this.passphrase) {
        this.passphrase = stored.portableKey;
        restoredPortableKey = true;
      } else if (this.passphrase !== stored.portableKey) {
        // Caller passed a different portable key than the one persisted under
        // dbName. This is the classic "self-sabotage": same dbName, two keys.
        // Local rows were written with one key; new flushes will use another;
        // every reload after this will start poisoning remote files.
        this.log(
          "error",
          "restoreCredentials() — passphrase conflict! Caller-provided passphrase differs from persisted. Refusing to silently swap.",
          {
            dbName: this.dbName,
            remotePath: this.config.remotePath,
          },
        );
        this.emit({
          type: "credentials:conflict",
          storedDeviceId: stored.deviceId,
          activeDeviceId: this.deviceId,
          dbName: this.dbName,
          remotePath: this.config.remotePath,
        });
        throw new CredentialReplacementRequiredError(this.dbName);
      }
    }

    this.emit({
      type: "credentials:restored",
      source: "silent-store",
      deviceIdChanged,
      hadPassphrase: restoredPortableKey,
    });
  }

  /**
   * Start or resume the remote mesh session.
   *
   * `connect()` loads or creates the remote manifest, pulls remote changes,
   * flushes queued local writes, and starts polling or relay-backed
   * invalidation. It auto-`init()`s if needed.
   */
  async connect(): Promise<void> {
    await this.ensureReady();
    // The only place the teardown gate is lifted; see haltPolling().
    this.pollingHalted = false;
    if (this.encrypted && !this.encryptionKey) await this.resolveEncryption();
    if (!this.config.remotePath)
      throw new Error("connect() requires remotePath; configure mesh before connecting");
    this.setConnectionStatus("connecting");

    // Idempotent. If we are already connected to a live mesh on this
    // adapter+remotePath, don't restart the session — restart was the root
    // cause of the "observer" reload bug, where polling/flush timers and
    // adapter sessions stacked across UI reloads and started corrupting
    // the local cursor + remote files.
    if (this.connected && !this.remotePoisonError) {
      this.log("debug", "connect() — already connected, no-op", {
        dbName: this.dbName,
        remotePath: this.config.remotePath,
        deviceId: this.deviceId,
      });
      this.emit({
        type: "connect:noop",
        dbName: this.dbName,
        remotePath: this.config.remotePath,
        deviceId: this.deviceId,
        reason: "already-connected",
      });
      return;
    }

    // Concurrent-callers dedupe. The `connected` flag flips true only after
    // the full pipeline (manifest, pull, doFlush, startPolling) resolves;
    // a second caller arriving before that would re-enter and double every
    // flushed change file. Share the in-flight promise instead.
    if (this.connectPromise) {
      this.log("debug", "connect() — join in-flight connect", {
        dbName: this.dbName,
        remotePath: this.config.remotePath,
        deviceId: this.deviceId,
      });
      this.emit({
        type: "connect:noop",
        dbName: this.dbName,
        remotePath: this.config.remotePath,
        deviceId: this.deviceId,
        reason: "already-connected",
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
    const cached =
      this.manifest ?? ((await this.local.getMeta("manifestCache")) as Manifest | undefined);
    if (!cached || cached.encrypted !== this.encrypted) return false;

    // A cached manifest is not proof that the configured remote still names
    // the same mesh. Verify the authoritative manifest before a shortcut can
    // bypass the full join/parity pipeline.
    try {
      await this.doLoadOrCreateManifest("connect-fast-path-identity", true, {
        assertLocalMeshId: false,
        createIfMissing: false,
        persistCache: false,
      });
    } catch {
      return false;
    }
    if (this.manifest?.meshId !== cached.meshId) return false;
    await this.assertCredentialMeshParity();
    const observation = await ChangeObservationLedger.load(this.local);
    const cursor = observation.globalHighWaterHlc;
    if (!cursor) return false;
    if (!observation.hasExactObservationHistory) return false;
    if ((await this.offlineRetentionState()).expired) return false;
    if ((await this.local.outboxSize()) > 0) return false;
    if ((await this.local.peekPendingBatch()) !== null) return false;

    const remotePath = this.requireRemotePath("connect() fast-path");
    const p = paths(remotePath);
    try {
      const headRaw = await adapter.readFile(p.changesHead);
      const head = JSON.parse(new TextDecoder().decode(headRaw)) as { latestHlc?: string };
      this.emit({
        type: "trace:head",
        op: "read",
        reason: "connect-fast-path",
        path: p.changesHead,
        priorHlc: head.latestHlc ?? null,
      });
      if (head.latestHlc && hlcCompareStr(head.latestHlc, cursor) <= 0) {
        // A global HLC head cannot reveal a late-flushed change that sorts
        // behind the head. Verify authoritative filenames against exact-file
        // progress before taking the reload fast path. This still avoids all
        // change-file GETs.
        const files = await adapter.listFiles(p.changesFolder);
        if (observation.hasUnseenChange(files)) {
          return false;
        }
        this.emit({
          type: "trace:head",
          op: "skip-no-change",
          reason: "connect-fast-path",
          path: p.changesHead,
          priorHlc: head.latestHlc,
          nextHlc: cursor,
        });
        this.emit({
          type: "connect:state",
          dbName: this.dbName,
          remotePath: this.config.remotePath,
          deviceId: this.deviceId,
          meshId: this.manifest?.meshId,
          encrypted: this.encrypted,
        });
        this.emit({ type: "sync:complete", entriesMerged: 0 });
        this.startPolling(this.config.pollInterval);
        this.startRemoteInvalidations(adapter);
        this.connected = true;
        this.clearRemoteAccessPause(adapter.name);
        await this.markSuccessfulRemoteSync();
        this.scheduleRetentionCompactionCheck(0);
        this.setConnectionStatus("idle");
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
  private async runConnectStage<T>(
    name: string,
    op: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
    try {
      const value = await withDeadline(name, op, this.config.connectStageTimeoutMs);
      return { ok: true, value };
    } catch (error) {
      if (error instanceof ConnectStageTimeoutError) {
        this.log("warn", `connect() — stage stalled: ${name}`, { timeoutMs: error.timeoutMs });
        this.emit({
          type: "connect:error",
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
        this.setConnectionStatus("offline");
        return { ok: false, error };
      }
      return { ok: false, error };
    }
  }

  private async doConnect(): Promise<void> {
    const adapter = this.requireAdapter("connect()");
    const stage = (s: string, err: unknown): Error => {
      const e = err instanceof Error ? err : new Error(String(err));
      this.handleRemoteAccessError(e, "connect");
      this.emit({
        type: "connect:error",
        error: e,
        stage: s,
        dbName: this.dbName,
        remotePath: this.config.remotePath,
        deviceId: this.deviceId,
      });
      return e;
    };
    const stageOk = (s: string, extra?: Record<string, unknown>) => {
      this.log("debug", "connect() — stage ok", {
        stage: s,
        dbName: this.dbName,
        deviceId: this.deviceId,
        ...extra,
      });
    };

    this.log("debug", "connect() — authenticating with adapter", { adapter: adapter.name });
    if (!adapter.isAuthenticated()) {
      this.emit({ type: "auth:required" });
      const authResult = await this.runConnectStage("authenticate", () => adapter.authenticate());
      if (!authResult.ok) {
        if (authResult.error instanceof ConnectStageTimeoutError) return; // offline-ready degrade
        this.log("error", "connect() — authentication failed", authResult.error);
        throw stage("authenticate", authResult.error);
      }
      this.emit({ type: "auth:complete" });
    }

    // Reload steady-state fast path: local cache has exact change-file
    // progress, there is no pending outbox, and every authoritative change
    // filename has been observed. After the minimal auth check, probe head
    // plus the changes folder and stop — no folder creation, manifest reads,
    // device metadata writes, or change-file reads. This covers clients that
    // recreate the adapter on reload before calling setRemoteStorage().
    if (!this.readerMode && (await this.tryConnectFastPath(adapter))) return;

    if (this.readerMode) {
      const manifestResult = await this.runConnectStage("loadExistingManifest", () =>
        this.doLoadOrCreateManifest("reader-connect", true, {
          assertLocalMeshId: false,
          createIfMissing: false,
        }),
      );
      if (!manifestResult.ok) {
        if (manifestResult.error instanceof ConnectStageTimeoutError) return;
        throw stage("loadExistingManifest", manifestResult.error);
      }

      const readerMeshMemory = await this.rememberedMeshIdentity();
      await this.applyJoinExistingMeshPolicy(false);
      // A reader cannot refill, but it must still learn that the mesh it is
      // reading is a different life of the one it read last time.
      await this.applyMeshEvictionPolicy({ bootstrapped: false, ...readerMeshMemory });
      if ((await this.local.outboxSize()) > 0 || (await this.local.peekPendingBatch()) !== null) {
        throw stage(
          "readerLocalState",
          new Error(
            "InterocitorReader localStore contains queued writes; use a dedicated reader cache",
          ),
        );
      }

      this.readerManifestFresh = true;
      const pullResult = await this.runConnectStage("pull", () => this.pull());
      if (!pullResult.ok) {
        if (pullResult.error instanceof ConnectStageTimeoutError) return;
        throw stage("pull", pullResult.error);
      }

      this.startPolling(this.config.pollInterval);
      this.startRemoteInvalidations(adapter);
      this.connected = true;
      this.clearRemoteAccessPause(adapter.name);
      await this.markSuccessfulRemoteSync();
      this.setConnectionStatus("idle");
      return;
    }

    const remotePath = this.requireRemotePath("connect()");
    const p = paths(remotePath);
    this.log("debug", "connect() — ensuring remote folders", {
      remotePath,
      deviceId: this.deviceId,
    });
    for (const folder of [remotePath, p.devicesFolder, p.mainlineFolder, p.changesFolder]) {
      const folderResult = await this.runConnectStage("ensureFolder", () =>
        adapter.ensureFolder(folder),
      );
      if (!folderResult.ok) {
        if (folderResult.error instanceof ConnectStageTimeoutError) return; // offline-ready degrade
        this.log("error", "connect() — ensureFolder failed", folder, folderResult.error);
        throw stage("ensureFolder", folderResult.error);
      }
      this.log("debug", "connect() — ensureFolder ok", folder);
    }

    // Capture what this device remembers before anything overwrites it. The
    // join policy rewrites the remembered mesh ID, and a bootstrap consumes
    // the remembered lineage, so both must be read ahead of the manifest load.
    const meshMemory = await this.rememberedMeshIdentity();

    this.log("debug", "connect() — loading/creating manifest");
    let bootstrapped = false;
    const manifestResult = await this.runConnectStage("loadOrCreateManifest", () =>
      this.doLoadOrCreateManifest("connect", true, { assertLocalMeshId: false }),
    );
    if (!manifestResult.ok) {
      if (manifestResult.error instanceof ConnectStageTimeoutError) return; // offline-ready degrade
      this.log("error", "connect() — loadOrCreateManifest failed", manifestResult.error);
      throw stage("loadOrCreateManifest", manifestResult.error);
    }
    bootstrapped = manifestResult.value.bootstrapped;
    stageOk("loadOrCreateManifest", {
      bootstrapped,
      meshId: this.manifest?.meshId,
      generation: this.manifest?.generation,
    });

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
      stageOk("credentialMeshParity", { meshId: this.manifest?.meshId });
    } catch (err) {
      this.log("error", "connect() — credential mesh parity failed", err);
      throw stage("credentialMeshParity", err);
    }

    // Only a verified credential/manifest pairing may authorize destructive
    // local replacement or retention of local work into another mesh.
    await this.applyJoinExistingMeshPolicy(bootstrapped);
    stageOk("joinExistingMeshPolicy", {
      policy: this.config.joinExistingMeshPolicy,
      meshId: this.manifest?.meshId,
    });

    const refillEvictedMesh = await this.applyMeshEvictionPolicy({ bootstrapped, ...meshMemory });
    stageOk("meshEvictionPolicy", {
      policy: this.config.evictedMeshPolicy,
      refill: refillEvictedMesh,
    });

    // Anchor credentials to the live meshId now that parity is known
    // good. First-connect of a fresh mesh has no meshId in the
    // credential record yet; on reconnect this is a no-op write that
    // keeps the record fresh.
    await this.persistCredentials();
    stageOk("persistCredentialsPostManifest");

    const expiredQuarantine = await this.local.withLock(SYNC_STATE_LOCK, () =>
      this.quarantineExpiredOfflineWrites(),
    );
    const offlineRetentionExpired = expiredQuarantine !== null;
    stageOk("offlineRetention", {
      expired: offlineRetentionExpired,
      quarantinedChangeCount: expiredQuarantine?.entries.length ?? 0,
    });

    const deviceMetadataResult = await this.runConnectStage("upsertDeviceMetadata", () =>
      upsertDeviceMetadata(adapter, remotePath, this.deviceId, {
        displayName: this.config.deviceName,
        deviceType: this.config.deviceType,
        // Skip the read-merge GET when we just minted the manifest in this
        // same connect cycle — no prior device record can possibly exist.
        bootstrap: bootstrapped,
        skipTouchIfUnchanged: !bootstrapped,
      }),
    );
    if (!deviceMetadataResult.ok) {
      if (deviceMetadataResult.error instanceof ConnectStageTimeoutError) return;
      throw stage("upsertDeviceMetadata", deviceMetadataResult.error);
    }
    stageOk("upsertDeviceMetadata");

    const localEpochRaw = await this.local.getMeta("epoch");
    const localEpoch = typeof localEpochRaw === "number" ? localEpochRaw : 0;
    const remoteEpoch = this.manifest?.epoch ?? 0;
    this.log("debug", "connect() — epoch check", { localEpoch, remoteEpoch });
    this.emit({
      type: "connect:state",
      dbName: this.dbName,
      remotePath: this.config.remotePath,
      deviceId: this.deviceId,
      localEpoch,
      remoteEpoch,
      meshId: this.manifest?.meshId,
      encrypted: this.encrypted,
    });

    let flushedBeforeSnapshotRestore = false;
    if (offlineRetentionExpired) {
      // An expired writer is fenced before this point. Replace its local sync
      // state without publishing the quarantine, even when the snapshot epoch
      // has not advanced since its last connection.
      const resetResult = await this.runConnectStage("expired-client-rehydrate", () =>
        this.local.withLock(SYNC_STATE_LOCK, () => this.resetExpiredClientFromRemote()),
      );
      if (!resetResult.ok) {
        if (resetResult.error instanceof ConnectStageTimeoutError) return;
        throw stage("expired-client-rehydrate", resetResult.error);
      }
      flushedBeforeSnapshotRestore = true;
    } else if (localEpoch < remoteEpoch) {
      // An old client is not equivalent to a new client: it may have durable
      // writes that no remote snapshot contains. Publish those immutable
      // entries before clearAll() replaces local state, then rehydrate pulls
      // the just-published entries back on top of the snapshot.
      this.log("debug", "connect() — epoch advanced, rehydrating from snapshot");
      const rehydrateResult = await this.runConnectStage("flush-and-rehydrate", () =>
        this.local.withLock(SYNC_STATE_LOCK, () => this.flushAndRehydrateNow()),
      );
      if (!rehydrateResult.ok) {
        if (rehydrateResult.error instanceof ConnectStageTimeoutError) return;
        throw stage("flush-and-rehydrate", rehydrateResult.error);
      }
      flushedBeforeSnapshotRestore = true;
    } else {
      this.log("debug", "connect() — running initial pull");
      const pullResult = await this.runConnectStage("pull", () => this.pull());
      if (!pullResult.ok) {
        if (pullResult.error instanceof ConnectStageTimeoutError) return;
        throw stage("pull", pullResult.error);
      }
    }
    // A device fenced by the offline rule has already had its local state
    // replaced from the remote and its queue quarantined. It holds nothing of
    // its own left to contribute, so it must not republish what it just pulled.
    // A bootstrap normally republishes local state, which is how an evicted
    // mesh used to refill itself by accident. Under the `manual` policy that
    // is exactly what the caller asked not to happen, so it waits instead.
    const republish = this.evictedMeshAwaitingRefill
      ? false
      : bootstrapped || (refillEvictedMesh && !offlineRetentionExpired);
    if (republish) {
      await this.rebuildOutboxFromLocalState();
    }
    if (!flushedBeforeSnapshotRestore || republish) {
      const flushResult = await this.runConnectStage("flush", () => this.flushQueued(true));
      if (!flushResult.ok) {
        if (flushResult.error instanceof ConnectStageTimeoutError) return;
        throw stage("flush", flushResult.error);
      }
    }

    this.startPolling(this.config.pollInterval);
    this.startRemoteInvalidations(adapter);
    this.connected = true;
    this.clearRemoteAccessPause(adapter.name);
    await this.markSuccessfulRemoteSync();
    this.scheduleRetentionCompactionCheck(0);
    this.setConnectionStatus("idle");
    this.log("info", "connect() — connected", {
      remotePath: this.config.remotePath,
      deviceId: this.deviceId,
      pollInterval: this.config.pollInterval,
    });
  }

  async disconnect(): Promise<void> {
    await this.ensureReady();
    // Hard tear-down. Order matters: stop timers first so no in-flight
    // poll/push/flush touches the adapter while we are killing the session.
    this.haltPolling();
    this.stopRemoteInvalidations();
    this.clearScheduledFlush();
    this.clearCompactTimers();
    this.clearBatchTimer();
    if (!this.readerMode && !this.remotePoisonError) {
      try {
        await this.flushQueued(true);
      } catch (err) {
        this.log("warn", "disconnect() — flush before close failed (continuing)", err);
      }
    }
    this.emit({
      type: "transport:teardown",
      dbName: this.dbName,
      remotePath: this.config.remotePath,
      deviceId: this.deviceId,
      reason: "disconnect",
    });
    this.local.close();
    this.connected = false;
    this.initialized = false;
    this.connectionStatus = "offline";
    this.emit({ type: "connection:status", status: this.getConnectionStatus() });
    this.initPromise = null;
    this.connectPromise = null;
    this.remotePoisonError = null;
    this.remoteAccessError = null;
  }

  /**
   * Attach, replace, or remove the current remote storage adapter.
   *
   * Use this when the engine is created in local-only mode or when the app
   * intentionally switches mailbox backends. If a remote session is active,
   * the engine tears it down and reconnects on the new adapter as needed.
   */
  async setRemoteStorage(adapter: StorageAdapter | null): Promise<void> {
    this.log("debug", "setRemoteStorage() — entry", {
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
    const wasConnected = this.connected;
    const hadAdapter = this.adapter !== null;
    const switching = adapter !== this.adapter;
    this.log("debug", "setRemoteStorage() — decision", {
      wasConnected,
      hadAdapter,
      switching,
    });

    // Same-adapter no-op. Callers (auto-reconnect, React StrictMode, etc.)
    // commonly re-attach the same adapter on every reload. Without this
    // guard we would tear down the live transport, reset cursor/epoch/meshId,
    // re-queue every local row into the outbox via rebuildOutboxFromLocalState,
    // then reconnect — which re-flushes the entire dataset as a fresh batch
    // of change files on every reload.
    if (!switching) {
      this.log("debug", "setRemoteStorage() — same adapter, no-op");
      return;
    }

    if (wasConnected && hadAdapter && !this.remotePoisonError) {
      try {
        await this.pull();
      } catch (err) {
        this.log("warn", "setRemoteStorage() — final pull before swap failed (continuing)", err);
      }
    }

    // Hard tear-down of the previous transport before swapping.
    // Without this, polling timers + outbox flush can race against the
    // newly-attached adapter and re-write the *new* mesh with files signed
    // for the old mesh — i.e. self-poison the remote on adapter switch.
    this.haltPolling();
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
        type: "transport:teardown",
        dbName: this.dbName,
        remotePath: this.config.remotePath,
        deviceId: this.deviceId,
        reason: adapter ? "switch-adapter" : "detach",
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
    this.remoteAccessError = null;

    if (wasConnected && adapter) await this.connect();
  }

  async setLocalStore(local: LocalStore): Promise<void> {
    await this.ensureReady();
    const wasConnected = this.connected;
    if (wasConnected && !this.readerMode) await this.flushQueued(true);

    this.clearScheduledFlush();
    this.pendingCount = 0;

    this.local.close();
    this.local = local;
    await this.local.open();
    await this.loadLocalState();
    this.initialized = true;

    if (!wasConnected) return;
    await this.pull();
    if (!this.readerMode) await this.flushQueued(true);
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
   * can distinguish cached reads from authoritative remote refreshes.
   */
  /**
   * Returns whether the manifest was bootstrapped (freshly minted) on this
   * call. Callers (connect()) use this to skip the device-metadata GET when
   * we know no prior device record can exist.
   */
  private async doLoadOrCreateManifest(
    reason: string = "unknown",
    force: boolean = false,
    options: {
      assertLocalMeshId?: boolean;
      createIfMissing?: boolean;
      persistCache?: boolean;
    } = {},
  ): Promise<{ bootstrapped: boolean }> {
    if (!force && this.manifest && !this.remotePoisonError) {
      this.emit({
        type: "trace:manifest",
        op: "cache-hit",
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
      options,
    );
    this.manifest = manifest;
    this.encrypted = manifest.encrypted || this.encrypted;
    if (options.persistCache !== false) await this.local.setMeta("manifestCache", manifest);
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
    if (this.batchDepth > 0) return this.putNow(table, rowId, columns, userId);
    return this.local.withLock(SYNC_STATE_LOCK, () => this.putNow(table, rowId, columns, userId));
  }

  async delete<K extends keyof S & string>(
    table: K,
    rowId: string,
    userId?: string,
  ): Promise<void> {
    await this.ensureReady();
    if (this.batchDepth > 0) return this.deleteNow(table, rowId, userId);
    return this.local.withLock(SYNC_STATE_LOCK, () => this.deleteNow(table, rowId, userId));
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

  /**
   * Return the typed table handle for one table in the schema.
   *
   * This is the main entrypoint for row CRUD, live row handles, and query
   * handles in application code.
   */
  table<K extends keyof S & string>(name: K): Table<S[K]> {
    return new Table(this, name);
  }

  // ── Batched writes ─────────────────────────────────────────────────
  // All writes performed inside `fn` are merged into ONE ChangeEntry.
  // Implicit batching also happens automatically: writes within the
  // configured batch period are flushed into a single ChangeEntry.

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
    const run = async (): Promise<R> => {
      this.batchDepth += 1;
      try {
        return await fn();
      } finally {
        this.batchDepth -= 1;
        if (this.batchDepth === 0) await this.flushPendingBatch();
      }
    };
    if (this.batchDepth > 0) return run();
    return this.local.withLock(SYNC_STATE_LOCK, run);
  }

  private isBatching(): boolean {
    return this.batchDepth > 0;
  }

  private clearBatchTimer(): void {
    if (!this.batchTimer) return;
    clearTimeout(this.batchTimer);
    this.batchTimer = null;
  }

  private armImplicitBatchTimer(): void {
    if (this.isBatching()) return;
    if (this.batchTimer) return;
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      void this.local.withLock(SYNC_STATE_LOCK, () => this.flushPendingBatch());
    }, this.config.batchWindowMs);
  }

  private async flushPendingBatch(): Promise<void> {
    this.clearBatchTimer();
    const pending = await this.local.promotePendingBatch();
    if (!pending) return;
    this.pendingBatch = false;
    const effects = [...this.pendingLocalEffects.values()]
      .map(({ table, rowId, before, after }) => createRowChangeEffect(table, rowId, before, after))
      .filter((effect) => effect !== null);
    const observationListeners = this.pendingLocalObservationListeners;
    this.pendingLocalEffects.clear();
    this.pendingLocalObservationListeners = null;
    if (effects.length > 0 && observationListeners && observationListeners.size > 0) {
      this.emitChangeObservation(
        {
          source: "local",
          observedAt: Date.now(),
          change: cloneChangeEntry(pending),
          effects,
        },
        observationListeners,
      );
    }
    this.scheduleFlush();
  }

  // ── Flush (local → cloud) ──────────────────────────────────────────

  private scheduleFlush(): void {
    this.pendingCount++;
    this.maybeEmitCompactWarning();
    this.armDelayedCompactAfterChange();
    if (this.pendingCount >= this.config.flushThreshold) {
      this.flushQueued().catch((err) => this.emit({ type: "flush:error", error: err }));
      return;
    }
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushQueued().catch((err) => this.emit({ type: "flush:error", error: err }));
    }, this.config.flushDebounce);
  }

  private maybeEmitCompactWarning(): void {
    if (this.compactWarningEmitted) return;
    if (this.pendingCount < this.config.compactWarnThreshold) return;
    this.compactWarningEmitted = true;
    this.emit({
      type: "compact:warning",
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

    const sampleWindow = Math.max(
      1,
      Math.floor(
        this.config.compactAutoDeviceCount / Math.max(1, this.config.compactAutoSampleNumerator),
      ),
    );
    const sampleRoll = Math.floor(Math.random() * sampleWindow);
    const baseEvent = {
      queuedChangeCount: triggerQueuedChangeCount,
      threshold: this.config.compactAutoThreshold,
      sampleRoll,
      sampleWindow,
      trigger: "immediate" as const,
      remotePath: this.config.remotePath,
      deviceId: this.deviceId,
    };

    if (!this.config.autoCompact) {
      this.emit({ type: "compact:auto:skip", ...baseEvent, reason: "disabled" });
      return;
    }
    if (!this.adapter || !this.config.remotePath) {
      this.emit({ type: "compact:auto:skip", ...baseEvent, reason: "missing-remote" });
      return;
    }
    if (!this.connected) {
      this.emit({ type: "compact:auto:skip", ...baseEvent, reason: "not-connected" });
      return;
    }
    if (!this.manifest?.server.managed) {
      this.emit({ type: "compact:auto:skip", ...baseEvent, reason: "peer-mode" });
      return;
    }
    if (this.remotePoisonError) {
      this.emit({ type: "compact:auto:skip", ...baseEvent, reason: "poisoned" });
      return;
    }
    if (this.compactInFlight) {
      this.emit({ type: "compact:auto:skip", ...baseEvent, reason: "already-running" });
      return;
    }
    if (sampleRoll !== 0) {
      this.emit({ type: "compact:auto:skip", ...baseEvent, reason: "sampling" });
      return;
    }

    this.emit({ type: "compact:auto:start", ...baseEvent });
    const run = this.compact()
      .then(() => {
        this.emit({
          type: "compact:auto:complete",
          queuedChangeCount: triggerQueuedChangeCount,
          threshold: this.config.compactAutoThreshold,
          trigger: "immediate",
          remotePath: this.config.remotePath,
          deviceId: this.deviceId,
        });
      })
      .catch((error: Error) => {
        this.emit({
          type: "compact:auto:error",
          queuedChangeCount: triggerQueuedChangeCount,
          threshold: this.config.compactAutoThreshold,
          trigger: "immediate",
          remotePath: this.config.remotePath,
          deviceId: this.deviceId,
          error,
        });
      })
      .finally(() => {
        if (this.compactInFlight === run) this.compactInFlight = null;
      });
    this.compactInFlight = run;
    await run;
  }

  // ── Finite change-retention deadline ─────────────────────────────

  private scheduleRetentionCompactionCheck(
    delayMs = this.activeRetentionPolicy().compactAfterMs,
  ): void {
    if (
      this.readerMode ||
      !this.connected ||
      !this.config.remotePath ||
      !this.manifest?.server.managed
    )
      return;
    const dueAt = Date.now() + Math.max(0, delayMs);
    if (this.compactRetentionTimer && this.compactRetentionDueAt <= dueAt) return;
    if (this.compactRetentionTimer) clearTimeout(this.compactRetentionTimer);
    this.compactRetentionDueAt = dueAt;
    const waitMs = Math.min(Math.max(0, dueAt - Date.now()), MAX_TIMER_DELAY_MS);
    this.emit({
      type: "compact:retention:scheduled",
      dueAt: new Date(dueAt).toISOString(),
      remotePath: this.config.remotePath,
      deviceId: this.deviceId,
    });
    this.compactRetentionTimer = setTimeout(() => {
      this.compactRetentionTimer = null;
      const targetDueAt = this.compactRetentionDueAt;
      this.compactRetentionDueAt = 0;
      if (Date.now() < targetDueAt) {
        this.scheduleRetentionCompactionCheck(targetDueAt - Date.now());
        return;
      }
      void this.runRetentionCompactionCheck();
    }, waitMs);
    unrefTimer(this.compactRetentionTimer);
  }

  private async runRetentionCompactionCheck(): Promise<void> {
    if (
      this.readerMode ||
      !this.connected ||
      !this.adapter ||
      !this.config.remotePath ||
      !this.manifest?.server.managed
    )
      return;
    const adapter = this.adapter;
    const remotePath = this.config.remotePath;
    if (this.remotePoisonError) {
      this.scheduleRetentionCompactionCheck(RETENTION_RETRY_DELAY_MS);
      return;
    }

    let snapshotCleanupNeedsRetry = false;
    try {
      await this.local.withLock(SYNC_STATE_LOCK, async () => {
        // Keep cleanup on the same local serialization boundary as snapshot
        // publication so it cannot mistake an in-progress candidate for a
        // superseded snapshot.
        await this.doLoadOrCreateManifest("snapshot-retention-check", true);
        const activeSnapshotPath = this.manifest?.snapshotPath;
        if (activeSnapshotPath) {
          const cleanup = await pruneSupersededSnapshots(
            adapter,
            remotePath,
            activeSnapshotPath,
            (event) => this.emit(event),
            this.deviceId,
          );
          snapshotCleanupNeedsRetry = cleanup.error !== undefined || cleanup.failedPaths.length > 0;
        }
      });
    } catch (error) {
      this.emit({
        type: "compact:retention:error",
        error: error instanceof Error ? error : new Error(String(error)),
        remotePath: this.config.remotePath,
        deviceId: this.deviceId,
      });
      this.scheduleRetentionCompactionCheck(RETENTION_RETRY_DELAY_MS);
      return;
    }

    let oldestChangeAt: number | undefined;
    try {
      const files = await this.adapter.listFiles(paths(this.config.remotePath).changesFolder);
      for (const file of files) {
        if (!/-chg_[^/]+\.json$/.test(file.name)) continue;
        const modifiedAt = Date.parse(file.modifiedTime);
        // An adapter that cannot provide a usable modification time cannot
        // prove the file is young, so compact conservatively.
        const candidate = Number.isFinite(modifiedAt) ? modifiedAt : 0;
        oldestChangeAt =
          oldestChangeAt === undefined ? candidate : Math.min(oldestChangeAt, candidate);
      }
    } catch (error) {
      this.emit({
        type: "compact:retention:error",
        error: error instanceof Error ? error : new Error(String(error)),
        remotePath: this.config.remotePath,
        deviceId: this.deviceId,
      });
      this.scheduleRetentionCompactionCheck(RETENTION_RETRY_DELAY_MS);
      return;
    }

    const compactAfterMs = this.activeRetentionPolicy().compactAfterMs;
    if (oldestChangeAt === undefined) {
      this.scheduleRetentionCompactionCheck(
        snapshotCleanupNeedsRetry ? RETENTION_RETRY_DELAY_MS : compactAfterMs,
      );
      return;
    }
    const ageMs = Math.max(0, Date.now() - oldestChangeAt);
    if (ageMs < compactAfterMs) {
      const delayMs = compactAfterMs - ageMs;
      this.scheduleRetentionCompactionCheck(
        snapshotCleanupNeedsRetry ? Math.min(delayMs, RETENTION_RETRY_DELAY_MS) : delayMs,
      );
      return;
    }
    if (this.compactInFlight) {
      this.scheduleRetentionCompactionCheck(60_000);
      return;
    }

    const oldestChangeAtIso = new Date(oldestChangeAt).toISOString();
    this.emit({
      type: "compact:retention:start",
      oldestChangeAt: oldestChangeAtIso,
      ageMs,
      remotePath: this.config.remotePath,
      deviceId: this.deviceId,
    });
    try {
      await this.compact();
      this.emit({
        type: "compact:retention:complete",
        oldestChangeAt: oldestChangeAtIso,
        ageMs,
        remotePath: this.config.remotePath,
        deviceId: this.deviceId,
      });
      // Covered-file deletion is intentionally best-effort. If the adapter is
      // refusing deletes, an immediate recheck would publish snapshots in a
      // tight loop. Recheck with bounded backoff; a successful cleanup sees no
      // changes and returns to the normal full retention interval.
      this.clearRetentionCompactionTimer();
      this.scheduleRetentionCompactionCheck(RETENTION_RETRY_DELAY_MS);
    } catch (error) {
      this.emit({
        type: "compact:retention:error",
        oldestChangeAt: oldestChangeAtIso,
        error: error instanceof Error ? error : new Error(String(error)),
        remotePath: this.config.remotePath,
        deviceId: this.deviceId,
      });
      this.clearRetentionCompactionTimer();
      this.scheduleRetentionCompactionCheck(RETENTION_RETRY_DELAY_MS);
    }
  }

  // ── Delayed compact support (secondary path) ────────────────────────
  // Independent from the immediate sampled auto-compact above. Both paths
  // can co-exist: any single compact() call is deduped via compactInFlight.
  // Helps lazy clients eventually compact even when sampling never fires.

  private armDelayedCompactAfterChange(): void {
    if (!this.config.autoCompact) return;
    if (!this.config.remotePath) return;
    if (!this.manifest?.server.managed) return;

    const delayMs = this.jitterDelay(
      this.config.firstCompactDelayMs,
      this.config.firstCompactDelayJitterMs,
    );
    this.compactScheduleVersion += 1;
    const version = this.compactScheduleVersion;

    if (this.compactCheckTimer) clearTimeout(this.compactCheckTimer);
    this.emit({
      type: "compact:delayed:scheduled",
      queuedChangeCount: this.pendingCount,
      delayMs,
      phase: "check",
      remotePath: this.config.remotePath,
      deviceId: this.deviceId,
    });
    this.compactCheckTimer = setTimeout(() => {
      this.compactCheckTimer = null;
      this.runDelayedCompactCheck(version).catch(() => {});
    }, delayMs);
    unrefTimer(this.compactCheckTimer);
  }

  private async runDelayedCompactCheck(version: number): Promise<void> {
    if (version !== this.compactScheduleVersion) return;
    if (!this.config.autoCompact || !this.connected || !this.adapter || !this.config.remotePath)
      return;
    if (this.remotePoisonError) return;

    let remoteChangeFileCount = 0;
    try {
      const adapter = this.adapter;
      const remoteRoot = this.config.remotePath;
      const list = await adapter
        .listFiles(`${remoteRoot}/changes`)
        .catch(() => [] as { path: string }[]);
      remoteChangeFileCount = list.filter((f) =>
        /\/changes\/[^/]+-chg_[^/]+\.json$/.test(f.path),
      ).length;
    } catch {
      /* best-effort */
    }

    this.emit({
      type: "compact:delayed:check",
      queuedChangeCount: this.pendingCount,
      remoteChangeFileCount,
      threshold: this.config.compactRemoteChangeThreshold,
      remotePath: this.config.remotePath,
      deviceId: this.deviceId,
    });

    if (remoteChangeFileCount <= this.config.compactRemoteChangeThreshold) {
      this.emit({
        type: "compact:auto:skip",
        queuedChangeCount: this.pendingCount,
        threshold: this.config.compactAutoThreshold,
        trigger: "delayed",
        remotePath: this.config.remotePath,
        deviceId: this.deviceId,
        reason: "below-remote-threshold",
      });
      return;
    }

    const delayMs = this.jitterDelay(
      this.config.secondCompactDelayMs,
      this.config.secondCompactDelayJitterMs,
    );
    if (this.compactRunTimer) clearTimeout(this.compactRunTimer);
    this.emit({
      type: "compact:delayed:scheduled",
      queuedChangeCount: this.pendingCount,
      delayMs,
      phase: "compact",
      remotePath: this.config.remotePath,
      deviceId: this.deviceId,
    });
    const triggerQueuedChangeCount = this.pendingCount;
    this.compactRunTimer = setTimeout(() => {
      this.compactRunTimer = null;
      this.runDelayedCompact(version, triggerQueuedChangeCount, remoteChangeFileCount).catch(
        () => {},
      );
    }, delayMs);
    unrefTimer(this.compactRunTimer);
  }

  private async runDelayedCompact(
    version: number,
    queuedChangeCount: number,
    remoteChangeFileCount: number,
  ): Promise<void> {
    if (version !== this.compactScheduleVersion) {
      this.emit({
        type: "compact:auto:skip",
        queuedChangeCount,
        threshold: this.config.compactAutoThreshold,
        trigger: "delayed",
        remotePath: this.config.remotePath,
        deviceId: this.deviceId,
        reason: "superseded",
      });
      return;
    }
    if (!this.config.autoCompact || !this.connected || !this.adapter || !this.config.remotePath) {
      this.emit({
        type: "compact:auto:skip",
        queuedChangeCount,
        threshold: this.config.compactAutoThreshold,
        trigger: "delayed",
        remotePath: this.config.remotePath,
        deviceId: this.deviceId,
        reason: this.connected
          ? this.config.autoCompact
            ? "missing-remote"
            : "disabled"
          : "not-connected",
      });
      return;
    }
    if (this.remotePoisonError) {
      this.emit({
        type: "compact:auto:skip",
        queuedChangeCount,
        threshold: this.config.compactAutoThreshold,
        trigger: "delayed",
        remotePath: this.config.remotePath,
        deviceId: this.deviceId,
        reason: "poisoned",
      });
      return;
    }
    if (this.compactInFlight) {
      this.emit({
        type: "compact:auto:skip",
        queuedChangeCount,
        threshold: this.config.compactAutoThreshold,
        trigger: "delayed",
        remotePath: this.config.remotePath,
        deviceId: this.deviceId,
        reason: "already-running",
      });
      return;
    }

    this.emit({
      type: "compact:auto:start",
      queuedChangeCount,
      threshold: this.config.compactAutoThreshold,
      trigger: "delayed",
      remoteChangeFileCount,
      remotePath: this.config.remotePath,
      deviceId: this.deviceId,
    });

    const run = this.compact()
      .then(() => {
        this.emit({
          type: "compact:auto:complete",
          queuedChangeCount,
          threshold: this.config.compactAutoThreshold,
          trigger: "delayed",
          remoteChangeFileCount,
          remotePath: this.config.remotePath,
          deviceId: this.deviceId,
        });
      })
      .catch((error: Error) => {
        this.emit({
          type: "compact:auto:error",
          queuedChangeCount,
          threshold: this.config.compactAutoThreshold,
          trigger: "delayed",
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
    return this.flushQueued(true);
  }

  private async flushQueued(includePendingBatch = false): Promise<void> {
    const triggerQueuedChangeCount = await this.local.withLock(SYNC_STATE_LOCK, async () => {
      if (includePendingBatch) await this.flushPendingBatch();
      return this.doFlush();
    });
    await this.maybeAutoCompact(triggerQueuedChangeCount);
  }

  private async doFlush(): Promise<number> {
    if (!this.adapter) {
      this.clearScheduledFlush();
      return 0;
    }
    if (this.remoteAccessError) {
      // The remote denied access. Retrying will not change the provider's
      // decision; keep the outbox durable and wait for connect().
      this.clearScheduledFlush();
      this.log("debug", "flush() — skipped, remote access paused", {
        kind: this.remoteAccessError.kind,
        status: this.remoteAccessError.status,
      });
      return 0;
    }

    const triggerQueuedChangeCount = this.pendingCount;
    // Keep entries durable until authoritative publication succeeds. An empty
    // flush/disconnect remains local-only and cannot bootstrap remote state.
    const entries = await this.local.peekOutbox();
    if (entries.length === 0) {
      this.pendingCount = 0;
      this.resetCompactWarning();
      return 0;
    }

    // The mesh policy may have been tightened while this device was offline.
    // Refresh it before deciding whether queued writes remain eligible; doing
    // this after the check would let direct flush() bypass the current policy.
    await this.doLoadOrCreateManifest("flush-retention", true);
    if (await this.quarantineExpiredOfflineWrites()) return 0;

    this.log("debug", "flush() — start", { entryCount: entries.length });
    this.emit({ type: "flush:start", entryCount: entries.length });
    if (this.connected) this.setConnectionStatus("syncing");
    this.pendingCount = 0;
    this.resetCompactWarning();
    this.clearScheduledFlush();

    try {
      await flushPrimary(
        this.adapter,
        this.local,
        this.requireRemotePath("flush()"),
        entries,
        this.codecState,
        this.deviceId,
        (e) => this.emit(e),
        this.config.replicas.map((replica) => ({
          adapter: replica.adapter,
          remotePath: replica.remotePath ?? this.requireRemotePath("flush() replica"),
        })),
        (adapterName, err) => {
          this.log("warn", "flush() — replica write failed", { adapter: adapterName }, err);
          this.emit({ type: "replica:error", adapter: adapterName, error: err as Error });
        },
        (level, ...args) => this.log(level, ...args),
      );
      await this.local.acknowledgeOutbox(entries.map((entry) => entry.id));
      await this.markSuccessfulRemoteSync();
      this.scheduleRetentionCompactionCheck(0);

      this.log("debug", "flush() — complete", { entryCount: entries.length });
      this.emit({ type: "flush:complete" });
      if (this.connected) this.setConnectionStatus("idle");
      return triggerQueuedChangeCount;
    } catch (err) {
      this.handleRemoteAccessError(err, "flush");
      if (this.connected) this.setConnectionStatus("idle");
      this.log("error", "flush() — failed, durable entries remain queued", err);
      this.pendingCount = entries.length;
      this.maybeEmitCompactWarning();
      throw err;
    }
  }

  // ── Pull (cloud → local) ──────────────────────────────────────────

  async pull(): Promise<void> {
    await this.ensureReady();
    return this.local.withLock(SYNC_STATE_LOCK, () => this.pullNow());
  }

  private async pullNow(): Promise<void> {
    const adapter = this.requireAdapter("pull()");
    if (this.connected) this.setConnectionStatus("syncing");
    try {
      if (this.readerMode) {
        if (!this.readerManifestFresh) {
          await this.doLoadOrCreateManifest("reader-pull", true, { createIfMissing: false });
        }
        this.readerManifestFresh = false;
        const localEpochRaw = await this.local.getMeta("epoch");
        const localEpoch = typeof localEpochRaw === "number" ? localEpochRaw : 0;
        if (this.manifest && this.manifest.epoch > localEpoch && this.manifest.snapshotPath) {
          this.readerManifestFresh = true;
          await this.rehydrateNow();
          return;
        }
      }
      this.hlc = await doPull({
        adapter,
        local: this.local,
        remotePath: this.requireRemotePath("pull()"),
        codecState: this.codecState,
        hlc: this.hlc,
        deviceId: this.deviceId,
        tables: this.tables,
        knownTables: this.knownTables,
        schema: this.schema,
        emit: (e) => this.emit(e),
        observeChange:
          this.changeObservationListeners.size > 0
            ? (observation) => this.emitChangeObservation(observation)
            : undefined,
        ensureRowsCached: (ops) => this.ensureRowsCached(ops),
        poisonRemote: (err, path) => this.poisonRemote(err, path),
        loadOrCreateManifest: async () => {
          await this.doLoadOrCreateManifest("pull", false, {
            createIfMissing: !this.readerMode,
          });
        },
      });
      if (this.connected) {
        await this.markSuccessfulRemoteSync();
        this.scheduleRetentionCompactionCheck();
      }
      await this.acknowledgeManifest();
    } catch (err) {
      this.handleRemoteAccessError(err, "pull");
      throw err;
    } finally {
      if (this.connected) this.setConnectionStatus("idle");
    }
  }

  // ── Rehydrate / Compact ────────────────────────────────────────────

  async rehydrate(): Promise<void> {
    await this.ensureReady();
    return this.local.withLock(SYNC_STATE_LOCK, () => this.flushAndRehydrateNow());
  }

  private async flushAndRehydrateNow(): Promise<void> {
    // Snapshot replacement is destructive to local metadata. It may proceed
    // only after every completed local mutation is durably published. A
    // publication failure aborts before clearAll(), preserving the outbox.
    await this.flushPendingBatch();
    await this.doFlush();
    await this.rehydrateNow(await this.preservedRetentionMeta());
  }

  private async rehydrateNow(preservedMeta?: Readonly<Record<string, unknown>>): Promise<void> {
    const adapter = this.requireAdapter("rehydrate()");
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
      pull: () => this.pullNow(),
      reloadManifest: async () => {
        await this.doLoadOrCreateManifest("rehydrate-stale-snapshot", true, {
          createIfMissing: !this.readerMode,
        });
        return this.manifest;
      },
      preservedMeta,
    });
    await this.acknowledgeManifest();
  }

  /**
   * Publish a full snapshot and manifest generation, then best-effort delete
   * the exact covered changes and every superseded mainline snapshot. Callers
   * must serialize compaction across engine instances because adapters provide
   * no distributed lease or compare-and-swap publication primitive.
   *
   * @see {@link ../../docs/compaction.md | Compaction}
   *   — when to call it, what a healthy remote looks like afterwards, and how
   *   an absent device catches up across a compaction.
   */
  async compact(): Promise<void> {
    await this.ensureReady();
    if (this.compactInFlight) return this.compactInFlight;
    const run = this.local
      .withLock(SYNC_STATE_LOCK, async () => {
        // Establish one local cut: completed batches are durable and all queued
        // changes are authoritative before pull/capture can publish a snapshot.
        await this.doLoadOrCreateManifest("compact-retention", true);
        const expiredQuarantine = await this.quarantineExpiredOfflineWrites();
        if (expiredQuarantine) {
          await this.resetExpiredClientFromRemote();
          return;
        }
        await this.flushPendingBatch();
        await this.doFlush();
        const adapter = this.requireAdapter("compact()");
        if (!this.manifest) throw new Error("Engine is not connected");
        this.manifest = await doCompact({
          adapter,
          local: this.local,
          remotePath: this.requireRemotePath("compact()"),
          manifest: this.manifest,
          codecState: this.codecState,
          hlc: this.hlc,
          deviceId: this.deviceId,
          serverId: this.serverId,
          retention: this.config.retentionConfigured
            ? this.config.retention
            : this.activeRetentionPolicy(),
          emit: (e) => this.emit(e),
          pull: () => this.pullNow(),
        });
        await this.acknowledgeManifest();
      })
      .finally(() => {
        if (this.compactInFlight === run) this.compactInFlight = null;
      });
    this.compactInFlight = run;
    return run;
  }

  // ── Durable file storage ───────────────────────────────────────────

  /**
   * Upload a durable application file.
   *
   * Files share the same mesh and encryption boundary as row data, but they do
   * not participate in CRDT merge or compaction. Writing the same path later
   * overwrites it. The returned metadata always carries `digest`, the SHA-256
   * of the plaintext; pass it through `toFileRef` to store an immutable
   * reference in a `types.file` row column.
   */
  async putFile(
    path: string,
    data: Uint8Array | string,
    contentType?: string,
    seal?: FileSeal,
  ): Promise<StoredFileMetadata> {
    return this.fileAccess(this.putFileImpl(path, data, contentType, seal));
  }

  private async putFileImpl(
    path: string,
    data: Uint8Array | string,
    contentType?: string,
    seal?: FileSeal,
  ): Promise<StoredFileMetadata> {
    await this.ensureReady();
    const adapter = this.requireAdapter("putFile()");
    if (seal && !seal.taint.trim()) throw new Error("Object seal taint must not be empty");
    const filePath = await this.storedFilePath(path);
    const { stored, header } = await this.encodeStoredFile(data, contentType, seal);
    const options: StoredFileWriteOptions = {
      uploadedByDeviceId: this.deviceId,
      sealGuard: seal ? await this.fileGuard(seal.key, filePath) : undefined,
    };
    if (adapter.putStoredFile) {
      return this.describeStoredFile(
        await adapter.putStoredFile(filePath, stored, options),
        header,
      );
    }
    await adapter.ensureFolder(`${this.requireRemotePath("putFile()").replace(/\/$/, "")}/files`);
    await adapter.writeFile(filePath, stored);
    const meta = await adapter.getFileMetadata(filePath);
    return this.describeStoredFile(
      {
        name: meta?.name ?? filePath.split("/").pop() ?? filePath,
        path: filePath,
        size: meta?.size ?? stored.byteLength,
        modifiedTime: meta?.modifiedTime ?? new Date().toISOString(),
        etag: meta?.etag,
        uploadedByDeviceId: this.deviceId,
        storedSize: stored.byteLength,
      },
      header,
    );
  }

  /**
   * Read and decrypt an untainted durable application file with the mesh key.
   *
   * Accepts a path or a `FileRef` from a `types.file` column. Given a
   * reference, the opened bytes are verified against `ref.digest` and a
   * mismatch rejects with `FileIntegrityError`.
   *
   * If the stored file is tainted/sealed under another key, call `openFile()`
   * and provide the matching key explicitly.
   */
  async getFile(target: string | FileRef): Promise<Uint8Array> {
    const path = fileTargetPath(target);
    const sealed = await this.openFile(target);
    if (sealed.taint)
      throw new Error(
        `Object ${path} is tainted with ${sealed.taint}; unlock the matching key and call openFile().open(key)`,
      );
    return sealed.open();
  }

  /**
   * Download a durable application file and defer plaintext opening.
   *
   * This is the low-level file-read API for sealed/tainted files where the
   * caller, not the engine, decides when and with which key plaintext should
   * be opened.
   */
  async openFile(target: string | FileRef): Promise<SealedFile> {
    return this.fileAccess(this.openFileImpl(fileTargetPath(target), expectedFileDigest(target)));
  }

  private async openFileImpl(path: string, expectedDigest?: string): Promise<SealedFile> {
    await this.ensureReady();
    const adapter = this.requireAdapter("openFile()");
    const filePath = await this.storedFilePath(path);
    const [stored, metadata] = await Promise.all([
      adapter.getStoredFile ? adapter.getStoredFile(filePath) : adapter.readFile(filePath),
      adapter.getStoredFileMetadata
        ? adapter.getStoredFileMetadata(filePath)
        : adapter
            .getFileMetadata(filePath)
            .then((meta): StoredFileMetadata | null =>
              meta ? { ...meta, storedSize: meta.size } : null,
            ),
    ]);
    const fallbackMetadata: StoredFileMetadata = {
      name: filePath.split("/").pop() ?? filePath,
      path: filePath,
      size: stored.byteLength,
      modifiedTime: new Date().toISOString(),
      storedSize: stored.byteLength,
    };
    const { header, body } = await this.decodeStoredFile(stored);
    const taint = header.taint;
    return {
      metadata: this.describeStoredFile(metadata ?? fallbackMetadata, header),
      taint,
      open: async (key?: CryptoKey) => {
        if (taint && !key)
          throw new Error(`Object ${path} is tainted with ${taint}; a matching key is required`);
        const plaintext = taint && key ? await decryptBytes(key, body) : body;
        if (expectedDigest) {
          const actual = await sha256Hex(plaintext);
          if (actual !== expectedDigest) throw new FileIntegrityError(path, expectedDigest, actual);
        }
        return plaintext;
      },
    };
  }

  /** Delete a durable application file. Missing files are treated as already deleted. */
  /**
   * Delete a durable file; a missing object is already deleted. A sealed file
   * needs its extra key here as well, because a store that records seal
   * guards refuses to delete without proof of that key.
   */
  async deleteFile(target: string | FileRef, seal?: Pick<FileSeal, "key">): Promise<void> {
    return this.fileAccess(this.deleteFileImpl(fileTargetPath(target), seal));
  }

  private async deleteFileImpl(path: string, seal?: Pick<FileSeal, "key">): Promise<void> {
    await this.ensureReady();
    const adapter = this.requireAdapter("deleteFile()");
    const filePath = await this.storedFilePath(path);
    if (adapter.deleteStoredFile) {
      await adapter.deleteStoredFile(filePath, {
        sealGuard: seal ? await this.fileGuard(seal.key, filePath) : undefined,
      });
    } else await adapter.deleteFile(filePath);
  }

  /** The seal guard for an object, bound to its remote name. */
  private fileGuard(sealKey: CryptoKey, filePath: string): Promise<string> {
    return deriveFileGuard(sealKey, filePath.split("/").pop() ?? filePath);
  }

  /**
   * Return metadata for a durable application file, or null when it does not
   * exist.
   *
   * Content type, taint, plaintext size, and digest live inside the stored
   * object, so this reads the object. A `FileRef` held in a row answers the
   * same questions without a remote round trip.
   */
  async getFileMetadata(target: string | FileRef): Promise<StoredFileMetadata | null> {
    return this.fileAccess(this.getFileMetadataImpl(fileTargetPath(target)));
  }

  private async getFileMetadataImpl(path: string): Promise<StoredFileMetadata | null> {
    await this.ensureReady();
    const adapter = this.requireAdapter("getFileMetadata()");
    const filePath = await this.storedFilePath(path);
    const meta = adapter.getStoredFileMetadata
      ? await adapter.getStoredFileMetadata(filePath)
      : await adapter
          .getFileMetadata(filePath)
          .then((m) => (m ? { ...m, storedSize: m.size } : null));
    if (!meta) return null;
    return (await this.openFileImpl(path)).metadata;
  }

  /**
   * Durable-file operations share the mesh's access decision: a 401/403 on a
   * file route pauses the remote session exactly like one on a sync route,
   * and reaches the caller as a `RemoteAccessError`.
   */
  private async fileAccess<T>(op: Promise<T>): Promise<T> {
    try {
      return await op;
    } catch (err) {
      this.handleRemoteAccessError(err, "file");
      throw err;
    }
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
        list: async () => {
          await ensure();
          return inner.list();
        },
        get: async (id) => {
          await ensure();
          return inner.get(id);
        },
        put: async (creds) => {
          await ensure();
          return inner.put(creds);
        },
        remove: async (id) => {
          await ensure();
          return inner.remove(id);
        },
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
}
