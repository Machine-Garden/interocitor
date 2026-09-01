/**
 * reconnect-after-disconnect.spec.ts
 *
 * Repro for client report:
 *   - create new mesh
 *   - disconnect
 *   - reconnect -> failure
 *
 * Same trace happens on page reload. Console shows:
 *   [interocitor] pull() — failed Error: Decryption failed:
 *   payload not decryptable with the active mesh key
 *   (Unknown envelope version: undefined).
 *
 * Engine writes a change file during the first session, then on the
 * second connect() pull() can't decode it — meaning either the file
 * was written without an encryption envelope, or the active key on
 * reconnect differs from the key used to write.
 */
import { test, expect } from "@playwright/test";
import {
  attachWebDavRouteMock,
  createWebDavRouteState,
  type WebDavRouteState,
} from "./helpers/webdav-route-mock.ts";

type Page = import("@playwright/test").Page;

async function clearAllLocalState(page: Page, dbNames: string[]): Promise<void> {
  await page.evaluate(async (names: string[]) => {
    localStorage.clear();
    for (const n of names) {
      await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase(n);
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      });
    }
  }, dbNames);
}

test.describe("Reconnect on the same engine after disconnect", () => {
  test("same engine: create mesh → write → disconnect → reconnect must not poison remote", async ({
    browser,
    baseURL,
  }) => {
    const cloud: WebDavRouteState = createWebDavRouteState();
    const ctx = await browser.newContext();
    try {
      await attachWebDavRouteMock(ctx, cloud, "/__dav_recon__");
      const page = await ctx.newPage();
      await page.goto(`${baseURL}/packages/core/tests/e2e/fixtures/harness-plain.html`);
      await clearAllLocalState(page, ["recon-mesh"]);

      const result = await page.evaluate(async () => {
        const { Interocitor, MemoryLocalStore, PortablePassphraseKeySource, readColumn } =
          await import("/packages/core/dist/index.js");
        const { WebDAVAdapter } = await import("/packages/core/dist/adapters/webdav.js");
        const adapter = new WebDAVAdapter({
          baseUrl: `${location.origin}/__dav_recon__`,
          auth: { username: "u", password: "p" },
        });

        const keySource = new PortablePassphraseKeySource();
        const engine = new Interocitor(adapter, {
          remotePath: "/MealPlanner",
          dbName: "recon-mesh",
          deviceId: "dev_recon",
          pollInterval: 600_000,
          flushDebounce: 60_000,
          flushThreshold: 999,
          keySource,
          localStore: new MemoryLocalStore(),
        });

        const events: any[] = [];
        engine.on((e) => events.push(e));

        // Cycle 1: create mesh, write, flush, disconnect.
        await engine.init();
        await engine.connect();
        await engine.put("items", "i1", { text: "first" });
        await engine.flush();
        await engine.disconnect();

        // Cycle 2: reconnect on the same engine instance. After
        // disconnect, init is reset; the engine should re-init,
        // resolve the same key from the retained key source, and
        // decode its own previously-flushed change file.
        let secondConnectError = "";
        try {
          await engine.connect();
        } catch (err: any) {
          secondConnectError = String(err?.message ?? err);
        }

        const rows = await engine.query("items").catch(() => []);
        const titles = rows.map((r: any) => readColumn(r, "text")).toSorted();

        await engine.disconnect().catch(() => {});

        const poisoned = events.filter((e) => e.type === "remote:poisoned");
        const decodeErrors = events.filter((e) => e.type === "decode:error");

        return {
          secondConnectError,
          titles,
          poisonedCount: poisoned.length,
          poisonedMessage: poisoned[0]?.error?.message ?? null,
          decodeErrorCount: decodeErrors.length,
        };
      });

      expect(result.secondConnectError).toBe("");
      expect(result.poisonedCount).toBe(0);
      expect(result.decodeErrorCount).toBe(0);
      expect(result.titles).toEqual(["first"]);
    } finally {
      await ctx.close();
    }
  });

  test("regression: encrypted-default reconnect on plaintext-written remote must not poison silently", async ({
    browser,
    baseURL,
  }) => {
    // Repro: first session opens the mesh with encryption disabled
    // (or never resolves a key before flush), so the change file lands
    // on the remote as plaintext JSON. On reconnect the engine defaults
    // to `encrypted: true`, derives a key from the credential store,
    // and pull() throws `Unknown envelope version: undefined` because
    // the file has no envelope.
    //
    // Matches the client trace:
    //   [interocitor] resolveEncryption() — derived key from passphrase
    //   [interocitor] pull() — start
    //   [interocitor] remote:poisoned — sync halted ...
    //     message: 'Decryption failed: ... Unknown envelope version: undefined'
    const cloud: WebDavRouteState = createWebDavRouteState();
    const ctx = await browser.newContext();
    try {
      await attachWebDavRouteMock(ctx, cloud, "/__dav_recon3__");
      const page = await ctx.newPage();
      await page.goto(`${baseURL}/packages/core/tests/e2e/fixtures/harness-plain.html`);
      await clearAllLocalState(page, ["recon3-mesh"]);

      const result = await page.evaluate(async () => {
        const {
          Interocitor,
          MemoryLocalStore,
          MeshEncryptionMismatchError,
          PortablePassphraseKeySource,
        } = await import("/packages/core/dist/index.js");
        const { WebDAVAdapter } = await import("/packages/core/dist/adapters/webdav.js");
        const adapter = new WebDAVAdapter({
          baseUrl: `${location.origin}/__dav_recon3__`,
          auth: { username: "u", password: "p" },
        });

        // Cycle 1: encrypted explicitly OFF.
        const e1 = new Interocitor(adapter, {
          remotePath: "/MealPlanner",
          dbName: "recon3-mesh",
          deviceId: "dev_recon3",
          keySource: null,
          localStore: new MemoryLocalStore(),
          pollInterval: 600_000,
          flushDebounce: 60_000,
          flushThreshold: 999,
        });
        await e1.init();
        await e1.connect();
        await e1.put("items", "i1", { text: "first" });
        await e1.flush();
        await e1.disconnect();

        // Cycle 2: brand new engine explicitly asks for encryption.
        const adapter2 = new WebDAVAdapter({
          baseUrl: `${location.origin}/__dav_recon3__`,
          auth: { username: "u", password: "p" },
        });
        const e2 = new Interocitor(adapter2, {
          remotePath: "/MealPlanner",
          dbName: "recon3-mesh",
          deviceId: "dev_recon3",
          keySource: new PortablePassphraseKeySource(),
          localStore: new MemoryLocalStore(),
          pollInterval: 600_000,
          flushDebounce: 60_000,
          flushThreshold: 999,
        });
        const events: any[] = [];
        e2.on((e) => events.push(e));
        let connectError = "";
        let connectErrorCode: string | undefined;
        let connectErrorName = "";
        let connectErrorIsTyped = false;
        let connectErrorExpected: boolean | undefined;
        let connectErrorActual: boolean | undefined;
        await e2.init();
        try {
          await e2.connect();
        } catch (err: any) {
          connectError = String(err?.message ?? err);
          connectErrorCode = err?.code;
          connectErrorName = err?.name ?? "";
          connectErrorIsTyped = err instanceof MeshEncryptionMismatchError;
          connectErrorExpected = err?.expectedMode;
          connectErrorActual = err?.actualMode;
        }
        await e2.disconnect().catch(() => {});

        const poisoned = events.filter((e) => e.type === "remote:poisoned");
        return {
          connectError,
          connectErrorCode,
          connectErrorName,
          connectErrorIsTyped,
          connectErrorExpected,
          connectErrorActual,
          poisonedCount: poisoned.length,
          poisonedMessage: poisoned[0]?.error?.message ?? null,
        };
      });

      // 1. connect() must throw the typed error with structured fields.
      expect(result.connectErrorIsTyped).toBe(true);
      expect(result.connectErrorName).toBe("MeshEncryptionMismatchError");
      expect(result.connectErrorCode).toBe("MESH_ENCRYPTION_MISMATCH");
      expect(result.connectErrorExpected).toBe(false);
      expect(result.connectErrorActual).toBe(true);

      // 2. Message stays human-actionable.
      expect(result.connectError).toMatch(/Mesh encryption mode mismatch/);
      expect(result.connectError).toMatch(/encrypted=false/);
      expect(result.connectError).toMatch(/encrypted=true/);

      // 3. Must NOT crash with the cryptic decode error or its envelope cause.
      expect(result.connectError).not.toMatch(/Unknown envelope version: undefined/);
      expect(result.connectError).not.toMatch(/payload not decryptable/);

      // 4. Must NOT poison the remote — the remote is fine, the local
      //    engine config is wrong. Poisoning a healthy remote on bad
      //    config is the bug we are fixing.
      expect(result.poisonedCount).toBe(0);
    } finally {
      await ctx.close();
    }
  });

  test("explicit key sources isolate new meshes that reuse a dbName", async ({
    browser,
    baseURL,
  }) => {
    const cloud1: WebDavRouteState = createWebDavRouteState();
    const cloud2: WebDavRouteState = createWebDavRouteState();
    const ctx = await browser.newContext();
    try {
      await attachWebDavRouteMock(ctx, cloud1, "/__dav_meshA__");
      await attachWebDavRouteMock(ctx, cloud2, "/__dav_meshB__");
      const page = await ctx.newPage();
      await page.goto(`${baseURL}/packages/core/tests/e2e/fixtures/harness-plain.html`);
      await clearAllLocalState(page, ["shared-mesh-name"]);

      const result = await page.evaluate(async () => {
        const { Interocitor, MemoryLocalStore, PortablePassphraseKeySource } =
          await import("/packages/core/dist/index.js");
        const { WebDAVAdapter } = await import("/packages/core/dist/adapters/webdav.js");

        // Mesh A: created, written, disconnected with its own explicit source.
        const adapterA = new WebDAVAdapter({
          baseUrl: `${location.origin}/__dav_meshA__`,
          auth: { username: "u", password: "p" },
        });
        const keySourceA = new PortablePassphraseKeySource();
        const eA = new Interocitor(adapterA, {
          remotePath: "/MealPlanner",
          dbName: "shared-mesh-name",
          deviceId: "dev_meshA",
          pollInterval: 600_000,
          flushDebounce: 60_000,
          flushThreshold: 999,
          keySource: keySourceA,
          localStore: new MemoryLocalStore(),
        });
        await eA.init();
        await eA.connect();
        await eA.put("items", "i1", { text: "A" });
        await eA.flush();
        const meshIdA = eA.getMeshId();
        const portableKeyA = keySourceA.getPortableKey();
        await eA.disconnect();

        // Mesh B: brand-new mesh, same dbName, different remote and source.
        const adapterB = new WebDAVAdapter({
          baseUrl: `${location.origin}/__dav_meshB__`,
          auth: { username: "u", password: "p" },
        });
        const keySourceB = new PortablePassphraseKeySource();
        const eB = new Interocitor(adapterB, {
          remotePath: "/MealPlanner",
          dbName: "shared-mesh-name",
          deviceId: "dev_meshB",
          pollInterval: 600_000,
          flushDebounce: 60_000,
          flushThreshold: 999,
          keySource: keySourceB,
          localStore: new MemoryLocalStore(),
        });
        const events: any[] = [];
        eB.on((e) => events.push(e));

        let connectError = "";
        await eB.init();
        try {
          await eB.connect();
        } catch (err: any) {
          connectError = String(err?.message ?? err);
        }
        const meshIdB = eB.getMeshId();
        const portableKeyB = keySourceB.getPortableKey();
        await eB.disconnect().catch(() => {});

        const poisoned = events.filter((e) => e.type === "remote:poisoned");
        const mismatch = events.filter((e) => e.type === "credentials:meshMismatch");
        return {
          meshIdA,
          meshIdB,
          portableKeyA,
          portableKeyB,
          connectError,
          poisonedCount: poisoned.length,
          mismatchEventCount: mismatch.length,
          mismatchEventStored: mismatch[0]?.storedMeshId ?? "",
          mismatchEventActive: mismatch[0]?.activeMeshId ?? "",
        };
      });

      expect(result.connectError).toBe("");
      expect(result.meshIdB).toBeTruthy();
      expect(result.meshIdB).not.toBe(result.meshIdA);
      expect(result.portableKeyA).toBeTruthy();
      expect(result.portableKeyB).toBeTruthy();
      expect(result.portableKeyB).not.toBe(result.portableKeyA);
      expect(result.mismatchEventCount).toBe(0);
      expect(result.poisonedCount).toBe(0);
    } finally {
      await ctx.close();
    }
  });

  test("fresh engine (page reload sim): create mesh → write → close → new engine reconnects", async ({
    browser,
    baseURL,
  }) => {
    const cloud: WebDavRouteState = createWebDavRouteState();
    const ctx = await browser.newContext();
    try {
      await attachWebDavRouteMock(ctx, cloud, "/__dav_recon2__");
      const page = await ctx.newPage();
      await page.goto(`${baseURL}/packages/core/tests/e2e/fixtures/harness-plain.html`);
      await clearAllLocalState(page, ["recon2-mesh"]);

      const result = await page.evaluate(async () => {
        const { Interocitor, MemoryLocalStore, PortablePassphraseKeySource, readColumn } =
          await import("/packages/core/dist/index.js");
        const { WebDAVAdapter } = await import("/packages/core/dist/adapters/webdav.js");
        const adapter = new WebDAVAdapter({
          baseUrl: `${location.origin}/__dav_recon2__`,
          auth: { username: "u", password: "p" },
        });

        // Cycle 1: same as above, then drop the engine reference.
        const keySource = new PortablePassphraseKeySource();
        const e1 = new Interocitor(adapter, {
          remotePath: "/MealPlanner",
          dbName: "recon2-mesh",
          deviceId: "dev_recon2",
          pollInterval: 600_000,
          flushDebounce: 60_000,
          flushThreshold: 999,
          keySource,
          localStore: new MemoryLocalStore(),
        });
        await e1.init();
        await e1.connect();
        await e1.put("items", "i1", { text: "first" });
        await e1.flush();
        await e1.disconnect();

        // Cycle 2: brand-new engine, same dbName + remotePath.
        // Mirrors a page reload: the runtime supplies the same portable key,
        // and pull must decode the previously-flushed change file.
        const adapter2 = new WebDAVAdapter({
          baseUrl: `${location.origin}/__dav_recon2__`,
          auth: { username: "u", password: "p" },
        });
        const e2 = new Interocitor(adapter2, {
          remotePath: "/MealPlanner",
          dbName: "recon2-mesh",
          deviceId: "dev_recon2",
          pollInterval: 600_000,
          flushDebounce: 60_000,
          flushThreshold: 999,
          keySource: new PortablePassphraseKeySource({ portableKey: keySource.getPortableKey() }),
          localStore: new MemoryLocalStore(),
        });
        const events: any[] = [];
        e2.on((e) => events.push(e));

        let connectError = "";
        await e2.init();
        try {
          await e2.connect();
        } catch (err: any) {
          connectError = String(err?.message ?? err);
        }

        const rows = await e2.query("items").catch(() => []);
        const titles = rows.map((r: any) => readColumn(r, "text")).toSorted();
        await e2.disconnect().catch(() => {});

        const poisoned = events.filter((e) => e.type === "remote:poisoned");
        const decodeErrors = events.filter((e) => e.type === "decode:error");
        return {
          connectError,
          titles,
          poisonedCount: poisoned.length,
          poisonedMessage: poisoned[0]?.error?.message ?? null,
          decodeErrorCount: decodeErrors.length,
        };
      });

      expect(result.connectError).toBe("");
      expect(result.poisonedCount).toBe(0);
      expect(result.decodeErrorCount).toBe(0);
      expect(result.titles).toEqual(["first"]);
    } finally {
      await ctx.close();
    }
  });
});
