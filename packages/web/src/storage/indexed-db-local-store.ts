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

import type {
  Row,
  ChangeEntry,
  LocalStore,
  DatabaseSchemaDefinition,
  TableIndexDefinition,
  SchemaField,
  WhereClause,
  WherePrimitive,
} from '@interocitor/core';

const DEFAULT_DB_NAME = 'interocitor';
const DEFAULT_DB_VERSION = 1;
const CACHE_FINGERPRINT_META_KEY = 'interocitor:cache:fingerprint';

const STORES = {
  rows: 'rows',         // key: "{table}/{rowId}"
  outbox: 'outbox',     // key: auto-increment
  cursors: 'cursors',   // key: deviceId
  meta: 'meta',         // key: string
} as const;

const SCHEMA_INDEX_PREFIX = 'idx:';

function schemaIndexName(table: string, indexName: string): string {
  return `${SCHEMA_INDEX_PREFIX}${table}:${indexName}`;
}

function schemaIndexKeyPath(field: string): string[] {
  // Index key is composite: [table, payload-field-value]. Both live under
  // namespaced parents now. ColumnEntry stores the user value under `.value`.
  return ['_meta.table', `payload.${field}.value`];
}

function normalizeSchema(schema?: DatabaseSchemaDefinition): DatabaseSchemaDefinition | undefined {
  if (!schema) return undefined;
  return schema;
}

function domStringListToArray(list: DOMStringList): string[] {
  const out: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list.item(i);
    if (item) out.push(item);
  }
  return out;
}

function expectedSchemaIndexes(schema?: DatabaseSchemaDefinition): Map<string, { keyPath: string[]; unique: boolean }> {
  const expected = new Map<string, { keyPath: string[]; unique: boolean }>();
  if (!schema) return expected;
  for (const table of Object.keys(schema.tables).sort()) {
    const def = schema.tables[table]!;
    const fieldEntries = Object.entries(def.fields ?? {}).sort(([a], [b]) => a.localeCompare(b));
    for (const [fieldName, input] of fieldEntries) {
      const fieldDef = normalizeFieldInput(input);
      if (!fieldDef.index && !fieldDef.unique) continue;
      expected.set(schemaIndexName(table, `by_${fieldName}`), {
        keyPath: schemaIndexKeyPath(fieldName),
        unique: fieldDef.unique ?? false,
      });
    }
    const indexes = [...(def.indexes ?? [])].sort((a, b) => a.name.localeCompare(b.name) || a.field.localeCompare(b.field));
    for (const index of indexes) {
      expected.set(schemaIndexName(table, index.name), {
        keyPath: schemaIndexKeyPath(index.field),
        unique: index.unique ?? false,
      });
    }
  }
  return expected;
}

function normalizeFieldInput(input: SchemaField<unknown>): { index: boolean; unique: boolean } {
  return {
    index: input.index ?? false,
    unique: input.unique ?? false,
  };
}

function readColumnValue(row: Row, field: string): unknown {
  const entry = row.payload?.[field];
  if (entry === undefined) return undefined;
  return entry.value;
}

function compare(a: WherePrimitive, b: WherePrimitive): number {
  const av = a instanceof Date ? a.getTime() : a;
  const bv = b instanceof Date ? b.getTime() : b;
  if (av < bv) return -1;
  if (av > bv) return 1;
  return 0;
}

function matchesClause(value: unknown, clause: WhereClause): boolean {
  if (value === undefined || value === null) return false;
  switch (clause.op) {
    case 'equals':
      return compare(value as WherePrimitive, clause.value as WherePrimitive) === 0;
    case 'above':
      return compare(value as WherePrimitive, clause.value as WherePrimitive) > 0;
    case 'aboveOrEqual':
      return compare(value as WherePrimitive, clause.value as WherePrimitive) >= 0;
    case 'below':
      return compare(value as WherePrimitive, clause.value as WherePrimitive) < 0;
    case 'belowOrEqual':
      return compare(value as WherePrimitive, clause.value as WherePrimitive) <= 0;
    case 'between': {
      const lowerCmp = compare(value as WherePrimitive, clause.lower as WherePrimitive);
      const upperCmp = compare(value as WherePrimitive, clause.upper as WherePrimitive);
      const lowerOk = clause.lowerOpen ? lowerCmp > 0 : lowerCmp >= 0;
      const upperOk = clause.upperOpen ? upperCmp < 0 : upperCmp <= 0;
      return lowerOk && upperOk;
    }
    case 'startsWith':
      return typeof value === 'string' && value.startsWith(String(clause.value));
    case 'anyOf':
      return (clause.values ?? []).some(v => compare(value as WherePrimitive, v) === 0);
    default:
      return false;
  }
}

function hasSchemaIndex(
  schema: DatabaseSchemaDefinition | undefined,
  table: string,
  field: string,
): TableIndexDefinition | undefined {
  const tableSchema = schema?.tables[table];
  if (!tableSchema) return undefined;

  const legacy = tableSchema.indexes?.find(index => index.field === field);
  if (legacy) return legacy;

  const fromField = tableSchema.fields?.[field] as SchemaField<unknown> | undefined;
  if (!fromField) return undefined;
  const fieldDef = normalizeFieldInput(fromField);
  if (!fieldDef.index && !fieldDef.unique) return undefined;
  return {
    name: `by_${field}`,
    field,
    unique: fieldDef.unique,
  };
}

function rangeForClause(table: string, clause: WhereClause): IDBKeyRange | null {
  // Schema indexes are keyed as [table, fieldValue]. Range queries must bound
  // both sides of the compound key; lowerBound([table, value]) alone would also
  // include later table names, and upperBound([table, value]) would include
  // earlier table names.
  const tableLowerBound = [table];
  const tableUpperBound = [table, []];

  switch (clause.op) {
    case 'equals':
      return IDBKeyRange.only([table, clause.value]);
    case 'above':
      return IDBKeyRange.bound([table, clause.value], tableUpperBound, true, false);
    case 'aboveOrEqual':
      return IDBKeyRange.bound([table, clause.value], tableUpperBound, false, false);
    case 'below':
      return IDBKeyRange.bound(tableLowerBound, [table, clause.value], false, true);
    case 'belowOrEqual':
      return IDBKeyRange.bound(tableLowerBound, [table, clause.value], false, false);
    case 'between':
      return IDBKeyRange.bound(
        [table, clause.lower],
        [table, clause.upper],
        clause.lowerOpen ?? false,
        clause.upperOpen ?? false,
      );
    case 'startsWith': {
      const prefix = String(clause.value ?? '');
      return IDBKeyRange.bound([table, prefix], [table, `${prefix}\uFFFF`], false, false);
    }
    case 'anyOf':
      return null;
    default:
      return null;
  }
}

function reconcileSchemaIndexes(rowsStore: IDBObjectStore, schema?: DatabaseSchemaDefinition): void {
  const expected = expectedSchemaIndexes(schema);
  const existing = domStringListToArray(rowsStore.indexNames).filter(name => name.startsWith(SCHEMA_INDEX_PREFIX));

  for (const indexName of existing) {
    if (!expected.has(indexName)) {
      rowsStore.deleteIndex(indexName);
    }
  }

  for (const [indexName, def] of expected.entries()) {
    if (!rowsStore.indexNames.contains(indexName)) {
      rowsStore.createIndex(indexName, def.keyPath, { unique: def.unique });
    }
  }
}

function openDB(
  dbName: string,
  dbVersion: number | undefined,
  schema?: DatabaseSchemaDefinition,
  onProgress?: () => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = dbVersion === undefined ? indexedDB.open(dbName) : indexedDB.open(dbName, dbVersion);

    req.onupgradeneeded = () => {
      // Signal "the platform is alive and processing". The resilient wrapper
      // uses this to disarm its open-deadline: a long-running upgrade
      // (creating indexes over many rows on a slow device) is making
      // progress, not blocked. Without this, a legitimate upgrade past the
      // deadline would falsely trigger memory-mode fallback.
      try { onProgress?.(); } catch { /* never let a bad listener break open */ }
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.rows)) {
        // keyPath uses dotted path into the new namespaced row shape.
        // IndexedDB resolves "_meta.key" against the stored object.
        const rows = db.createObjectStore(STORES.rows, { keyPath: '_meta.key' });
        rows.createIndex('by_table', '_meta.table', { unique: false });
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

      const rowsStore = req.transaction?.objectStore(STORES.rows);
      if (rowsStore) reconcileSchemaIndexes(rowsStore, schema);
    };

    req.onsuccess = () => {
      const db = req.result;
      // If another caller (sibling tab, worker, or even our own next open()
      // for an upgrade) requests a higher version, voluntarily close this
      // connection so the upgrade can proceed instead of blocking it.
      // Without this handler, an upgrade open elsewhere would hang on
      // 'blocked' until this connection is closed manually.
      db.onversionchange = () => {
        try { db.close(); } catch { /* already closed */ }
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error(`IndexedDB open failed for "${dbName}"`));
    // Fired when an upgrade open is held up by another live connection at a
    // lower version. Without this handler the request never fires success or
    // error and the promise hangs forever — surfacing only as a downstream
    // init() timeout with no diagnostic. Reject loudly with an actionable
    // message instead.
    req.onblocked = () => {
      reject(new Error(
        `IndexedDB open blocked: another connection to "${dbName}" is open at a lower version ` +
        `(requested v${dbVersion ?? 'current'}). Close other tabs/workers using this database, ` +
        `or ensure prior LocalStore instances called close().`,
      ));
    };
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

/**
 * Default IndexedDB-backed local persistence layer used by {@link Interocitor}.
 *
 * Most applications do not need to interact with this class directly unless
 * they are supplying a custom `LocalStore` or swapping local storage at
 * runtime for testing or advanced integrations.
 */
export class IndexedDbLocalStore implements LocalStore {
  private db: IDBDatabase | null = null;
  private readonly dbName: string;
  private readonly configuredDbVersion?: number;
  private readonly schema?: DatabaseSchemaDefinition;
  private readonly expectedIndexes: Map<string, { keyPath: string[]; unique: boolean }>;
  private readonly desiredFingerprint: string;

  /**
   * @param dbName    IndexedDB database name. Use distinct names to isolate
   *                  multiple engine instances on the same origin.
   *                  Default: "interocitor"
   * @param dbVersion IndexedDB schema version. Default: 1
   */
  constructor(dbName?: string, dbVersion?: number, schema?: DatabaseSchemaDefinition) {
    this.schema = normalizeSchema(schema);
    this.dbName = dbName ?? DEFAULT_DB_NAME;
    this.configuredDbVersion = dbVersion;
    this.expectedIndexes = expectedSchemaIndexes(this.schema);
    this.desiredFingerprint = JSON.stringify(Array.from(this.expectedIndexes.entries()).map(([name, def]) => ({
      name,
      keyPath: def.keyPath,
      unique: def.unique,
    })));
  }

  private async readCacheFingerprint(db: IDBDatabase): Promise<string | undefined> {
    const t = tx(db, STORES.meta, 'readonly');
    const value = await reqToPromise(t.objectStore(STORES.meta).get(CACHE_FINGERPRINT_META_KEY));
    return typeof value === 'string' ? value : undefined;
  }

  private async writeCacheFingerprint(db: IDBDatabase): Promise<void> {
    const t = tx(db, STORES.meta, 'readwrite');
    t.objectStore(STORES.meta).put(this.desiredFingerprint, CACHE_FINGERPRINT_META_KEY);
    await txComplete(t);
  }

  private needsRepair(db: IDBDatabase, storedFingerprint?: string): boolean {
    if (!db.objectStoreNames.contains(STORES.rows)) return true;
    const rows = tx(db, STORES.rows, 'readonly').objectStore(STORES.rows);
    const existing = new Set(domStringListToArray(rows.indexNames).filter(name => name.startsWith(SCHEMA_INDEX_PREFIX)));
    if (storedFingerprint !== this.desiredFingerprint) return true;
    if (existing.size !== this.expectedIndexes.size) return true;
    for (const name of this.expectedIndexes.keys()) {
      if (!existing.has(name)) return true;
    }
    return false;
  }

  async open(onProgress?: () => void): Promise<void> {
    const requestedVersion = this.configuredDbVersion ?? DEFAULT_DB_VERSION;
    let db = await openDB(this.dbName, undefined, this.schema, onProgress);

    const reopenAt = async (nextVersion: number): Promise<IDBDatabase> => {
      // Close synchronously, then yield a macrotask before re-opening at the
      // higher version. db.close() only requests close; the actual close
      // happens after pending transactions drain. Reopening immediately can
      // race the prior connection still appearing live to indexedDB.open(),
      // producing a transient 'blocked' event. The yield gives the platform
      // a beat to finalize the close. Onversionchange on the prior handle
      // is still our backstop if any other connection lingers.
      db.close();
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      // A reopen is itself "progress" — the deadline (if any) has already
      // been disarmed, but we keep the contract by signaling again on the
      // upcoming upgrade-needed.
      return openDB(this.dbName, nextVersion, this.schema, onProgress);
    };

    if (db.version < requestedVersion) {
      db = await reopenAt(requestedVersion);
    }

    let storedFingerprint = await this.readCacheFingerprint(db);
    const repairVersion = this.needsRepair(db, storedFingerprint)
      ? Math.max(db.version + 1, requestedVersion)
      : null;

    if (repairVersion !== null) {
      db = await reopenAt(repairVersion);
      storedFingerprint = await this.readCacheFingerprint(db);
    }

    if (storedFingerprint !== this.desiredFingerprint) {
      await this.writeCacheFingerprint(db);
    }

    this.db = db;
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

  /** Stamp the composite IndexedDB key into row._meta.key. Pure. */
  private withKey(row: Row): Row {
    return {
      ...row,
      _meta: { ...row._meta, key: this.rowKey(row._meta.table, row._meta.rowId) },
      payload: row.payload,
    };
  }

  async putRow(row: Row): Promise<void> {
    const db = this.ensureDB();
    const t = tx(db, STORES.rows, 'readwrite');
    const store = t.objectStore(STORES.rows);
    store.put(this.withKey(row));
    await txComplete(t);
  }

  async putRows(rows: Row[]): Promise<void> {
    if (rows.length === 0) return;
    const db = this.ensureDB();
    const t = tx(db, STORES.rows, 'readwrite');
    const store = t.objectStore(STORES.rows);
    for (const row of rows) {
      store.put(this.withKey(row));
    }
    await txComplete(t);
  }

  async getTable(table: string): Promise<Row[]> {
    const db = this.ensureDB();
    const t = tx(db, STORES.rows, 'readonly');
    const store = t.objectStore(STORES.rows);
    const index = store.index('by_table');
    const results = await reqToPromise(index.getAll(table));
    return (results as Row[]).filter(r => !r._meta.deleted);
  }

  async queryWhere(table: string, clause: WhereClause): Promise<Row[]> {
    const db = this.ensureDB();
    const indexDef = hasSchemaIndex(this.schema, table, clause.field);

    if (!indexDef) {
      const rows = await this.getTable(table);
      return rows.filter(row => matchesClause(readColumnValue(row, clause.field), clause));
    }

    const t = tx(db, STORES.rows, 'readonly');
    const store = t.objectStore(STORES.rows);
    const indexName = schemaIndexName(table, indexDef.name);
    if (!store.indexNames.contains(indexName)) {
      const rows = await this.getTable(table);
      return rows.filter(row => matchesClause(readColumnValue(row, clause.field), clause));
    }
    const index = store.index(indexName);

    if (clause.op === 'anyOf') {
      const values = clause.values ?? [];
      const merged = new Map<string, Row>();
      for (const value of values) {
        const matches = await reqToPromise(index.getAll(IDBKeyRange.only([table, value])));
        for (const row of matches as Row[]) {
          if (!row._meta.deleted && row._meta.table === table) {
            merged.set(`${row._meta.table}/${row._meta.rowId}`, row);
          }
        }
      }
      return Array.from(merged.values());
    }

    const range = rangeForClause(table, clause);
    const results = await reqToPromise(index.getAll(range ?? undefined));
    return (results as Row[]).filter(row => !row._meta.deleted && row._meta.table === table);
  }

  async getTableNames(): Promise<string[]> {
    const db = this.ensureDB();
    // Intentionally avoids openKeyCursor: Safari rejects null as a key range
    // argument in some IDB versions. A full-store getAll() is safe everywhere
    // and acceptable here — called once at init on an otherwise-empty DB.
    const t = tx(db, STORES.rows, 'readonly');
    const store = t.objectStore(STORES.rows);
    const all = await reqToPromise(store.getAll()) as Row[];
    const names = new Set<string>();
    for (const row of all) {
      const table = row._meta?.table;
      if (table) names.add(table);
    }
    return Array.from(names);
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
    await this.pushOutboxEntries([entry]);
  }

  async pushOutboxEntries(entries: ChangeEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const db = this.ensureDB();
    const t = tx(db, STORES.outbox, 'readwrite');
    const store = t.objectStore(STORES.outbox);
    for (const entry of entries) store.add(entry);
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
