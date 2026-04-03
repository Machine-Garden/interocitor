/**
 * CRDT Merge Engine — Last-Writer-Wins per column
 *
 * Each column in each row carries its own HLC.
 * The highest HLC wins for that column independently.
 * Deletes are soft (tombstone with HLC).
 */

import type { Row, Op, ColumnEntry, ChangeEntry } from './types.ts';
import { hlcCompareStr } from './hlc.ts';

/** Reserved keys that are not user columns */
const META_KEYS = new Set(['_table', '_rowId', '_deleted', '_deletedHlc', '_schemaVersion']);

/**
 * Apply a single op to the in-memory state.
 * Returns the affected row (mutated in place) or null if no change.
 */
export function applyOp(
  tables: Record<string, Record<string, Row>>,
  op: Op,
  schemaVersion: number
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
    if (!existing || !existing.hlc || hlcCompareStr(entry.hlc, existing.hlc) > 0) {
      row[col] = entry;
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
  schemaVersion: number
): Row[] {
  const affected: Row[] = [];
  for (const op of entry.ops) {
    const row = applyOp(tables, op, schemaVersion);
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
