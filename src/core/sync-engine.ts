/**
 * Sync Engine
 *
 * Orchestrates:
 *  - Local writes → outbox → flush to cloud
 *  - Cloud poll → download → decrypt → CRDT merge → local DB
 *  - Compaction (with optional migration transform)
 *  - Rehydration from snapshot
 */

import type {
  StorageAdapter,
  SyncConfig,
  ChangeEntry,
  Manifest,
  Snapshot,
  Row,
  Op,
  UpsertOp,
  ColumnEntry,
  SyncEvent,
  SyncEventListener,
} from '../core/types.ts';

import { hlcInit, hlcNow, hlcSerialize, hlcParse, hlcReceive } from '../core/hlc.ts';
import { applyOp, applyChangeEntry } from '../core/crdt.ts';
import { LocalStore } from '../storage/local-store.ts';
import {
  encryptEntry,
  decryptEntry,
} from '../crypto/encryption.ts';

import type { HLC } from '../core/types.ts';

// ─── Paths ───────────────────────────────────────────────────────────

function paths(root: string) {
  return {
    manifest: `${root}/manifest.json`,
    changes: `${root}/changes`,
    snapshots: `${root}/snapshots`,
    snapshotLatest: `${root}/snapshots/latest.json`,
    changeLog: (deviceId: string) => `${root}/changes/${deviceId}.ndjson`,
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

// ─── Sync Engine ─────────────────────────────────────────────────────

export class SyncEngine {
  private adapter: StorageAdapter;
  private config: Required<SyncConfig>;
  private local: LocalStore;
  private deviceId: string;
  private hlc: HLC;
  private encryptionKey: CryptoKey | null = null;
  private encrypted = false;

  // In-memory state (mirror of local DB for fast access)
  private tables: Record<string, Record<string, Row>> = {};
  private manifest: Manifest | null = null;

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
      pollInterval: config.pollInterval ?? 30_000,
      flushDebounce: config.flushDebounce ?? 2_000,
      flushThreshold: config.flushThreshold ?? 50,
      compactionThreshold: config.compactionThreshold ?? 1_048_576, // 1MB
    };
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

    const p = paths(this.config.rootPath);
    await this.adapter.ensureFolder(p.changes);
    await this.adapter.ensureFolder(p.snapshots);

    // Read or create manifest
    await this.loadOrCreateManifest();

    // Initial sync
    await this.pull();
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

  private async loadOrCreateManifest(): Promise<void> {
    const p = paths(this.config.rootPath);
    try {
      const meta = await this.adapter.getFileMetadata(p.manifest);
      if (meta) {
        const data = await this.adapter.readFile(p.manifest);
        const json = textDecoder.decode(data);
        this.manifest = JSON.parse(json) as Manifest;
        this.encrypted = this.manifest.encrypted;

        // Register this device
        if (!this.manifest.devices[this.deviceId]) {
          this.manifest.devices[this.deviceId] = { deviceId: this.deviceId };
          await this.saveManifest();
        }
        return;
      }
    } catch {
      // manifest doesn't exist, create it
    }

    this.manifest = {
      version: 1,
      meshId: generateId('mesh'),
      schema: 1,
      encrypted: this.encrypted,
      epoch: 0,
      devices: { [this.deviceId]: { deviceId: this.deviceId } },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await this.saveManifest();
  }

  private async saveManifest(): Promise<void> {
    if (!this.manifest) return;
    const p = paths(this.config.rootPath);
    this.manifest.updatedAt = new Date().toISOString();
    const json = JSON.stringify(this.manifest, null, 2);
    await this.adapter.writeFile(p.manifest, textEncoder.encode(json));
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
      const p = paths(this.config.rootPath);
      const logPath = p.changeLog(this.deviceId);

      // Serialize entries as NDJSON lines
      const lines = entries.map(e => JSON.stringify(e));

      // Encrypt if needed
      let payload: string;
      if (this.encrypted && this.encryptionKey) {
        const encryptedLines = await Promise.all(
          lines.map(line => encryptEntry(this.encryptionKey!, line))
        );
        payload = encryptedLines.join('\n') + '\n';
      } else {
        payload = lines.join('\n') + '\n';
      }

      // Read-modify-write (no append API on cloud providers)
      let existing = '';
      try {
        const data = await this.adapter.readFile(logPath);
        existing = textDecoder.decode(data);
      } catch {
        // file doesn't exist yet
      }

      const combined = existing + payload;
      await this.adapter.writeFile(logPath, textEncoder.encode(combined));

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
      const p = paths(this.config.rootPath);
      const files = await this.adapter.listFiles(p.changes);
      let totalMerged = 0;

      for (const file of files) {
        // Extract device ID from filename
        const match = file.name.match(/^(.+)\.ndjson$/);
        if (!match) continue;
        const remoteDeviceId = match[1];

        // Skip own file
        if (remoteDeviceId === this.deviceId) continue;

        const cursor = await this.local.getCursor(remoteDeviceId);

        // Skip if file hasn't grown
        if (file.size <= cursor) continue;

        // Download full file (range reads not universally supported)
        const data = await this.adapter.readFile(file.path);
        const content = textDecoder.decode(data);
        const allLines = content.split('\n').filter(l => l.trim());

        // We track cursor as line count (simpler than byte offset for NDJSON)
        const newLines = allLines.slice(cursor);
        if (newLines.length === 0) continue;

        // Decrypt + parse
        for (const line of newLines) {
          try {
            let json: string;
            if (this.encrypted && this.encryptionKey) {
              const decrypted = await this.decodeFromCloud(line);
              if (!decrypted) continue; // corrupt line
              json = decrypted;
            } else {
              json = line;
            }

            const entry = JSON.parse(json) as ChangeEntry;

            // Advance our HLC from the remote entry
            const remoteHlc = hlcParse(entry.hlc);
            this.hlc = hlcReceive(this.hlc, remoteHlc);

            // CRDT merge
            const affected = applyChangeEntry(
              this.tables,
              entry,
              this.manifest?.schema ?? 1
            );

            // Persist affected rows
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
          } catch {
            // skip corrupt entry
          }
        }

        // Update cursor
        await this.local.setCursor(remoteDeviceId, allLines.length);
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

    const p = paths(this.config.rootPath);

    try {
      const data = await this.adapter.readFile(p.snapshotLatest);
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

      // Restore cursors
      for (const [deviceId, offset] of Object.entries(snapshot.cursors)) {
        await this.local.setCursor(deviceId, offset);
      }

      // Restore HLC
      if (snapshot.hlc) {
        this.hlc = hlcParse(snapshot.hlc);
        this.hlc.nodeId = this.deviceId;
      }

      await this.local.setMeta('epoch', snapshot.epoch);
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
   * Compact: merge all change logs into a snapshot.
   * Optional transform function for schema migrations.
   */
  async compact(
    transform?: (table: string, row: Row) => Row
  ): Promise<void> {
    this.emit({ type: 'compact:start' });

    const p = paths(this.config.rootPath);

    // Build complete state from memory (already merged)
    const snapshotTables: Record<string, Record<string, Row>> = {};
    for (const [tableName, rows] of Object.entries(this.tables)) {
      snapshotTables[tableName] = {};
      for (const [rowId, row] of Object.entries(rows)) {
        // Skip old tombstones (30 day TTL)
        if (row._deleted && row._deletedHlc) {
          const deleteTime = hlcParse(row._deletedHlc).ts;
          if (Date.now() - deleteTime > 30 * 24 * 60 * 60 * 1000) continue;
        }

        // Apply migration transform if provided
        const finalRow = transform ? transform(tableName, { ...row }) : row;
        snapshotTables[tableName][rowId] = finalRow;
      }
    }

    // Gather cursors
    const cursors = await this.local.getAllCursors();

    const newEpoch = (this.manifest?.epoch ?? 0) + 1;
    const newSchema = transform
      ? (this.manifest?.schema ?? 1) + 1
      : (this.manifest?.schema ?? 1);

    const snapshot: Snapshot = {
      snapshotId: generateId('snap'),
      timestamp: new Date().toISOString(),
      hlc: hlcSerialize(this.hlc),
      epoch: newEpoch,
      schemaVersion: newSchema,
      cursors,
      tables: snapshotTables,
    };

    // Write snapshot
    const json = JSON.stringify(snapshot);
    let payload: string;
    if (this.encrypted && this.encryptionKey) {
      payload = await this.encodeForCloud(json);
    } else {
      payload = json;
    }
    await this.adapter.writeFile(p.snapshotLatest, textEncoder.encode(payload));

    // Update manifest
    if (this.manifest) {
      this.manifest.epoch = newEpoch;
      this.manifest.schema = newSchema;
      await this.saveManifest();
    }

    // Delete old change logs
    const files = await this.adapter.listFiles(p.changes);
    for (const file of files) {
      try {
        await this.adapter.deleteFile(file.path);
      } catch {
        // best effort
      }
    }

    // Update local state with transformed rows if migrated
    if (transform) {
      this.tables = snapshotTables;
      await this.local.clearRows();
      for (const rows of Object.values(snapshotTables)) {
        await this.local.putRows(Object.values(rows));
      }
    }

    await this.local.setMeta('epoch', newEpoch);
    this.emit({ type: 'compact:complete', epoch: newEpoch });
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
   * Re-encrypts all cloud data.
   */
  async enableEncryption(key: CryptoKey): Promise<void> {
    this.encryptionKey = key;
    this.encrypted = true;

    if (this.manifest) {
      this.manifest.encrypted = true;
      await this.saveManifest();
    }

    // Re-encrypt: compact writes encrypted snapshot + clears old plaintext logs
    await this.compact();
  }
}
