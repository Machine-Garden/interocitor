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
  LocalStoreAdapter,
  DatabaseSchemaDefinition,
  TableIndexDefinition,
  SchemaField,
  WhereClause,
  WherePrimitive,
} from '../core/types.ts';

const DEFAULT_DB_NAME = 'interocitor';
const DEFAULT_DB_VERSION = 1;

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
  return ['_table', `${field}.value`];
}

function normalizeSchema(schema?: DatabaseSchemaDefinition): DatabaseSchemaDefinition | undefined {
  if (!schema) return undefined;
  if (!Number.isInteger(schema.version) || schema.version < 1) {
    throw new Error('Schema version must be an integer >= 1');
  }
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
  for (const [table, def] of Object.entries(schema.tables)) {
    const fieldEntries = Object.entries(def.fields ?? {});
    for (const [fieldName, input] of fieldEntries) {
      const fieldDef = normalizeFieldInput(input);
      if (!fieldDef.index && !fieldDef.unique) continue;
      expected.set(schemaIndexName(table, `by_${fieldName}`), {
        keyPath: schemaIndexKeyPath(fieldName),
        unique: fieldDef.unique ?? false,
      });
    }
    for (const index of def.indexes ?? []) {
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
  const raw = row[field] as unknown;
  if (raw !== null && raw !== undefined && typeof raw === 'object' && 'value' in (raw as object)) {
    return (raw as { value: unknown }).value;
  }
  return raw;
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
  switch (clause.op) {
    case 'equals':
      return IDBKeyRange.only([table, clause.value]);
    case 'above':
      return IDBKeyRange.lowerBound([table, clause.value], true);
    case 'aboveOrEqual':
      return IDBKeyRange.lowerBound([table, clause.value], false);
    case 'below':
      return IDBKeyRange.upperBound([table, clause.value], true);
    case 'belowOrEqual':
      return IDBKeyRange.upperBound([table, clause.value], false);
    case 'between':
      return IDBKeyRange.bound(
        [table, clause.lower],
        [table, clause.upper],
        clause.lowerOpen ?? false,
        clause.upperOpen ?? false,
      );
    case 'startsWith': {
      const prefix = String(clause.value ?? '');
      return IDBKeyRange.bound([table, prefix], [table, `${prefix}\uffff`], false, false);
    }
    case 'anyOf':
      return null;
    default:
      return null;
  }
}

function openDB(dbName: string, dbVersion: number, schema?: DatabaseSchemaDefinition): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, dbVersion);

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

      const rowsStore = req.transaction?.objectStore(STORES.rows);
      if (rowsStore) {
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

/**
 * Default IndexedDB-backed local persistence layer used by {@link SyncEngine}.
 *
 * Most applications do not need to interact with this class directly unless
 * they are supplying a custom `localStoreFactory` or swapping local storage at
 * runtime for testing or advanced integrations.
 */
export class LocalStore implements LocalStoreAdapter {
  private db: IDBDatabase | null = null;
  private readonly dbName: string;
  private readonly dbVersion: number;
  private readonly schema?: DatabaseSchemaDefinition;

  /**
   * @param dbName    IndexedDB database name. Use distinct names to isolate
   *                  multiple engine instances on the same origin.
   *                  Default: "interocitor"
   * @param dbVersion IndexedDB schema version. Default: 1
   */
  constructor(dbName?: string, dbVersion?: number, schema?: DatabaseSchemaDefinition) {
    this.schema = normalizeSchema(schema);
    const schemaVersionBump = this.schema?.version ?? 0;
    this.dbName = dbName ?? DEFAULT_DB_NAME;
    this.dbVersion = dbVersion ?? (DEFAULT_DB_VERSION + schemaVersionBump);
  }

  async open(): Promise<void> {
    this.db = await openDB(this.dbName, this.dbVersion, this.schema);
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

  async queryWhere(table: string, clause: WhereClause): Promise<Row[]> {
    const db = this.ensureDB();
    const indexDef = hasSchemaIndex(this.schema, table, clause.field);

    if (!indexDef) {
      const rows = await this.getTable(table);
      return rows.filter(row => matchesClause(readColumnValue(row, clause.field), clause));
    }

    const t = tx(db, STORES.rows, 'readonly');
    const store = t.objectStore(STORES.rows);
    const index = store.index(schemaIndexName(table, indexDef.name));

    if (clause.op === 'anyOf') {
      const values = clause.values ?? [];
      const merged = new Map<string, Row>();
      for (const value of values) {
        const matches = await reqToPromise(index.getAll(IDBKeyRange.only([table, value])));
        for (const row of matches as Row[]) {
          if (!row._deleted) {
            merged.set(`${row._table}/${row._rowId}`, row);
          }
        }
      }
      return Array.from(merged.values());
    }

    const range = rangeForClause(table, clause);
    const results = await reqToPromise(index.getAll(range ?? undefined));
    return (results as Row[]).filter(row => !row._deleted);
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
      if (row._table) names.add(row._table);
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
