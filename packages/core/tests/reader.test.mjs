import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Interocitor,
  InterocitorReader,
  MemoryLocalStore,
  ReaderRemotePullIncompleteError,
} from "../dist/index.js";
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

test("InterocitorReader readOnce bypasses broken persistence and reports cold replay", async () => {
  const adapter = new MemoryAdapter();
  const writer = new Interocitor(adapter, {
    remotePath: "/reader-once",
    localStore: new MemoryLocalStore(),
    keySource: null,
    deviceId: "writer",
    batchWindowMs: 0,
    autoCompact: false,
  });
  await writer.connect();
  await writer.table("tasks").put("task-1", { title: "Authoritative" });
  await writer.flush();

  class BrokenPersistentStore extends MemoryLocalStore {
    async open() {
      throw new DOMException("persistent storage unavailable", "UnknownError");
    }
  }

  const reader = new InterocitorReader(adapter, {
    remotePath: "/reader-once",
    localStore: new BrokenPersistentStore(),
    keySource: null,
    relayEnabled: false,
  });

  const result = await reader.readOnce(async (view) => view.table("tasks").query());
  assert.deepEqual(result.value, [{ title: "Authoritative" }]);
  assert.deepEqual(result.diagnostics.cache, {
    mode: "memory",
    persistent: false,
    coldReplay: true,
  });
  assert.equal(result.diagnostics.consistency, "completed-remote-pull");
  assert.equal(result.diagnostics.elapsedMs >= 0, true);
  assert.equal(reader.isReady(), false);

  await writer.disconnect();
});

test("InterocitorReader rejects a connect deadline instead of exposing an empty cache", async () => {
  const adapter = new MemoryAdapter();
  adapter.readFile = async () =>
    new Promise(() => {
      // Simulate a remote request that never settles.
    });
  const stalls = [];
  const reader = new InterocitorReader(adapter, {
    remotePath: "/reader-stalled",
    keySource: null,
    relayEnabled: false,
    connectStageTimeoutMs: 10,
    onConnectStalled: (info) => stalls.push(info),
  });

  await assert.rejects(
    reader.connect(),
    (error) =>
      error instanceof ReaderRemotePullIncompleteError &&
      error.code === "READER_REMOTE_PULL_INCOMPLETE" &&
      error.stage === "loadExistingManifest" &&
      error.timeoutMs === 10,
  );
  assert.equal(reader.isConnected(), false);
  assert.equal(stalls.length, 1);
  await reader.disconnect();
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
