import { expect, test } from "@playwright/test";
import { Interocitor, MemoryLocalStore, type ConnectedStoreCredentials } from "@interocitor/core";

import { useConnectedStore, useConnectedStores } from "../../dist/index.js";
import { deferred, renderHook, runInAct, waitFor } from "./helpers.js";

function credentials(id: string, remotePath = `/${id}`): ConnectedStoreCredentials {
  return {
    id,
    remotePath,
    passphrase: null,
    encrypted: false,
    dbName: `${id}-db`,
  };
}

async function createDatabase(deviceId: string): Promise<Interocitor<Record<string, never>>> {
  const database = new Interocitor<Record<string, never>>({
    keySource: null,
    deviceId,
    localStore: new MemoryLocalStore(),
  });
  await database.init();
  return database;
}

test("useConnectedStores lists and proxies credential mutations", async () => {
  const database = await createDatabase("react_connected_stores");
  const harness = await renderHook(() => useConnectedStores(database));

  await waitFor(() => {
    expect(harness.result().loading).toBe(false);
    expect(harness.result().credentials).toEqual([]);
  });

  const stored = await runInAct(() => harness.result().put(credentials("reviews")));
  expect(stored.id).toBe("reviews");
  expect(stored.createdAt).toBeTruthy();
  expect(harness.result().credentials.map(({ id }) => id)).toEqual(["reviews"]);
  expect((await harness.result().get("reviews"))?.id).toBe("reviews");

  expect(await runInAct(() => harness.result().remove("missing"))).toBe(false);
  expect(await runInAct(() => harness.result().remove("reviews"))).toBe(true);
  expect(harness.result().credentials).toEqual([]);

  await harness.unmount();
  await database.disconnect();
});

test("useConnectedStore follows id changes and supports explicit refresh", async () => {
  const database = await createDatabase("react_connected_store");
  await database.connectedStores.put(credentials("alpha"));
  await database.connectedStores.put(credentials("beta"));
  let id = "alpha";
  const harness = await renderHook(() => useConnectedStore(database, id));

  await waitFor(() => expect(harness.result().credentials?.id).toBe("alpha"));
  id = "beta";
  await harness.rerender();
  await waitFor(() => expect(harness.result().credentials?.id).toBe("beta"));

  await database.connectedStores.put(credentials("beta", "/beta-updated"));
  await runInAct(() => harness.result().refresh());
  expect(harness.result().credentials?.remotePath).toBe("/beta-updated");

  await harness.unmount();
  await database.disconnect();
});

test("connected-store hooks normalize non-Error failures", async () => {
  const database = {
    connectedStores: {
      list: () => Promise.reject("vault unavailable"),
      get: () => Promise.resolve(null),
      put: (value: ConnectedStoreCredentials) => Promise.resolve(value),
      remove: () => Promise.resolve(false),
    },
  } as unknown as Interocitor<Record<string, never>>;
  const harness = await renderHook(() => useConnectedStores(database));

  await waitFor(() => {
    expect(harness.result().loading).toBe(false);
    expect(harness.result().error).toBeInstanceOf(Error);
    expect(harness.result().error?.message).toBe("vault unavailable");
  });

  await harness.unmount();
});

test("useConnectedStores ignores a stale list after the database changes", async () => {
  const stale = deferred<ConnectedStoreCredentials[]>();
  const first = {
    connectedStores: {
      list: () => stale.promise,
    },
  } as unknown as Interocitor<Record<string, never>>;
  const second = {
    connectedStores: {
      list: () => Promise.resolve([credentials("second")]),
    },
  } as unknown as Interocitor<Record<string, never>>;
  let database = first;
  const harness = await renderHook(() => useConnectedStores(database));

  database = second;
  await harness.rerender();
  await waitFor(() => expect(harness.result().credentials[0]?.id).toBe("second"));
  stale.resolve([credentials("stale")]);
  await runInAct(() => stale.promise);
  expect(harness.result().credentials[0]?.id).toBe("second");

  await harness.unmount();
});

test("useConnectedStore ignores a stale read after the id changes", async () => {
  const stale = deferred<ConnectedStoreCredentials | null>();
  const database = {
    connectedStores: {
      get: (id: string) =>
        id === "first" ? stale.promise : Promise.resolve(credentials("second")),
    },
  } as unknown as Interocitor<Record<string, never>>;
  let id = "first";
  const harness = await renderHook(() => useConnectedStore(database, id));

  id = "second";
  await harness.rerender();
  await waitFor(() => expect(harness.result().credentials?.id).toBe("second"));
  stale.resolve(credentials("first"));
  await runInAct(() => stale.promise);
  expect(harness.result().credentials?.id).toBe("second");

  await harness.unmount();
});
