import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryLocalStore } from '../dist/index.js';

function row(table, rowId, fields, deleted = false) {
  const payload = {};
  let i = 0;
  for (const [key, value] of Object.entries(fields)) {
    payload[key] = { value, hlc: `2024-01-01T00:00:00.000Z-${i++}:dev` };
  }
  return {
    _meta: {
      table,
      rowId,
      deleted,
      schemaVersion: 1,
      ...(deleted ? { deletedHlc: '2024-01-01T00:00:00.000Z-9:dev' } : {}),
    },
    payload,
  };
}

async function withStore(fn) {
  const store = new MemoryLocalStore();
  await store.open();
  try {
    await fn(store);
  } finally {
    store.close();
  }
}

test('MemoryLocalStore contract: rows, tombstones, and queries', async () => {
  await withStore(async (store) => {
    await store.putRows([
      row('tasks', 'a', { title: 'Alpha', status: 'open', priority: 1 }),
      row('tasks', 'b', { title: 'Bravo', status: 'done', priority: 2 }),
      row('tasks', 'deleted', { title: 'Removed', status: 'open', priority: 3 }, true),
    ]);

    assert.equal((await store.getTable('tasks')).length, 2);
    assert.equal((await store.getAllRows()).length, 3);
    assert.deepEqual(await store.getTableNames(), ['tasks']);
    assert.equal((await store.getRow('tasks', 'a')).payload.title.value, 'Alpha');

    const done = await store.queryWhere('tasks', { field: 'status', op: 'equals', value: 'done' });
    assert.deepEqual(done.map((r) => r._meta.rowId), ['b']);

    const above = await store.queryWhere('tasks', { field: 'priority', op: 'above', value: 1 });
    assert.deepEqual(above.map((r) => r._meta.rowId), ['b']);
  });
});

test('MemoryLocalStore contract: outbox FIFO and drain', async () => {
  await withStore(async (store) => {
    const first = { id: 'chg_1', ts: 1, device: 'dev', hlc: 'h1', ops: [] };
    const second = { id: 'chg_2', ts: 2, device: 'dev', hlc: 'h2', ops: [] };
    await store.pushOutbox(first);
    await store.pushOutboxEntries([second]);

    assert.equal(await store.outboxSize(), 2);
    assert.deepEqual(await store.drainOutbox(), [first, second]);
    assert.equal(await store.outboxSize(), 0);
  });
});

test('MemoryLocalStore contract: local mutation staging and exact acknowledgement are crash-safe', async () => {
  await withStore(async (store) => {
    const first = { id: 'chg_1', ts: 1, device: 'dev', hlc: 'h1', ops: [] };
    const second = { id: 'chg_2', ts: 2, device: 'dev', hlc: 'h2', ops: [] };
    const stagedRow = row('tasks', 'staged', { title: 'Durable' });

    await store.commitLocalMutation(stagedRow, first);
    assert.equal((await store.getRow('tasks', 'staged')).payload.title.value, 'Durable');
    assert.deepEqual(await store.getMeta('pendingBatch'), first);

    assert.deepEqual(await store.promotePendingBatch(), first);
    assert.equal(await store.getMeta('pendingBatch'), undefined);
    await store.pushOutbox(second);

    const publicationCut = await store.peekOutbox();
    await store.pushOutbox({ id: 'chg_3', ts: 3, device: 'dev', hlc: 'h3', ops: [] });
    await store.acknowledgeOutbox(publicationCut.map((entry) => entry.id));
    await store.acknowledgeOutbox(publicationCut.map((entry) => entry.id));

    assert.deepEqual((await store.peekOutbox()).map((entry) => entry.id), ['chg_3']);
  });
});

test('MemoryLocalStore contract: independent writers merge the durable pending batch', async () => {
  await withStore(async (store) => {
    const first = { id: 'chg_first', ts: 1, device: 'dev', hlc: 'h1', ops: [{ type: 'delete', table: 'tasks', rowId: 'a', hlc: 'h1' }] };
    const second = { id: 'chg_second', ts: 2, device: 'dev', hlc: 'h2', ops: [{ type: 'delete', table: 'tasks', rowId: 'b', hlc: 'h2' }] };

    await store.commitLocalMutation(row('tasks', 'a', { title: 'A' }), first);
    const merged = await store.commitLocalMutation(row('tasks', 'b', { title: 'B' }), second);

    assert.equal(merged.id, first.id);
    assert.equal(merged.hlc, second.hlc);
    assert.deepEqual(merged.ops, [...first.ops, ...second.ops]);
    assert.deepEqual(await store.getMeta('pendingBatch'), merged);
  });
});

test('MemoryLocalStore contract: cursors, meta, and clearAll', async () => {
  await withStore(async (store) => {
    await store.putRow(row('notes', 'n1', { title: 'Note' }));
    await store.pushOutbox({ id: 'chg_1', ts: 1, device: 'dev', hlc: 'h1', ops: [] });
    await store.setCursor('dev_a', 42);
    await store.setMeta('meshId', 'mesh_1');

    assert.equal(await store.getCursor('dev_a'), 42);
    assert.deepEqual(await store.getAllCursors(), { dev_a: 42 });
    assert.equal(await store.getMeta('meshId'), 'mesh_1');

    await store.clearAll();
    assert.deepEqual(await store.getAllRows(), []);
    assert.equal(await store.outboxSize(), 0);
    assert.deepEqual(await store.getAllCursors(), {});
    assert.equal(await store.getMeta('meshId'), undefined);
  });
});
