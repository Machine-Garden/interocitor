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
  ManifestPointer,
  Snapshot,
  Row,
  Op,
  UpsertOp,
  ColumnEntry,
  ChangesHead,
  DeviceMetadata,
  SyncEvent,
  SyncEventListener,
  DatabaseSchemaDefinition,
  WhereClause,
  ReplicaConfig,
  MeshChangePayload,
  MeshSnapshotPayload,
} from '../core/types.ts';

import { hlcInit, hlcNow, hlcSerialize, hlcParse, hlcReceive, hlcCompareStr } from '../core/hlc.ts';
import { applyOp, applyChangeEntry } from '../core/crdt.ts';
import { LocalStore } from '../storage/local-store.ts';
import { Table } from '../core/table.ts';
import {
  encryptEntry,
  decryptEntry,
} from '../crypto/encryption.ts';

import type { HLC } from '../core/types.ts';

// ─── Cloud path layout ──────────────────────────────────────────────
//
// {remotePath}/
//   manifest.json                          ← pointer
//   manifest-{generation}.json             ← immutable, content-hashed
//   devices/
//     {deviceId}.json
//   mainline/
//     snapshot-{epoch}-{writer}.json
//   changes/
//     head.json                            ← { latestHlc }
//     {hlc}-{changeId}.json               ← one file per flush entry
//

interface CloudPaths {
  manifestPointer: string;
  manifestFile: (generation: number) => string;
  devicesFolder: string;
  deviceFile: (deviceId: string) => string;
  mainlineFolder: string;
  changesFolder: string;
  changesHead: string;
  changeFile: (fileName: string) => string;
}

type ResolvedSyncConfig = Omit<Required<SyncConfig>, 'schema' | 'replicas'> & {
  schema?: DatabaseSchemaDefinition;
  replicas: ReplicaConfig[];
};

function paths(root: string): CloudPaths {
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

function log(level: 'debug' | 'info' | 'warn' | 'error', ...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console[level](LOG_PREFIX, ...args);
}

// ─── Helpers ─────────────────────────────────────────────────────────

function generateId(prefix: string): string {
  const rand = crypto.getRandomValues(new Uint8Array(8));
  const hex = Array.from(rand).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${hex}`;
}

function getDeviceId(): string {
  const KEY = 'interocitor-device-id';
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = generateId('dev');
    localStorage.setItem(KEY, id);
  }
  return id;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const ROW_META_KEYS = new Set(['_table', '_rowId', '_deleted', '_deletedHlc', '_schemaVersion']);

function hexFromBytes(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function computeContentHash(payload: unknown): Promise<string> {
  const json = JSON.stringify(payload);
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(json));
  return `sha256:${hexFromBytes(new Uint8Array(digest))}`;
}

// ─── Sync Engine ─────────────────────────────────────────────────────

/**
 * Type parameter S maps table names to their plain record types.
 *
 * @example
 * interface AppSchema {
 *   tasks: { title: string; status: 'open' | 'done' };
 *   notes: { content: string };
 * }
 * const engine = new SyncEngine<AppSchema>(adapter, { remotePath: '/App' });
 * const tasks = engine.table('tasks'); // Table<{ title: string; status: 'open' | 'done' }>
 *
 * Schema is optional — omit it for untyped usage.
 */
export class SyncEngine<S extends Record<string, Record<string, unknown>> = Record<string, Record<string, unknown>>> {
  private adapter: StorageAdapter | null;
  private config: ResolvedSyncConfig;
  private serverId: string;
  private local: LocalStoreAdapter;
  private deviceId: string;
  private hlc: HLC;
  private encryptionKey: CryptoKey | null = null;
  private encrypted = false;

  // In-memory CRDT merge cache — lazily populated on writes and pulls.
  // NOT a full dataset mirror; reads go to IDB directly.
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

  // Event listeners
  private listeners: Set<SyncEventListener> = new Set();
  private readonly schema?: DatabaseSchemaDefinition;

  /**
   * Create a sync engine.
   *
   * Pass a remote adapter up front for immediate sync support, or pass only
   * config to start fully local and attach a remote later with
   * {@link setRemoteStorage}.
   *
   * @example
   * ```ts
   * const engine = new SyncEngine({ remotePath: '/App', dbName: 'app' });
   * await engine.init();
   * await engine.put('tasks', 'task_1', { title: 'offline first' });
   * ```
   */
  constructor(config: SyncConfig);
  constructor(adapter: StorageAdapter | null, config: SyncConfig);
  constructor(adapterOrConfig: StorageAdapter | SyncConfig | null, maybeConfig?: SyncConfig) {
    const config = (maybeConfig ?? adapterOrConfig) as SyncConfig;
    const adapter = (maybeConfig ? adapterOrConfig : null) as StorageAdapter | null;

    this.schema = config.schema;
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
    };
    this.serverId = this.config.serverId;
    this.local = this.config.localStoreFactory();
    this.deviceId = getDeviceId();
    this.hlc = hlcInit(this.deviceId);
  }

  private requireAdapter(operation: string): StorageAdapter {
    if (this.remotePoisonError) {
      throw this.remotePoisonError;
    }
    if (!this.adapter) {
      throw new Error(`No remote storage adapter configured. Call setRemoteStorage() before ${operation}.`);
    }
    return this.adapter;
  }

  private clearScheduledFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

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
      if (!latest || hlcCompareStr(entryHlc, latest) > 0) {
        latest = entryHlc;
      }
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

    return {
      type: 'upsert',
      table: row._table,
      rowId: row._rowId,
      columns,
    };
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

  // ── Private lifecycle helpers ──────────────────────────────────────

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

  /**
   * Ensure rows referenced by ops are in the CRDT cache before merging.
   * Reads from IDB only when a row isn't already cached.
   */
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

  // ── Events ─────────────────────────────────────────────────────────

  /**
   * Subscribe to engine lifecycle and data-change events.
   *
   * Returns an unsubscribe function.
   *
   * @example
   * ```ts
   * const off = engine.on((event) => {
   *   if (event.type === 'change') console.log(event.table, event.rowId);
   * });
   * ```
   */
  on(listener: SyncEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: SyncEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* don't let listener errors break sync */ }
    }
  }

  // ── Encryption ─────────────────────────────────────────────────────

  /**
   * Configure the mesh encryption key before connecting to an encrypted mesh.
   *
   * Use this for fresh engines or when joining an already-encrypted mesh.
   */
  setEncryptionKey(key: CryptoKey): void {
    this.encryptionKey = key;
    this.encrypted = true;
  }

  private async encodeForCloud(plaintext: string): Promise<string> {
    if (!this.encrypted || !this.encryptionKey) return plaintext;
    return encryptEntry(this.encryptionKey, plaintext);
  }

  private async decodeFromCloud(data: string): Promise<string> {
    if (!this.encrypted || !this.encryptionKey) return data;
    return decryptEntry(this.encryptionKey, data);
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

  private async assertExpectedMeshId(meshId: string): Promise<void> {
    if (!meshId) {
      throw new Error('Remote mesh is missing meshId');
    }

    const manifestMeshId = this.manifest?.meshId;
    if (manifestMeshId && manifestMeshId !== meshId) {
      throw new Error(`Remote mesh mismatch: expected ${manifestMeshId}, got ${meshId}`);
    }

    const storedMeshId = await this.local.getMeta('meshId');
    if (typeof storedMeshId === 'string' && storedMeshId && storedMeshId !== meshId) {
      throw new Error(`Remote mesh mismatch: expected ${storedMeshId}, got ${meshId}`);
    }

    await this.local.setMeta('meshId', meshId);
  }

  private async encodeChangePayload(entry: ChangeEntry): Promise<string> {
    const meshId = this.manifest?.meshId;
    if (!meshId) {
      throw new Error('Cannot encode change payload before manifest is loaded');
    }

    const payload: MeshChangePayload = { meshId, kind: 'change', entry };
    return this.encodeForCloud(JSON.stringify(payload));
  }

  private async decodeChangePayload(data: string, path: string): Promise<ChangeEntry> {
    const decoded = await this.decodeFromCloud(data);
    const payload = JSON.parse(decoded) as MeshChangePayload;

    if (payload.kind !== 'change' || !payload.entry) {
      throw new Error(`Remote change payload has invalid shape: ${path}`);
    }

    await this.assertExpectedMeshId(String(payload.meshId || ''));
    return payload.entry;
  }

  private async encodeSnapshotPayload(snapshot: Snapshot): Promise<string> {
    const meshId = this.manifest?.meshId;
    if (!meshId) {
      throw new Error('Cannot encode snapshot payload before manifest is loaded');
    }

    const payload: MeshSnapshotPayload = { meshId, kind: 'snapshot', snapshot };
    return this.encodeForCloud(JSON.stringify(payload));
  }

  private async decodeSnapshotPayload(data: string, path: string): Promise<Snapshot> {
    const decoded = await this.decodeFromCloud(data);
    const payload = JSON.parse(decoded) as MeshSnapshotPayload;

    if (payload.kind !== 'snapshot' || !payload.snapshot) {
      throw new Error(`Remote snapshot payload has invalid shape: ${path}`);
    }

    await this.assertExpectedMeshId(String(payload.meshId || ''));
    return payload.snapshot;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  /**
   * Initialize: open local DB, load state into memory.
   * No network required — this is a purely local operation.
   */
  async init(): Promise<void> {
    log('debug', 'init() — opening local store', { dbName: this.config.dbName, encrypted: this.encrypted });
    try {
      await this.local.open();
    } catch (err) {
      log('error', 'init() — local store open failed', err);
      throw err;
    }
    if (this.schema) {
      await this.local.setMeta('schema:version', this.schema.version);
    }
    log('debug', 'init() — loading local state (table names, HLC)');
    try {
      await this.loadLocalState();
    } catch (err) {
      log('error', 'init() — loadLocalState failed', err);
      throw err;
    }
    log('debug', 'init() — complete', { knownTables: Array.from(this.knownTables) });
    this.initialized = true;
  }

  /**
   * Connect to cloud and start background sync.
   * Call after init() and after setting encryption key if needed.
   */
  async connect(): Promise<void> {
    if (!this.initialized) {
      throw new Error('Engine must be initialized via init() before connect()');
    }

    const adapter = this.requireAdapter('connect()');

    log('debug', 'connect() — authenticating with adapter', { adapter: adapter.name });
    if (!adapter.isAuthenticated()) {
      this.emit({ type: 'auth:required' });
      try {
        await adapter.authenticate();
      } catch (err) {
        log('error', 'connect() — authentication failed', err);
        throw err;
      }
      this.emit({ type: 'auth:complete' });
    }

    const p = paths(this.config.remotePath);
    log('debug', 'connect() — ensuring remote folders', { remotePath: this.config.remotePath, deviceId: this.deviceId });
    const foldersToEnsure = [
      this.config.remotePath,
      p.devicesFolder,
      p.mainlineFolder,
      p.changesFolder,
    ];
    for (const folder of foldersToEnsure) {
      try {
        await adapter.ensureFolder(folder);
        log('debug', 'connect() — ensureFolder ok', folder);
      } catch (err) {
        log('error', 'connect() — ensureFolder failed', folder, err);
        throw err;
      }
    }

    log('debug', 'connect() — loading/creating manifest');
    try {
      await this.loadOrCreateManifest();
    } catch (err) {
      log('error', 'connect() — loadOrCreateManifest failed', err);
      throw err;
    }

    await this.upsertDeviceMetadata();

    // If remote epoch advanced (usually after compaction), local cache
    // may be stale and must be rebuilt from snapshot first.
    const localEpochRaw = await this.local.getMeta('epoch');
    const localEpoch = typeof localEpochRaw === 'number' ? localEpochRaw : 0;
    const remoteEpoch = this.manifest?.epoch ?? 0;
    log('debug', 'connect() — epoch check', { localEpoch, remoteEpoch });

    if (localEpoch < remoteEpoch) {
      log('debug', 'connect() — epoch advanced, rehydrating from snapshot');
      await this.rehydrate();
    } else {
      log('debug', 'connect() — running initial pull');
      await this.pull();
    }
    await this.flush();

    // Start polling
    this.startPolling();
    this.connected = true;
    log('info', 'connect() — connected', { remotePath: this.config.remotePath, deviceId: this.deviceId, pollInterval: this.config.pollInterval });

    // Flush on page unload
    if (typeof window !== 'undefined') {
      window.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          this.flush().catch(() => {});
        }
      });
    }
  }

  /**
   * Stop background sync, attempt a final flush, and close the local store.
   *
   * Call {@link init} again before reconnecting the same engine instance.
   */
  async disconnect(): Promise<void> {
    this.stopPolling();
    this.clearScheduledFlush();
    if (!this.remotePoisonError) {
      await this.flush();
    }
    this.local.close();
    this.connected = false;
    this.initialized = false;
    this.remotePoisonError = null;
  }

  /**
   * Attach, replace, or remove the active remote storage backend.
   *
   * When switching to a new adapter, the engine preserves current local data,
   * resets remote sync state, rebuilds its outbox from IndexedDB, and then
   * resumes syncing against the selected backend. Passing `null` detaches
   * cloud sync while preserving local state and queued changes.
   *
   * If the engine was already connected, it reconnects automatically.
   *
   * @example
   * ```ts
   * await engine.setRemoteStorage(new WebDAVAdapter({
   *   baseUrl: 'https://cloud.example.com/dav',
   *   auth: { username: 'alice', password: 'app-password' },
   * }));
   * await engine.connect();
   *
   * await engine.setRemoteStorage(null); // back to local-only mode
   * ```
   */
  async setRemoteStorage(adapter: StorageAdapter | null): Promise<void> {
    const wasConnected = this.connected;
    const hadAdapter = this.adapter !== null;

    if (wasConnected && hadAdapter && !this.remotePoisonError) {
      await this.pull();
    }

    this.stopPolling();
    this.clearScheduledFlush();

    if (this.initialized) {
      await this.resetRemoteSyncState();
      if (adapter) {
        await this.rebuildOutboxFromLocalState();
      }
    } else {
      this.manifest = null;
      this.connected = false;
    }

    this.adapter = adapter;
    this.remotePoisonError = null;

    if (wasConnected && adapter) {
      await this.connect();
    }
  }

  /**
   * Replace the local persistence backend.
   *
   * This is primarily useful for advanced integrations and tests. When the
   * engine is already connected, the new local store is topped up from remote
   * after the swap so it converges to the current mesh state.
   */
  async setLocalStorage(local: LocalStoreAdapter): Promise<void> {
    const wasConnected = this.connected;

    if (wasConnected) {
      await this.flush();
    }

    this.clearScheduledFlush();
    this.pendingCount = 0;

    this.local.close();
    this.local = local;
    await this.local.open();
    await this.loadLocalState();
    this.initialized = true;

    if (!wasConnected) return;

    await this.pull();
    await this.flush();
  }

  // ── Manifest ───────────────────────────────────────────────────────

  private async readJson<T>(path: string): Promise<T> {
    const adapter = this.requireAdapter(`read ${path}`);
    const data = await adapter.readFile(path);
    return JSON.parse(textDecoder.decode(data)) as T;
  }

  private async readJsonIfExists<T>(path: string): Promise<T | null> {
    try {
      return await this.readJson<T>(path);
    } catch {
      return null;
    }
  }

  private assertServerAuth(manifest: { writtenBy: string }): void {
    if (manifest.writtenBy !== this.serverId) {
      throw new Error(`Unauthorized manifest writer: ${manifest.writtenBy}`);
    }
  }

  private async validateManifestHash(manifest: { contentHash: string; [key: string]: unknown }): Promise<void> {
    const { contentHash, ...payload } = manifest;
    const expected = await computeContentHash(payload);
    if (contentHash !== expected) {
      throw new Error('Manifest content hash mismatch');
    }
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    const adapter = this.requireAdapter(`write ${path}`);
    await adapter.writeFile(path, textEncoder.encode(JSON.stringify(value, null, 2)));
  }

  private async createBootstrapManifest(): Promise<void> {
    const p = paths(this.config.remotePath);
    const now = new Date().toISOString();

    const payload = {
      generation: 1,
      parentGeneration: 0,
      writtenBy: this.serverId,
      writtenAt: now,
      version: 3,
      meshId: generateId('mesh'),
      schema: this.schema?.version ?? 1,
      encrypted: this.encrypted,
      server: {
        managed: this.config.serverManaged,
        relayUrl: null,
        serverId: this.serverId,
      },
      createdAt: now,
      epoch: 0,
      watermarkHlc: '',
      snapshotPath: null,
      deltaPath: null,
    };

    const manifest: Manifest = {
      ...payload,
      contentHash: await computeContentHash(payload),
    };

    const manifestFile = `manifest-${manifest.generation}.json`;

    await this.writeJson(p.manifestFile(manifest.generation), manifest);
    await this.writeJson(p.manifestPointer, {
      currentGeneration: manifest.generation,
      file: manifestFile,
    } satisfies ManifestPointer);
  }

  private async loadOrCreateManifest(): Promise<void> {
    const p = paths(this.config.remotePath);

    const globalPointer = await this.readJsonIfExists<ManifestPointer>(p.manifestPointer);
    if (!globalPointer) {
      await this.createBootstrapManifest();
    }

    const pointer = await this.readJson<ManifestPointer>(p.manifestPointer);
    const manifestPath = `${this.config.remotePath}/${pointer.file}`;
    const manifest = await this.readJson<Manifest>(manifestPath);
    await this.validateManifestHash(manifest as unknown as { contentHash: string; [key: string]: unknown });
    try {
      await this.assertExpectedMeshId(manifest.meshId);
    } catch (err) {
      throw await this.poisonRemote(err, manifestPath);
    }

    if (manifest.version !== 3) {
      throw new Error(`Unsupported manifest version ${manifest.version} (expected 3).`);
    }
    if (this.schema && manifest.schema !== this.schema.version) {
      this.emit({ type: 'schema:mismatch', local: this.schema.version, remote: manifest.schema });
      throw new Error(`Schema version mismatch: local=${this.schema.version}, remote=${manifest.schema}`);
    }
    if (manifest.server.managed) {
      this.assertServerAuth(manifest);
    }

    this.manifest = manifest;
    this.encrypted = manifest.encrypted || this.encrypted;
  }

  private async upsertDeviceMetadata(): Promise<void> {
    const p = paths(this.config.remotePath);
    const now = new Date().toISOString();
    const existing = await this.readJsonIfExists<DeviceMetadata>(p.deviceFile(this.deviceId));
    const next: DeviceMetadata = {
      deviceId: this.deviceId,
      registeredAt: existing?.registeredAt ?? now,
      lastSeenAt: now,
      userId: existing?.userId,
      name: existing?.name,
      retired: existing?.retired,
    };
    await this.writeJson(p.deviceFile(this.deviceId), next);
  }

  // ── Local writes ───────────────────────────────────────────────────

  /**
   * Insert or update a row.
   *
   * Writes are applied to local IndexedDB immediately and then queued for
   * asynchronous sync. This method never requires network access.
   *
   * @example
   * ```ts
   * await engine.put('tasks', 'task_1', {
   *   title: 'Ship docs polish',
   *   status: 'open',
   * });
   * ```
   */
  async put(
    table: string,
    rowId: string,
    columns: Record<string, unknown>,
    userId?: string
  ): Promise<Row> {
    this.hlc = hlcNow(this.hlc);
    const hlcStr = hlcSerialize(this.hlc);

    const columnEntries: Record<string, ColumnEntry> = {};
    for (const [key, value] of Object.entries(columns)) {
      columnEntries[key] = { value: value as any, hlc: hlcStr };
    }

    const op: UpsertOp = {
      type: 'upsert',
      table,
      rowId,
      columns: columnEntries,
    };

    // Ensure current row state is in the CRDT cache before merging
    await this.ensureRowsCached([op]);

    // Apply to in-memory CRDT cache
    const row = applyOp(this.tables, op, this.manifest?.schema ?? 1)!;
    this.knownTables.add(table);

    // Persist locally
    await this.local.putRow(row);
    await this.local.setMeta('hlc', hlcSerialize(this.hlc));

    // Queue for sync
    const entry: ChangeEntry = {
      id: generateId('chg'),
      ts: Date.now(),
      device: this.deviceId,
      user: userId,
      hlc: hlcStr,
      ops: [op],
    };
    await this.local.pushOutbox(entry);

    this.emit({ type: 'change', table, rowId, row });
    this.scheduleFlush();

    return row;
  }

  /**
   * Tombstone a row locally and queue that deletion for sync.
   *
   * Deletions are CRDT operations, so they can be merged safely across
   * devices without coordination.
   */
  async delete(table: string, rowId: string, userId?: string): Promise<void> {
    this.hlc = hlcNow(this.hlc);
    const hlcStr = hlcSerialize(this.hlc);

    const op: Op = { type: 'delete', table, rowId, hlc: hlcStr };
    await this.ensureRowsCached([op]);
    applyOp(this.tables, op, this.manifest?.schema ?? 1);

    const row = this.tables[table]?.[rowId];
    if (row) await this.local.putRow(row);
    await this.local.setMeta('hlc', hlcSerialize(this.hlc));

    const entry: ChangeEntry = {
      id: generateId('chg'),
      ts: Date.now(),
      device: this.deviceId,
      user: userId,
      hlc: hlcStr,
      ops: [op],
    };
    await this.local.pushOutbox(entry);

    this.emit({ type: 'delete', table, rowId });
    this.scheduleFlush();
  }

  // ── Read ───────────────────────────────────────────────────────────

  /**
   * Read a single live row from local IndexedDB.
   *
   * Returns `undefined` when the row does not exist or has been deleted.
   */
  async get(table: string, rowId: string): Promise<Row | undefined> {
    const row = await this.local.getRow(table, rowId);
    if (!row || row._deleted) return undefined;
    return row;
  }

  /**
   * Read all live rows in a table from local IndexedDB.
   */
  async query(table: string): Promise<Row[]> {
    return this.local.getTable(table);
  }

  /**
   * Query local rows using an indexed where-clause when available.
   *
   * If no matching secondary index exists, the query falls back to a
   * full-table scan.
   */
  async queryWhere(table: string, clause: WhereClause): Promise<Row[]> {
    return this.local.queryWhere(table, clause);
  }

  /** Get all known table names. No network required. */
  async tableNames(): Promise<string[]> {
    return Array.from(this.knownTables);
  }

  /**
   * Get a type-safe handle for a named collection.
   *
   * When the engine itself is typed with a schema, the table value type is
   * inferred automatically.
   *
   * @example
   * ```ts
   * const tasks = engine.table('tasks');
   * await tasks.put('task_1', { title: 'hello' });
   * ```
   */
  table<K extends keyof S & string>(name: K): Table<S[K]>;
  table<T extends Record<string, unknown>>(name: string): Table<T>;
  table(name: string): Table<Record<string, unknown>> {
    return new Table(this, name);
  }

  // ── Flush (local → cloud) ──────────────────────────────────────────

  private scheduleFlush(): void {
    this.pendingCount++;

    if (this.pendingCount >= this.config.flushThreshold) {
      this.flush().catch(err => this.emit({ type: 'flush:error', error: err }));
      return;
    }

    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flush().catch(err => this.emit({ type: 'flush:error', error: err }));
    }, this.config.flushDebounce);
  }

  /**
   * Immediately push the queued local outbox to the active remote backend.
   *
   * If no remote adapter is configured, this becomes a no-op and local changes
   * remain queued until a backend is attached.
   */
  async flush(): Promise<void> {
    if (!this.adapter) {
      this.clearScheduledFlush();
      return;
    }

    const entries = await this.local.drainOutbox();
    if (entries.length === 0) return;

    log('debug', 'flush() — start', { entryCount: entries.length });
    this.emit({ type: 'flush:start', entryCount: entries.length });
    this.pendingCount = 0;
    this.clearScheduledFlush();

    try {
      await this.loadOrCreateManifest();
      await this.flushToAdapter(this.adapter, this.config.remotePath, entries, true);

      // Best-effort replication — failures don't fail the primary flush.
      for (const replica of this.config.replicas) {
        try {
          const replicaRoot = replica.remotePath ?? this.config.remotePath;
          if (!replica.adapter.isAuthenticated()) {
            await replica.adapter.authenticate();
          }
          await this.flushToAdapter(replica.adapter, replicaRoot, entries, false);
        } catch (err) {
          log('warn', 'flush() — replica write failed', { adapter: replica.adapter.name }, err);
          this.emit({ type: 'replica:error', adapter: replica.adapter.name, error: err as Error });
        }
      }

      log('debug', 'flush() — complete', { entryCount: entries.length });
      this.emit({ type: 'flush:complete' });
    } catch (err) {
      log('error', 'flush() — failed, re-queuing entries', err);
      for (const entry of entries) {
        await this.local.pushOutbox(entry);
      }
      throw err;
    }
  }

  /**
   * Write a batch of change entries to a single adapter.
   * Shared by primary flush and replica flush.
   */
  private async flushToAdapter(
    adapter: StorageAdapter,
    remotePath: string,
    entries: ChangeEntry[],
    isPrimary: boolean,
  ): Promise<void> {
    const p = paths(remotePath);
    await adapter.ensureFolder(p.changesFolder);

    let lastWrittenHlc = '';

    for (const entry of entries) {
      const fileName = `${entry.hlc}-${entry.id}.json`;
      const payload = await this.encodeChangePayload(entry);
      await adapter.writeFile(p.changeFile(fileName), textEncoder.encode(payload));

      if (!lastWrittenHlc || hlcCompareStr(entry.hlc, lastWrittenHlc) > 0) {
        lastWrittenHlc = entry.hlc;
      }
    }

    // Update global head — monotonic HLC hint for fast poll skipping.
    const readHeadIfExists = async (): Promise<ChangesHead | null> => {
      try {
        const data = await adapter.readFile(p.changesHead);
        return JSON.parse(textDecoder.decode(data)) as ChangesHead;
      } catch {
        return null;
      }
    };

    const priorHead = await readHeadIfExists();
    const bestHlc = (priorHead?.latestHlc && hlcCompareStr(priorHead.latestHlc, lastWrittenHlc) > 0)
      ? priorHead.latestHlc
      : lastWrittenHlc;
    await adapter.writeFile(
      p.changesHead,
      textEncoder.encode(JSON.stringify({ latestHlc: bestHlc } satisfies ChangesHead, null, 2)),
    );

    if (isPrimary) {
      await this.upsertDeviceMetadata();
    }
  }

  // ── Pull (cloud → local) ──────────────────────────────────────────

  /**
   * Pull remote changes into local IndexedDB immediately.
   *
   * This is useful for manual sync controls, tests, or when you want to force
   * convergence before reading local state.
   */
  async pull(): Promise<void> {
    const adapter = this.requireAdapter('pull()');

    log('debug', 'pull() — start');
    this.emit({ type: 'sync:start' });

    try {
      await this.loadOrCreateManifest();
      const p = paths(this.config.remotePath);

      // Single global cursor.
      const cursorRaw = await this.local.getMeta('cursor');
      const cursor = typeof cursorRaw === 'string' ? cursorRaw : '';

      // Fast path: if global head hasn't advanced past cursor, skip listing.
      const head = await this.readJsonIfExists<ChangesHead>(p.changesHead);
      if (head?.latestHlc && cursor && hlcCompareStr(head.latestHlc, cursor) <= 0) {
        log('debug', 'pull() — head unchanged, skipping');
        this.emit({ type: 'sync:complete', entriesMerged: 0 });
        return;
      }

      // List the flat changes folder once.
      let files;
      try {
        files = await adapter.listFiles(p.changesFolder);
      } catch {
        log('debug', 'pull() — changes folder not found, nothing to merge');
        this.emit({ type: 'sync:complete', entriesMerged: 0 });
        return;
      }
      // Sort by filename (HLC prefix makes this chronological).
      files.sort((a, b) => a.name.localeCompare(b.name));

      let totalMerged = 0;
      let latestMergedHlc = cursor;

      for (const file of files) {
        if (file.name === 'head.json') continue;

        try {
          const chgIdx = file.name.lastIndexOf('-chg_');
          if (chgIdx === -1) continue;
          const fileHlc = file.name.slice(0, chgIdx);
          if (cursor && hlcCompareStr(fileHlc, cursor) <= 0) continue;

          const raw = textDecoder.decode(await adapter.readFile(file.path));
          const entry = await this.decodeChangePayload(raw, file.path);
          if (cursor && hlcCompareStr(entry.hlc, cursor) <= 0) continue;

          const remoteHlc = hlcParse(entry.hlc);
          this.hlc = hlcReceive(this.hlc, remoteHlc);

          await this.ensureRowsCached(entry.ops);
          const affected = applyChangeEntry(this.tables, entry, this.manifest?.schema ?? 1);
          if (affected.length > 0) {
            await this.local.putRows(affected);
            totalMerged += affected.length;
            for (const row of affected) {
              this.knownTables.add(row._table);
              if (row._deleted) {
                this.emit({ type: 'delete', table: row._table, rowId: row._rowId });
              } else {
                this.emit({ type: 'change', table: row._table, rowId: row._rowId, row });
              }
            }
          }

          if (!latestMergedHlc || hlcCompareStr(entry.hlc, latestMergedHlc) > 0) {
            latestMergedHlc = entry.hlc;
          }
        } catch (err) {
          throw await this.poisonRemote(err, file.path);
        }
      }

      if (latestMergedHlc && latestMergedHlc !== cursor) {
        await this.local.setMeta('cursor', latestMergedHlc);
      }

      await this.local.setMeta('hlc', hlcSerialize(this.hlc));
      log('debug', 'pull() — complete', { totalMerged });
      this.emit({ type: 'sync:complete', entriesMerged: totalMerged });
    } catch (err) {
      log('error', 'pull() — failed', err);
      this.emit({ type: 'sync:error', error: err as Error });
      throw err;
    }
  }

  // ── Rehydrate (from snapshot) ──────────────────────────────────────

  /**
   * Rebuild local IndexedDB from the current remote snapshot, then pull newer
   * change files on top.
   */
  async rehydrate(): Promise<void> {
    const adapter = this.requireAdapter('rehydrate()');

    this.emit({ type: 'rehydrate:start' });

    const snapshotPath = this.manifest?.snapshotPath;
    if (!snapshotPath) {
      this.emit({ type: 'rehydrate:complete', rowCount: 0 });
      await this.pull();
      return;
    }

    try {
      const data = await adapter.readFile(snapshotPath);
      const snapshot = await this.decodeSnapshotPayload(textDecoder.decode(data), snapshotPath);

      // Clear local state
      await this.local.clearAll();
      this.tables = {};
      this.knownTables = new Set();

      // Write snapshot rows to IDB (CRDT cache stays empty — reads go to IDB)
      let rowCount = 0;
      for (const [tableName, rows] of Object.entries(snapshot.tables)) {
        this.knownTables.add(tableName);
        for (const row of Object.values(rows)) {
          await this.local.putRow(row);
          rowCount++;
        }
      }

      // Restore HLC
      if (snapshot.hlc) {
        this.hlc = hlcParse(snapshot.hlc);
        this.hlc.nodeId = this.deviceId;
      }

      await this.local.setMeta('epoch', snapshot.epoch);
      this.emit({ type: 'rehydrate:complete', rowCount });
    } catch (err) {
      const poisoned = await this.poisonRemote(err, snapshotPath);
      this.emit({ type: 'sync:error', error: poisoned });
      throw poisoned;
    }

    // Pull any changes since the snapshot
    await this.pull();
  }

  // ── Compaction / Migration ─────────────────────────────────────────

  /**
   * Compaction publishes a new snapshot and manifest generation.
   * In server-managed mode, only the configured server writer may compact.
   */
  async compact(): Promise<void> {
    const adapter = this.requireAdapter('compact()');

    if (!this.manifest) {
      throw new Error('Engine is not connected');
    }
    if (this.manifest.server.managed && this.deviceId !== this.serverId) {
      throw new Error('Compaction is allowed only for the authorized server writer');
    }

    // Ensure the compactor has merged latest remote changes before snapshotting.
    await this.pull();

    const p = paths(this.config.remotePath);
    const now = new Date().toISOString();
    const nextEpoch = this.manifest.epoch + 1;
    const nextGeneration = this.manifest.generation + 1;
    const snapshotPath = `${p.mainlineFolder}/snapshot-${nextEpoch}-${this.serverId}.json`;

    // Build a full snapshot from IDB — the in-memory cache is partial.
    const allRows = await this.local.getAllRows();
    const snapshotTables: Record<string, Record<string, Row>> = {};
    for (const row of allRows) {
      if (!snapshotTables[row._table]) snapshotTables[row._table] = {};
      snapshotTables[row._table][row._rowId] = row;
    }

    const snapshot: Snapshot = {
      snapshotId: generateId('snap'),
      timestamp: now,
      hlc: hlcSerialize(this.hlc),
      epoch: nextEpoch,
      schemaVersion: this.manifest.schema,
      tables: snapshotTables,
    };

    const snapshotPayload = await this.encodeSnapshotPayload(snapshot);
    await adapter.writeFile(snapshotPath, textEncoder.encode(snapshotPayload));

    const manifestPayload = {
      generation: nextGeneration,
      parentGeneration: this.manifest.generation,
      writtenBy: this.serverId,
      writtenAt: now,
      version: 3,
      meshId: this.manifest.meshId,
      schema: this.manifest.schema,
      encrypted: this.manifest.encrypted,
      server: this.manifest.server,
      createdAt: this.manifest.createdAt,
      epoch: nextEpoch,
      watermarkHlc: hlcSerialize(this.hlc),
      snapshotPath,
      deltaPath: null,
    };

    const nextManifest: Manifest = {
      ...manifestPayload,
      contentHash: await computeContentHash(manifestPayload),
    };

    const manifestFile = `manifest-${nextGeneration}.json`;
    await this.writeJson(p.manifestFile(nextGeneration), nextManifest);
    await this.writeJson(p.manifestPointer, {
      currentGeneration: nextGeneration,
      file: manifestFile,
    } satisfies ManifestPointer);

    this.manifest = nextManifest;
    await this.local.setMeta('epoch', nextEpoch);

    // Prune all change files captured in the snapshot.
    const watermarkHlc = nextManifest.watermarkHlc;
    log('debug', 'compact() — pruning change files ≤ watermark', { watermarkHlc });
    try {
      const files = await adapter.listFiles(p.changesFolder);
      for (const file of files) {
        if (file.name === 'head.json') continue;
        const chgIdx = file.name.lastIndexOf('-chg_');
        if (chgIdx === -1) continue;
        const fileHlc = file.name.slice(0, chgIdx);
        if (hlcCompareStr(fileHlc, watermarkHlc) <= 0) {
          await adapter.deleteFile(file.path);
        }
      }
      log('debug', 'compact() — pruning complete');
    } catch (err) {
      log('warn', 'compact() — pruning failed (non-fatal, snapshot is still valid)', err);
    }
  }

  // ── Mesh management ───────────────────────────────────────────

  /**
   * Return the currently loaded manifest, if the engine has connected to a remote mesh.
   */
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
   * Re-encryption is handled during compaction.
   */
  async enableEncryption(key: CryptoKey): Promise<void> {
    this.encryptionKey = key;
    this.encrypted = true;
  }
}
