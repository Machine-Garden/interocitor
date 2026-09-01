/**
 * pairing-flow.spec.ts
 *
 * Real-world multi-device pairing scenarios:
 *
 *   1. Device 1 creates an encrypted mesh, writes data.
 *   2. Device 2 joins Device 1 via handshake — downloads data.
 *   3. Device 2 "switches teams" — joins a *different* mesh on Device 3.
 *      Old data must NOT leak into the new mesh.
 *   4. Device 2 reconnects to Device 1's mesh — downloads data again.
 *   5. Device 2 invites Device 4 into Device 1's mesh (chain-invite).
 *
 * Validates:
 *   - deviceId / meshId lifecycle
 *   - passphrase handling via Interocitor config and credentials
 *   - database isolation across meshes (different remotePath + dbName)
 *   - no unintentional data leakage between teams
 *   - passphrase survival across reconnects (lost passphrase == lost data)
 */

import { expect, test } from "@playwright/test";
import {
  attachWebDavRouteMock,
  createWebDavRouteState,
  type WebDavRouteState,
} from "./helpers/webdav-route-mock";

// ─── Helpers ──────────────────────────────────────────────────────────

type Page = import("@playwright/test").Page;

async function clearLocalDb(page: Page, dbName = "interocitor"): Promise<void> {
  await page.evaluate(async (db) => {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(db);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  }, dbName);
}

async function clearAllLocalState(page: Page, dbNames: string[]): Promise<void> {
  for (const db of dbNames) {
    await clearLocalDb(page, db);
  }
  await page.evaluate(() => {
    localStorage.removeItem("interocitor-device-id");
    localStorage.removeItem("interocitor-key:team-alpha");
    localStorage.removeItem("interocitor-key:team-bravo");
  });
}

// ─── Test ─────────────────────────────────────────────────────────────

test.describe("Multi-device pairing flow", () => {
  test("full lifecycle: setup → join → switch team → reconnect → chain-invite", async ({
    browser,
    baseURL,
  }) => {
    const cloudAlpha: WebDavRouteState = createWebDavRouteState();
    const cloudBravo: WebDavRouteState = createWebDavRouteState();

    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const ctx3 = await browser.newContext();
    const ctx4 = await browser.newContext();

    try {
      for (const ctx of [ctx1, ctx2, ctx3, ctx4]) {
        await attachWebDavRouteMock(ctx, cloudAlpha, "/__dav_alpha__");
        await attachWebDavRouteMock(ctx, cloudBravo, "/__dav_bravo__");
      }

      const page1 = await ctx1.newPage();
      const page2 = await ctx2.newPage();
      const page3 = await ctx3.newPage();
      const page4 = await ctx4.newPage();

      const harness = `${baseURL}/packages/core/tests/e2e/fixtures/harness-plain.html`;
      await Promise.all([
        page1.goto(harness),
        page2.goto(harness),
        page3.goto(harness),
        page4.goto(harness),
      ]);

      const allDbs = ["team-alpha", "team-bravo"];
      await Promise.all([
        clearAllLocalState(page1, allDbs),
        clearAllLocalState(page2, allDbs),
        clearAllLocalState(page3, allDbs),
        clearAllLocalState(page4, allDbs),
      ]);

      // ──────────────────────────────────────────────────────────────
      // STEP 1: Device 1 — master setup for team-alpha (encrypted)
      // ──────────────────────────────────────────────────────────────

      const step1 = await page1.evaluate(async () => {
        const { Interocitor, MemoryLocalStore, PortablePassphraseKeySource, readColumn } =
          await import("/packages/core/dist/index.js");
        const { WebDAVAdapter } = await import("/packages/core/dist/adapters/webdav.js");

        const adapter = new WebDAVAdapter({
          baseUrl: `${location.origin}/__dav_alpha__`,
          auth: { username: "u", password: "p" },
        });

        const keySource = new PortablePassphraseKeySource();
        const engine = new Interocitor(adapter, {
          batchWindowMs: 0,
          remotePath: "/TeamAlpha",
          dbName: "team-alpha",
          deviceId: "device_1",
          keySource,
          localStore: new MemoryLocalStore(),
          pollInterval: 600_000,
          flushDebounce: 60_000,
          flushThreshold: 999,
        });
        await engine.init();
        await engine.connect();

        await engine.put("projects", "proj_1", { name: "Secret Project", budget: 100000 });
        await engine.put("projects", "proj_2", { name: "Internal Tool", budget: 5000 });
        await engine.flush();

        const deviceId = engine.getDeviceId();
        const meshId = engine.getMeshId();
        const rows = await engine.query("projects");
        const passphrase = keySource.getPortableKey();

        await engine.disconnect();

        return {
          deviceId,
          meshId,
          rowCount: rows.length,
          names: rows.map((r: any) => readColumn(r, "name")).toSorted(),
          passphrase,
        };
      });

      expect(step1.deviceId).toBe("device_1");
      expect(step1.meshId).toBeTruthy();
      expect(step1.rowCount).toBe(2);
      expect(step1.names).toEqual(["Internal Tool", "Secret Project"]);

      const alphaMeshId = step1.meshId!;
      const alphaPassphrase = step1.passphrase;
      if (!alphaPassphrase)
        throw new Error("encrypted team-alpha mesh did not expose a portable key");

      // ──────────────────────────────────────────────────────────────
      // STEP 2: Device 2 joins Device 1 via handshake (share flow)
      //
      // Device 1 generates "share" QR.
      // Device 2 scans it and receives credentials.
      // They communicate via relay files on cloudAlpha.
      // ──────────────────────────────────────────────────────────────

      // Phase A: Device 1 starts the share — returns QR payload and
      // begins waiting for scanner. We don't await complete() yet.
      const step2_qr = await page1.evaluate(async (passArg: string) => {
        const { generateShareQR } = await import("/packages/core/dist/index.js");
        const { WebDAVAdapter } = await import("/packages/core/dist/adapters/webdav.js");

        const adapter = new WebDAVAdapter({
          baseUrl: `${location.origin}/__dav_alpha__`,
          auth: { username: "u", password: "p" },
        });

        const { qrPayload, complete } = await generateShareQR({
          adapter,
          relayBase: "/TeamAlpha",
          remotePath: "/TeamAlpha",
          passphrase: passArg,
          pollIntervalMs: 50,
          timeoutMs: 15_000,
        });

        // Stash complete() on window so we can call it later.
        (window as any).__hsComplete = complete;

        return qrPayload;
      }, alphaPassphrase);

      // Phase B: Device 2 scans the QR, receives credentials, connects.
      // Meanwhile Device 1's complete() is waiting for scanner-pub.
      const [, step2_device2] = await Promise.all([
        // Device 1: finish the handshake.
        page1.evaluate(async () => {
          await (window as any).__hsComplete();
        }),
        // Device 2: scan and join.
        page2.evaluate(async (payload: any) => {
          const {
            Interocitor,
            MemoryLocalStore,
            PortablePassphraseKeySource,
            readColumn,
            handleScannedQR,
          } = await import("/packages/core/dist/index.js");
          const { WebDAVAdapter } = await import("/packages/core/dist/adapters/webdav.js");

          const adapter = new WebDAVAdapter({
            baseUrl: `${location.origin}/__dav_alpha__`,
            auth: { username: "u", password: "p" },
          });

          const credentials = await handleScannedQR({
            adapter,
            relayBase: "/TeamAlpha",
            payload,
            pollIntervalMs: 50,
            timeoutMs: 15_000,
          });

          if (!credentials) return { error: "no credentials" };

          const engine = new Interocitor(adapter, {
            batchWindowMs: 0,
            remotePath: credentials.remotePath,
            dbName: "team-alpha",
            deviceId: "device_2",
            keySource: new PortablePassphraseKeySource({ portableKey: credentials.passphrase }),
            localStore: new MemoryLocalStore(),
            pollInterval: 600_000,
            flushDebounce: 60_000,
            flushThreshold: 999,
          });
          await engine.init();
          await engine.connect();

          const deviceId = engine.getDeviceId();
          const meshId = engine.getMeshId();
          const rows = await engine.query("projects");

          await engine.disconnect();

          return {
            remotePath: credentials.remotePath,
            deviceId,
            meshId,
            rowCount: rows.length,
            names: rows.map((r: any) => readColumn(r, "name")).toSorted(),
          };
        }, step2_qr),
      ]);

      expect(step2_device2.deviceId).toBe("device_2");
      expect(step2_device2.meshId).toBe(alphaMeshId);
      expect(step2_device2.rowCount).toBe(2);
      expect(step2_device2.names).toEqual(["Internal Tool", "Secret Project"]);
      expect(step2_device2.remotePath).toBe("/TeamAlpha");

      // ──────────────────────────────────────────────────────────────
      // STEP 3: Device 3 creates team-bravo. Device 2 switches teams.
      //         Old team-alpha data must NOT appear in team-bravo.
      // ──────────────────────────────────────────────────────────────

      // Device 3: setup team-bravo + generate share QR
      const step3_qr = await page3.evaluate(async () => {
        const { Interocitor, MemoryLocalStore, PortablePassphraseKeySource, generateShareQR } =
          await import("/packages/core/dist/index.js");
        const { WebDAVAdapter } = await import("/packages/core/dist/adapters/webdav.js");

        const adapter = new WebDAVAdapter({
          baseUrl: `${location.origin}/__dav_bravo__`,
          auth: { username: "u", password: "p" },
        });

        const keySource = new PortablePassphraseKeySource();
        const engine = new Interocitor(adapter, {
          batchWindowMs: 0,
          remotePath: "/TeamBravo",
          dbName: "team-bravo",
          deviceId: "device_3",
          keySource,
          localStore: new MemoryLocalStore(),
          pollInterval: 600_000,
          flushDebounce: 60_000,
          flushThreshold: 999,
        });
        await engine.init();
        await engine.connect();

        await engine.put("projects", "bravo_1", { name: "Public Launch", budget: 50000 });
        await engine.flush();

        const meshId = engine.getMeshId();
        const passphrase = keySource.getPortableKey();

        const { qrPayload, complete } = await generateShareQR({
          adapter,
          relayBase: "/TeamBravo",
          remotePath: "/TeamBravo",
          passphrase,
          pollIntervalMs: 50,
          timeoutMs: 15_000,
        });

        (window as any).__hsComplete = complete;

        await engine.disconnect();

        return { meshId, qrPayload };
      });

      const bravoMeshId = step3_qr.meshId!;
      expect(bravoMeshId).toBeTruthy();
      expect(bravoMeshId).not.toBe(alphaMeshId);

      // Device 2: local reset + join team-bravo
      const [, step3_device2] = await Promise.all([
        page3.evaluate(async () => {
          await (window as any).__hsComplete();
        }),
        page2.evaluate(
          async ({ payload, alphaPortableKey }: { payload: any; alphaPortableKey: string }) => {
            const {
              Interocitor,
              MemoryLocalStore,
              PortablePassphraseKeySource,
              readColumn,
              handleScannedQR,
            } = await import("/packages/core/dist/index.js");
            const { WebDAVAdapter } = await import("/packages/core/dist/adapters/webdav.js");

            const adapter = new WebDAVAdapter({
              baseUrl: `${location.origin}/__dav_bravo__`,
              auth: { username: "u", password: "p" },
            });

            const credentials = await handleScannedQR({
              adapter,
              relayBase: "/TeamBravo",
              payload,
              pollIntervalMs: 50,
              timeoutMs: 15_000,
            });

            if (!credentials) return { error: "no credentials" };

            // DIFFERENT dbName — team-bravo is a separate database.
            const engine = new Interocitor(adapter, {
              batchWindowMs: 0,
              remotePath: credentials.remotePath,
              dbName: "team-bravo",
              deviceId: "device_2",
              keySource: new PortablePassphraseKeySource({ portableKey: credentials.passphrase }),
              localStore: new MemoryLocalStore(),
              pollInterval: 600_000,
              flushDebounce: 60_000,
              flushThreshold: 999,
            });
            await engine.init();
            await engine.connect();

            const meshId = engine.getMeshId();
            const rows = await engine.query("projects");
            const bravoNames = rows.map((r: any) => readColumn(r, "name")).toSorted();

            await engine.disconnect();

            // Verify isolation by reconnecting to team-alpha with its distinct
            // portable key. Core intentionally provides no browser-persistent
            // local store, so this fresh engine restores from the remote mesh.
            const alphaEngine = new Interocitor(
              new (await import("/packages/core/dist/adapters/webdav.js")).WebDAVAdapter({
                baseUrl: `${location.origin}/__dav_alpha__`,
                auth: { username: "u", password: "p" },
              }),
              {
                remotePath: "/TeamAlpha",
                dbName: "team-alpha",
                keySource: new PortablePassphraseKeySource({ portableKey: alphaPortableKey }),
                localStore: new MemoryLocalStore(),
                pollInterval: 600_000,
              },
            );
            await alphaEngine.init();
            await alphaEngine.connect();
            const alphaRows = await alphaEngine.query("projects");
            const alphaNames = alphaRows.map((r: any) => readColumn(r, "name")).toSorted();
            await alphaEngine.disconnect();

            return {
              meshId,
              bravoNames,
              bravoRowCount: rows.length,
              alphaNames,
              alphaRowCount: alphaRows.length,
              remotePath: credentials.remotePath,
            };
          },
          { payload: step3_qr.qrPayload, alphaPortableKey: alphaPassphrase },
        ),
      ]);

      expect(step3_device2.meshId).toBe(bravoMeshId);
      expect(step3_device2.bravoRowCount).toBe(1);
      expect(step3_device2.bravoNames).toEqual(["Public Launch"]);
      expect(step3_device2.remotePath).toBe("/TeamBravo");
      // Old data still in its own local DB — isolated, not leaked.
      expect(step3_device2.alphaRowCount).toBe(2);
      expect(step3_device2.alphaNames).toEqual(["Internal Tool", "Secret Project"]);

      // ──────────────────────────────────────────────────────────────
      // STEP 4: Device 2 reconnects to team-alpha.
      //         Must restore the old key — without it, data is lost.
      // ──────────────────────────────────────────────────────────────

      const step4 = await page2.evaluate(async (passArg: string) => {
        const { Interocitor, MemoryLocalStore, PortablePassphraseKeySource, readColumn } =
          await import("/packages/core/dist/index.js");
        const { WebDAVAdapter } = await import("/packages/core/dist/adapters/webdav.js");

        const adapter = new WebDAVAdapter({
          baseUrl: `${location.origin}/__dav_alpha__`,
          auth: { username: "u", password: "p" },
        });
        const engine = new Interocitor(adapter, {
          batchWindowMs: 0,
          remotePath: "/TeamAlpha",
          dbName: "team-alpha",
          deviceId: "device_2",
          keySource: new PortablePassphraseKeySource({ portableKey: passArg }),
          localStore: new MemoryLocalStore(),
          pollInterval: 600_000,
          flushDebounce: 60_000,
          flushThreshold: 999,
        });
        await engine.init();
        await engine.connect();

        const rows = await engine.query("projects");
        const names = rows.map((r: any) => readColumn(r, "name")).toSorted();
        const meshId = engine.getMeshId();

        // Write something new — device 2 is back in the game.
        await engine.put("projects", "proj_3", { name: "Comeback Feature", budget: 7500 });
        await engine.flush();

        await engine.disconnect();
        return { meshId, names, rowCount: rows.length };
      }, alphaPassphrase);

      expect(step4.meshId).toBe(alphaMeshId);
      expect(step4.rowCount).toBe(2);
      expect(step4.names).toEqual(["Internal Tool", "Secret Project"]);

      // Verify Device 1 sees the new row.
      const step4_verify = await page1.evaluate(async (passArg: string) => {
        const { Interocitor, MemoryLocalStore, PortablePassphraseKeySource, readColumn } =
          await import("/packages/core/dist/index.js");
        const { WebDAVAdapter } = await import("/packages/core/dist/adapters/webdav.js");

        const adapter = new WebDAVAdapter({
          baseUrl: `${location.origin}/__dav_alpha__`,
          auth: { username: "u", password: "p" },
        });
        const engine = new Interocitor(adapter, {
          batchWindowMs: 0,
          remotePath: "/TeamAlpha",
          dbName: "team-alpha",
          deviceId: "device_1",
          keySource: new PortablePassphraseKeySource({ portableKey: passArg }),
          localStore: new MemoryLocalStore(),
          pollInterval: 600_000,
          flushDebounce: 60_000,
          flushThreshold: 999,
        });
        await engine.init();
        await engine.connect();

        const rows = await engine.query("projects");
        const names = rows.map((r: any) => readColumn(r, "name")).toSorted();

        await engine.disconnect();
        return { names, rowCount: rows.length };
      }, alphaPassphrase);

      expect(step4_verify.rowCount).toBe(3);
      expect(step4_verify.names).toEqual(["Comeback Feature", "Internal Tool", "Secret Project"]);

      // ──────────────────────────────────────────────────────────────
      // STEP 5: Device 2 invites Device 4 into team-alpha.
      //         Chain-invite: device 2 is NOT the original creator
      //         but has the credentials and can share them.
      // ──────────────────────────────────────────────────────────────

      // Device 2: generate share QR for team-alpha.
      const step5_qr = await page2.evaluate(async (passArg: string) => {
        const { generateShareQR } = await import("/packages/core/dist/index.js");
        const { WebDAVAdapter } = await import("/packages/core/dist/adapters/webdav.js");

        const adapter = new WebDAVAdapter({
          baseUrl: `${location.origin}/__dav_alpha__`,
          auth: { username: "u", password: "p" },
        });

        const { qrPayload, complete } = await generateShareQR({
          adapter,
          relayBase: "/TeamAlpha",
          remotePath: "/TeamAlpha",
          passphrase: passArg,
          pollIntervalMs: 50,
          timeoutMs: 15_000,
        });

        (window as any).__hsComplete = complete;
        return qrPayload;
      }, alphaPassphrase);

      // Device 4: scan and join.
      const [, step5_device4] = await Promise.all([
        page2.evaluate(async () => {
          await (window as any).__hsComplete();
        }),
        page4.evaluate(async (payload: any) => {
          const {
            Interocitor,
            MemoryLocalStore,
            PortablePassphraseKeySource,
            readColumn,
            handleScannedQR,
          } = await import("/packages/core/dist/index.js");
          const { WebDAVAdapter } = await import("/packages/core/dist/adapters/webdav.js");

          const adapter = new WebDAVAdapter({
            baseUrl: `${location.origin}/__dav_alpha__`,
            auth: { username: "u", password: "p" },
          });

          const credentials = await handleScannedQR({
            adapter,
            relayBase: "/TeamAlpha",
            payload,
            pollIntervalMs: 50,
            timeoutMs: 15_000,
          });

          if (!credentials) return { error: "no credentials" };

          const engine = new Interocitor(adapter, {
            batchWindowMs: 0,
            remotePath: credentials.remotePath,
            dbName: "team-alpha",
            deviceId: "device_4",
            keySource: new PortablePassphraseKeySource({ portableKey: credentials.passphrase }),
            localStore: new MemoryLocalStore(),
            pollInterval: 600_000,
            flushDebounce: 60_000,
            flushThreshold: 999,
          });
          await engine.init();
          await engine.connect();

          const deviceId = engine.getDeviceId();
          const meshId = engine.getMeshId();
          const rows = await engine.query("projects");
          const names = rows.map((r: any) => readColumn(r, "name")).toSorted();

          await engine.disconnect();

          return {
            deviceId,
            meshId,
            remotePath: credentials.remotePath,
            rowCount: rows.length,
            names,
          };
        }, step5_qr),
      ]);

      expect(step5_device4.deviceId).toBe("device_4");
      expect(step5_device4.meshId).toBe(alphaMeshId);
      expect(step5_device4.remotePath).toBe("/TeamAlpha");
      expect(step5_device4.rowCount).toBe(3);
      expect(step5_device4.names).toEqual(["Comeback Feature", "Internal Tool", "Secret Project"]);

      // ──────────────────────────────────────────────────────────────
      // FINAL: Cross-cloud pollution check.
      //
      // Data is encrypted, so we can't check plaintext in cloud dumps.
      // Instead verify structural isolation:
      //   - cloudAlpha only has /TeamAlpha/ paths
      //   - cloudBravo only has /TeamBravo/ paths
      //   - each cloud has change files (data was actually written)
      // ──────────────────────────────────────────────────────────────

      const alphaPaths = [...cloudAlpha.files.keys()];
      const bravoPaths = [...cloudBravo.files.keys()];

      // Every file in cloudAlpha is under /TeamAlpha/
      for (const p of alphaPaths) {
        expect(p).toMatch(/^\/TeamAlpha\//);
      }
      // Every file in cloudBravo is under /TeamBravo/
      for (const p of bravoPaths) {
        expect(p).toMatch(/^\/TeamBravo\//);
      }

      // Both clouds have change files (actual data was written)
      const alphaChanges = alphaPaths.filter(
        (p) => p.includes("/changes/") && p.endsWith(".json") && !p.endsWith("head.json"),
      );
      const bravoChanges = bravoPaths.filter(
        (p) => p.includes("/changes/") && p.endsWith(".json") && !p.endsWith("head.json"),
      );
      expect(alphaChanges.length).toBeGreaterThanOrEqual(3); // proj_1, proj_2, proj_3
      expect(bravoChanges.length).toBeGreaterThanOrEqual(1); // bravo_1

      // No /TeamBravo/ paths in cloudAlpha and vice versa
      expect(alphaPaths.some((p) => p.startsWith("/TeamBravo/"))).toBe(false);
      expect(bravoPaths.some((p) => p.startsWith("/TeamAlpha/"))).toBe(false);
    } finally {
      await Promise.all([ctx1.close(), ctx2.close(), ctx3.close(), ctx4.close()]);
    }
  });
});
