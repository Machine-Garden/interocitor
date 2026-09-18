import assert from "node:assert/strict";
import { test } from "node:test";

import { Interocitor, MemoryLocalStore } from "../dist/index.js";
import { MemoryAdapter } from "../dist/adapters/memory.js";

const REMOTE = "/evicted-mesh";

/**
 * A local store that survives the engine being torn down, which is what every
 * real device has. The plain memory store empties itself on close(), so a
 * second engine over it would look like a fresh install rather than the same
 * device coming back.
 */
class DeviceStore extends MemoryLocalStore {
  close() {}
}

function engine(adapter, localStore, deviceId, extra = {}) {
  return new Interocitor(adapter, {
    remotePath: REMOTE,
    localStore,
    keySource: null,
    deviceId,
    batchWindowMs: 0,
    autoCompact: false,
    ...extra,
  });
}

function collectEvictions(db) {
  const seen = [];
  db.on((event) => {
    if (event.type === "mesh:evicted") seen.push(event);
  });
  return seen;
}

/**
 * Reclaim every object the mesh occupies, exactly as a host TTL sweep does.
 * The mesh address stays valid; only the payloads are gone.
 */
function evictHost(adapter) {
  for (const path of Object.keys(adapter.dump())) {
    if (path.startsWith(`${REMOTE}/`)) adapter.deleteFile(path);
  }
  adapter.resetFolderCache();
}

function publishAttestation(adapter, record) {
  adapter.writeFile(`${REMOTE}/evicted.json`, JSON.stringify(record));
}

test("a first connect to an empty mailbox is a new mesh, not an eviction", async () => {
  const adapter = new MemoryAdapter();
  const db = engine(adapter, new DeviceStore(), "fresh");
  const evictions = collectEvictions(db);
  await db.connect();
  await db.table("tasks").put("t1", { title: "Buy milk" });
  await db.flush();
  await db.disconnect();

  assert.deepEqual(evictions, []);
});

test("a reconnect to a live mesh reports nothing and leaves the lineage at one", async () => {
  const adapter = new MemoryAdapter();
  const local = new DeviceStore();
  const first = engine(adapter, local, "steady");
  await first.connect();
  await first.table("tasks").put("t1", { title: "Buy milk" });
  await first.flush();
  await first.disconnect();

  const again = engine(adapter, local, "steady");
  const evictions = collectEvictions(again);
  await again.connect();
  await again.disconnect();

  assert.deepEqual(evictions, []);
  assert.equal(await local.getMeta("meshLineage"), 1);
});

test("a device returning to a wiped mailbox detects eviction and republishes its rows", async () => {
  const adapter = new MemoryAdapter();
  const local = new DeviceStore();
  const before = engine(adapter, local, "keeper");
  await before.connect();
  await before.table("tasks").put("t1", { title: "Buy milk" });
  await before.table("tasks").put("t2", { title: "Call Ana" });
  await before.flush();
  const meshId = before.getConnectionStatusDetails().meshId ?? (await local.getMeta("meshId"));
  await before.disconnect();

  evictHost(adapter);

  const after = engine(adapter, local, "keeper");
  const evictions = collectEvictions(after);
  await after.connect();
  await after.flush();

  assert.equal(evictions.length, 1);
  const event = evictions[0];
  assert.equal(event.detectedBy, "missing-manifest");
  assert.equal(event.meshId, meshId);
  assert.equal(event.deviceId, "keeper");
  assert.equal(event.remotePath, REMOTE);
  assert.equal(event.previousLineage, 1);
  assert.equal(event.lineage, 2);
  assert.equal(event.localRowCount, 2);
  assert.equal(event.policy, "refill");
  assert.equal(event.attestation, null);
  assert.equal(await local.getMeta("meshLineage"), 2);
  await after.disconnect();

  // The rows are back in the mailbox: a device that has never seen this mesh
  // pulls both of them out of it.
  const observer = engine(adapter, new DeviceStore(), "observer");
  await observer.connect();
  const titles = (await observer.table("tasks").query()).map((row) => row.title).toSorted();
  assert.deepEqual(titles, ["Buy milk", "Call Ana"]);
  await observer.disconnect();
});

test("the host's attestation reaches the event when one is published", async () => {
  const adapter = new MemoryAdapter();
  const local = new DeviceStore();
  const before = engine(adapter, local, "attested");
  await before.connect();
  await before.table("tasks").put("t1", { title: "Buy milk" });
  await before.flush();
  await before.disconnect();

  evictHost(adapter);
  const record = {
    evicted: true,
    meshAddress: "main",
    remotePath: REMOTE,
    evictedAt: "2026-09-18T03:00:00.000Z",
    reason: "idle",
    idleSince: "2025-09-17T11:42:05.000Z",
    fileBodiesRetained: true,
  };
  publishAttestation(adapter, record);

  const after = engine(adapter, local, "attested");
  const evictions = collectEvictions(after);
  await after.connect();
  assert.equal(evictions.length, 1);
  assert.deepEqual(evictions[0].attestation, record);
  await after.disconnect();
});

test("a device that missed the eviction detects the lineage change and republishes", async () => {
  const adapter = new MemoryAdapter();
  const localA = new DeviceStore();
  const localB = new DeviceStore();

  const a = engine(adapter, localA, "device-a");
  await a.connect();
  await a.table("tasks").put("shared", { title: "Shared row" });
  await a.flush();
  await a.disconnect();

  // B syncs, then writes a row only B holds, then goes away.
  const b = engine(adapter, localB, "device-b");
  await b.connect();
  await b.table("tasks").put("only-b", { title: "Only B has this" });
  await b.flush();
  await b.disconnect();

  // A pulls B's row so it is not the one carrying the whole mesh, then the
  // host reclaims the mesh and A refills it.
  const aAgain = engine(adapter, localA, "device-a");
  await aAgain.connect();
  await aAgain.disconnect();
  evictHost(adapter);
  const aRefill = engine(adapter, localA, "device-a");
  await aRefill.connect();
  await aRefill.flush();
  await aRefill.disconnect();

  const bReturns = engine(adapter, localB, "device-b");
  const evictions = collectEvictions(bReturns);
  await bReturns.connect();
  await bReturns.flush();

  assert.equal(evictions.length, 1);
  assert.equal(evictions[0].detectedBy, "lineage-change");
  assert.equal(evictions[0].previousLineage, 1);
  assert.equal(evictions[0].lineage, 2);
  await bReturns.disconnect();

  // One reconnect later, the same eviction is not reported a second time.
  const bSettled = engine(adapter, localB, "device-b");
  const settled = collectEvictions(bSettled);
  await bSettled.connect();
  await bSettled.disconnect();
  assert.deepEqual(settled, []);
});

test("the manual policy reports the eviction and republishes nothing until asked", async () => {
  const adapter = new MemoryAdapter();
  const local = new DeviceStore();
  const before = engine(adapter, local, "manual");
  await before.connect();
  await before.table("tasks").put("t1", { title: "Buy milk" });
  await before.flush();
  await before.disconnect();

  evictHost(adapter);

  const after = engine(adapter, local, "manual", { evictedMeshPolicy: "manual" });
  const evictions = collectEvictions(after);
  await after.connect();
  await after.flush();

  assert.equal(evictions.length, 1);
  assert.equal(evictions[0].policy, "manual");
  assert.equal(after.awaitingEvictedMeshRefill, true);

  const empty = engine(adapter, new DeviceStore(), "empty-observer");
  await empty.connect();
  assert.deepEqual(await empty.table("tasks").query(), []);
  await empty.disconnect();

  await after.refillEvictedMesh();
  assert.equal(after.awaitingEvictedMeshRefill, false);
  await after.disconnect();

  const filled = engine(adapter, new DeviceStore(), "late-observer");
  await filled.connect();
  assert.deepEqual(
    (await filled.table("tasks").query()).map((row) => row.title),
    ["Buy milk"],
  );
  await filled.disconnect();
});
