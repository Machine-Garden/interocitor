import assert from "node:assert/strict";
import { test } from "node:test";

import { Interocitor, InterocitorReader, MemoryLocalStore } from "../dist/index.js";
import { MemoryAdapter } from "../dist/adapters/memory.js";

test("InterocitorReader consumes an existing mesh without remote writes or device identity", async () => {
  const adapter = new MemoryAdapter();
  const writer = new Interocitor(adapter, {
    remotePath: "/reader-mesh",
    localStore: new MemoryLocalStore(),
    keySource: null,
    deviceId: "writer",
    batchWindowMs: 0,
    autoCompact: false,
  });
  await writer.connect();
  await writer.table("tasks").put("task-1", { title: "Family dinner", done: false });
  await writer.putFile("photos/menu.txt", "curry", "text/plain");
  await writer.flush();

  const mailboxBefore = Object.keys(adapter.dump()).toSorted();
  const attemptedWrites = [];
  for (const method of [
    "ensureFolder",
    "writeFile",
    "deleteFile",
    "putStoredFile",
    "deleteStoredFile",
  ]) {
    const original = adapter[method].bind(adapter);
    adapter[method] = (...args) => {
      attemptedWrites.push(method);
      return original(...args);
    };
  }

  const localStore = new MemoryLocalStore();
  const reader = new InterocitorReader(adapter, {
    remotePath: "/reader-mesh",
    localStore,
    keySource: null,
    relayEnabled: false,
  });

  assert.equal("put" in reader, false);
  assert.equal("putFile" in reader, false);
  assert.equal("put" in reader.table("tasks"), false);
  assert.equal("delete" in reader.table("tasks"), false);

  await reader.connect();
  assert.deepEqual(await reader.table("tasks").query(), [{ title: "Family dinner", done: false }]);
  assert.equal(new TextDecoder().decode(await reader.getFile("photos/menu.txt")), "curry");
  assert.equal(await localStore.getMeta("deviceId"), undefined);
  assert.deepEqual(Object.keys(adapter.dump()).toSorted(), mailboxBefore);
  assert.deepEqual(attemptedWrites, []);

  await reader.disconnect();
  assert.deepEqual(attemptedWrites, []);
  await writer.disconnect();
});

test("InterocitorReader refuses to bootstrap a missing mesh", async () => {
  const adapter = new MemoryAdapter();
  const reader = new InterocitorReader(adapter, {
    remotePath: "/missing-reader-mesh",
    keySource: null,
    relayEnabled: false,
  });

  await assert.rejects(reader.connect(), /not found/i);
  assert.deepEqual(adapter.dump(), {});
});

test("InterocitorReader restores a newer compacted snapshot without acknowledging it", async () => {
  const adapter = new MemoryAdapter();
  const writer = new Interocitor(adapter, {
    remotePath: "/reader-compaction",
    localStore: new MemoryLocalStore(),
    keySource: null,
    deviceId: "writer",
    serverManaged: true,
    serverId: "writer",
    batchWindowMs: 0,
    autoCompact: false,
  });
  await writer.connect();
  await writer.table("tasks").put("task-1", { title: "Before" });
  await writer.flush();

  const reader = new InterocitorReader(adapter, {
    remotePath: "/reader-compaction",
    localStore: new MemoryLocalStore(),
    keySource: null,
    serverId: "writer",
    relayEnabled: false,
  });
  const readerEvents = [];
  reader.on((event) => readerEvents.push(event));
  await reader.connect();

  await writer.table("tasks").put("task-1", { title: "After" });
  await writer.flush();
  await writer.compact();
  const mailboxAfterCompaction = Object.keys(adapter.dump()).toSorted();

  await reader.pull();
  assert.equal((await reader.table("tasks").row("task-1")).title, "After");
  assert.deepEqual(Object.keys(adapter.dump()).toSorted(), mailboxAfterCompaction);
  assert.equal(
    Object.keys(adapter.dump()).some((path) => path.includes("/devices/reader.json")),
    false,
  );
  assert.equal(
    readerEvents.some((event) => event.type === "compact:retention:scheduled"),
    false,
  );

  await reader.disconnect();
  await writer.disconnect();
});
