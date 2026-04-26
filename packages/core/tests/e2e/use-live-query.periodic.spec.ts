import { expect, test } from '@playwright/test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { Interocitor } from '../../dist/core/sync-engine.js';
import { MemoryAdapter } from '../../dist/adapters/memory.js';
import { useLiveQuery } from '../../../react/src/use-live-query.ts';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type ColumnValue = string | number | boolean | null | object;
type ChangeEntry = {
  id: string;
  ts: number;
  device: string;
  hlc: string;
  ops: unknown[];
};
type Row = {
  _meta: { table: string; rowId: string; deleted?: boolean };
  payload: Record<string, { value: ColumnValue; hlc: string }>;
};
type WhereClause = {
  field: string;
  op: 'equals' | 'above' | 'aboveOrEqual' | 'below' | 'belowOrEqual' | 'between' | 'startsWith' | 'anyOf';
  value?: string | number | boolean | Date;
  lower?: string | number | boolean | Date;
  upper?: string | number | boolean | Date;
  values?: Array<string | number | boolean | Date>;
};
interface LocalStoreAdapter {
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

class InMemoryLocalStore implements LocalStoreAdapter {
  private rows = new Map<string, Row>();
  private outbox: ChangeEntry[] = [];
  private cursors = new Map<string, number>();
  private meta = new Map<string, unknown>();

  async open(): Promise<void> {}
  close(): void {}

  private key(table: string, rowId: string): string {
    return `${table}\u0000${rowId}`;
  }

  async getRow(table: string, rowId: string): Promise<Row | undefined> {
    return this.rows.get(this.key(table, rowId));
  }

  async putRow(row: Row): Promise<void> {
    this.rows.set(this.key(row._meta.table, row._meta.rowId), row);
  }

  async putRows(rows: Row[]): Promise<void> {
    for (const row of rows) await this.putRow(row);
  }

  async getTable(table: string): Promise<Row[]> {
    return [...this.rows.values()].filter(row => row._meta.table === table && !row._meta.deleted);
  }

  async queryWhere(table: string, clause: WhereClause): Promise<Row[]> {
    const rows = await this.getTable(table);
    return rows.filter(row => {
      const entry = row.payload[clause.field];
      const value = entry?.value as string | number | boolean | Date | undefined;
      if (value === undefined) return false;
      switch (clause.op) {
        case 'equals': return value === clause.value;
        case 'above': return value > clause.value!;
        case 'aboveOrEqual': return value >= clause.value!;
        case 'below': return value < clause.value!;
        case 'belowOrEqual': return value <= clause.value!;
        case 'between': return value >= clause.lower! && value <= clause.upper!;
        case 'startsWith': return typeof value === 'string' && value.startsWith(String(clause.value ?? ''));
        case 'anyOf': return (clause.values ?? []).includes(value as any);
        default: return false;
      }
    });
  }

  async getAllRows(): Promise<Row[]> {
    return [...this.rows.values()];
  }

  async clearRows(): Promise<void> {
    this.rows.clear();
  }

  async getTableNames(): Promise<string[]> {
    return [...new Set([...this.rows.values()].map(row => row._meta.table))];
  }

  async pushOutbox(entry: ChangeEntry): Promise<void> {
    this.outbox.push(entry);
  }

  async pushOutboxEntries(entries: ChangeEntry[]): Promise<void> {
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

  async getCursor(deviceId: string): Promise<number> {
    return this.cursors.get(deviceId) ?? 0;
  }

  async setCursor(deviceId: string, offset: number): Promise<void> {
    this.cursors.set(deviceId, offset);
  }

  async getAllCursors(): Promise<Record<string, number>> {
    return Object.fromEntries(this.cursors);
  }

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

function renderedText(renderer: ReactTestRenderer): string {
  const tree = renderer.toJSON();
  if (!tree || Array.isArray(tree)) return '';
  return tree.children?.join('') ?? '';
}

async function waitFor(assertion: () => void | Promise<void>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await act(async () => {
        await assertion();
      });
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 25));
      });
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

test('useLiveQuery updates when periodic polling pulls remote rows', async () => {
  type Task = { title: string };
  type Schema = { tasks: Task };

  const remote = new MemoryAdapter();
  const writer = new Interocitor<Schema>(remote, {
    remotePath: '/LiveQueryPeriodic',
    encrypted: false,
    deviceId: 'live_query_writer',
    pollInterval: 60_000,
    flushThreshold: 1,
    batchWindowMs: 0,
    localStoreFactory: () => new InMemoryLocalStore(),
  });
  const reader = new Interocitor<Schema>(remote, {
    remotePath: '/LiveQueryPeriodic',
    encrypted: false,
    deviceId: 'live_query_reader',
    pollInterval: 25,
    flushThreshold: 999,
    batchWindowMs: 0,
    localStoreFactory: () => new InMemoryLocalStore(),
  });

  let renderer: ReactTestRenderer | null = null;

  function TaskTitles() {
    const result = useLiveQuery(
      () => reader.table('tasks').query().orderBy('title'),
      [reader],
      rows => rows.map(row => row.title).join(','),
    );
    return React.createElement('div', { id: 'titles' }, result.data ?? (result.loading ? 'loading' : 'empty'));
  }

  try {
    await writer.init();
    await reader.init();
    await writer.connect();
    await reader.connect();

    await act(async () => {
      renderer = create(React.createElement(TaskTitles));
    });

    await waitFor(() => {
      expect(renderedText(renderer!)).toBe('');
    });

    await writer.put('tasks', 'task-from-remote', { title: 'remote periodic task' });
    await writer.flush();

    await waitFor(() => {
      expect(renderedText(renderer!)).toBe('remote periodic task');
    });
  } finally {
    await act(async () => {
      renderer?.unmount();
    });
    await reader.disconnect().catch(() => undefined);
    await writer.disconnect().catch(() => undefined);
  }
});
