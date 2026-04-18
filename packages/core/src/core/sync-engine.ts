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
  UpsertOp,
  ColumnEntry,
  SyncEvent,
  SyncEventListener,
  DatabaseSchemaDefinition,
  WhereClause,
  ReplicaConfig,
} from './types.ts';

import type { HLC } from './types.ts';
import { hlcInit, hlcNow, hlcSerialize, hlcParse, hlcCompareStr } from './hlc.ts';
import { applyOp } from './crdt.ts';
import { LocalStore } from '../storage/local-store.ts';
import { Table } from './table.ts';

// Extracted modules
import { paths, log, generateId, getDeviceId, ROW_META_KEYS } from './internals.ts';
import type { CodecState } from './codec.ts';
import { loadOrCreateManifest, upsertDeviceMetadata } from './manifest.ts';
import { generateKey, keyToPassphrase, passphraseToKey } from '../crypto/encryption.ts';
import { createCredentialStore, type CredentialStore } from '../storage/credential-store.ts';
import type { ManifestContext } from './manifest.ts';
import { flushToAdapter } from './flush.ts';
import { pull as doPull } from './pull.ts';
import { compact as doCompact, rehydrate as doRehydrate } from './compaction.ts';

// ─── Config ──────────────────────────────────────────────────────────

type ResolvedSyncConfig<S extends Record<string, Record<string, unknown>>> =
  Omit<Required<SyncConfig<S>>, 'schema' | 'replicas' | 'passphrase' | 'encrypted' | 'deviceId' | 'credentialStore' | 'appName'> & {
    schema?: DatabaseSchemaDefinition<S>;
    replicas: ReplicaConfig[];
  };

// ─── Sync Engine ─────────────────────────────────────────────────────

/**
 * Typed sync engine. `S` is your database shape — inferred automatically
 * from `InferSchemaType<typeof schema>`. No default: either typed or `any`.
 *
 * @example
 * const schema = { version: 1, tables: { tasks: { fields: { title: types.string } } } }
 *   satisfies DatabaseSchemaDefinition;
 *
 * type DB = InferSchemaType<typeof schema>;
 * const engine = new SyncEngine<DB>(adapter, { schema, remotePath: '/App', appName: 'App' });
 *
 * // Or declare a typed getter:
 * const getDb = async (): Promise<SyncEngine<DB>> => { ... }
 *
 * engine.table('tasks'); // Table<{ title: string }>
 * engine.table('other'); // TS error — 'other' is not keyof DB
 */
export class SyncEngine<S extends Record<string, Record<string, unknown>>> {
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

  // Event listeners
  private listeners: Set<SyncEventListener> = new Set();
  private readonly schema?: DatabaseSchemaDefinition<S>;
  private readonly credentialStore: CredentialStore | null;

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
   * const engine = new SyncEngine(adapter, { schema, remotePath: '/App', appName: 'App' });
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
    };
    this.serverId = this.config.serverId;
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
      // Will generate key in init() if no persisted key found
    }
  }

  // ── Internal accessors ─────────────────────────────────────────────

  private requireAdapter(operation: string): StorageAdapter {
    if (this.remotePoisonError) throw this.remotePoisonError;
    if (!this.adapter) {
      throw new Error(`No remote storage adapter configured. Call setRemoteStorage() before ${operation}.`);
    }
    return this.adapter;
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
      remotePath: this.config.remotePath,
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

  /**
   * Set the mesh encryption passphrase.
   * Call before init() or between disconnect() and init().
   */
  setPassphrase(passphrase: string): void {
    this.passphrase = passphrase;
    this.encrypted = true;
    this.encryptionKey = null; // re-derived in init()
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

    // Recover credentials from the silent primary store only.
    // No biometric prompt during normal init.
    await this.restoreCredentials();

    // Resolve encryption: derive key from passphrase, load persisted, or generate.
    await this.resolveEncryption();

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
   * Silent credential restore from the primary store only.
   * Used during normal init(). No biometric prompt.
   */
  private async restoreCredentials(): Promise<void> {
    const stored = await this.loadPersistedCredentials();
    if (!stored) return;

    if (stored.deviceId && stored.deviceId !== this.deviceId) {
      this.deviceId = stored.deviceId;
      this.hlc.nodeId = stored.deviceId;
      try { localStorage.setItem('interocitor-device-id', stored.deviceId); } catch { /* ok */ }
    }

    if (this.encrypted && !this.passphrase && stored.passphrase) {
      this.passphrase = stored.passphrase;
    }
  }

  async connect(): Promise<void> {
    if (!this.initialized) {
      throw new Error('Engine must be initialized via init() before connect()');
    }

    const adapter = this.requireAdapter('connect()');

    log('debug', 'connect() — authenticating with adapter', { adapter: adapter.name });
    if (!adapter.isAuthenticated()) {
      this.emit({ type: 'auth:required' });
      try { await adapter.authenticate(); } catch (err) {
        log('error', 'connect() — authentication failed', err);
        throw err;
      }
      this.emit({ type: 'auth:complete' });
    }

    const p = paths(this.config.remotePath);
    log('debug', 'connect() — ensuring remote folders', { remotePath: this.config.remotePath, deviceId: this.deviceId });
    for (const folder of [this.config.remotePath, p.devicesFolder, p.mainlineFolder, p.changesFolder]) {
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
      await this.doLoadOrCreateManifest();
    } catch (err) {
      log('error', 'connect() — loadOrCreateManifest failed', err);
      throw err;
    }

    await upsertDeviceMetadata(adapter, this.config.remotePath, this.deviceId);

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

    this.startPolling();
    this.connected = true;
    log('info', 'connect() — connected', { remotePath: this.config.remotePath, deviceId: this.deviceId, pollInterval: this.config.pollInterval });

    if (typeof window !== 'undefined') {
      window.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          this.flush().catch(() => {});
        }
      });
    }
  }

  async disconnect(): Promise<void> {
    this.stopPolling();
    this.clearScheduledFlush();
    if (!this.remotePoisonError) await this.flush();
    this.local.close();
    this.connected = false;
    this.initialized = false;
    this.remotePoisonError = null;
  }

  async setRemoteStorage(adapter: StorageAdapter | null): Promise<void> {
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
    const wasConnected = this.connected;
    if (wasConnected) await this.flush();

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
    this.hlc = hlcNow(this.hlc);
    const hlcStr = hlcSerialize(this.hlc);

    const columnEntries: Record<string, ColumnEntry> = {};
    for (const [key, value] of Object.entries(columns)) {
      columnEntries[key] = { value: value as any, hlc: hlcStr };
    }

    const op: UpsertOp = { type: 'upsert', table, rowId, columns: columnEntries };
    await this.ensureRowsCached([op]);
    const row = applyOp(this.tables, op, this.manifest?.schema ?? 1, this.schema)!;
    this.knownTables.add(table);

    await this.local.putRow(row);
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

    this.emit({ type: 'change', table, rowId, row });
    this.scheduleFlush();
    return row as unknown as S[K];
  }

  async delete<K extends keyof S & string>(table: K, rowId: string, userId?: string): Promise<void> {
    this.hlc = hlcNow(this.hlc);
    const hlcStr = hlcSerialize(this.hlc);

    const op: Op = { type: 'delete', table, rowId, hlc: hlcStr };
    await this.ensureRowsCached([op]);
    applyOp(this.tables, op, this.manifest?.schema ?? 1, this.schema);

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

  async get<K extends keyof S & string>(table: K, rowId: string): Promise<S[K] | undefined> {
    const row = await this.local.getRow(table, rowId);
    if (!row || row._deleted) return undefined;
    return row as unknown as S[K];
  }

  async query<K extends keyof S & string>(table: K): Promise<S[K][]> {
    return this.local.getTable(table) as unknown as S[K][];
  }

  async queryWhere<K extends keyof S & string>(table: K, clause: WhereClause): Promise<S[K][]> {
    return this.local.queryWhere(table, clause) as unknown as S[K][];
  }

  async tableNames(): Promise<string[]> {
    return Array.from(this.knownTables);
  }

  table<K extends keyof S & string>(name: K): Table<S[K]> {
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
      await this.doLoadOrCreateManifest();
      await flushToAdapter(this.adapter, this.config.remotePath, entries, true, this.codecState, this.deviceId);

      for (const replica of this.config.replicas) {
        try {
          const replicaRoot = replica.remotePath ?? this.config.remotePath;
          if (!replica.adapter.isAuthenticated()) await replica.adapter.authenticate();
          await flushToAdapter(replica.adapter, replicaRoot, entries, false, this.codecState, this.deviceId);
        } catch (err) {
          log('warn', 'flush() — replica write failed', { adapter: replica.adapter.name }, err);
          this.emit({ type: 'replica:error', adapter: replica.adapter.name, error: err as Error });
        }
      }

      log('debug', 'flush() — complete', { entryCount: entries.length });
      this.emit({ type: 'flush:complete' });
    } catch (err) {
      log('error', 'flush() — failed, re-queuing entries', err);
      for (const entry of entries) await this.local.pushOutbox(entry);
      throw err;
    }
  }

  // ── Pull (cloud → local) ──────────────────────────────────────────

  async pull(): Promise<void> {
    const adapter = this.requireAdapter('pull()');
    this.hlc = await doPull({
      adapter,
      local: this.local,
      remotePath: this.config.remotePath,
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
    const adapter = this.requireAdapter('compact()');
    if (!this.manifest) throw new Error('Engine is not connected');

    this.manifest = await doCompact({
      adapter,
      local: this.local,
      remotePath: this.config.remotePath,
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
