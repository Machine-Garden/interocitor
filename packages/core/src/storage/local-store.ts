// compass: interocitor.rows.local-store

import type { ChangeEntry, Row, WhereClause } from "../core/types.ts";

/** Identifies one row for batched reads. */
export interface RowRef {
  table: string;
  rowId: string;
}

/**
 * Contract every local persistence implementation must satisfy.
 *
 * The local store is a durable cache for rows, pending outbox entries,
 * remote cursors, and engine metadata. Runtimes own the concrete backend:
 * memory for tests, browser storage in web packages, and future Node stores.
 */
export interface LocalStore {
  /** Serialize a named correctness-critical operation across store wrappers. */
  withLock<T>(name: string, operation: () => Promise<T>): Promise<T>;
  open(): Promise<void>;
  close(): void;

  getRow(table: string, rowId: string): Promise<Row | undefined>;
  /** Read many rows at once; the result is positionally aligned with `refs`. */
  getRows(refs: readonly RowRef[]): Promise<(Row | undefined)[]>;
  putRow(row: Row): Promise<void>;
  putRows(rows: Row[]): Promise<void>;
  getTable(table: string): Promise<Row[]>;
  queryWhere(table: string, clause: WhereClause): Promise<Row[]>;
  getAllRows(): Promise<Row[]>;
  clearRows(): Promise<void>;
  getTableNames(): Promise<string[]>;

  /**
   * Durably write `row` and append `change.ops` to the pending batch in one
   * atomic step. The first change of a batch fixes its id, ts, and device;
   * later changes only advance the batch HLC and add ops.
   */
  commitLocalMutation(row: Row, change: ChangeEntry): Promise<void>;
  /** Read the pending batch (if any) without promoting it. */
  peekPendingBatch(): Promise<ChangeEntry | null>;
  /** Move the pending batch to the outbox and return it. */
  promotePendingBatch(): Promise<ChangeEntry | null>;
  pushOutbox(entry: ChangeEntry): Promise<void>;
  pushOutboxEntries(entries: ChangeEntry[]): Promise<void>;
  peekOutbox(): Promise<ChangeEntry[]>;
  acknowledgeOutbox(entryIds: readonly string[]): Promise<void>;
  drainOutbox(): Promise<ChangeEntry[]>;
  outboxSize(): Promise<number>;

  getCursor(deviceId: string): Promise<number>;
  setCursor(deviceId: string, offset: number): Promise<void>;
  getAllCursors(): Promise<Record<string, number>>;

  getMeta(key: string): Promise<unknown>;
  setMeta(key: string, value: unknown): Promise<void>;
  clearAll(): Promise<void>;
}
