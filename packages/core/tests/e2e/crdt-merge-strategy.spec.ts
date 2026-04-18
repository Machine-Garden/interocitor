import { expect, test } from '@playwright/test';

function counterMerge(local: any, remote: any, _ctx: any) {
  return {
    value: (local.value as number) + (remote.value as number),
    hlc: local.hlc > remote.hlc ? local.hlc : remote.hlc,
  };
}

function keepLocal(local: any, _remote: any) {
  return local;
}


test.beforeEach(async ({ page }) => {
  await page.goto('/packages/core/tests/e2e/fixtures/harness.html');
});

// ─── lww (default) ───────────────────────────────────────────────────

test.describe('merge strategy — lww (default)', () => {
  test('newer HLC wins', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { applyOp, readColumn } = await import('/packages/core/dist/core/crdt.js');
      const tables: Record<string, Record<string, any>> = {};

      applyOp(tables, {
        type: 'upsert', table: 't', rowId: 'r1',
        columns: { name: { value: 'old', hlc: '000001000000000000-0000-dev_a' } },
      }, 1);

      applyOp(tables, {
        type: 'upsert', table: 't', rowId: 'r1',
        columns: { name: { value: 'new', hlc: '000002000000000000-0000-dev_b' } },
      }, 1);

      return readColumn(tables.t.r1, 'name');
    });
    expect(result).toBe('new');
  });

  test('older HLC loses', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { applyOp, readColumn } = await import('/packages/core/dist/core/crdt.js');
      const tables: Record<string, Record<string, any>> = {};

      applyOp(tables, {
        type: 'upsert', table: 't', rowId: 'r1',
        columns: { name: { value: 'winner', hlc: '000002000000000000-0000-dev_a' } },
      }, 1);

      applyOp(tables, {
        type: 'upsert', table: 't', rowId: 'r1',
        columns: { name: { value: 'loser', hlc: '000001000000000000-0000-dev_b' } },
      }, 1);

      return readColumn(tables.t.r1, 'name');
    });
    expect(result).toBe('winner');
  });
});

// ─── local-wins ──────────────────────────────────────────────────────

test.describe('merge strategy — local-wins', () => {
  test('keeps local value when both exist', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { applyOp, readColumn } = await import('/packages/core/dist/core/crdt.js');
      const tables: Record<string, Record<string, any>> = {};
      const schema = {
        version: 1,
        tables: { t: { merge: 'local-wins' } },
      };

      // Local write
      applyOp(tables, {
        type: 'upsert', table: 't', rowId: 'r1',
        columns: { name: { value: 'local', hlc: '000001000000000000-0000-dev_a' } },
      }, 1, schema);

      // Remote write with newer HLC — should still lose
      const changed = applyOp(tables, {
        type: 'upsert', table: 't', rowId: 'r1',
        columns: { name: { value: 'remote', hlc: '000002000000000000-0000-dev_b' } },
      }, 1, schema);

      return { value: readColumn(tables.t.r1, 'name'), changed: changed !== null };
    });
    expect(result.value).toBe('local');
    expect(result.changed).toBe(false);
  });

  test('accepts remote when no local value exists', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { applyOp, readColumn } = await import('/packages/core/dist/core/crdt.js');
      const tables: Record<string, Record<string, any>> = {};
      const schema = {
        version: 1,
        tables: { t: { merge: 'local-wins' } },
      };

      // Remote write to a column that doesn't exist locally
      applyOp(tables, {
        type: 'upsert', table: 't', rowId: 'r1',
        columns: { name: { value: 'remote', hlc: '000001000000000000-0000-dev_b' } },
      }, 1, schema);

      return readColumn(tables.t.r1, 'name');
    });
    expect(result).toBe('remote');
  });

  test('independent columns still merge', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { applyOp, readColumn } = await import('/packages/core/dist/core/crdt.js');
      const tables: Record<string, Record<string, any>> = {};
      const schema = {
        version: 1,
        tables: { t: { merge: 'local-wins' } },
      };

      applyOp(tables, {
        type: 'upsert', table: 't', rowId: 'r1',
        columns: { title: { value: 'from A', hlc: '000001000000000000-0000-dev_a' } },
      }, 1, schema);

      applyOp(tables, {
        type: 'upsert', table: 't', rowId: 'r1',
        columns: { status: { value: 'done', hlc: '000002000000000000-0000-dev_b' } },
      }, 1, schema);

      return {
        title: readColumn(tables.t.r1, 'title'),
        status: readColumn(tables.t.r1, 'status'),
      };
    });
    expect(result.title).toBe('from A');
    expect(result.status).toBe('done');
  });
});

// ─── remote-wins ─────────────────────────────────────────────────────

test.describe('merge strategy — remote-wins', () => {
  test('remote always overwrites even with older HLC', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { applyOp, readColumn } = await import('/packages/core/dist/core/crdt.js');
      const tables: Record<string, Record<string, any>> = {};
      const schema = {
        version: 1,
        tables: { t: { merge: 'remote-wins' } },
      };

      applyOp(tables, {
        type: 'upsert', table: 't', rowId: 'r1',
        columns: { name: { value: 'local', hlc: '000002000000000000-0000-dev_a' } },
      }, 1, schema);

      applyOp(tables, {
        type: 'upsert', table: 't', rowId: 'r1',
        columns: { name: { value: 'remote', hlc: '000001000000000000-0000-dev_b' } },
      }, 1, schema);

      return readColumn(tables.t.r1, 'name');
    });
    expect(result).toBe('remote');
  });
});

// ─── per-field merge ─────────────────────────────────────────────────

test.describe('merge strategy — per-field', () => {
  test('different strategies per field within a table', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { applyOp, readColumn } = await import('/packages/core/dist/core/crdt.js');
      const tables: Record<string, Record<string, any>> = {};
      const schema = {
        version: 1,
        tables: {
          t: {
            merge: {
              strategy: 'lww',
              fields: {
                title: 'local-wins',
                status: 'remote-wins',
              },
            },
          },
        },
      };

      // Set initial values
      applyOp(tables, {
        type: 'upsert', table: 't', rowId: 'r1',
        columns: {
          title: { value: 'local title', hlc: '000001000000000000-0000-dev_a' },
          status: { value: 'local status', hlc: '000002000000000000-0000-dev_a' },
          priority: { value: 1, hlc: '000001000000000000-0000-dev_a' },
        },
      }, 1, schema);

      // Incoming remote with conflicting values
      applyOp(tables, {
        type: 'upsert', table: 't', rowId: 'r1',
        columns: {
          title: { value: 'remote title', hlc: '000003000000000000-0000-dev_b' },
          status: { value: 'remote status', hlc: '000001000000000000-0000-dev_b' },
          priority: { value: 99, hlc: '000003000000000000-0000-dev_b' },
        },
      }, 1, schema);

      return {
        title: readColumn(tables.t.r1, 'title'),     // local-wins → keep local
        status: readColumn(tables.t.r1, 'status'),   // remote-wins → accept remote
        priority: readColumn(tables.t.r1, 'priority'), // lww → newer HLC wins
      };
    });
    expect(result.title).toBe('local title');
    expect(result.status).toBe('remote status');
    expect(result.priority).toBe(99);
  });
});

// ─── custom merge function ───────────────────────────────────────────

test.describe('merge strategy — custom function', () => {
  test('custom function receives context and can produce merged value', async ({ page }) => {
    const result = await page.evaluate(async () => {
      function counterMerge(local: any, remote: any, _ctx: any) {
        return {
          value: (local.value as number) + (remote.value as number),
          hlc: local.hlc > remote.hlc ? local.hlc : remote.hlc,
        };
      }
      const { applyOp, readColumn } = await import('/packages/core/dist/core/crdt.js');
      const tables: Record<string, Record<string, any>> = {};

      // Counter merge: sum values, keep latest HLC

      const schema = {
        version: 1,
        tables: {
          counters: {
            merge: {
              fields: { count: counterMerge },
            },
          },
        },
      };

      applyOp(tables, {
        type: 'upsert', table: 'counters', rowId: 'c1',
        columns: { count: { value: 5, hlc: '000001000000000000-0000-dev_a' } },
      }, 1, schema);

      applyOp(tables, {
        type: 'upsert', table: 'counters', rowId: 'c1',
        columns: { count: { value: 3, hlc: '000002000000000000-0000-dev_b' } },
      }, 1, schema);

      return readColumn(tables.counters.c1, 'count');
    });
    expect(result).toBe(8);
  });

  test('custom function receives correct context fields', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { applyOp } = await import('/packages/core/dist/core/crdt.js');
      const tables: Record<string, Record<string, any>> = {};
      let capturedCtx: any = null;

      const spy = (local: any, remote: any, ctx: any) => {
        capturedCtx = ctx;
        return remote;
      };

      const schema = {
        version: 1,
        tables: { tasks: { merge: spy } },
      };

      applyOp(tables, {
        type: 'upsert', table: 'tasks', rowId: 'task_42',
        columns: { title: { value: 'old', hlc: '000001000000000000-0000-dev_a' } },
      }, 1, schema);

      applyOp(tables, {
        type: 'upsert', table: 'tasks', rowId: 'task_42',
        columns: { title: { value: 'new', hlc: '000002000000000000-0000-dev_b' } },
      }, 1, schema);

      return capturedCtx;
    });
    expect(result.table).toBe('tasks');
    expect(result.rowId).toBe('task_42');
    expect(result.field).toBe('title');
  });

  test('custom function returning local means no change', async ({ page }) => {
    const result = await page.evaluate(async () => {
      function keepLocal(local: any, _remote: any) { return local; }
      const { applyOp, readColumn } = await import('/packages/core/dist/core/crdt.js');
      const tables: Record<string, Record<string, any>> = {};

      const schema = {
        version: 1,
        tables: { t: { merge: keepLocal } },
      };

      applyOp(tables, {
        type: 'upsert', table: 't', rowId: 'r1',
        columns: { name: { value: 'local', hlc: '000001000000000000-0000-dev_a' } },
      }, 1, schema);

      const changed = applyOp(tables, {
        type: 'upsert', table: 't', rowId: 'r1',
        columns: { name: { value: 'remote', hlc: '000002000000000000-0000-dev_b' } },
      }, 1, schema);

      return { value: readColumn(tables.t.r1, 'name'), changed: changed !== null };
    });
    expect(result.value).toBe('local');
    expect(result.changed).toBe(false);
  });
});

// ─── database-level default ──────────────────────────────────────────

test.describe('merge strategy — database-level default', () => {
  test('database mergeStrategy defaults to remote-wins when schema present', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { applyOp, readColumn } = await import('/packages/core/dist/core/crdt.js');
      const tables: Record<string, Record<string, any>> = {};
      const schema = {
        version: 1,
        // no mergeStrategy → defaults to 'remote-wins'
        tables: { t: {}, t2: {} },
      };

      // table t
      applyOp(tables, {
        type: 'upsert', table: 't', rowId: 'r1',
        columns: { x: { value: 'local', hlc: '000002000000000000-0000-dev_a' } },
      }, 1, schema);
      applyOp(tables, {
        type: 'upsert', table: 't', rowId: 'r1',
        columns: { x: { value: 'remote', hlc: '000001000000000000-0000-dev_b' } },
      }, 1, schema);

      // table t2
      applyOp(tables, {
        type: 'upsert', table: 't2', rowId: 'r1',
        columns: { y: { value: 'local2', hlc: '000002000000000000-0000-dev_a' } },
      }, 1, schema);
      applyOp(tables, {
        type: 'upsert', table: 't2', rowId: 'r1',
        columns: { y: { value: 'remote2', hlc: '000001000000000000-0000-dev_b' } },
      }, 1, schema);

      return {
        x: readColumn(tables.t.r1, 'x'),
        y: readColumn(tables.t2.r1, 'y'),
      };
    });
    expect(result.x).toBe('remote');
    expect(result.y).toBe('remote2');
  });

  test('table-level overrides database-level', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { applyOp, readColumn } = await import('/packages/core/dist/core/crdt.js');
      const tables: Record<string, Record<string, any>> = {};
      const schema = {
        version: 1,
        // default remote-wins
        tables: {
          protected: { merge: 'local-wins' },
          normal: {},
        },
      };

      // protected table: local-wins overrides database remote-wins
      applyOp(tables, {
        type: 'upsert', table: 'protected', rowId: 'r1',
        columns: { x: { value: 'local', hlc: '000001000000000000-0000-dev_a' } },
      }, 1, schema);
      applyOp(tables, {
        type: 'upsert', table: 'protected', rowId: 'r1',
        columns: { x: { value: 'remote', hlc: '000002000000000000-0000-dev_b' } },
      }, 1, schema);

      // normal table: inherits database remote-wins
      applyOp(tables, {
        type: 'upsert', table: 'normal', rowId: 'r1',
        columns: { x: { value: 'local', hlc: '000002000000000000-0000-dev_a' } },
      }, 1, schema);
      applyOp(tables, {
        type: 'upsert', table: 'normal', rowId: 'r1',
        columns: { x: { value: 'remote', hlc: '000001000000000000-0000-dev_b' } },
      }, 1, schema);

      return {
        protected: readColumn(tables.protected.r1, 'x'),
        normal: readColumn(tables.normal.r1, 'x'),
      };
    });
    expect(result.protected).toBe('local');
    expect(result.normal).toBe('remote');
  });
});

// ─── deletes always use LWW ─────────────────────────────────────────

test.describe('merge strategy — deletes', () => {
  test('deletes use LWW regardless of table merge strategy', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { applyOp } = await import('/packages/core/dist/core/crdt.js');
      const tables: Record<string, Record<string, any>> = {};
      const schema = {
        version: 1,
        tables: { t: { merge: 'local-wins' } },
      };

      applyOp(tables, {
        type: 'upsert', table: 't', rowId: 'r1',
        columns: { name: { value: 'hello', hlc: '000001000000000000-0000-dev_a' } },
      }, 1, schema);

      applyOp(tables, {
        type: 'delete', table: 't', rowId: 'r1',
        hlc: '000003000000000000-0000-dev_b',
      }, 1, schema);

      return tables.t.r1._deleted;
    });
    expect(result).toBe(true);
  });
});

// ─── applyChangeEntry with schema ────────────────────────────────────

test.describe('applyChangeEntry with merge strategy', () => {
  test('passes schema through to applyOp', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { applyChangeEntry, readColumn } = await import('/packages/core/dist/core/crdt.js');
      const tables: Record<string, Record<string, any>> = {};
      const schema = {
        version: 1,
        tables: { t: { merge: 'local-wins' } },
      };

      // Seed local value
      applyChangeEntry(tables, {
        id: 'chg_1', ts: 1, device: 'dev_a', hlc: '000001000000000000-0000-dev_a',
        ops: [{
          type: 'upsert', table: 't', rowId: 'r1',
          columns: { name: { value: 'local', hlc: '000001000000000000-0000-dev_a' } },
        }],
      }, 1, schema);

      // Remote batch — should not overwrite
      const affected = applyChangeEntry(tables, {
        id: 'chg_2', ts: 2, device: 'dev_b', hlc: '000002000000000000-0000-dev_b',
        ops: [{
          type: 'upsert', table: 't', rowId: 'r1',
          columns: { name: { value: 'remote', hlc: '000002000000000000-0000-dev_b' } },
        }],
      }, 1, schema);

      return {
        value: readColumn(tables.t.r1, 'name'),
        affectedCount: affected.length,
      };
    });
    expect(result.value).toBe('local');
    expect(result.affectedCount).toBe(0);
  });
});
