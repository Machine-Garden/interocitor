import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyOp } from '../dist/core/crdt.js';

function upsert(hlc, value) {
  return {
    type: 'upsert',
    table: 'tasks',
    rowId: 'task-1',
    columns: { state: { value, hlc } },
  };
}

test('a strategy-only table merge config applies its declared strategy', () => {
  const tables = {};
  const schema = { tables: { tasks: { merge: { strategy: 'remote-wins' } } } };
  applyOp(tables, upsert('000000000000002-0000-local', 'local-newer'), 1, schema);
  applyOp(tables, upsert('000000000000001-0000-remote', 'remote-older'), 1, schema);

  assert.equal(tables.tasks['task-1'].payload.state.value, 'remote-older');
});
