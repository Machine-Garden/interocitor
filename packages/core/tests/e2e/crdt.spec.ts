import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/packages/core/tests/e2e/fixtures/harness.html');
});

// ─── applyOp: upsert ────────────────────────────────────────────────

test.describe('applyOp — upsert', () => {
  test('creates a new row in an empty table', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { applyOp, readColumn } = await import('/packages/core/dist/core/crdt.js');
      const tables: Record<string, Record<string, any>> = {};
      const row = applyOp(tables, {
        type: 'upsert',
        table: 'tasks',
        rowId: 'task_1',
        columns: {
          title: { value: 'Hello', hlc: '000001711785600000-0001-dev_a' },
        },
      }, 1);

      return {
        rowMeta: row?._meta,
        title: row ? readColumn(row, 'title') : null,
        tableExists: 'tasks' in tables,
        rowInTable: tables.tasks?.task_1 !== null && tables.tasks?.task_1 !== undefined,
      };
    });

    expect(result.rowMeta).toMatchObject({ table: 'tasks', rowId: 'task_1', deleted: false });
    expect(result.title).toBe('Hello');
    expect(result.tableExists).toBe(true);
    expect(result.rowInTable).toBe(true);
  });

  test('updates a column with a newer HLC', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { applyOp, readColumn } = await import('/packages/core/dist/core/crdt.js');
      const tables: Record<string, Record<string, any>> = {};

      applyOp(tables, {
        type: 'upsert', table: 't', rowId: 'r1',
        columns: { name: { value: 'old', hlc: '000001000000000000-0000-dev_a' } },
      }, 1);

      applyOp(tables, {
        type: 'upsert', table: 't', rowId: 'r1',
        columns: { name: { value: 'new', hlc: '000002000000000000-0000-dev_a' } },
      }, 1);

      return readColumn(tables.t.r1, 'name');
    });

    expect(result).toBe('new');
  });

  test('rejects a column update with an older HLC (stale write)', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { applyOp, readColumn } = await import('/packages/core/dist/core/crdt.js');
      const tables: Record<string, Record<string, any>> = {};

      applyOp(tables, {
        type: 'upsert', table: 't', rowId: 'r1',
        columns: { name: { value: 'winner', hlc: '000002000000000000-0000-dev_a' } },
      }, 1);

      const changed = applyOp(tables, {
        type: 'upsert', table: 't', rowId: 'r1',
        columns: { name: { value: 'loser', hlc: '000001000000000000-0000-dev_b' } },
      }, 1);

      return { value: readColumn(tables.t.r1, 'name'), changed };
    });

    expect(result.value).toBe('winner');
    expect(result.changed).toBeNull();
  });

  test('merges independent columns from different devices', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { applyOp, readColumn } = await import('/packages/core/dist/core/crdt.js');
      const tables: Record<string, Record<string, any>> = {};

      applyOp(tables, {
        type: 'upsert', table: 't', rowId: 'r1',
        columns: { title: { value: 'from A', hlc: '000001000000000000-0000-dev_a' } },
      }, 1);

      applyOp(tables, {
        type: 'upsert', table: 't', rowId: 'r1',
        columns: { status: { value: 'done', hlc: '000002000000000000-0000-dev_b' } },
      }, 1);

      return {
        title: readColumn(tables.t.r1, 'title'),
        status: readColumn(tables.t.r1, 'status'),
      };
    });

    expect(result.title).toBe('from A');
    expect(result.status).toBe('done');
  });
});

// ─── applyOp: delete ─────────────────────────────────────────────────

test.describe('applyOp — delete', () => {
  test('soft-deletes an existing row', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { applyOp } = await import('/packages/core/dist/core/crdt.js');
      const tables: Record<string, Record<string, any>> = {};

      applyOp(tables, {
        type: 'upsert', table: 't', rowId: 'r1',
        columns: { x: { value: 1, hlc: '000001000000000000-0000-dev_a' } },
      }, 1);

      const deleted = applyOp(tables, {
        type: 'delete', table: 't', rowId: 'r1',
        hlc: '000002000000000000-0000-dev_a',
      }, 1);

      return { deleted: deleted?._meta.deleted, hlc: deleted?._meta.deletedHlc, payload: deleted?.payload };
    });

    expect(result.deleted).toBe(true);
    expect(result.hlc).toBeTruthy();
    expect(result.payload).toEqual({});
  });

  test('rejects a delete older than existing column HLC', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { applyOp } = await import('/packages/core/dist/core/crdt.js');
      const tables: Record<string, Record<string, any>> = {};

      applyOp(tables, {
        type: 'upsert', table: 't', rowId: 'r1',
        columns: { x: { value: 1, hlc: '000003000000000000-0000-dev_a' } },
      }, 1);

      const deleted = applyOp(tables, {
        type: 'delete', table: 't', rowId: 'r1',
        hlc: '000001000000000000-0000-dev_b',
      }, 1);

      return { changeApplied: deleted, isDeleted: tables.t.r1._meta.deleted };
    });

    expect(result.changeApplied).toBeNull();
    expect(result.isDeleted).toBe(false);
  });

  test('creates a tombstone for an unknown row', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { applyOp } = await import('/packages/core/dist/core/crdt.js');
      const tables: Record<string, Record<string, any>> = {};

      const row = applyOp(tables, {
        type: 'delete', table: 't', rowId: 'r_unknown',
        hlc: '000001000000000000-0000-dev_a',
      }, 1);

      return {
        created: row !== null && row !== undefined,
        deleted: row?._meta.deleted,
        inTable: tables.t?.r_unknown !== null && tables.t?.r_unknown !== undefined,
      };
    });

    expect(result.created).toBe(true);
    expect(result.deleted).toBe(true);
    expect(result.inTable).toBe(true);
  });

  test('upsert with newer HLC revives a tombstoned row', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { applyOp, readColumn } = await import('/packages/core/dist/core/crdt.js');
      const tables: Record<string, Record<string, any>> = {};

      applyOp(tables, {
        type: 'upsert', table: 't', rowId: 'r1',
        columns: { x: { value: 'alive', hlc: '000001000000000000-0000-dev_a' } },
      }, 1);

      applyOp(tables, {
        type: 'delete', table: 't', rowId: 'r1',
        hlc: '000002000000000000-0000-dev_a',
      }, 1);

      const revived = applyOp(tables, {
        type: 'upsert', table: 't', rowId: 'r1',
        columns: { x: { value: 'back', hlc: '000003000000000000-0000-dev_b' } },
      }, 1);

      return {
        deleted: revived?._meta.deleted,
        value: revived ? readColumn(revived, 'x') : null,
      };
    });

    expect(result.deleted).toBe(false);
    expect(result.value).toBe('back');
  });

  test('partial upsert after delete starts a fresh incarnation', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { applyOp, rowToPlain } = await import('/packages/core/dist/core/crdt.js');
      const tables: Record<string, Record<string, any>> = {};

      applyOp(tables, {
        type: 'upsert', table: 't', rowId: 'r1',
        columns: {
          x: { value: 'old-x', hlc: '000001000000000000-0000-dev_a' },
          y: { value: 'old-y', hlc: '000001000000000000-0000-dev_a' },
        },
      }, 1);

      applyOp(tables, {
        type: 'delete', table: 't', rowId: 'r1',
        hlc: '000002000000000000-0000-dev_a',
      }, 1);

      const revived = applyOp(tables, {
        type: 'upsert', table: 't', rowId: 'r1',
        columns: { x: { value: 'new-x', hlc: '000003000000000000-0000-dev_b' } },
      }, 1);

      return revived ? rowToPlain(revived) : null;
    });

    expect(result).toEqual({ _table: 't', _rowId: 'r1', _deleted: false, x: 'new-x' });
  });

  test('stale upsert after delete does not mutate the tombstone payload', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { applyOp, rowToPlain } = await import('/packages/core/dist/core/crdt.js');
      const tables: Record<string, Record<string, any>> = {};

      applyOp(tables, {
        type: 'delete', table: 't', rowId: 'r1',
        hlc: '000002000000000000-0000-dev_a',
      }, 1);

      const changed = applyOp(tables, {
        type: 'upsert', table: 't', rowId: 'r1',
        columns: { x: { value: 'stale', hlc: '000001000000000000-0000-dev_b' } },
      }, 1);

      return { changed, row: rowToPlain(tables.t.r1) };
    });

    expect(result.changed).toBeNull();
    expect(result.row).toEqual({ _table: 't', _rowId: 'r1', _deleted: true });
  });

  test('upsert with older HLC than delete does NOT revive', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { applyOp } = await import('/packages/core/dist/core/crdt.js');
      const tables: Record<string, Record<string, any>> = {};

      applyOp(tables, {
        type: 'upsert', table: 't', rowId: 'r1',
        columns: { x: { value: 'alive', hlc: '000001000000000000-0000-dev_a' } },
      }, 1);

      applyOp(tables, {
        type: 'delete', table: 't', rowId: 'r1',
        hlc: '000005000000000000-0000-dev_a',
      }, 1);

      applyOp(tables, {
        type: 'upsert', table: 't', rowId: 'r1',
        columns: { x: { value: 'stale', hlc: '000003000000000000-0000-dev_b' } },
      }, 1);

      return { deleted: tables.t.r1._meta.deleted };
    });

    expect(result.deleted).toBe(true);
  });

  test('rejects a duplicate delete with an older HLC', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { applyOp } = await import('/packages/core/dist/core/crdt.js');
      const tables: Record<string, Record<string, any>> = {};

      applyOp(tables, {
        type: 'upsert', table: 't', rowId: 'r1',
        columns: { x: { value: 1, hlc: '000001000000000000-0000-dev_a' } },
      }, 1);

      applyOp(tables, {
        type: 'delete', table: 't', rowId: 'r1',
        hlc: '000005000000000000-0000-dev_a',
      }, 1);

      const staleDelete = applyOp(tables, {
        type: 'delete', table: 't', rowId: 'r1',
        hlc: '000003000000000000-0000-dev_b',
      }, 1);

      return { changeApplied: staleDelete };
    });

    expect(result.changeApplied).toBeNull();
  });
});

// ─── applyChangeEntry ────────────────────────────────────────────────

test.describe('applyChangeEntry', () => {
  test('applies a batch of operations and returns affected rows', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { applyChangeEntry, readColumn } = await import('/packages/core/dist/core/crdt.js');
      const tables: Record<string, Record<string, any>> = {};

      const affected = applyChangeEntry(tables, {
        id: 'chg_1', ts: 0, device: 'dev_a', hlc: '000001000000000000-0000-dev_a',
        ops: [
          {
            type: 'upsert', table: 'meals', rowId: 'm1',
            columns: { name: { value: 'Ramen', hlc: '000001000000000000-0000-dev_a' } },
          },
          {
            type: 'upsert', table: 'meals', rowId: 'm2',
            columns: { name: { value: 'Sushi', hlc: '000001000000000000-0001-dev_a' } },
          },
        ],
      }, 1);

      return {
        count: affected.length,
        names: affected.map(r => readColumn(r, 'name')),
      };
    });

    expect(result.count).toBe(2);
    expect(result.names).toContain('Ramen');
    expect(result.names).toContain('Sushi');
  });
});

// ─── readColumn / rowToPlain ─────────────────────────────────────────

test.describe('readColumn / rowToPlain', () => {
  test('readColumn unwraps ColumnEntry value', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { readColumn } = await import('/packages/core/dist/core/crdt.js');
      const row = {
        _meta: { table: 't', rowId: 'r', deleted: false, schemaVersion: 1 },
        payload: { name: { value: 'Alice', hlc: '000001000000000000-0000-dev_a' } },
      };
      return readColumn(row, 'name');
    });

    expect(result).toBe('Alice');
  });

  test('readColumn returns undefined for non-existent column', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { readColumn } = await import('/packages/core/dist/core/crdt.js');
      const row = { _meta: { table: 't', rowId: 'r', deleted: false, schemaVersion: 1 }, payload: {} };
      return readColumn(row, 'missing');
    });

    expect(result).toBeUndefined();
  });

  test('rowToPlain strips HLC metadata from all columns', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { rowToPlain } = await import('/packages/core/dist/core/crdt.js');
      const row = {
        _meta: { table: 'tasks', rowId: 't1', deleted: false, schemaVersion: 1 },
        payload: {
          title: { value: 'Do stuff', hlc: '000001000000000000-0000-dev_a' },
          status: { value: 'open', hlc: '000001000000000001-0000-dev_a' },
        },
      };
      return rowToPlain(row);
    });

    expect(result).toEqual({
      _table: 'tasks',
      _rowId: 't1',
      _deleted: false,
      title: 'Do stuff',
      status: 'open',
    });
  });

  test('rowToPlain handles a row with no user columns', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { rowToPlain } = await import('/packages/core/dist/core/crdt.js');
      return rowToPlain({
        _meta: { table: 't', rowId: 'r', deleted: true, schemaVersion: 1 },
        payload: {},
      });
    });

    expect(result).toEqual({ _table: 't', _rowId: 'r', _deleted: true });
  });
});
