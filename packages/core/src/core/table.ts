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
import type { Row, TableEventListener } from './types.ts';
import type {
  QueryDescriptor,
  QueryExecutionOptions,
  QueryExecutionPolicy,
  RowDescriptor,
  WhereClause,
  WherePrimitive,
} from './types.ts';
import { createRowId } from './row-id.ts';

/**
 * Thenable result of an async query.
 *
 * Two layers live here, kept distinct on purpose:
 *  1. Async query identity: `descriptor` + `cacheKey`. Owned by core. Stable
 *     across `.sort()` chains. Used by any cache layer (React etc.) to dedupe
 *     loads, share in-flight promises, and keep stale data across remounts.
 *  2. Sync derivation: `.sort(compareFn)` runs after the async load. Does not
 *     change `cacheKey`. Not part of cache identity. Pure post-processing.
 *
 * `then(...)` triggers a load through the engine cache. Use `load({ bypassCache })`
 * to force a fresh fetch.
 */
export class QueryResult<T extends Record<string, unknown>> implements PromiseLike<T[]> {
  /** Stable async-query identity. */
  readonly descriptor: QueryDescriptor;
  /** Stable cache key derived from descriptor by core. */
  readonly cacheKey: string;

  constructor(
    descriptor: QueryDescriptor,
    private readonly _engine: AnyEngine | null,
    /** Optional sync transform stack — runs after rows are loaded. */
    private readonly _sortChain: ReadonlyArray<(rows: T[]) => T[]> = [],
    /** Optional pre-resolved promise (used for synthetic / engine-less results). */
    private readonly _explicitPromise: Promise<T[]> | null = null,
  ) {
    this.descriptor = descriptor;
    this.cacheKey = _engine
      ? _engine.getQueryCacheKey(descriptor)
      : computeCacheKey(descriptor);
  }

  /** Public metadata. Mirrors `QueryMetadata` shape. */
  get metadata() {
    return { descriptor: this.descriptor, cacheKey: this.cacheKey };
  }

  /**
   * Async load through engine cache.
   * Pass `{ bypassCache: true }` to ignore cached snapshot and refetch.
   */
  load(options?: QueryExecutionOptions): Promise<T[]> {
    return this._loadRaw(options).then(rows => this._applySort(rows));
  }

  /**
   * Read cached rows synchronously, if available. Returns `undefined` only if
   * the cache has no row snapshot. Does not start a load.
   *
   * Stale-while-revalidate contract: pending/error snapshots may still carry
   * rows from the previous ready load. Expose those rows so consumers can keep
   * stale data visible while a refresh is in flight.
   *
   * Stable reference contract: callers (React, useSyncExternalStore, etc.)
   * MUST be able to compare the returned array by reference. We memoize the
   * typed+sorted projection keyed by the raw rows reference from the engine
   * cache. As long as the engine cache hasn't moved, this returns the exact
   * same array instance.
   */
  peekCache(): T[] | undefined {
    if (!this._engine) return undefined;
    const snap = this._engine.readQueryCache(this.descriptor);
    if (!snap.rows) return undefined;
    return this._project(snap.rows);
  }

  /**
   * Sync status read for cache consumers (e.g. React bindings). Mirrors the
   * cache snapshot status without exposing engine internals.
   */
  peekStatus(): { status: 'empty' | 'pending' | 'ready' | 'error'; error?: Error } {
    if (!this._engine) return { status: 'empty' };
    const snap = this._engine.readQueryCache(this.descriptor);
    return { status: snap.status, error: snap.error };
  }

  /**
   * Render-time read. If the engine is ready and a cache snapshot exists,
   * returns rows synchronously (no flash). Otherwise returns a promise.
   * If the engine is not ready and `mode === 'cache-first'`, falls back to
   * sync `undefined`-like behavior by returning a promise — caller decides.
   */
  readForRender(policy?: QueryExecutionPolicy): Promise<T[]> | T[] {
    const cached = this.peekCache();
    if (cached && policy?.mode !== 'bypass-cache') return cached;
    return this.load({ bypassCache: policy?.mode === 'bypass-cache' });
  }

  // eslint-disable-next-line unicorn/no-thenable -- QueryResult intentionally supports await/db.table(...).where(...).
  then<R1 = T[], R2 = never>(
    onfulfilled?: ((value: T[]) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.load().then(onfulfilled, onrejected);
  }

  /**
   * Sort the result. Same signature as `Array.prototype.sort`.
   * Sync-only. Does NOT change `cacheKey` — this is post-load derivation.
   */
  sort(compareFn: (a: T, b: T) => number): QueryResult<T> {
    // eslint-disable-next-line unicorn/no-array-sort -- package target/browser tests do not provide Array.prototype.toSorted.
    const next = (rows: T[]) => [...rows].sort(compareFn);
    return new QueryResult<T>(
      this.descriptor,
      this._engine,
      [...this._sortChain, next],
      this._explicitPromise,
    );
  }

  /**
   * Sort by a single field. Default: ascending.
   *
   * Deterministic and serializable, so it lives on the descriptor and
   * participates in `cacheKey`. Two queries with the same shape and the
   * same `orderBy` share a cache entry; differing only by direction or
   * field produces a distinct cache entry.
   *
   * Re-applying `orderBy` overwrites the previous one (last write wins).
   * The sync `.sort(compareFn)` chain is preserved on top of orderBy for
   * post-load derivations.
   */
  orderBy<K extends keyof T>(field: K, dir: 'asc' | 'desc' = 'asc'): QueryResult<T> {
    const nextDescriptor: QueryDescriptor = {
      ...this.descriptor,
      orderBy: { field: field as string, dir },
    };
    return new QueryResult<T>(
      nextDescriptor,
      this._engine,
      this._sortChain,
      this._explicitPromise,
    );
  }

  /**
   * Subscribe to changes that affect this query's table.
   * Returns an unsubscribe function. Currently table-wide; finer-grained
   * invalidation can be added in core later without changing this contract.
   */
  subscribe(cb: TableEventListener<T>): () => void {
    if (!this._engine) return () => {};
    const engine = this._engine;
    const tableName = this.descriptor.table;
    return engine.on(event => {
      if (event.type === 'change' && event.table === tableName) {
        cb({ type: 'change', rowId: event.rowId, row: rowToTyped<T>(event.row) });
      } else if (event.type === 'delete' && event.table === tableName) {
        cb({ type: 'delete', rowId: event.rowId });
      }
    });
  }

  // ─── internals ───────────────────────────────────────────────────

  /**
   * Memoization for the typed+sorted projection. Keyed by the raw rows
   * reference from the engine cache. Same input ref ⇒ same output ref.
   * Cleared automatically when the engine swaps in a fresh raw rows array
   * (e.g. after a write invalidation).
   */
  private _projectionInputRef: readonly Row[] | null = null;
  private _projectionOutput: T[] | null = null;

  private _project(rawRows: readonly Row[]): T[] {
    if (this._projectionInputRef === rawRows && this._projectionOutput !== null) {
      return this._projectionOutput;
    }
    const typed = rawRows.map(r => rowToTyped<T>(r));
    const sorted = this._applySort(typed);
    this._projectionInputRef = rawRows;
    this._projectionOutput = sorted;
    return sorted;
  }

  private _applySort(rows: T[]): T[] {
    if (this._sortChain.length === 0) return rows;
    let out = rows;
    for (const fn of this._sortChain) out = fn(out);
    return out;
  }

  private async _loadRaw(options?: QueryExecutionOptions): Promise<T[]> {
    if (this._explicitPromise) return this._explicitPromise;
    if (!this._engine) return [];
    const rawRows = await this._engine.loadQueryRows(this.descriptor, options);
    // Use the same projection cache so post-load + peekCache yield the
    // same reference for the same raw rows.
    return this._project(rawRows);
  }
}

/**
 * Stable, deterministic cache key derived from a query descriptor.
 *
 * Only async-affecting fields are included. Sync derivations (custom `sort`)
 * are intentionally excluded.
 */
export function computeCacheKey(descriptor: QueryDescriptor): string {
  const parts: string[] = [`t=${descriptor.table}`];
  if (descriptor.clause) {
    const c = descriptor.clause;
    parts.push(`w=${c.field}:${c.op}`);
    if (c.value !== undefined) parts.push(`v=${serializePrimitive(c.value)}`);
    if (c.values !== undefined) parts.push(`vs=${c.values.map(serializePrimitive).join(',')}`);
    if (c.lower !== undefined) parts.push(`l=${serializePrimitive(c.lower)}`);
    if (c.upper !== undefined) parts.push(`u=${serializePrimitive(c.upper)}`);
    if (c.lowerOpen) parts.push('lo=1');
    if (c.upperOpen) parts.push('uo=1');
  }
  if (descriptor.orderBy) {
    parts.push(`o=${descriptor.orderBy.field}:${descriptor.orderBy.dir}`);
  }
  return parts.join('|');
}

function serializePrimitive(v: WherePrimitive): string {
  if (v instanceof Date) return `d:${v.getTime()}`;
  if (typeof v === 'string') return `s:${v}`;
  if (typeof v === 'number') return `n:${v}`;
  if (typeof v === 'boolean') return `b:${v ? 1 : 0}`;
  return `x:${String(v)}`;
}

/**
 * Thenable result of a single-row read.
 *
 * Same contract as `QueryResult`, scaled down to one row:
 *  - identity is `descriptor` + `cacheKey`
 *  - `then(...)` / `load(...)` go through the engine row cache
 *  - `peekCache()` / `peekStatus()` are sync probes
 *  - `subscribe(cb)` fires on table events that touch the same rowId
 *
 * Returns `undefined` when the row is absent or deleted.
 */
export class RowResult<T extends Record<string, unknown>> implements PromiseLike<T | undefined> {
  readonly descriptor: RowDescriptor;
  readonly cacheKey: string;

  constructor(
    descriptor: RowDescriptor,
    private readonly _engine: AnyEngine | null,
  ) {
    this.descriptor = descriptor;
    this.cacheKey = _engine
      ? _engine.getRowCacheKey(descriptor)
      : `r=${descriptor.table}|id=${descriptor.rowId}`;
  }

  get metadata() {
    return { descriptor: this.descriptor, cacheKey: this.cacheKey };
  }

  /**
   * Memoization for the typed projection. Keyed by the raw row reference.
   * Same input ref ⇒ same output ref — required by useSyncExternalStore
   * consumers and by selector memoization in the React hooks.
   */
  private _projectionInputRef: Row | null = null;
  private _projectionOutput: T | null = null;

  private _project(rawRow: Row | null | undefined): T | undefined {
    if (!rawRow) return undefined;
    if (this._projectionInputRef === rawRow && this._projectionOutput !== null) {
      return this._projectionOutput;
    }
    const typed = rowToTyped<T>(rawRow);
    this._projectionInputRef = rawRow;
    this._projectionOutput = typed;
    return typed;
  }

  load(options?: QueryExecutionOptions): Promise<T | undefined> {
    if (!this._engine) return Promise.resolve(undefined);
    return this._engine.loadRow(this.descriptor, options).then(r => this._project(r));
  }

  /**
   * Sync cached row, or `undefined` if the cache has no row. Pending/error
   * snapshots may still carry the previous row for stale-while-revalidate.
   */
  peekCache(): T | undefined {
    if (!this._engine) return undefined;
    const snap = this._engine.readRowCache(this.descriptor);
    return this._project(snap.row);
  }

  peekStatus(): { status: 'empty' | 'pending' | 'ready' | 'error'; error?: Error } {
    if (!this._engine) return { status: 'empty' };
    const snap = this._engine.readRowCache(this.descriptor);
    return { status: snap.status, error: snap.error };
  }

  readForRender(policy?: QueryExecutionPolicy): Promise<T | undefined> | T | undefined {
    const cached = this.peekCache();
    if (cached !== undefined && policy?.mode !== 'bypass-cache') return cached;
    return this.load({ bypassCache: policy?.mode === 'bypass-cache' });
  }

  // eslint-disable-next-line unicorn/no-thenable -- RowResult intentionally supports await/db.table(...).row(...).
  then<R1 = T | undefined, R2 = never>(
    onfulfilled?: ((value: T | undefined) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.load().then(onfulfilled, onrejected);
  }

  /**
   * Subscribe to changes that touch this row's `rowId`.
   * Returns an unsubscribe function. Filtering done here so callers don't
   * see unrelated table events.
   */
  subscribe(cb: TableEventListener<T>): () => void {
    if (!this._engine) return () => {};
    const engine = this._engine;
    const { table, rowId } = this.descriptor;
    return engine.on(event => {
      if (event.type === 'change' && event.table === table && event.rowId === rowId) {
        cb({ type: 'change', rowId: event.rowId, row: rowToTyped<T>(event.row) });
      } else if (event.type === 'delete' && event.table === table && event.rowId === rowId) {
        cb({ type: 'delete', rowId: event.rowId });
      }
    });
  }
}

function rowToTyped<T extends Record<string, unknown>>(row: Row): T {
  // Project payload only. _meta is engine-private; user types never see it.
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(row.payload)) {
    result[key] = entry.value;
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

  /**
   * Build a single-row handle. Same descriptor + cacheKey contract as
   * `query()`, scaled down to one row. Lazy: nothing fetched until
   * `then()` / `load()` / `readForRender()` is called.
   *
   * Use `await table.row(id)` for an async fetch, `table.row(id).peekCache()`
   * for a sync cache read, or pass the handle directly to `useRow`.
   */
  row(rowId: string): RowResult<T> {
    return new RowResult<T>({ table: this.name, rowId }, this.engine);
  }

  /** Retrieve all live (non-deleted) records in this collection. */
  query(): QueryResult<T> {
    return new QueryResult<T>({ table: this.name }, this.engine);
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

  /** Back-compat alias for older code paths. */
  async put(rowId: string, data: Partial<T>, userId?: string): Promise<T> {
    return this.patch(rowId, data, userId);
  }

  /**
   * Replace a record — writes ALL fields in `data`, explicitly nulling any
   * fields present in the existing row but absent from `data`.
   * Returns the full row.
   */
  async replace(rowId: string, data: T, userId?: string): Promise<T> {
    // Iterate ONLY existing payload keys. Meta is in a separate namespace
    // and must never appear as a "field" to be nulled.
    const existing = await this.engine.loadRow({ table: this.name, rowId });
    const existingPayloadKeys = existing ? Object.keys(existing.payload) : [];
    const nulled = Object.fromEntries(
      existingPayloadKeys.filter(k => !(k in data)).map(k => [k, null]),
    );
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
    const fullClause = { field: this.field, ...clause } as WhereClause;
    return new QueryResult<T>({ table: this.table, clause: fullClause }, this.engine);
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

