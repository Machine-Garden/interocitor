/**
 * Local storage layer — IndexedDB
 *
 * This is a cache, not the source of truth.
 * If cleared, the app rehydrates from cloud.
 *
 * Stores:
 *  - rows: the current merged state of all tables
 *  - outbox: change entries pending upload
 *  - cursors: byte offsets into each device's change log
 *  - meta: device ID, last snapshot epoch, etc.
 */

import type { Row, ChangeEntry } from '../core/types.ts';

const DB_NAME = 'interocitor';
const DB_VERSION = 1;

const STORES = {
  rows: 'rows',         // key: "{table}/{rowId}"
  outbox: 'outbox',     // key: auto-increment
  cursors: 'cursors',   // key: deviceId
  meta: 'meta',         // key: string
} as const;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.rows)) {
        const rows = db.createObjectStore(STORES.rows, { keyPath: '_key' });
        rows.createIndex('by_table', '_table', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.outbox)) {
        db.createObjectStore(STORES.outbox, { autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORES.cursors)) {
        db.createObjectStore(STORES.cursors);
      }
      if (!db.objectStoreNames.contains(STORES.meta)) {
        db.createObjectStore(STORES.meta);
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(
  db: IDBDatabase,
  stores: string | string[],
  mode: IDBTransactionMode
): IDBTransaction {
  return db.transaction(stores, mode);
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

// ─── Public API ──────────────────────────────────────────────────────

export class LocalStore {
  private db: IDBDatabase | null = null;

  async open(): Promise<void> {
    this.db = await openDB();
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  private ensureDB(): IDBDatabase {
    if (!this.db) throw new Error('LocalStore not opened');
    return this.db;
  }

  // ── Rows ─────────────────────────────────────────────────────────

  private rowKey(table: string, rowId: string): string {
    return `${table}/${rowId}`;
  }

  async getRow(table: string, rowId: string): Promise<Row | undefined> {
    const db = this.ensureDB();
    const t = tx(db, STORES.rows, 'readonly');
    const store = t.objectStore(STORES.rows);
    const result = await reqToPromise(store.get(this.rowKey(table, rowId)));
    return result as Row | undefined;
  }

  async putRow(row: Row): Promise<void> {
    const db = this.ensureDB();
    const t = tx(db, STORES.rows, 'readwrite');
    const store = t.objectStore(STORES.rows);
    const record = { ...row, _key: this.rowKey(row._table, row._rowId) };
    store.put(record);
    await txComplete(t);
  }

  async putRows(rows: Row[]): Promise<void> {
    if (rows.length === 0) return;
    const db = this.ensureDB();
    const t = tx(db, STORES.rows, 'readwrite');
    const store = t.objectStore(STORES.rows);
    for (const row of rows) {
      const record = { ...row, _key: this.rowKey(row._table, row._rowId) };
      store.put(record);
    }
    await txComplete(t);
  }

  async getTable(table: string): Promise<Row[]> {
    const db = this.ensureDB();
    const t = tx(db, STORES.rows, 'readonly');
    const store = t.objectStore(STORES.rows);
    const index = store.index('by_table');
    const results = await reqToPromise(index.getAll(table));
    return (results as Row[]).filter(r => !r._deleted);
  }

  async getAllRows(): Promise<Row[]> {
    const db = this.ensureDB();
    const t = tx(db, STORES.rows, 'readonly');
    const store = t.objectStore(STORES.rows);
    return reqToPromise(store.getAll()) as Promise<Row[]>;
  }

  async clearRows(): Promise<void> {
    const db = this.ensureDB();
    const t = tx(db, STORES.rows, 'readwrite');
    t.objectStore(STORES.rows).clear();
    await txComplete(t);
  }

  // ── Outbox ───────────────────────────────────────────────────────

  async pushOutbox(entry: ChangeEntry): Promise<void> {
    const db = this.ensureDB();
    const t = tx(db, STORES.outbox, 'readwrite');
    t.objectStore(STORES.outbox).add(entry);
    await txComplete(t);
  }

  async drainOutbox(): Promise<ChangeEntry[]> {
    const db = this.ensureDB();
    const t = tx(db, STORES.outbox, 'readwrite');
    const store = t.objectStore(STORES.outbox);
    const entries = await reqToPromise(store.getAll()) as ChangeEntry[];
    store.clear();
    await txComplete(t);
    return entries;
  }

  async outboxSize(): Promise<number> {
    const db = this.ensureDB();
    const t = tx(db, STORES.outbox, 'readonly');
    return reqToPromise(t.objectStore(STORES.outbox).count());
  }

  // ── Cursors ──────────────────────────────────────────────────────

  async getCursor(deviceId: string): Promise<number> {
    const db = this.ensureDB();
    const t = tx(db, STORES.cursors, 'readonly');
    const result = await reqToPromise(t.objectStore(STORES.cursors).get(deviceId));
    return (result as number) || 0;
  }

  async setCursor(deviceId: string, offset: number): Promise<void> {
    const db = this.ensureDB();
    const t = tx(db, STORES.cursors, 'readwrite');
    t.objectStore(STORES.cursors).put(offset, deviceId);
    await txComplete(t);
  }

  async getAllCursors(): Promise<Record<string, number>> {
    const db = this.ensureDB();
    const t = tx(db, STORES.cursors, 'readonly');
    const store = t.objectStore(STORES.cursors);
    const keys = await reqToPromise(store.getAllKeys()) as string[];
    const values = await reqToPromise(store.getAll()) as number[];
    const cursors: Record<string, number> = {};
    for (let i = 0; i < keys.length; i++) {
      cursors[keys[i]] = values[i];
    }
    return cursors;
  }

  // ── Meta ─────────────────────────────────────────────────────────

  async getMeta(key: string): Promise<unknown> {
    const db = this.ensureDB();
    const t = tx(db, STORES.meta, 'readonly');
    return reqToPromise(t.objectStore(STORES.meta).get(key));
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    const db = this.ensureDB();
    const t = tx(db, STORES.meta, 'readwrite');
    t.objectStore(STORES.meta).put(value, key);
    await txComplete(t);
  }

  /** Nuke everything. Used before full rehydration. */
  async clearAll(): Promise<void> {
    const db = this.ensureDB();
    const t = tx(db, Object.values(STORES), 'readwrite');
    for (const name of Object.values(STORES)) {
      t.objectStore(name).clear();
    }
    await txComplete(t);
  }
}
