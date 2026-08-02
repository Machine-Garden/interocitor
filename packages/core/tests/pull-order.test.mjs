import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pull } from '../dist/core/pull.js';

function changePayload(hlc, id, value) {
  return JSON.stringify({
    meshId: 'mesh_pull_order',
    kind: 'change',
    entry: {
      id,
      ts: 1,
      device: hlc.slice(22),
      hlc,
      ops: [{
        type: 'upsert',
        table: 'tasks',
        rowId: 'shared-task',
        columns: { state: { value, hlc } },
      }],
    },
  });
}

test('pull applies same-tick remote-wins changes in canonical HLC order', async () => {
  const upper = '000000000000001-0000-A';
  const lower = '000000000000001-0000-a';
  const payloads = new Map([
    [`/mesh/changes/${lower}-chg_lower.json`, changePayload(lower, 'chg_lower', 'from-lowercase')],
    [`/mesh/changes/${upper}-chg_upper.json`, changePayload(upper, 'chg_upper', 'from-uppercase')],
  ]);
  const metadata = new Map();
  const adapter = {
    async listFiles() {
      // Deliberately return the opposite order. Pull must derive a canonical
      // order from HLC, not from adapter insertion order or locale collation.
      return [...payloads].map(([path, data]) => ({
        name: path.slice(path.lastIndexOf('/') + 1),
        path,
        size: data.length,
        modifiedTime: '2026-01-01T00:00:00.000Z',
      }));
    },
    async readFile(path) {
      const data = payloads.get(path);
      if (data === undefined) throw new Error(`not found: ${path}`);
      return new TextEncoder().encode(data);
    },
  };
  const local = {
    async getMeta(key) { return metadata.get(key); },
    async setMeta(key, value) { metadata.set(key, value); },
    async putRows() {},
  };
  const tables = {};

  await pull({
    adapter,
    local,
    remotePath: '/mesh',
    codecState: { encryptionKey: null, encrypted: false, manifest: { meshId: 'mesh_pull_order', schema: 1 } },
    hlc: { ts: 0, counter: 0, nodeId: 'reader' },
    deviceId: 'reader',
    tables,
    knownTables: new Set(),
    schema: { tables: { tasks: { merge: 'remote-wins' } } },
    emit() {},
    async ensureRowsCached() {},
    async poisonRemote(error) { return error instanceof Error ? error : new Error(String(error)); },
    async loadOrCreateManifest() {},
  });

  // `A` is before `a` in the HLC's UTF-16 ordering, so the lower-case
  // change is applied last and wins under the configured remote-wins policy.
  assert.equal(tables.tasks['shared-task'].payload.state.value, 'from-lowercase');
});
