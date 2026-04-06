/**
 * Sync Engine
 *
 * Orchestrates:
 *  - Local writes → outbox → flush to cloud
 *  - Cloud poll → download → decrypt → CRDT merge → local DB
 *  - Rehydration from manifest-authoritative snapshot
 */

import type {
  StorageAdapter,
  SyncConfig,
  ChangeEntry,
  Manifest,
  ManifestPointer,
  ChannelManifest,
  Snapshot,
  Row,
  Op,
  UpsertOp,
  ColumnEntry,
  DeviceHead,
  DeviceMetadata,
  SyncEvent,
  SyncEventListener,
} from '../core/types.ts';

import { hlcInit, hlcNow, hlcSerialize, hlcParse, hlcReceive, hlcCompareStr } from '../core/hlc.ts';
import { applyOp, applyChangeEntry } from '../core/crdt.ts';
import { LocalStore } from '../storage/local-store.ts';
import {
  encryptEntry,
  decryptEntry,
} from '../crypto/encryption.ts';

import type { HLC } from '../core/types.ts';

interface CloudPaths {
  manifestPointer: string;
  manifestFile: (generation: number) => string;
  devicesFolder: string;
  deviceFile: (deviceId: string) => string;
  channelRoot: string;
  channelPointer: string;
  channelManifestFile: (generation: number, writerId: string) => string;
  mainlineFolder: string;
  clientsFolder: string;
  clientRoot: (deviceId: string) => string;
  clientHead: (deviceId: string) => string;
  clientDateFolder: (deviceId: string, date: string) => string;
  clientChangeFile: (deviceId: string, date: string, fileName: string) => string;
}

function paths(root: string, channelId: string): CloudPaths {
  const channelRoot = `${root}/${channelId}`;
  return {
    manifestPointer: `${root}/manifest.json`,
    manifestFile: (generation: number) => `${root}/manifest-${generation}.json`,
    devicesFolder: `${root}/devices`,
    deviceFile: (deviceId: string) => `${root}/devices/${deviceId}.json`,
    channelRoot,
    channelPointer: `${channelRoot}/channel.json`,
    channelManifestFile: (generation: number, writerId: string) =>
      `${channelRoot}/channel-manifest-${generation}-${writerId}.json`,
    mainlineFolder: `${channelRoot}/mainline`,
    clientsFolder: `${channelRoot}/clients`,
    clientRoot: (deviceId: string) => `${channelRoot}/clients/${deviceId}`,
    clientHead: (deviceId: string) => `${channelRoot}/clients/${deviceId}/head.json`,
    clientDateFolder: (deviceId: string, date: string) => `${channelRoot}/clients/${deviceId}/${date}`,
    clientChangeFile: (deviceId: string, date: string, fileName: string) =>
      `${channelRoot}/clients/${deviceId}/${date}/${fileName}`,
  };
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

function isoDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function hexFromBytes(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function computeContentHash(payload: unknown): Promise<string> {
  const json = JSON.stringify(payload);
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(json));
  return `sha256:${hexFromBytes(new Uint8Array(digest))}`;
}

function makeCursorKey(channelId: string, deviceId: string): string {
  return `cursor:${channelId}:${deviceId}`;
}

// ─── Sync Engine ─────────────────────────────────────────────────────

export class SyncEngine {
  private adapter: StorageAdapter;
  private config: Required<SyncConfig>;
  private channelId: string;
  private serverId: string;
  private local: LocalStore;
  private deviceId: string;
  private hlc: HLC;
  private encryptionKey: CryptoKey | null = null;
  private encrypted = false;

  // In-memory state (mirror of local DB for fast access)
  private tables: Record<string, Record<string, Row>> = {};
  private manifest: Manifest | null = null;
  private channelManifest: ChannelManifest | null = null;

  // Flush management
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingCount = 0;

  // Poll management
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  // Event listeners
  private listeners: Set<SyncEventListener> = new Set();

  constructor(adapter: StorageAdapter, config: SyncConfig) {
    this.adapter = adapter;
    this.config = {
      rootPath: config.rootPath,
      channelId: config.channelId ?? 'c1',
      serverManaged: config.serverManaged ?? false,
      serverId: config.serverId ?? 'server_relay_1',
      pollInterval: config.pollInterval ?? 30_000,
      flushDebounce: config.flushDebounce ?? 2_000,
      flushThreshold: config.flushThreshold ?? 50,
    };
    this.channelId = this.config.channelId;
    this.serverId = this.config.serverId;
    this.local = new LocalStore();
    this.deviceId = getDeviceId();
    this.hlc = hlcInit(this.deviceId);
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

  setEncryptionKey(key: CryptoKey): void {
    this.encryptionKey = key;
    this.encrypted = true;
  }

  private async encodeForCloud(plaintext: string): Promise<string> {
    if (!this.encrypted || !this.encryptionKey) return plaintext;
    return encryptEntry(this.encryptionKey, plaintext);
  }

  private async decodeFromCloud(data: string): Promise<string | null> {
    if (!this.encrypted || !this.encryptionKey) return data;
    try {
      return await decryptEntry(this.encryptionKey, data);
    } catch {
      return null;
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  /**
   * Initialize: open local DB, load state into memory,
   * authenticate with cloud, then sync.
   */
  async init(): Promise<void> {
    await this.local.open();

    // Load local state into memory
    const rows = await this.local.getAllRows();
    for (const row of rows) {
      if (!this.tables[row._table]) this.tables[row._table] = {};
      this.tables[row._table][row._rowId] = row;
    }

    // Restore HLC
    const savedHlc = await this.local.getMeta('hlc') as string | undefined;
    if (savedHlc) {
      this.hlc = hlcParse(savedHlc);
      this.hlc.nodeId = this.deviceId; // ensure nodeId is current device
    }
  }

  /**
   * Connect to cloud and start background sync.
   * Call after init() and after setting encryption key if needed.
   */
  async connect(): Promise<void> {
    if (!this.adapter.isAuthenticated()) {
      this.emit({ type: 'auth:required' });
      await this.adapter.authenticate();
      this.emit({ type: 'auth:complete' });
    }

    const p = paths(this.config.rootPath, this.channelId);
    await this.adapter.ensureFolder(this.config.rootPath);
    await this.adapter.ensureFolder(p.devicesFolder);
    await this.adapter.ensureFolder(p.channelRoot);
    await this.adapter.ensureFolder(p.mainlineFolder);
    await this.adapter.ensureFolder(p.clientsFolder);
    await this.adapter.ensureFolder(p.clientRoot(this.deviceId));

    // Read or create manifests
    await this.loadOrCreateManifests();
    await this.upsertDeviceMetadata();

    // If remote epoch advanced (usually after compaction), local cache
    // may be stale and must be rebuilt from snapshot first.
    const localEpochRaw = await this.local.getMeta(`epoch:${this.channelId}`);
    const localEpoch = typeof localEpochRaw === 'number' ? localEpochRaw : 0;
    const remoteEpoch = this.channelManifest?.epoch ?? 0;

    if (localEpoch < remoteEpoch) {
      await this.rehydrate();
    } else {
      // Initial sync
      await this.pull();
    }
    await this.flush();

    // Start polling
    this.pollTimer = setInterval(() => {
      this.pull().catch(err => this.emit({ type: 'sync:error', error: err }));
    }, this.config.pollInterval);

    // Flush on page unload
    if (typeof window !== 'undefined') {
      window.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          this.flush().catch(() => {});
        }
      });
    }
  }

  /** Stop polling, flush remaining changes. */
  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
    this.local.close();
  }

  // ── Manifest ───────────────────────────────────────────────────────

  private async readJson<T>(path: string): Promise<T> {
    const data = await this.adapter.readFile(path);
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
    await this.adapter.writeFile(path, textEncoder.encode(JSON.stringify(value, null, 2)));
  }

  private async createBootstrapManifests(): Promise<void> {
    const p = paths(this.config.rootPath, this.channelId);
    const now = new Date().toISOString();

    const globalPayload = {
      generation: 1,
      parentGeneration: 0,
      writtenBy: this.serverId,
      writtenAt: now,
      version: 2,
      meshId: generateId('mesh'),
      schema: 1,
      lensVersion: 1,
      encrypted: this.encrypted,
      channels: [this.channelId],
      channelNames: { [this.channelId]: 'default' },
      defaultChannel: this.channelId,
      server: {
        managed: this.config.serverManaged,
        relayUrl: null,
        serverId: this.serverId,
      },
      createdAt: now,
    };

    const globalManifest: Manifest = {
      ...globalPayload,
      contentHash: await computeContentHash(globalPayload),
    };

    const channelPayload = {
      generation: 1,
      parentGeneration: 0,
      writtenBy: this.serverId,
      writtenAt: now,
      channelId: this.channelId,
      epoch: 0,
      watermarkHlc: '',
      snapshotPath: null,
      deltaPath: null,
    };

    const channelManifest: ChannelManifest = {
      ...channelPayload,
      contentHash: await computeContentHash(channelPayload),
    };

    const globalFile = `manifest-${globalManifest.generation}.json`;
    const channelFile = `channel-manifest-${channelManifest.generation}-${this.serverId}.json`;

    await this.writeJson(p.manifestFile(globalManifest.generation), globalManifest);
    await this.writeJson(p.channelManifestFile(channelManifest.generation, this.serverId), channelManifest);
    await this.writeJson(p.manifestPointer, {
      currentGeneration: globalManifest.generation,
      file: globalFile,
    } satisfies ManifestPointer);
    await this.writeJson(p.channelPointer, {
      currentGeneration: channelManifest.generation,
      file: channelFile,
    } satisfies ManifestPointer);
  }

  private async loadOrCreateManifests(): Promise<void> {
    const p = paths(this.config.rootPath, this.channelId);

    const globalPointer = await this.readJsonIfExists<ManifestPointer>(p.manifestPointer);
    if (!globalPointer) {
      await this.createBootstrapManifests();
    }

    const pointer = await this.readJson<ManifestPointer>(p.manifestPointer);
    const globalManifest = await this.readJson<Manifest>(`${this.config.rootPath}/${pointer.file}`);
    await this.validateManifestHash(globalManifest as unknown as { contentHash: string; [key: string]: unknown });

    if (globalManifest.version !== 2) {
      throw new Error('Unsupported manifest version for this beta.');
    }
    if (globalManifest.server.managed) {
      this.assertServerAuth(globalManifest);
    }

    const channelPointer = await this.readJson<ManifestPointer>(p.channelPointer);
    const channelManifest = await this.readJson<ChannelManifest>(`${p.channelRoot}/${channelPointer.file}`);
    await this.validateManifestHash(channelManifest as unknown as { contentHash: string; [key: string]: unknown });
    if (globalManifest.server.managed) {
      this.assertServerAuth(channelManifest);
    }

    this.manifest = globalManifest;
    this.channelManifest = channelManifest;
    this.encrypted = globalManifest.encrypted || this.encrypted;
  }

  private async upsertDeviceMetadata(): Promise<void> {
    const p = paths(this.config.rootPath, this.channelId);
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
   * Write a row. This is the main API for mutations.
   * Applies locally immediately, queues for sync.
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

    // Apply to in-memory state
    const row = applyOp(this.tables, op, this.manifest?.schema ?? 1)!;

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

  /** Soft-delete a row. */
  async delete(table: string, rowId: string, userId?: string): Promise<void> {
    this.hlc = hlcNow(this.hlc);
    const hlcStr = hlcSerialize(this.hlc);

    const op: Op = { type: 'delete', table, rowId, hlc: hlcStr };
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

  /** Get a single row (from memory). */
  get(table: string, rowId: string): Row | undefined {
    const row = this.tables[table]?.[rowId];
    if (row?._deleted) return undefined;
    return row;
  }

  /** Get all rows in a table (from memory). */
  query(table: string): Row[] {
    const t = this.tables[table];
    if (!t) return [];
    return Object.values(t).filter(r => !r._deleted);
  }

  /** Get all table names. */
  tableNames(): string[] {
    return Object.keys(this.tables);
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
    const entries = await this.local.drainOutbox();
    if (entries.length === 0) return;

    this.emit({ type: 'flush:start', entryCount: entries.length });
    this.pendingCount = 0;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    try {
      const p = paths(this.config.rootPath, this.channelId);
      await this.adapter.ensureFolder(p.clientRoot(this.deviceId));

      let lastWrittenHlc = '';
      let lastWrittenDate = '';

      for (const entry of entries) {
        const date = isoDay(entry.ts);
        const fileName = `${entry.hlc}-${entry.id}.json`;
        const dateFolder = p.clientDateFolder(this.deviceId, date);
        await this.adapter.ensureFolder(dateFolder);

        const raw = JSON.stringify(entry);
        const payload = await this.encodeForCloud(raw);
        await this.adapter.writeFile(
          p.clientChangeFile(this.deviceId, date, fileName),
          textEncoder.encode(payload)
        );

        if (!lastWrittenHlc || hlcCompareStr(entry.hlc, lastWrittenHlc) > 0) {
          lastWrittenHlc = entry.hlc;
          lastWrittenDate = date;
        }
      }

      const priorHead = await this.readJsonIfExists<DeviceHead>(p.clientHead(this.deviceId));
      const nextHead: DeviceHead = {
        device: this.deviceId,
        latestHlc: lastWrittenHlc || priorHead?.latestHlc || '',
        latestDate: lastWrittenDate || priorHead?.latestDate || isoDay(Date.now()),
        fileCount: (priorHead?.fileCount ?? 0) + entries.length,
      };
      await this.writeJson(p.clientHead(this.deviceId), nextHead);
      await this.upsertDeviceMetadata();

      this.emit({ type: 'flush:complete' });
    } catch (err) {
      // Put entries back in outbox for retry
      for (const entry of entries) {
        await this.local.pushOutbox(entry);
      }
      throw err;
    }
  }

  // ── Pull (cloud → local) ──────────────────────────────────────────

  async pull(): Promise<void> {
    this.emit({ type: 'sync:start' });

    try {
      await this.loadOrCreateManifests();
      const p = paths(this.config.rootPath, this.channelId);
      const deviceFiles = await this.adapter.listFiles(p.devicesFolder);
      let totalMerged = 0;

      for (const deviceFile of deviceFiles) {
        if (!deviceFile.name.endsWith('.json')) continue;
        const remoteDeviceId = deviceFile.name.slice(0, -5);

        const cursorKey = makeCursorKey(this.channelId, remoteDeviceId);
        const cursorRaw = await this.local.getMeta(cursorKey);
        const cursor = typeof cursorRaw === 'string' ? cursorRaw : '';

        const head = await this.readJsonIfExists<DeviceHead>(p.clientHead(remoteDeviceId));
        if (!head?.latestHlc) continue;
        if (cursor && hlcCompareStr(head.latestHlc, cursor) <= 0) continue;

        // Discover all date-sharded folders under this device's client dir,
        // then scan from the cursor date forward (inclusive) to cover multi-day gaps.
        const cursorDate = cursor ? isoDay(hlcParse(cursor).ts) : '';
        const dateFolders = await this.adapter.listFolders(p.clientRoot(remoteDeviceId));
        const relevantDates = dateFolders
          .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
          .filter(d => !cursorDate || d >= cursorDate)
          .sort();

        let latestMergedHlc = cursor;

        for (const date of relevantDates) {
          let files;
          try {
            files = await this.adapter.listFiles(p.clientDateFolder(remoteDeviceId, date));
          } catch {
            continue; // Folder may not exist yet (eventual consistency).
          }
          files.sort((a, b) => a.name.localeCompare(b.name));

          for (const file of files) {
            try {
              const raw = textDecoder.decode(await this.adapter.readFile(file.path));
              const decoded = await this.decodeFromCloud(raw);
              if (!decoded) continue;
              const entry = JSON.parse(decoded) as ChangeEntry;
              if (cursor && hlcCompareStr(entry.hlc, cursor) <= 0) continue;

              const remoteHlc = hlcParse(entry.hlc);
              this.hlc = hlcReceive(this.hlc, remoteHlc);

              const affected = applyChangeEntry(this.tables, entry, this.manifest?.schema ?? 1);
              if (affected.length > 0) {
                await this.local.putRows(affected);
                totalMerged += affected.length;
                for (const row of affected) {
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
            } catch {
              // Skip corrupt or unreadable entry.
            }
          }
        }

        if (latestMergedHlc && latestMergedHlc !== cursor) {
          await this.local.setMeta(cursorKey, latestMergedHlc);
        }
      }

      await this.local.setMeta('hlc', hlcSerialize(this.hlc));
      this.emit({ type: 'sync:complete', entriesMerged: totalMerged });
    } catch (err) {
      this.emit({ type: 'sync:error', error: err as Error });
    }
  }

  // ── Rehydrate (from snapshot) ──────────────────────────────────────

  async rehydrate(): Promise<void> {
    this.emit({ type: 'rehydrate:start' });

    const snapshotPath = this.channelManifest?.snapshotPath;
    if (!snapshotPath) {
      this.emit({ type: 'rehydrate:complete', rowCount: 0 });
      await this.pull();
      return;
    }

    try {
      const data = await this.adapter.readFile(snapshotPath);
      let json: string;

      if (this.encrypted && this.encryptionKey) {
        const content = textDecoder.decode(data);
        const decrypted = await this.decodeFromCloud(content);
        if (!decrypted) throw new Error('Failed to decrypt snapshot');
        json = decrypted;
      } else {
        json = textDecoder.decode(data);
      }

      const snapshot = JSON.parse(json) as Snapshot;

      // Clear local state
      await this.local.clearAll();
      this.tables = {};

      // Load snapshot into memory + local DB
      let rowCount = 0;
      for (const [tableName, rows] of Object.entries(snapshot.tables)) {
        this.tables[tableName] = {};
        for (const [rowId, row] of Object.entries(rows)) {
          this.tables[tableName][rowId] = row;
          await this.local.putRow(row);
          rowCount++;
        }
      }

      // Restore HLC
      if (snapshot.hlc) {
        this.hlc = hlcParse(snapshot.hlc);
        this.hlc.nodeId = this.deviceId;
      }

      await this.local.setMeta(`epoch:${this.channelId}`, snapshot.epoch);
      this.emit({ type: 'rehydrate:complete', rowCount });
    } catch {
      // No snapshot available — start fresh
      this.emit({ type: 'rehydrate:complete', rowCount: 0 });
    }

    // Pull any changes since the snapshot
    await this.pull();
  }

  // ── Compaction / Migration ─────────────────────────────────────────

  /**
   * Compaction publishes a new snapshot and channel manifest generation.
   * In server-managed mode, only the configured server writer may compact.
   */
  async compact(): Promise<void> {
    if (!this.manifest || !this.channelManifest) {
      throw new Error('Engine is not connected');
    }
    if (this.manifest.server.managed && this.deviceId !== this.serverId) {
      throw new Error('Compaction is allowed only for the authorized server writer');
    }

    // Ensure the compactor has merged latest remote changes before snapshotting.
    await this.pull();

    const p = paths(this.config.rootPath, this.channelId);
    const now = new Date().toISOString();
    const nextEpoch = this.channelManifest.epoch + 1;
    const nextGeneration = this.channelManifest.generation + 1;
    const snapshotPath = `${p.mainlineFolder}/snapshot-${nextEpoch}-${this.serverId}.json`;

    const snapshot: Snapshot = {
      snapshotId: generateId('snap'),
      timestamp: now,
      hlc: hlcSerialize(this.hlc),
      epoch: nextEpoch,
      schemaVersion: this.manifest.schema,
      tables: this.tables,
    };

    const snapshotJson = JSON.stringify(snapshot);
    const snapshotPayload = await this.encodeForCloud(snapshotJson);
    await this.adapter.writeFile(snapshotPath, textEncoder.encode(snapshotPayload));

    const channelPayload = {
      generation: nextGeneration,
      parentGeneration: this.channelManifest.generation,
      writtenBy: this.serverId,
      writtenAt: now,
      channelId: this.channelId,
      epoch: nextEpoch,
      watermarkHlc: hlcSerialize(this.hlc),
      snapshotPath,
      deltaPath: null,
    };

    const nextChannelManifest: ChannelManifest = {
      ...channelPayload,
      contentHash: await computeContentHash(channelPayload),
    };

    const channelFile = `channel-manifest-${nextGeneration}-${this.serverId}.json`;
    await this.writeJson(
      p.channelManifestFile(nextGeneration, this.serverId),
      nextChannelManifest
    );
    await this.writeJson(p.channelPointer, {
      currentGeneration: nextGeneration,
      file: channelFile,
    } satisfies ManifestPointer);

    this.channelManifest = nextChannelManifest;
    await this.local.setMeta(`epoch:${this.channelId}`, nextEpoch);
  }

  // ── Mesh management ───────────────────────────────────────────

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
