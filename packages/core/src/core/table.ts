/**
 * Table<T> — typed handle for a named collection within a Interocitor.
 *
 * Wraps the engine's raw Row/string API with a type-safe surface.
 * All reads return plain T objects (internal HLC metadata stripped).
 * All writes accept Partial<T> and return T.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { Interocitor } from './sync-engine.ts';

// Use a loose engine reference so Table<T> doesn't need to know S
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEngine = Interocitor<any>;
import type { Row, ColumnEntry, TableEventListener } from './types.ts';
import type { WhereClause, WherePrimitive } from './types.ts';
import { createRowId } from './row-id.ts';

/**
 * Thenable result of a query — awaitable as `Promise<T[]>` and chainable with `.sort()`.
 * Carries engine + table context for reactive subscriptions.
 */
export class QueryResult<T extends Record<string, unknown>> implements PromiseLike<T[]> {
  constructor(
    private readonly _promise: Promise<T[]>,
    private readonly _engine?: AnyEngine,
    private readonly _tableName?: string,
  ) {}

  then<R1 = T[], R2 = never>(
    onfulfilled?: ((value: T[]) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this._promise.then(onfulfilled, onrejected);
  }

  /** Sort the result. Same signature as `Array.prototype.sort`. */
  sort(compareFn: (a: T, b: T) => number): QueryResult<T> {
    return new QueryResult(
      this._promise.then(rows => [...rows].sort(compareFn)),
      this._engine,
      this._tableName,
    );
  }

  /** Sort by a single field. Default: ascending. */
  orderBy<K extends keyof T>(field: K, dir: 'asc' | 'desc' = 'asc'): QueryResult<T> {
    return this.sort((a, b) => {
      const av = a[field];
      const bv = b[field];
      if (av === bv) return 0;
      const lt = av < bv ? -1 : 1;
      return dir === 'asc' ? lt : -lt;
    });
  }

  /**
   * Subscribe to changes that affect this query's table.
   * Returns an unsubscribe function.
   */
  subscribe(cb: TableEventListener<T>): () => void {
    if (!this._engine || !this._tableName) {
      return () => {};
    }
    const engine = this._engine;
    const tableName = this._tableName;
    return engine.on(event => {
      if (event.type === 'change' && event.table === tableName) {
        cb({ type: 'change', rowId: event.rowId, row: rowToTyped<T>(event.row) });
      } else if (event.type === 'delete' && event.table === tableName) {
        cb({ type: 'delete', rowId: event.rowId });
      }
    });
  }
}

function rowToTyped<T extends Record<string, unknown>>(row: Row): T {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(row)) {
    if (key.startsWith('_')) continue;
    if (val !== null && val !== undefined && typeof val === 'object' && 'value' in val && 'hlc' in val) {
      result[key] = (val as ColumnEntry).value;
    }
  }
  return result as T;
}

/**
 * Typed handle for a named collection within a {@link Interocitor}.
 *
 * All reads return plain objects with CRDT metadata stripped away.
 *
 * @example
 * ```ts
 * const tasks = engine.table<{ title: string; done: boolean }>('tasks');
 * await tasks.put('task_1', { title: 'Write docs', done: false });
 * const open = await tasks.where('done').equals(false);
 * ```
 */
export class Table<T extends Record<string, unknown>> {
  constructor(
    private readonly engine: AnyEngine,
    /** The collection name as stored in the engine. */
    readonly name: string,
  ) {}

  /** Retrieve a single record by ID, or undefined if not found / deleted. */
  async get(rowId: string): Promise<T | undefined> {
    const row = await this.engine.get(this.name, rowId);
    return row ? rowToTyped<T>(row) : undefined;
  }

  /** Retrieve all live (non-deleted) records in this collection. */
  query(): QueryResult<T> {
    return new QueryResult(
      this.engine.query(this.name).then(rows => rows.map(r => rowToTyped<T>(r))),
      this.engine,
      this.name,
    );
  }

  /** Build a field-scoped where query (Dexie-style, without string schema syntax). */
  where<K extends keyof T & string>(field: K): TableWhere<T> {
    return new TableWhere<T>(this.engine, this.name, field);
  }

  /**
   * Patch a record — only the provided fields are updated.
   * Omitted fields are untouched (CRDT per-field merge).
   * Returns the full merged row.
   */
  async patch(rowId: string, data: Partial<T>, userId?: string): Promise<T> {
    const row = await this.engine.put(this.name, rowId, data as Record<string, unknown>, userId);
    return rowToTyped<T>(row);
  }

  /**
   * Replace a record — writes ALL fields in `data`, explicitly nulling any
   * fields present in the existing row but absent from `data`.
   * Returns the full row.
   */
  async replace(rowId: string, data: T, userId?: string): Promise<T> {
    const existing = await this.engine.get(this.name, rowId);
    const existingKeys = existing ? Object.keys(existing) : [];
    const nulled = Object.fromEntries(existingKeys.filter(k => !(k in data)).map(k => [k, null]));
    const row = await this.engine.put(
      this.name,
      rowId,
      { ...nulled, ...data } as Record<string, unknown>,
      userId,
    );
    return rowToTyped<T>(row);
  }

  /**
   * Insert a new record with an auto-generated row ID.
   * Returns the generated ID.
   *
   * @example
   * const id = await table.add({ title: 'Buy milk' });
   * const id = await table.add({ title: 'Buy milk' }, { prefix: 'task' });
   */
  async add(data: T, opts?: { prefix?: string }, userId?: string): Promise<string> {
    const id = createRowId({ prefix: opts?.prefix });
    await this.engine.put(this.name, id, data as Record<string, unknown>, userId);
    return id;
  }

  /** Soft-delete a record. */
  async delete(rowId: string, userId?: string): Promise<void> {
    return this.engine.delete(this.name, rowId, userId);
  }

  /**
   * Subscribe to changes in this table. Fires on every change/delete.
   * Returns an unsubscribe function.
   *
   * @example
   * const unsub = db.table('tasks').subscribe(event => {
   *   if (event.type === 'change') console.log(event.row);
   * });
   */
  subscribe(cb: TableEventListener<T>): () => void {
    return this.engine.on(event => {
      if (event.type === 'change' && event.table === this.name) {
        cb({ type: 'change', rowId: event.rowId, row: rowToTyped<T>(event.row) });
      } else if (event.type === 'delete' && event.table === this.name) {
        cb({ type: 'delete', rowId: event.rowId });
      }
    });
  }
}

class TableWhere<T extends Record<string, unknown>> {
  constructor(
    private readonly engine: AnyEngine,
    private readonly table: string,
    private readonly field: string,
  ) {}

  private run(clause: Omit<WhereClause, 'field'>): QueryResult<T> {
    return new QueryResult(
      this.engine.queryWhere(this.table, {
        field: this.field,
        ...clause,
      } as WhereClause).then(rows => rows.map(row => rowToTyped<T>(row))),
      this.engine,
      this.table,
    );
  }

  equals(value: WherePrimitive): QueryResult<T> {
    return this.run({ op: 'equals', value });
  }

  above(value: WherePrimitive): QueryResult<T> {
    return this.run({ op: 'above', value });
  }

  aboveOrEqual(value: WherePrimitive): QueryResult<T> {
    return this.run({ op: 'aboveOrEqual', value });
  }

  below(value: WherePrimitive): QueryResult<T> {
    return this.run({ op: 'below', value });
  }

  belowOrEqual(value: WherePrimitive): QueryResult<T> {
    return this.run({ op: 'belowOrEqual', value });
  }

  between(
    lower: WherePrimitive,
    upper: WherePrimitive,
    options?: { lowerOpen?: boolean; upperOpen?: boolean },
  ): QueryResult<T> {
    return this.run({
      op: 'between',
      lower,
      upper,
      lowerOpen: options?.lowerOpen,
      upperOpen: options?.upperOpen,
    });
  }

  startsWith(prefix: string): QueryResult<T> {
    return this.run({ op: 'startsWith', value: prefix });
  }

  anyOf(values: WherePrimitive[]): QueryResult<T> {
    return this.run({ op: 'anyOf', values });
  }
}

