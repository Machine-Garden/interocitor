import { expect, test } from "@playwright/test";
import { Interocitor, MemoryLocalStore } from "@interocitor/core";
import { MemoryAdapter } from "@interocitor/core/adapters/memory";

import { useConnectionStatus, useIsSolo } from "../../dist/index.js";
import { renderHook, runInAct, waitFor } from "./helpers.js";

type Schema = { tasks: { title: string } };

test("connection hooks expose solo local readiness separately from transport status", async () => {
  const database = new Interocitor<Schema>({
    keySource: null,
    deviceId: "react_status_solo",
    localStore: new MemoryLocalStore(),
  });
  await database.init();
  const harness = await renderHook(() => ({
    status: useConnectionStatus(database),
    solo: useIsSolo(database),
  }));

  expect(harness.result()).toEqual({ status: "offline", solo: true });

  await harness.unmount();
  await database.disconnect();
});

test("connection hooks follow connect and disconnect transitions", async () => {
  const database = new Interocitor<Schema>(new MemoryAdapter(), {
    remotePath: "/ReactConnectionStatus",
    keySource: null,
    deviceId: "react_status_remote",
    localStore: new MemoryLocalStore(),
  });
  await database.init();
  const harness = await renderHook(() => ({
    status: useConnectionStatus(database),
    solo: useIsSolo(database),
  }));

  expect(harness.result()).toEqual({ status: "offline", solo: false });
  await runInAct(() => database.connect());
  await waitFor(() => expect(harness.result()).toEqual({ status: "idle", solo: false }));
  await runInAct(() => database.disconnect());
  await waitFor(() => expect(harness.result()).toEqual({ status: "offline", solo: false }));

  await harness.unmount();
});

test("useIsSolo follows mesh configuration before initialization", async () => {
  const database = new Interocitor<Schema>({
    keySource: null,
    deviceId: "react_status_configure",
    localStore: new MemoryLocalStore(),
  });
  const harness = await renderHook(() => useIsSolo(database));

  expect(harness.result()).toBe(true);
  await runInAct(() => database.configureMesh({ remotePath: "/ConfiguredFromReact" }));
  expect(harness.result()).toBe(false);

  await harness.unmount();
  await database.disconnect();
});
