import type {
  ChangeEntry,
  Row,
  WhereClause,
} from '../core/types.ts';

/**
 * Contract every local persistence implementation must satisfy.
 *
 * The local store is a durable cache for rows, pending outbox entries,
 * remote cursors, and engine metadata. Runtimes own the concrete backend:
 * memory for tests, browser storage in web packages, and future Node stores.
 */
export interface LocalStore {
  open(): Promise<void>;
  close(): void;

  getRow(table: string, rowId: string): Promise<Row | undefined>;
  putRow(row: Row): Promise<void>;
  putRows(rows: Row[]): Promise<void>;
  getTable(table: string): Promise<Row[]>;
  queryWhere(table: string, clause: WhereClause): Promise<Row[]>;
  getAllRows(): Promise<Row[]>;
  clearRows(): Promise<void>;
  getTableNames(): Promise<string[]>;

  pushOutbox(entry: ChangeEntry): Promise<void>;
  pushOutboxEntries(entries: ChangeEntry[]): Promise<void>;
  drainOutbox(): Promise<ChangeEntry[]>;
  outboxSize(): Promise<number>;

  getCursor(deviceId: string): Promise<number>;
  setCursor(deviceId: string, offset: number): Promise<void>;
  getAllCursors(): Promise<Record<string, number>>;

  getMeta(key: string): Promise<unknown>;
  setMeta(key: string, value: unknown): Promise<void>;
  clearAll(): Promise<void>;
}
