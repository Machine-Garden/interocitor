/**
 * CRDT Merge Engine — configurable per-column merge strategy.
 *
 * Each column in each row carries its own HLC.
 * The merge strategy determines which value wins on conflict:
 *
 *  - `'remote-wins'` — Remote always overwrites local. (Default)
 *  - `'lww'`         — Last-Writer-Wins. Highest HLC wins.
 *  - `'local-wins'`  — Keep local value when both exist.
 *  - custom function  — `(local, remote, ctx) => ColumnEntry`
 *
 * Deletes are soft (tombstone with HLC) and always use LWW.
 */

import type {
  Row,
  Op,
  ColumnEntry,
  ChangeEntry,
  DatabaseSchemaDefinition,
  MergeStrategy,
  TableMergeConfig,
} from './types.ts';
import { hlcCompareStr } from './hlc.ts';

/** Reserved keys that are not user columns */
const META_KEYS = new Set(['_table', '_rowId', '_deleted', '_deletedHlc', '_schemaVersion']);

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
  const tableDef = schema?.tables[table];
  if (tableDef?.merge) {
    const m = tableDef.merge;
    if (typeof m === 'object' && 'fields' in m) {
      // TableMergeConfig
      const config = m as TableMergeConfig;
      if (config.fields?.[field]) return config.fields[field];
      if (config.strategy) return config.strategy;
    } else {
      // bare MergeStrategy (string or function) on the table
      return m as MergeStrategy;
    }
  }
  // No schema at all → LWW (backwards compat for raw applyOp callers).
  // Schema present but no mergeStrategy → remote-wins (sensible default).
  if (!schema) return 'lww';
  return schema.mergeStrategy ?? 'remote-wins';
}

/**
 * Decide which column entry wins given a strategy.
 *
 * `local` may be undefined (new column). In that case, remote always wins
 * regardless of strategy — there's no conflict.
 */
function mergeColumn(
  local: ColumnEntry | undefined,
  remote: ColumnEntry,
  strategy: MergeStrategy,
  table: string,
  rowId: string,
  field: string,
): ColumnEntry | null {
  // No local value → accept remote unconditionally
  if (!local || !local.hlc) return remote;

  if (typeof strategy === 'function') {
    const result = strategy(local, remote, { table, rowId, field });
    // Only count as changed if the result differs from local
    return result.hlc !== local.hlc || result.value !== local.value ? result : null;
  }

  switch (strategy) {
    case 'remote-wins':
      return remote;

    case 'local-wins':
      // Only accept remote if it's strictly newer (no conflict — local
      // hasn't written this column yet at this HLC).
      // When both have values, local keeps its value.
      return null;

    case 'lww':
    default:
      return hlcCompareStr(remote.hlc, local.hlc) > 0 ? remote : null;
  }
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

  if (op.type === 'delete') {
    const existing = table[op.rowId];
    if (existing) {
      // Only apply delete if its HLC is newer than all column HLCs
      if (existing._deletedHlc && hlcCompareStr(op.hlc, existing._deletedHlc) <= 0) {
        return null; // stale delete
      }
      // Check if any column has a newer HLC than this delete
      const hasNewerColumn = Object.entries(existing).some(([key, val]) => {
        if (META_KEYS.has(key)) return false;
        const entry = val as ColumnEntry;
        return entry?.hlc && hlcCompareStr(entry.hlc, op.hlc) > 0;
      });
      if (hasNewerColumn) return null;

      existing._deleted = true;
      existing._deletedHlc = op.hlc;
      return existing;
    } else {
      // Tombstone for a row we haven't seen — create it
      const row: Row = {
        _table: op.table,
        _rowId: op.rowId,
        _deleted: true,
        _deletedHlc: op.hlc,
        _schemaVersion: schemaVersion,
      };
      table[op.rowId] = row;
      return row;
    }
  }

  // Upsert
  let row = table[op.rowId];
  let changed = false;

  if (!row) {
    row = {
      _table: op.table,
      _rowId: op.rowId,
      _deleted: false,
      _schemaVersion: schemaVersion,
    };
    table[op.rowId] = row;
    changed = true;
  }

  for (const [col, entry] of Object.entries(op.columns)) {
    const existing = row[col] as ColumnEntry | undefined;
    const strategy = resolveStrategy(schema, op.table, col);
    const winner = mergeColumn(existing, entry, strategy, op.table, op.rowId, col);
    if (winner) {
      row[col] = winner;
      changed = true;
    }
  }

  // An upsert that's newer than a delete revives the row
  if (row._deleted && row._deletedHlc) {
    const newestOpHlc = Object.values(op.columns).reduce((max, entry) => {
      return !max || hlcCompareStr(entry.hlc, max) > 0 ? entry.hlc : max;
    }, '' as string);

    if (newestOpHlc && hlcCompareStr(newestOpHlc, row._deletedHlc) > 0) {
      row._deleted = false;
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

/**
 * Read a column value from a row, unwrapping the ColumnEntry.
 */
export function readColumn(row: Row, column: string): unknown {
  const entry = row[column];
  if (entry && typeof entry === 'object' && 'value' in entry && 'hlc' in entry) {
    return (entry as ColumnEntry).value;
  }
  return undefined;
}

/**
 * Build a plain object from a row (strip HLC metadata).
 */
export function rowToPlain(row: Row): Record<string, unknown> {
  const result: Record<string, unknown> = {
    _table: row._table,
    _rowId: row._rowId,
    _deleted: row._deleted,
  };
  for (const [key, val] of Object.entries(row)) {
    if (META_KEYS.has(key)) continue;
    if (val && typeof val === 'object' && 'value' in val && 'hlc' in val) {
      result[key] = (val as ColumnEntry).value;
    }
  }
  return result;
}
