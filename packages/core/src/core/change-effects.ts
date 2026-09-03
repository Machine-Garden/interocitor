/**
 * Endpoint-relative row effects for live change observation.
 *
 * The wire operation is not itself a diff: upserts can carry unchanged CRDT
 * columns, while merge can accept only part of an operation. This module owns
 * the before/after comparison used by both local and remote observations.
 */

import type {
  ChangeEntry,
  ColumnChangeEffect,
  ColumnEntry,
  Op,
  Row,
  RowChangeEffect,
} from "./types.ts";

interface CapturedRow {
  table: string;
  rowId: string;
  before?: Row;
}

function rowKey(table: string, rowId: string): string {
  return JSON.stringify([table, rowId]);
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => valuesEqual(value, right[index]))
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
      (key, index) => key === rightKeys[index] && valuesEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

function columnEntriesEqual(left?: ColumnEntry, right?: ColumnEntry): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.hlc === right.hlc && valuesEqual(left.value, right.value);
}

export function cloneRow(row: Row): Row {
  return structuredClone(row);
}

export function cloneChangeEntry(entry: ChangeEntry): ChangeEntry {
  return structuredClone(entry);
}

export function captureRowsForOps(
  tables: Record<string, Record<string, Row>>,
  ops: readonly Op[],
): Map<string, CapturedRow> {
  const captured = new Map<string, CapturedRow>();
  for (const op of ops) {
    const key = rowKey(op.table, op.rowId);
    if (captured.has(key)) continue;
    const row = tables[op.table]?.[op.rowId];
    captured.set(key, {
      table: op.table,
      rowId: op.rowId,
      before: row ? cloneRow(row) : undefined,
    });
  }
  return captured;
}

export function createRowChangeEffect(
  table: string,
  rowId: string,
  before: Row | undefined,
  after: Row | undefined,
): RowChangeEffect | null {
  if (!after) return null;

  const fields: Record<string, ColumnChangeEffect> = {};
  const names = new Set([...Object.keys(before?.payload ?? {}), ...Object.keys(after.payload)]);
  for (const name of names) {
    const previous = before?.payload[name];
    const next = after.payload[name];
    if (columnEntriesEqual(previous, next)) continue;
    fields[name] = {
      ...(previous === undefined ? {} : { before: structuredClone(previous) }),
      ...(next === undefined ? {} : { after: structuredClone(next) }),
    };
  }

  const beforeDeleted = before?._meta.deleted ?? false;
  const afterDeleted = after._meta.deleted;
  const kind = afterDeleted ? "delete" : beforeDeleted ? "resurrect" : before ? "update" : "create";

  if (before && beforeDeleted === afterDeleted && Object.keys(fields).length === 0) return null;

  return { table, rowId, kind, fields };
}

export function effectsFromCapturedRows(
  tables: Record<string, Record<string, Row>>,
  captured: ReadonlyMap<string, CapturedRow>,
): RowChangeEffect[] {
  const effects: RowChangeEffect[] = [];
  for (const { table, rowId, before } of captured.values()) {
    const effect = createRowChangeEffect(table, rowId, before, tables[table]?.[rowId]);
    if (effect) effects.push(effect);
  }
  return effects;
}
