import assert from "node:assert/strict";
import { test } from "node:test";

import { Interocitor, MemoryLocalStore } from "../dist/index.js";
import { MemoryAdapter } from "../dist/adapters/memory.js";

/**
 * Referenced libuv handles are what decides whether Node can exit. A timer that
 * is merely *pending* is fine; a timer that is pending **and referenced** holds
 * the process open. `process.getActiveResourcesInfo()` lists only the
 * referenced ones, which is exactly the question being asked here.
 */
function referencedTimers() {
  return process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
}

function engine(adapter, overrides = {}) {
  return new Interocitor(adapter, {
    remotePath: "/timer-lifecycle",
    localStore: new MemoryLocalStore(),
    keySource: null,
    deviceId: "device_timers",
    batchWindowMs: 0,
    autoCompact: false,
    pollInterval: 30_000,
    ...overrides,
  });
}

test("a connected mesh does not keep the host process alive", async () => {
  const before = referencedTimers();
  const mesh = engine(new MemoryAdapter());
  await mesh.connect();
  await mesh.table("tasks").put("t1", { title: "still running" });
  await mesh.flush();

  // Polling is live at this point — the assertion is that it is unref'd, not
  // that it is absent. A library's background poll must not by itself decide
  // when its host is allowed to exit.
  assert.equal(
    referencedTimers(),
    before,
    "a connected mesh added a referenced timer; the host can no longer exit on its own",
  );
  await mesh.disconnect();
});

test("polling cannot restart after disconnect()", async () => {
  const adapter = new MemoryAdapter();
  const mesh = engine(adapter);
  await mesh.connect();
  await mesh.disconnect();

  // The relay callbacks (onReady/onError/onClose) and the late continuation of
  // a rejected connect() all reach startPolling(). Before the teardown gate,
  // any of them re-armed the loop with a fresh generation token that nothing
  // would ever invalidate: the mesh was closed and the poll ran forever.
  let pulls = 0;
  const listFiles = adapter.listFiles.bind(adapter);
  adapter.listFiles = (...args) => {
    pulls += 1;
    return listFiles(...args);
  };

  mesh.startPolling(1);
  await new Promise((resolve) => {
    setTimeout(resolve, 60);
  });
  assert.equal(pulls, 0, "startPolling() re-armed the loop after disconnect()");
  assert.equal(mesh.pollTimer, null);

  // connect() is the only thing that lifts the gate.
  await mesh.connect();
  assert.notEqual(mesh.pollTimer, null, "connect() did not resume polling");
  await mesh.disconnect();
});

test("disconnect() leaves no referenced timer behind", async () => {
  const before = referencedTimers();
  const mesh = engine(new MemoryAdapter());
  await mesh.connect();
  await mesh.table("tasks").put("t1", { title: "done" });
  await mesh.flush();
  await mesh.disconnect();
  assert.equal(referencedTimers(), before);
});
