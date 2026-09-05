// compass: interocitor.rows.crdt-merge

/**
 * CRDT Merge Engine — configurable per-column merge strategy.
 *
 * Each column in each row carries its own HLC.
 * The merge strategy determines which value wins on conflict:
 *
 *  - `'lww'`         — Last-Writer-Wins. Highest HLC wins. (Default)
 *  - custom function  — `(existing, incoming, ctx) => ColumnEntry`; callers
 *    must supply a deterministic, commutative, associative, idempotent merge.
 *
 * Deletes are soft (tombstone with HLC) and always use LWW.
 *
 * Row shape (`{_meta, payload}`) keeps user payload fully isolated from
 * engine metadata. The merge loop only touches `row.payload`; `row._meta`
 * is never indexed by user-controlled keys.
 */

import type {
  Row,
  Op,
  ColumnEntry,
  ChangeEntry,
  DatabaseSchemaDefinition,
  MergeStrategy,
  TableMergeConfig,
} from "./types.ts";
import { hlcCompareStr } from "./hlc.ts";

/**
 * Resolve the merge strategy for a specific column.
 *
 * Resolution order (first defined wins):
 *   field-level → table-level → database-level → 'lww'
 */
function resolveStrategy(
  schema: DatabaseSchemaDefinition | undefined,
  table: string,
  field: string,
): MergeStrategy {
  const requireConvergentStrategy = (strategy: unknown): MergeStrategy => {
    if (strategy === "lww" || typeof strategy === "function") return strategy as MergeStrategy;
    throw new Error(
      `Unsupported replicated merge strategy ${JSON.stringify(strategy)} for ${table}.${field}; use "lww" or a convergent custom merge`,
    );
  };
  const tableDef = schema?.tables[table];
  if (tableDef?.merge) {
    const m = tableDef.merge;
    if (typeof m === "object" && ("fields" in m || "strategy" in m)) {
      const config = m as TableMergeConfig;
      if (config.fields?.[field]) return requireConvergentStrategy(config.fields[field]);
      if (config.strategy) return requireConvergentStrategy(config.strategy);
    } else {
      return requireConvergentStrategy(m);
    }
  }
  return schema?.mergeStrategy ? requireConvergentStrategy(schema.mergeStrategy) : "lww";
}

function columnValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => columnValuesEqual(value, right[index]))
    );
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  // Object.keys() returns fresh arrays, and the package targets ES2022.
  // eslint-disable-next-line unicorn/no-array-sort
  const leftKeys = Object.keys(leftRecord).sort();
  // eslint-disable-next-line unicorn/no-array-sort
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && columnValuesEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

/**
 * Decide which column entry wins given a strategy.
 *
 * `existing` may be undefined (new column). In that case, incoming always wins
 * regardless of strategy — there's no conflict.
 */
function mergeColumn(
  existing: ColumnEntry | undefined,
  incoming: ColumnEntry,
  strategy: MergeStrategy,
  table: string,
  rowId: string,
  field: string,
): ColumnEntry | null {
  if (!existing || !existing.hlc) return incoming;

  if (typeof strategy === "function") {
    const result = strategy(existing, incoming, { table, rowId, field });
    return result.hlc !== existing.hlc || !columnValuesEqual(result.value, existing.value)
      ? result
      : null;
  }

  const comparison = hlcCompareStr(incoming.hlc, existing.hlc);
  if (comparison > 0) return incoming;
  if (comparison < 0) return null;
  if (!columnValuesEqual(existing.value, incoming.value)) {
    throw new Error(`Conflicting values share HLC ${incoming.hlc} at ${table}/${rowId}.${field}`);
  }
  return null;
}

/** Build a fresh row stub. */
function blankRow(
  table: string,
  rowId: string,
  schemaVersion: number,
  deleted = false,
  deletedHlc?: string,
): Row {
  return {
    _meta: { table, rowId, deleted, deletedHlc, schemaVersion },
    payload: {},
  };
}

/**
 * Apply a single op to the in-memory state.
 * Returns the affected row (mutated in place) or null if no change.
 */
export function applyOp(
  tables: Record<string, Record<string, Row>>,
  op: Op,
  schemaVersion: number,
  schema?: DatabaseSchemaDefinition,
): Row | null {
  if (!tables[op.table]) {
    tables[op.table] = {};
  }
  const table = tables[op.table];

  if (op.type === "delete") {
    const existing = table[op.rowId];
    if (existing) {
      // Stale delete (older than current tombstone)?
      if (existing._meta.deletedHlc && hlcCompareStr(op.hlc, existing._meta.deletedHlc) <= 0) {
        return null;
      }
      // Any payload column newer than this delete? Then delete loses.
      const hasNewerColumn = Object.values(existing.payload).some((entry) => {
        return entry?.hlc && hlcCompareStr(entry.hlc, op.hlc) > 0;
      });
      if (hasNewerColumn) return null;

      existing._meta.deleted = true;
      existing._meta.deletedHlc = op.hlc;
      // A tombstone only needs deletedHlc for future conflict checks. Keeping
      // payload columns wastes storage and can leak pre-delete values into
      // future row incarnations.
      existing.payload = {};
      return existing;
    }
    // Tombstone for unseen row.
    const row = blankRow(op.table, op.rowId, schemaVersion, true, op.hlc);
    table[op.rowId] = row;
    return row;
  }

  // Upsert.
  let row = table[op.rowId];
  let changed = false;

  if (!row) {
    row = blankRow(op.table, op.rowId, schemaVersion);
    table[op.rowId] = row;
    changed = true;
  }

  let columnsToApply = Object.entries(op.columns);

  // Resurrection creates a new row incarnation. The tombstone wins over every
  // payload column at or before deletedHlc, including columns retained on the
  // local tombstone and stale columns bundled in a remote upsert. Otherwise a
  // partial insert after delete can republish pre-delete fields forever.
  if (row._meta.deleted && row._meta.deletedHlc) {
    const deletedHlc = row._meta.deletedHlc;
    columnsToApply = columnsToApply.filter(([, entry]) => hlcCompareStr(entry.hlc, deletedHlc) > 0);
    if (columnsToApply.length === 0) return null;

    row.payload = {};
    row._meta.deleted = false;
    row._meta.deletedHlc = undefined;
    changed = true;
  }

  for (const [col, entry] of columnsToApply) {
    const existing = row.payload[col];
    const strategy = resolveStrategy(schema, op.table, col);
    const winner = mergeColumn(existing, entry, strategy, op.table, op.rowId, col);
    if (winner) {
      row.payload[col] = winner;
      changed = true;
    }
  }

  return changed ? row : null;
}

/**
 * Apply a full change entry (potentially multiple ops).
 * Returns list of affected rows.
 */
export function applyChangeEntry(
  tables: Record<string, Record<string, Row>>,
  entry: ChangeEntry,
  schemaVersion: number,
  schema?: DatabaseSchemaDefinition,
): Row[] {
  const affected: Row[] = [];
  for (const op of entry.ops) {
    const row = applyOp(tables, op, schemaVersion, schema);
    if (row) affected.push(row);
  }
  return affected;
}

/** Read a column value from a row, unwrapping the ColumnEntry. */
export function readColumn(row: Row, column: string): unknown {
  const entry = row.payload?.[column];
  return entry?.value;
}

/**
 * Build a plain object from a row (strip HLC metadata).
 * Returns user-facing fields with `_meta` projection (table, rowId, deleted).
 */
export function rowToPlain(row: Row): Record<string, unknown> {
  const result: Record<string, unknown> = {
    _table: row._meta.table,
    _rowId: row._meta.rowId,
    _deleted: row._meta.deleted,
  };
  for (const [key, entry] of Object.entries(row.payload)) {
    result[key] = entry.value;
  }
  return result;
}
