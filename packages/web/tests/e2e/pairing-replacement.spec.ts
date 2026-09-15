import { expect, test } from "@playwright/test";

import {
  attachWebDavRouteMock,
  createWebDavRouteState,
} from "../../../core/tests/e2e/helpers/webdav-route-mock.ts";

type Page = import("@playwright/test").Page;

const HARNESS = "/packages/core/tests/e2e/fixtures/harness-plain.html";

async function clearBrowserMeshState(page: Page, dbName: string): Promise<void> {
  await page.evaluate(async (name) => {
    localStorage.removeItem(`interocitor-creds:${name}`);
    localStorage.removeItem("interocitor-device-id");
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    });
  }, dbName);
}

test("share pairing rejects an in-place key swap and joins through isolated durable state", async ({
  browser,
}) => {
  const oldRemote = createWebDavRouteState();
  const targetRemote = createWebDavRouteState();
  const ownerContext = await browser.newContext();
  const joinerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  const joinerPage = await joinerContext.newPage();
  const dbName = "pairing-durable-replacement";
  const joinedDbName = "pairing-durable-target";

  try {
    for (const context of [ownerContext, joinerContext]) {
      await attachWebDavRouteMock(context, oldRemote, "/__pair_old__");
      await attachWebDavRouteMock(context, targetRemote, "/__pair_target__");
    }
    await Promise.all([ownerPage.goto(HARNESS), joinerPage.goto(HARNESS)]);
    await clearBrowserMeshState(joinerPage, dbName);
    await clearBrowserMeshState(joinerPage, joinedDbName);

    const old = await joinerPage.evaluate(async (name) => {
      const { Interocitor, PortablePassphraseKeySource } =
        await import("/packages/core/dist/index.js");
      const { WebDAVAdapter } = await import("/packages/core/dist/adapters/webdav.js");
      const { IndexedDbLocalStore } =
        await import("/packages/web/dist/storage/indexed-db-local-store.js");
      const { createWebCredentialStore } = await import("/packages/web/dist/credential-store.js");
      const credentialStore = createWebCredentialStore(name);
      const keySource = new PortablePassphraseKeySource({ credentialStore });
      const engine = new Interocitor(
        new WebDAVAdapter({
          baseUrl: `${location.origin}/__pair_old__`,
          auth: { username: "u", password: "p" },
        }),
        {
          dbName: name,
          remotePath: "/OldHousehold",
          deviceId: "joining_phone",
          keySource,
          localStore: new IndexedDbLocalStore(name),
          batchWindowMs: 0,
          pollInterval: 600_000,
        },
      );
      await engine.init();
      await engine.connect();
      await engine.put("tasks", "old-only", { title: "old household" });
      await engine.flush();
      const result = {
        meshId: engine.getMeshId(),
        portableKey: keySource.getPortableKey(),
        credentials: await credentialStore.load(),
      };
      await engine.disconnect();
      return result;
    }, dbName);
    expect(old.meshId).toBeTruthy();
    expect(old.credentials?.meshId).toBe(old.meshId);

    const target = await ownerPage.evaluate(async () => {
      const { Interocitor, MemoryLocalStore, PortablePassphraseKeySource } =
        await import("/packages/core/dist/index.js");
      const { WebDAVAdapter } = await import("/packages/core/dist/adapters/webdav.js");
      const adapter = new WebDAVAdapter({
        baseUrl: `${location.origin}/__pair_target__`,
        auth: { username: "u", password: "p" },
      });
      const keySource = new PortablePassphraseKeySource();
      const engine = new Interocitor(adapter, {
        dbName: "pairing-target-owner",
        remotePath: "/TargetHousehold",
        deviceId: "target_owner",
        keySource,
        localStore: new MemoryLocalStore(),
        batchWindowMs: 0,
        pollInterval: 600_000,
      });
      await engine.init();
      await engine.connect();
      await engine.put("tasks", "target-only", { title: "target household" });
      await engine.flush();
      const result = { meshId: engine.getMeshId(), portableKey: keySource.getPortableKey() };
      await engine.disconnect();
      return result;
    });
    expect(target.meshId).toBeTruthy();
    expect(target.meshId).not.toBe(old.meshId);

    const rejectedReplacement = await joinerPage.evaluate(async (name) => {
      const { CredentialReplacementRequiredError, Interocitor, PortablePassphraseKeySource } =
        await import("/packages/core/dist/index.js");
      const { generateKey, keyToPassphrase } = await import("/packages/core/dist/crypto/keys.js");
      const { WebDAVAdapter } = await import("/packages/core/dist/adapters/webdav.js");
      const { IndexedDbLocalStore } =
        await import("/packages/web/dist/storage/indexed-db-local-store.js");
      const { createWebCredentialStore } = await import("/packages/web/dist/credential-store.js");
      const credentialStore = createWebCredentialStore(name);
      const localStore = new IndexedDbLocalStore(name);
      const engine = new Interocitor(
        new WebDAVAdapter({
          baseUrl: `${location.origin}/__pair_target__`,
          auth: { username: "u", password: "p" },
        }),
        {
          dbName: name,
          remotePath: "/TargetHousehold",
          deviceId: "joining_phone",
          keySource: new PortablePassphraseKeySource({
            portableKey: await keyToPassphrase(await generateKey()),
            credentialStore,
          }),
          localStore,
          pollInterval: 600_000,
        },
      );
      let error: unknown;
      try {
        await engine.init();
      } catch (cause) {
        error = cause;
      }
      const rows = await localStore.getAllRows();
      const result = {
        isReplacementRequired: error instanceof CredentialReplacementRequiredError,
        errorCode: (error as { code?: string } | undefined)?.code,
        rowIds: rows.map((row: any) => row._meta.rowId),
        credentials: await credentialStore.load(),
      };
      localStore.close();
      return result;
    }, dbName);

    expect(rejectedReplacement.isReplacementRequired).toBe(true);
    expect(rejectedReplacement.errorCode).toBe("CREDENTIAL_REPLACEMENT_REQUIRED");
    expect(rejectedReplacement.rowIds).toEqual(["old-only"]);
    expect(rejectedReplacement.credentials).toMatchObject({
      portableKey: old.portableKey,
      meshId: old.meshId,
    });

    const invitation = await ownerPage.evaluate(async (portableKey) => {
      const { generateShareQR } = await import("/packages/core/dist/index.js");
      const { WebDAVAdapter } = await import("/packages/core/dist/adapters/webdav.js");
      const adapter = new WebDAVAdapter({
        baseUrl: `${location.origin}/__pair_target__`,
        auth: { username: "u", password: "p" },
      });
      const { qrPayload, complete } = await generateShareQR({
        adapter,
        relayBase: "/Pairing",
        remotePath: "/TargetHousehold",
        passphrase: portableKey,
        pollIntervalMs: 20,
        timeoutMs: 10_000,
      });
      (window as typeof window & { completePairing?: () => Promise<void> }).completePairing =
        complete;
      return qrPayload;
    }, target.portableKey);

    const [, joined] = await Promise.all([
      ownerPage.evaluate(async () => {
        await (
          window as typeof window & { completePairing: () => Promise<void> }
        ).completePairing();
      }),
      joinerPage.evaluate(
        async ({ payload, name }) => {
          const { Interocitor, PortablePassphraseKeySource, handleScannedQR, readColumn } =
            await import("/packages/core/dist/index.js");
          const { WebDAVAdapter } = await import("/packages/core/dist/adapters/webdav.js");
          const { IndexedDbLocalStore } =
            await import("/packages/web/dist/storage/indexed-db-local-store.js");
          const { createWebCredentialStore } =
            await import("/packages/web/dist/credential-store.js");
          const adapter = new WebDAVAdapter({
            baseUrl: `${location.origin}/__pair_target__`,
            auth: { username: "u", password: "p" },
          });
          const received = await handleScannedQR({
            adapter,
            relayBase: "/Pairing",
            payload,
            pollIntervalMs: 20,
            timeoutMs: 10_000,
          });
          if (!received?.passphrase) throw new Error("share pairing returned no protected key");

          const credentialStore = createWebCredentialStore(name);
          const keySource = new PortablePassphraseKeySource({
            portableKey: received.passphrase,
            credentialStore,
          });
          const localStore = new IndexedDbLocalStore(name);
          const engine = new Interocitor(adapter, {
            dbName: name,
            remotePath: received.remotePath,
            deviceId: "joining_phone",
            keySource,
            localStore,
            batchWindowMs: 0,
            pollInterval: 600_000,
          });
          const events: any[] = [];
          engine.on((event) => events.push(event));
          await engine.init();
          await engine.connect();
          const rows = await engine.query("tasks");
          await engine.put("tasks", "joined-write", { title: "written after joining" });
          await engine.flush();
          const result = {
            meshId: engine.getMeshId(),
            titles: rows.map((row: any) => readColumn(row, "title")).toSorted(),
            localMeshId: await localStore.getMeta("meshId"),
            credentials: await credentialStore.load(),
            joins: events.filter((event) => event.type === "join:existing-mesh"),
            poisonCount: events.filter((event) => event.type === "remote:poisoned").length,
          };
          await engine.disconnect();
          return result;
        },
        { payload: invitation, name: joinedDbName },
      ),
    ]);

    expect(joined.meshId).toBe(target.meshId);
    expect(joined.localMeshId).toBe(target.meshId);
    expect(joined.credentials?.meshId).toBe(target.meshId);
    expect(joined.credentials?.portableKey).toBe(target.portableKey);
    expect(joined.titles).toEqual(["target household"]);
    expect(joined.joins).toEqual([]);
    expect(joined.poisonCount).toBe(0);

    await joinerPage.reload();
    const reloaded = await joinerPage.evaluate(async (name) => {
      const { Interocitor, PortablePassphraseKeySource, readColumn } =
        await import("/packages/core/dist/index.js");
      const { WebDAVAdapter } = await import("/packages/core/dist/adapters/webdav.js");
      const { IndexedDbLocalStore } =
        await import("/packages/web/dist/storage/indexed-db-local-store.js");
      const { createWebCredentialStore } = await import("/packages/web/dist/credential-store.js");
      const credentialStore = createWebCredentialStore(name);
      const keySource = new PortablePassphraseKeySource({ credentialStore });
      const engine = new Interocitor(
        new WebDAVAdapter({
          baseUrl: `${location.origin}/__pair_target__`,
          auth: { username: "u", password: "p" },
        }),
        {
          dbName: name,
          remotePath: "/TargetHousehold",
          deviceId: "joining_phone",
          keySource,
          localStore: new IndexedDbLocalStore(name),
          pollInterval: 600_000,
        },
      );
      const events: any[] = [];
      engine.on((event) => events.push(event));
      await engine.init();
      await engine.connect();
      const rows = await engine.query("tasks");
      const result = {
        meshId: engine.getMeshId(),
        portableKey: keySource.getPortableKey(),
        titles: rows.map((row: any) => readColumn(row, "title")).toSorted(),
        poisonCount: events.filter((event) => event.type === "remote:poisoned").length,
      };
      await engine.disconnect();
      return result;
    }, joinedDbName);

    expect(reloaded.meshId).toBe(target.meshId);
    expect(reloaded.portableKey).toBe(target.portableKey);
    expect(reloaded.titles).toEqual(["target household", "written after joining"]);
    expect(reloaded.poisonCount).toBe(0);
    const preservedOldRows = await joinerPage.evaluate(async (name) => {
      const { IndexedDbLocalStore } =
        await import("/packages/web/dist/storage/indexed-db-local-store.js");
      const store = new IndexedDbLocalStore(name);
      await store.open();
      const rowIds = (await store.getAllRows()).map((row: any) => row._meta.rowId);
      store.close();
      return rowIds;
    }, dbName);
    expect(preservedOldRows).toEqual(["old-only"]);
    expect([...targetRemote.files.keys()].some((path) => path.includes("old-only"))).toBe(false);
  } finally {
    await Promise.all([ownerContext.close(), joinerContext.close()]);
  }
});

test("live credential mismatch preserves rows, outbox, cursors, and metadata", async ({
  browser,
}) => {
  const oldRemote = createWebDavRouteState();
  const targetRemote = createWebDavRouteState();
  const context = await browser.newContext();
  const page = await context.newPage();
  const dbName = "connect-mismatch-preserves-local";

  try {
    await attachWebDavRouteMock(context, oldRemote, "/__preserve_old__");
    await attachWebDavRouteMock(context, targetRemote, "/__preserve_target__");
    await page.goto(HARNESS);
    await clearBrowserMeshState(page, dbName);

    const oldMeshId = await page.evaluate(async (name) => {
      const { Interocitor, PortablePassphraseKeySource } =
        await import("/packages/core/dist/index.js");
      const { WebDAVAdapter } = await import("/packages/core/dist/adapters/webdav.js");
      const { IndexedDbLocalStore } =
        await import("/packages/web/dist/storage/indexed-db-local-store.js");
      const { createWebCredentialStore } = await import("/packages/web/dist/credential-store.js");
      const engine = new Interocitor(
        new WebDAVAdapter({
          baseUrl: `${location.origin}/__preserve_old__`,
          auth: { username: "u", password: "p" },
        }),
        {
          dbName: name,
          remotePath: "/PreserveOld",
          deviceId: "preserved_device",
          keySource: new PortablePassphraseKeySource({
            credentialStore: createWebCredentialStore(name),
          }),
          localStore: new IndexedDbLocalStore(name),
          batchWindowMs: 0,
          pollInterval: 600_000,
        },
      );
      await engine.init();
      await engine.connect();
      await engine.put("tasks", "keep-row", { title: "keep" });
      await engine.flush();
      const meshId = engine.getMeshId();
      await engine.disconnect();

      const store = new IndexedDbLocalStore(name);
      await store.open();
      await store.pushOutbox({
        id: "chg_keep",
        ts: 1,
        device: "preserved_device",
        hlc: "000000000000001-0000-preserved_device",
        ops: [],
      } as any);
      await store.setCursor("peer", 17);
      await store.setMeta("sentinel", { keep: true });
      store.close();
      return meshId;
    }, dbName);

    const targetMeshId = await page.evaluate(async () => {
      const { Interocitor, MemoryLocalStore, PortablePassphraseKeySource } =
        await import("/packages/core/dist/index.js");
      const { WebDAVAdapter } = await import("/packages/core/dist/adapters/webdav.js");
      const engine = new Interocitor(
        new WebDAVAdapter({
          baseUrl: `${location.origin}/__preserve_target__`,
          auth: { username: "u", password: "p" },
        }),
        {
          dbName: "preserve-target-owner",
          remotePath: "/PreserveTarget",
          deviceId: "target_owner",
          keySource: new PortablePassphraseKeySource(),
          localStore: new MemoryLocalStore(),
          pollInterval: 600_000,
        },
      );
      await engine.init();
      await engine.connect();
      const meshId = engine.getMeshId();
      await engine.disconnect();
      return meshId;
    });
    expect(targetMeshId).not.toBe(oldMeshId);

    const result = await page.evaluate(async (name) => {
      const { Interocitor, MeshCredentialMismatchError, PortablePassphraseKeySource } =
        await import("/packages/core/dist/index.js");
      const { WebDAVAdapter } = await import("/packages/core/dist/adapters/webdav.js");
      const { IndexedDbLocalStore } =
        await import("/packages/web/dist/storage/indexed-db-local-store.js");
      const { createWebCredentialStore } = await import("/packages/web/dist/credential-store.js");
      const localStore = new IndexedDbLocalStore(name);
      const engine = new Interocitor(
        new WebDAVAdapter({
          baseUrl: `${location.origin}/__preserve_target__`,
          auth: { username: "u", password: "p" },
        }),
        {
          dbName: name,
          remotePath: "/PreserveTarget",
          keySource: new PortablePassphraseKeySource({
            credentialStore: createWebCredentialStore(name),
          }),
          localStore,
          pollInterval: 600_000,
        },
      );
      await engine.init();
      let error: unknown;
      try {
        await engine.connect();
      } catch (cause) {
        error = cause;
      }
      return {
        mismatch: error instanceof MeshCredentialMismatchError,
        rows: (await localStore.getAllRows()).map((row: any) => row._meta.rowId),
        outbox: (await localStore.peekOutbox()).map((entry: any) => entry.id),
        cursor: await localStore.getCursor("peer"),
        sentinel: await localStore.getMeta("sentinel"),
        meshId: await localStore.getMeta("meshId"),
      };
    }, dbName);

    expect(result).toEqual({
      mismatch: true,
      rows: ["keep-row"],
      outbox: ["chg_keep"],
      cursor: 17,
      sentinel: { keep: true },
      meshId: oldMeshId,
    });
  } finally {
    await context.close();
  }
});

test("durable credential inspection and persistence fail closed", async ({ page }) => {
  await page.goto(HARNESS);
  const result = await page.evaluate(async () => {
    const {
      CredentialPersistenceError,
      Interocitor,
      MemoryLocalStore,
      MeshKeySourceContractError,
    } = await import("/packages/core/dist/index.js");
    const { generateKey, keyToPassphrase } = await import("/packages/core/dist/crypto/keys.js");
    const portableKey = await keyToPassphrase(await generateKey());
    const base = {
      credentialPersistence: "durable" as const,
      load: async () => ({ encrypted: true, key: null, portableKey }),
      clear: async () => {},
    };

    let inspectPersistCalls = 0;
    const inspectEngine = new Interocitor({
      dbName: "inspect-failure",
      localStore: new MemoryLocalStore(),
      keySource: {
        ...base,
        loadPersistedCredentials: async () => {
          throw new Error("vault unavailable");
        },
        persist: async () => {
          inspectPersistCalls += 1;
        },
      },
    });
    let inspectError: unknown;
    try {
      await inspectEngine.init();
    } catch (cause) {
      inspectError = cause;
    }

    const saveEngine = new Interocitor({
      dbName: "save-failure",
      localStore: new MemoryLocalStore(),
      keySource: {
        ...base,
        loadPersistedCredentials: async () => null,
        persist: async () => {
          throw new Error("vault full");
        },
      },
    });
    let saveError: unknown;
    try {
      await saveEngine.init();
    } catch (cause) {
      saveError = cause;
    }

    const malformedEngine = new Interocitor({
      dbName: "malformed-source",
      localStore: new MemoryLocalStore(),
      keySource: { ...base, persist: async () => {} } as any,
    });
    let contractError: unknown;
    try {
      await malformedEngine.init();
    } catch (cause) {
      contractError = cause;
    }

    return {
      inspectTyped: inspectError instanceof CredentialPersistenceError,
      inspectOperation: (inspectError as any)?.operation,
      inspectPersistCalls,
      saveTyped: saveError instanceof CredentialPersistenceError,
      saveOperation: (saveError as any)?.operation,
      contractTyped: contractError instanceof MeshKeySourceContractError,
    };
  });

  expect(result).toEqual({
    inspectTyped: true,
    inspectOperation: "inspect",
    inspectPersistCalls: 0,
    saveTyped: true,
    saveOperation: "persist",
    contractTyped: true,
  });
});

test("simultaneous fresh initialization converges on one durable key", async ({ browser }) => {
  const context = await browser.newContext();
  const firstPage = await context.newPage();
  const secondPage = await context.newPage();
  const dbName = "simultaneous-fresh-key";
  try {
    await Promise.all([firstPage.goto(HARNESS), secondPage.goto(HARNESS)]);
    await clearBrowserMeshState(firstPage, dbName);
    const initialize = (page: Page) =>
      page.evaluate(async (name) => {
        const { Interocitor, PortablePassphraseKeySource } =
          await import("/packages/core/dist/index.js");
        const { IndexedDbLocalStore } =
          await import("/packages/web/dist/storage/indexed-db-local-store.js");
        const { createWebCredentialStore } = await import("/packages/web/dist/credential-store.js");
        const credentialStore = createWebCredentialStore(name);
        const keySource = new PortablePassphraseKeySource({ credentialStore });
        const engine = new Interocitor({
          dbName: name,
          keySource,
          localStore: new IndexedDbLocalStore(name),
        });
        await engine.init();
        return {
          key: keySource.getPortableKey(),
          stored: (await credentialStore.load())?.portableKey,
        };
      }, dbName);
    const [first, second] = await Promise.all([initialize(firstPage), initialize(secondPage)]);
    expect(first.key).toBeTruthy();
    expect(second.key).toBe(first.key);
    expect(first.stored).toBe(first.key);
    expect(second.stored).toBe(first.key);
  } finally {
    await context.close();
  }
});

test("connect fast path rejects a remotely replaced mesh before publishing", async ({
  browser,
}) => {
  const remote = createWebDavRouteState();
  const replacement = createWebDavRouteState();
  const context = await browser.newContext();
  const page = await context.newPage();
  const dbName = "fast-path-remote-replacement";
  try {
    await attachWebDavRouteMock(context, remote, "/__fast_original__");
    await attachWebDavRouteMock(context, replacement, "/__fast_replacement__");
    await page.goto(HARNESS);
    await clearBrowserMeshState(page, dbName);

    const create = (routeName: string, databaseName: string, useDurableStore: boolean) =>
      page.evaluate(
        async ({ route, name, durable }) => {
          const { Interocitor, MemoryLocalStore, PortablePassphraseKeySource } =
            await import("/packages/core/dist/index.js");
          const { WebDAVAdapter } = await import("/packages/core/dist/adapters/webdav.js");
          const { IndexedDbLocalStore } =
            await import("/packages/web/dist/storage/indexed-db-local-store.js");
          const { createWebCredentialStore } =
            await import("/packages/web/dist/credential-store.js");
          const keySource = new PortablePassphraseKeySource(
            durable ? { credentialStore: createWebCredentialStore(name) } : {},
          );
          const engine = new Interocitor(
            new WebDAVAdapter({
              baseUrl: `${location.origin}/${route}`,
              auth: { username: "u", password: "p" },
            }),
            {
              dbName: name,
              remotePath: "/FastMesh",
              deviceId: durable ? "fast_original" : "fast_replacement",
              keySource,
              localStore: durable ? new IndexedDbLocalStore(name) : new MemoryLocalStore(),
              batchWindowMs: 0,
              pollInterval: 600_000,
            },
          );
          await engine.init();
          await engine.connect();
          await engine.put("tasks", durable ? "original-row" : "replacement-row", {
            title: durable ? "original" : "replacement",
          });
          await engine.flush();
          const meshId = engine.getMeshId();
          await engine.disconnect();
          return meshId;
        },
        { route: routeName, name: databaseName, durable: useDurableStore },
      );

    const originalMeshId = await create("__fast_original__", dbName, true);
    const replacementMeshId = await create("__fast_replacement__", "fast-replacement-owner", false);
    expect(replacementMeshId).not.toBe(originalMeshId);

    for (const [path, file] of replacement.files) {
      if (!/\/manifest(?:-\d+)?\.json$/.test(path)) continue;
      remote.files.set(path, {
        data: file.data.slice(),
        modifiedTime: file.modifiedTime,
        etag: file.etag,
      });
    }
    const remoteFileCountBeforeReconnect = remote.files.size;

    const result = await page.evaluate(async (name) => {
      const { Interocitor, MeshCredentialMismatchError, PortablePassphraseKeySource } =
        await import("/packages/core/dist/index.js");
      const { WebDAVAdapter } = await import("/packages/core/dist/adapters/webdav.js");
      const { IndexedDbLocalStore } =
        await import("/packages/web/dist/storage/indexed-db-local-store.js");
      const { createWebCredentialStore } = await import("/packages/web/dist/credential-store.js");
      const localStore = new IndexedDbLocalStore(name);
      const engine = new Interocitor(
        new WebDAVAdapter({
          baseUrl: `${location.origin}/__fast_original__`,
          auth: { username: "u", password: "p" },
        }),
        {
          dbName: name,
          remotePath: "/FastMesh",
          keySource: new PortablePassphraseKeySource({
            credentialStore: createWebCredentialStore(name),
          }),
          localStore,
          pollInterval: 600_000,
        },
      );
      const events: any[] = [];
      engine.on((event) => events.push(event));
      await engine.init();
      let error: unknown;
      try {
        await engine.connect();
      } catch (cause) {
        error = cause;
      }
      return {
        mismatch: error instanceof MeshCredentialMismatchError,
        rows: (await localStore.getAllRows()).map((row: any) => row._meta.rowId),
        verifiedLiveManifest: events.some(
          (event) =>
            event.type === "trace:manifest" && event.reason === "connect-fast-path-identity",
        ),
      };
    }, dbName);

    expect(result).toEqual({
      mismatch: true,
      rows: ["original-row"],
      verifiedLiveManifest: true,
    });
    expect(remote.files.size).toBe(remoteFileCountBeforeReconnect);
  } finally {
    await context.close();
  }
});

test("mixed-key remote reports the exact poisoned change without deleting local state", async ({
  browser,
}) => {
  const remote = createWebDavRouteState();
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await attachWebDavRouteMock(context, remote, "/__mixed_key__");
    await page.goto(HARNESS);
    const setup = await page.evaluate(async () => {
      const { Interocitor, MemoryLocalStore, PortablePassphraseKeySource } =
        await import("/packages/core/dist/index.js");
      const { WebDAVAdapter } = await import("/packages/core/dist/adapters/webdav.js");
      const { generateKey, keyToPassphrase } = await import("/packages/core/dist/crypto/keys.js");
      const adapter = new WebDAVAdapter({
        baseUrl: `${location.origin}/__mixed_key__`,
        auth: { username: "u", password: "p" },
      });
      const keySource = new PortablePassphraseKeySource();
      const engine = new Interocitor(adapter, {
        dbName: "mixed-key-owner",
        remotePath: "/MixedKey",
        deviceId: "correct_writer",
        keySource,
        localStore: new MemoryLocalStore(),
        batchWindowMs: 0,
        pollInterval: 600_000,
      });
      await engine.init();
      await engine.connect();
      await engine.put("tasks", "good", { title: "good ciphertext" });
      await engine.flush();
      const result = {
        meshId: engine.getMeshId(),
        correctKey: keySource.getPortableKey(),
        wrongKey: await keyToPassphrase(await generateKey()),
      };
      await engine.disconnect();
      return result;
    });
    if (!setup.meshId || !setup.correctKey) throw new Error("encrypted fixture was not created");

    const injected = await page.evaluate(
      async ({ meshId, wrongKey }) => {
        const { passphraseToKey } = await import("/packages/core/dist/crypto/keys.js");
        const { encryptEntry } = await import("/packages/core/dist/crypto/encryption.js");
        const hlc = `${String(Date.now() + 1_000).padStart(15, "0")}-0000-wrong_writer`;
        const id = "chg_mixed_key";
        const body = await encryptEntry(
          await passphraseToKey(wrongKey),
          JSON.stringify({
            meshId,
            kind: "change",
            entry: { id, ts: Date.now(), device: "wrong_writer", hlc, ops: [] },
          }),
        );
        return { path: `/MixedKey/changes/${hlc}-${id}.json`, body };
      },
      { meshId: setup.meshId, wrongKey: setup.wrongKey },
    );
    remote.files.set(injected.path, {
      data: new TextEncoder().encode(injected.body),
      modifiedTime: new Date().toISOString(),
      etag: '"mixed-key"',
    });

    const result = await page.evaluate(async (correctKey) => {
      const { Interocitor, MemoryLocalStore, PortablePassphraseKeySource, readColumn } =
        await import("/packages/core/dist/index.js");
      const { WebDAVAdapter } = await import("/packages/core/dist/adapters/webdav.js");
      const localStore = new MemoryLocalStore();
      const engine = new Interocitor(
        new WebDAVAdapter({
          baseUrl: `${location.origin}/__mixed_key__`,
          auth: { username: "u", password: "p" },
        }),
        {
          dbName: "mixed-key-reader",
          remotePath: "/MixedKey",
          deviceId: "reader",
          keySource: new PortablePassphraseKeySource({ portableKey: correctKey }),
          localStore,
          pollInterval: 600_000,
        },
      );
      const events: any[] = [];
      engine.on((event) => events.push(event));
      let error = "";
      await engine.init();
      try {
        await engine.connect();
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
      const rows = await engine.query("tasks");
      const evaluation = {
        error,
        titles: rows.map((row: any) => readColumn(row, "title")),
        decode: events.find((event) => event.type === "decode:error"),
        poisoned: events.find((event) => event.type === "remote:poisoned"),
      };
      await engine.disconnect().catch(() => {});
      return evaluation;
    }, setup.correctKey);

    expect(result.error).toContain("payload not decryptable with the active mesh key");
    expect(result.titles).toEqual(["good ciphertext"]);
    expect(result.decode.path).toBe(injected.path);
    expect(result.decode.context).toMatchObject({ stage: "pull" });
    expect(result.poisoned.path).toBe(injected.path);
    expect(result.poisoned.context).toMatchObject({
      dbName: "mixed-key-reader",
      remotePath: "/MixedKey",
      meshId: setup.meshId,
      encrypted: true,
    });
    expect(remote.files.has(injected.path)).toBe(true);
  } finally {
    await context.close();
  }
});

test("named cache rotation preserves the encryption key across a WebKit reload", async ({
  browser,
}) => {
  const remote = createWebDavRouteState();
  const context = await browser.newContext();
  const page = await context.newPage();
  const baseName = `rotation-keeps-key-${crypto.randomUUID()}`;

  try {
    await attachWebDavRouteMock(context, remote, "/__rotation_keeps_key__");
    await page.goto("/packages/web/tests/e2e/fixtures/harness-importmap.html");

    const before = await page.evaluate(async (name) => {
      const { Interocitor, PortablePassphraseKeySource } =
        await import("/packages/core/dist/index.js");
      const { WebDAVAdapter } = await import("/packages/core/dist/adapters/webdav.js");
      const {
        UnstableCredentialNamespaceError,
        createNamedLocalStore,
        createWebCredentialStore,
        rotateLocalDatabaseName,
      } = await import("/packages/web/dist/index.js");

      const localStore = createNamedLocalStore({ baseName: name, openTimeoutMs: 2_000 });
      const credentialStore = createWebCredentialStore(localStore.credentialNamespace);
      const keySource = new PortablePassphraseKeySource({ credentialStore });
      const engine = new Interocitor(
        new WebDAVAdapter({
          baseUrl: `${location.origin}/__rotation_keeps_key__`,
          auth: { username: "u", password: "p" },
        }),
        {
          dbName: localStore.credentialNamespace,
          remotePath: "/RotatingMesh",
          deviceId: "rotation_owner",
          keySource,
          localStore,
          batchWindowMs: 0,
          pollInterval: 600_000,
        },
      );
      await engine.init();
      await engine.connect();
      await engine.put("tasks", "before-rotation", { title: "decrypt me after rotation" });
      await engine.flush();
      const portableKey = keySource.getPortableKey();
      if (!portableKey) throw new Error("encrypted fixture produced no portable key");
      const keyDigest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(portableKey),
      );
      const result = {
        credentialNamespace: localStore.credentialNamespace,
        physicalBefore: localStore.activeDatabaseName,
        fingerprint: Array.from(new Uint8Array(keyDigest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join(""),
      };
      await engine.disconnect();

      const rotation = rotateLocalDatabaseName(name);
      let rejectedPhysicalNamespace = false;
      try {
        createWebCredentialStore(rotation.to);
      } catch (error) {
        rejectedPhysicalNamespace = error instanceof UnstableCredentialNamespaceError;
      }
      return { ...result, rotation, rejectedPhysicalNamespace };
    }, baseName);

    expect(before.credentialNamespace).toBe(baseName);
    expect(before.physicalBefore).toBe(baseName);
    expect(before.rotation.to).toMatch(new RegExp(`^${baseName}-v2-[0-9a-f]{16}$`));
    expect(before.rejectedPhysicalNamespace).toBe(true);

    await page.reload();

    const after = await page.evaluate(async (name) => {
      const { Interocitor, PortablePassphraseKeySource, readColumn } =
        await import("/packages/core/dist/index.js");
      const { WebDAVAdapter } = await import("/packages/core/dist/adapters/webdav.js");
      const { createNamedLocalStore, createWebCredentialStore } =
        await import("/packages/web/dist/index.js");

      const localStore = createNamedLocalStore({ baseName: name, openTimeoutMs: 2_000 });
      const credentialStore = createWebCredentialStore(localStore.credentialNamespace);
      const keySource = new PortablePassphraseKeySource({ credentialStore });
      const engine = new Interocitor(
        new WebDAVAdapter({
          baseUrl: `${location.origin}/__rotation_keeps_key__`,
          auth: { username: "u", password: "p" },
        }),
        {
          dbName: localStore.credentialNamespace,
          remotePath: "/RotatingMesh",
          deviceId: "rotation_owner",
          keySource,
          localStore,
          pollInterval: 600_000,
        },
      );
      const events: any[] = [];
      engine.on((event) => events.push(event));
      await engine.init();
      await engine.connect();
      const rows = await engine.query("tasks");
      const portableKey = keySource.getPortableKey();
      if (!portableKey) throw new Error("persisted portable key was not restored");
      const keyDigest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(portableKey),
      );
      const result = {
        credentialNamespace: localStore.credentialNamespace,
        physicalAfter: localStore.activeDatabaseName,
        fingerprint: Array.from(new Uint8Array(keyDigest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join(""),
        titles: rows.map((row: any) => readColumn(row, "title")),
        poisonCount: events.filter((event) => event.type === "remote:poisoned").length,
        generatedCredentialRecord: localStorage.getItem(
          `interocitor-creds:${localStore.activeDatabaseName}`,
        ),
      };
      await engine.disconnect();
      return result;
    }, baseName);

    expect(after).toEqual({
      credentialNamespace: baseName,
      physicalAfter: before.rotation.to,
      fingerprint: before.fingerprint,
      titles: ["decrypt me after rotation"],
      poisonCount: 0,
      generatedCredentialRecord: null,
    });
  } finally {
    await context.close();
  }
});

test("a stale persisted mesh anchor fails before credentials or IndexedDB are changed", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const dbName = "pairing-stale-credential-anchor";

  try {
    await page.goto(HARNESS);
    await clearBrowserMeshState(page, dbName);
    const result = await page.evaluate(async (name) => {
      const { Interocitor, MeshCredentialMismatchError, PortablePassphraseKeySource } =
        await import("/packages/core/dist/index.js");
      const { generateKey, keyToPassphrase } = await import("/packages/core/dist/crypto/keys.js");
      const { IndexedDbLocalStore } =
        await import("/packages/web/dist/storage/indexed-db-local-store.js");
      const { createWebCredentialStore } = await import("/packages/web/dist/credential-store.js");

      const credentialStore = createWebCredentialStore(name);
      const portableKey = await keyToPassphrase(await generateKey());
      const originalCredentials = {
        portableKey,
        deviceId: "anchored_device",
        meshId: "mesh_from_credentials",
      };
      await credentialStore.save(originalCredentials);

      const localStore = new IndexedDbLocalStore(name);
      await localStore.open();
      await localStore.setMeta("meshId", "mesh_from_indexeddb");
      await localStore.setMeta("sentinel", "must survive");
      localStore.close();

      const engine = new Interocitor({
        dbName: name,
        deviceId: "anchored_device",
        keySource: new PortablePassphraseKeySource({ credentialStore }),
        localStore: new IndexedDbLocalStore(name),
      });
      let error: unknown;
      try {
        await engine.init();
      } catch (cause) {
        error = cause;
      }

      const checkStore = new IndexedDbLocalStore(name);
      await checkStore.open();
      const localMeshId = await checkStore.getMeta("meshId");
      const sentinel = await checkStore.getMeta("sentinel");
      checkStore.close();

      return {
        isTypedMismatch: error instanceof MeshCredentialMismatchError,
        errorCode: (error as { code?: string } | undefined)?.code,
        credentials: await credentialStore.load(),
        localMeshId,
        sentinel,
      };
    }, dbName);

    expect(result.isTypedMismatch).toBe(true);
    expect(result.errorCode).toBe("MESH_CREDENTIAL_MISMATCH");
    expect(result.credentials).toMatchObject({
      deviceId: "anchored_device",
      meshId: "mesh_from_credentials",
    });
    expect(result.localMeshId).toBe("mesh_from_indexeddb");
    expect(result.sentinel).toBe("must survive");
  } finally {
    await context.close();
  }
});
