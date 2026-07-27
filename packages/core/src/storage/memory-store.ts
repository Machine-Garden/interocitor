/**
 * In-memory local store.
 *
 * Implements the `LocalStore` contract, but holds everything in plain JS
 * structures. No persistence.
 *
 * Useful for tests, local-only demos, and runtime fallbacks.
 */

import type {
  Row,
  ChangeEntry,
  WhereClause,
  WherePrimitive,
} from '../core/types.ts';
import type { LocalStore } from './local-store.ts';

function compare(a: WherePrimitive, b: WherePrimitive): number {
  const av = a instanceof Date ? a.getTime() : a;
  const bv = b instanceof Date ? b.getTime() : b;
  if (av < bv) return -1;
  if (av > bv) return 1;
  return 0;
}

function readColumnValue(row: Row, field: string): unknown {
  const entry = row.payload?.[field];
  if (entry === undefined) return undefined;
  return entry.value;
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

function rowKey(table: string, rowId: string): string {
  return `${table}/${rowId}`;
}

/**
 * Volatile in-memory local store. Survives until close()/page reload.
 *
 * No schema awareness, no indexes — `queryWhere` is a linear scan.
 * That's fine: this store exists for fallback paths, not happy paths.
 */
export class MemoryLocalStore implements LocalStore {
  private rows = new Map<string, Row>();
  private outbox: ChangeEntry[] = [];
  private cursors = new Map<string, number>();
  private meta = new Map<string, unknown>();

  // Opening cannot block or fail. Closing clears every volatile record so a
  // disconnected test/fallback engine cannot leak state into later reuse.
  async open(): Promise<void> { /* noop */ }
  close(): void {
    this.rows.clear();
    this.outbox = [];
    this.cursors.clear();
    this.meta.clear();
  }

  // ── Rows ─────────────────────────────────────────────────────────

  async getRow(table: string, rowId: string): Promise<Row | undefined> {
    return this.rows.get(rowKey(table, rowId));
  }

  async putRow(row: Row): Promise<void> {
    const key = rowKey(row._meta.table, row._meta.rowId);
    this.rows.set(key, { ...row, _meta: { ...row._meta, key }, payload: row.payload });
  }

  async putRows(rows: Row[]): Promise<void> {
    for (const row of rows) await this.putRow(row);
  }

  async getTable(table: string): Promise<Row[]> {
    const out: Row[] = [];
    for (const row of this.rows.values()) {
      if (row._meta.table === table && !row._meta.deleted) out.push(row);
    }
    return out;
  }

  async queryWhere(table: string, clause: WhereClause): Promise<Row[]> {
    const rows = await this.getTable(table);
    return rows.filter(row => matchesClause(readColumnValue(row, clause.field), clause));
  }

  async getTableNames(): Promise<string[]> {
    const names = new Set<string>();
    for (const row of this.rows.values()) {
      const t = row._meta?.table;
      if (t) names.add(t);
    }
    return Array.from(names);
  }

  async getAllRows(): Promise<Row[]> {
    return Array.from(this.rows.values());
  }

  async clearRows(): Promise<void> {
    this.rows.clear();
  }

  // ── Outbox ───────────────────────────────────────────────────────

  async pushOutbox(entry: ChangeEntry): Promise<void> {
    this.outbox.push(entry);
  }

  async pushOutboxEntries(entries: ChangeEntry[]): Promise<void> {
    if (entries.length === 0) return;
    this.outbox.push(...entries);
  }

  async drainOutbox(): Promise<ChangeEntry[]> {
    const drained = this.outbox;
    this.outbox = [];
    return drained;
  }

  async outboxSize(): Promise<number> {
    return this.outbox.length;
  }

  // ── Cursors ──────────────────────────────────────────────────────

  async getCursor(deviceId: string): Promise<number> {
    return this.cursors.get(deviceId) ?? 0;
  }

  async setCursor(deviceId: string, offset: number): Promise<void> {
    this.cursors.set(deviceId, offset);
  }

  async getAllCursors(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.cursors) out[k] = v;
    return out;
  }

  // ── Meta ─────────────────────────────────────────────────────────

  async getMeta(key: string): Promise<unknown> {
    return this.meta.get(key);
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    this.meta.set(key, value);
  }

  async clearAll(): Promise<void> {
    this.rows.clear();
    this.outbox = [];
    this.cursors.clear();
    this.meta.clear();
  }
}
