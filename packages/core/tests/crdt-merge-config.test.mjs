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

test('a strategy-only table merge config applies convergent LWW', () => {
  const tables = {};
  const schema = { tables: { tasks: { merge: { strategy: 'lww' } } } };
  applyOp(tables, upsert('000000000000002-0000-local', 'local-newer'), 1, schema);
  applyOp(tables, upsert('000000000000001-0000-remote', 'remote-older'), 1, schema);

  assert.equal(tables.tasks['task-1'].payload.state.value, 'local-newer');
});

test('perspective-dependent legacy merge names are rejected', () => {
  const tables = {};
  const schema = { tables: { tasks: { merge: { strategy: 'remote-wins' } } } };

  assert.throws(
    () => applyOp(tables, upsert('000000000000001-0000-remote', 'value'), 1, schema),
    /Unsupported replicated merge strategy "remote-wins"/,
  );
});

test('equal HLCs are idempotent only when their values agree', () => {
  const hlc = '000000000000001-0000-writer';
  const tables = {};
  applyOp(tables, upsert(hlc, { nested: ['same'] }), 1);
  assert.equal(applyOp(tables, upsert(hlc, { nested: ['same'] }), 1), null);

  assert.throws(
    () => applyOp(tables, upsert(hlc, { nested: ['different'] }), 1),
    /Conflicting values share HLC/,
  );
});
