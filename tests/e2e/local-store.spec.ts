import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/e2e/fixtures/harness.html');
  await page.evaluate(async () => {
    // Delete the database before each test to ensure clean state
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase('interocitor');
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => resolve(); // best effort
    });
  });
});

// ─── Basic row CRUD ──────────────────────────────────────────────────

test.describe('LocalStore — row operations', () => {
  test('putRow + getRow round-trip', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { LocalStore } = await import('/dist/storage/local-store.js');
      const store = new LocalStore();
      await store.open();

      const row = {
        _table: 'tasks', _rowId: 't1', _deleted: false, _schemaVersion: 1,
        title: { value: 'Test', hlc: '000001000000000000-0000-dev_a' },
      };
      await store.putRow(row);
      const retrieved = await store.getRow('tasks', 't1');

      store.close();
      return retrieved;
    });

    expect(result).toBeTruthy();
    expect(result._table).toBe('tasks');
    expect(result._rowId).toBe('t1');
    expect(result.title.value).toBe('Test');
  });

  test('getRow returns undefined for missing row', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { LocalStore } = await import('/dist/storage/local-store.js');
      const store = new LocalStore();
      await store.open();
      const row = await store.getRow('nope', 'nope');
      store.close();
      return row;
    });

    expect(result).toBeUndefined();
  });

  test('putRows writes multiple rows atomically', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { LocalStore } = await import('/dist/storage/local-store.js');
      const store = new LocalStore();
      await store.open();

      await store.putRows([
        { _table: 't', _rowId: 'r1', _deleted: false, _schemaVersion: 1 },
        { _table: 't', _rowId: 'r2', _deleted: false, _schemaVersion: 1 },
        { _table: 't', _rowId: 'r3', _deleted: false, _schemaVersion: 1 },
      ]);
      const all = await store.getAllRows();
      store.close();
      return all.length;
    });

    expect(result).toBe(3);
  });

  test('getTable returns only rows for that table (excluding deleted)', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { LocalStore } = await import('/dist/storage/local-store.js');
      const store = new LocalStore();
      await store.open();

      await store.putRows([
        { _table: 'meals', _rowId: 'm1', _deleted: false, _schemaVersion: 1 },
        { _table: 'meals', _rowId: 'm2', _deleted: true, _schemaVersion: 1 },
        { _table: 'tasks', _rowId: 't1', _deleted: false, _schemaVersion: 1 },
      ]);

      const meals = await store.getTable('meals');
      const tasks = await store.getTable('tasks');
      store.close();
      return { meals: meals.length, tasks: tasks.length };
    });

    expect(result.meals).toBe(1); // m2 is deleted, excluded
    expect(result.tasks).toBe(1);
  });

  test('clearRows removes all rows but keeps other stores', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { LocalStore } = await import('/dist/storage/local-store.js');
      const store = new LocalStore();
      await store.open();

      await store.putRow({ _table: 't', _rowId: 'r1', _deleted: false, _schemaVersion: 1 });
      await store.setMeta('key', 'value');
      await store.clearRows();

      const rows = await store.getAllRows();
      const meta = await store.getMeta('key');
      store.close();
      return { rowCount: rows.length, metaPreserved: meta === 'value' };
    });

    expect(result.rowCount).toBe(0);
    expect(result.metaPreserved).toBe(true);
  });
});

// ─── Outbox ──────────────────────────────────────────────────────────

test.describe('LocalStore — outbox', () => {
  test('pushOutbox + drainOutbox FIFO semantics', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { LocalStore } = await import('/dist/storage/local-store.js');
      const store = new LocalStore();
      await store.open();

      await store.pushOutbox({ id: 'a', ts: 1, device: 'd', hlc: '0', ops: [] } as any);
      await store.pushOutbox({ id: 'b', ts: 2, device: 'd', hlc: '0', ops: [] } as any);

      const sizeBefore = await store.outboxSize();
      const drained = await store.drainOutbox();
      const sizeAfter = await store.outboxSize();

      store.close();
      return {
        sizeBefore,
        sizeAfter,
        ids: drained.map(e => e.id),
      };
    });

    expect(result.sizeBefore).toBe(2);
    expect(result.sizeAfter).toBe(0); // drain clears outbox
    expect(result.ids).toEqual(['a', 'b']);
  });

  test('drainOutbox returns empty array when outbox is empty', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { LocalStore } = await import('/dist/storage/local-store.js');
      const store = new LocalStore();
      await store.open();
      const drained = await store.drainOutbox();
      store.close();
      return drained;
    });

    expect(result).toEqual([]);
  });
});

// ─── Cursors ─────────────────────────────────────────────────────────

test.describe('LocalStore — cursors', () => {
  test('getCursor returns 0 for unknown device', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { LocalStore } = await import('/dist/storage/local-store.js');
      const store = new LocalStore();
      await store.open();
      const cursor = await store.getCursor('dev_unknown');
      store.close();
      return cursor;
    });

    expect(result).toBe(0);
  });

  test('setCursor + getCursor round-trip', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { LocalStore } = await import('/dist/storage/local-store.js');
      const store = new LocalStore();
      await store.open();
      await store.setCursor('dev_a', 42);
      await store.setCursor('dev_b', 99);
      const a = await store.getCursor('dev_a');
      const b = await store.getCursor('dev_b');
      store.close();
      return { a, b };
    });

    expect(result.a).toBe(42);
    expect(result.b).toBe(99);
  });

  test('getAllCursors returns full map', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { LocalStore } = await import('/dist/storage/local-store.js');
      const store = new LocalStore();
      await store.open();
      await store.setCursor('dev_a', 10);
      await store.setCursor('dev_b', 20);
      const all = await store.getAllCursors();
      store.close();
      return all;
    });

    expect(result).toEqual({ dev_a: 10, dev_b: 20 });
  });
});

// ─── Meta ────────────────────────────────────────────────────────────

test.describe('LocalStore — meta', () => {
  test('setMeta + getMeta round-trip for various types', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { LocalStore } = await import('/dist/storage/local-store.js');
      const store = new LocalStore();
      await store.open();

      await store.setMeta('string', 'hello');
      await store.setMeta('number', 42);
      await store.setMeta('object', { a: 1 });

      const s = await store.getMeta('string');
      const n = await store.getMeta('number');
      const o = await store.getMeta('object');
      const missing = await store.getMeta('nope');

      store.close();
      return { s, n, o, missing };
    });

    expect(result.s).toBe('hello');
    expect(result.n).toBe(42);
    expect(result.o).toEqual({ a: 1 });
    expect(result.missing).toBeUndefined();
  });
});

// ─── clearAll ────────────────────────────────────────────────────────

test.describe('LocalStore — clearAll', () => {
  test('nukes every object store', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { LocalStore } = await import('/dist/storage/local-store.js');
      const store = new LocalStore();
      await store.open();

      await store.putRow({ _table: 't', _rowId: 'r', _deleted: false, _schemaVersion: 1 });
      await store.pushOutbox({ id: 'x', ts: 0, device: 'd', hlc: '0', ops: [] } as any);
      await store.setCursor('dev_a', 5);
      await store.setMeta('k', 'v');

      await store.clearAll();

      const rows = await store.getAllRows();
      const outbox = await store.drainOutbox();
      const cursor = await store.getCursor('dev_a');
      const meta = await store.getMeta('k');

      store.close();
      return { rows: rows.length, outbox: outbox.length, cursor, meta };
    });

    expect(result.rows).toBe(0);
    expect(result.outbox).toBe(0);
    expect(result.cursor).toBe(0);
    expect(result.meta).toBeUndefined();
  });
});

