import { expect, test } from "@playwright/test";

/* eslint-disable unicorn/consistent-function-scoping -- Browser-context helpers must be defined inside page.evaluate. */

test.beforeEach(async ({ page }) => {
  await page.goto("/packages/core/tests/e2e/fixtures/harness.html");
  await page.evaluate(async () => {
    localStorage.removeItem("interocitor-key:interocitor");
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase("interocitor");
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => resolve();
    });
  });
});

test.describe("Interocitor protocol (MemoryAdapter)", () => {
  test("bootstraps manifests and default direct-cloud mode", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const adapter = new MemoryAdapter();
      const engine = new Interocitor(adapter, {
        batchWindowMs: 0,
        remotePath: "/MeshBoot",
        pollInterval: 600_000,
        deviceId: "dev_bootstrap",
      });

      await engine.init();
      await engine.connect();
      const manifest = engine.getManifest();
      await engine.disconnect();

      return {
        manifest,
        files: Object.keys(adapter.dump()),
      };
    });

    expect(result.manifest?.version).toBe(3);
    expect(result.manifest?.server.managed).toBe(false);
    expect(result.files).toContain("/MeshBoot/manifest.json");
  });

  test("connection status reports solo gate and connection phases", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const solo = new Interocitor(new MemoryAdapter(), {
        appName: "StatusTest",
        dbName: `status-solo-${crypto.randomUUID()}`,
        deviceId: "status_solo",
      });
      await solo.init();
      const soloStatus = solo.getConnectionStatus();
      const soloDetails = solo.getConnectionStatusDetails();

      const events: any[] = [];
      const db = new Interocitor(new MemoryAdapter(), {
        appName: "StatusTest",
        dbName: `status-mesh-${crypto.randomUUID()}`,
        remotePath: "/StatusMesh",
        deviceId: "status_mesh",
        pollInterval: 600_000,
      });
      db.on((event: any) => {
        if (event.type === "connection:status") events.push(event.status);
      });

      await db.init();
      const afterInit = db.getConnectionStatus();
      const connectPromise = db.connect();
      await Promise.resolve();
      const duringConnect = events.includes("connecting");
      await connectPromise;
      const afterConnect = db.getConnectionStatus();
      await db.put("tasks", "a", { title: "A" });
      await db.flush();
      const sawSyncing = events.includes("syncing");
      const afterFlush = db.getConnectionStatus();
      await db.disconnect();
      const afterDisconnect = events.at(-1);

      return {
        soloStatus,
        soloDetails,
        afterInit,
        duringConnect,
        afterConnect,
        sawSyncing,
        afterFlush,
        afterDisconnect,
      };
    });

    expect(result.soloStatus).toBe("offline");
    expect(result.soloDetails.status).toBe("offline");
    expect(result.soloDetails.solo).toBe(true);
    expect(result.soloDetails.ready).toBe(true);
    expect(result.afterInit).toBe("offline");
    expect(result.duringConnect).toBe(true);
    expect(result.afterConnect).toBe("idle");
    expect(result.sawSyncing).toBe(true);
    expect(result.afterFlush).toBe("idle");
    expect(result.afterDisconnect).toBe("offline");
  });

  test("connect() degrades to offline-ready when a cloud stage stalls past deadline", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      class StallingAdapter extends MemoryAdapter {
        name = "stalling-memory";
        // Force ensureFolder to never resolve, simulating a remote/network
        // call that hangs without rejecting.
        override async ensureFolder(_path: string): Promise<void> {
          await new Promise<void>(() => {
            /* never resolves */
          });
        }
      }

      const stalled: any[] = [];
      const events: string[] = [];
      const engine = new Interocitor(new StallingAdapter(), {
        remotePath: "/StallingMesh",
        deviceId: "dev_stall",
        pollInterval: 600_000,
        connectStageTimeoutMs: 50,
        onConnectStalled: (info: any) => stalled.push(info),
      });
      engine.on((event: { type: string }) => events.push(event.type));

      await engine.init();
      const t0 = Date.now();
      let connectError: string | null = null;
      try {
        await engine.connect();
      } catch (err) {
        connectError = err instanceof Error ? err.message : String(err);
      }
      const elapsed = Date.now() - t0;

      // After offline-ready degrade we should still be initialized, not
      // connected, and writes must still queue locally.
      const initializedBefore = engine.isReady();
      await engine.put("tasks", "queued-offline", { title: "queued offline" });
      const rowCount = (await engine.query("tasks")).length;
      const initializedAfter = engine.isReady();

      return {
        connectError,
        stalledStages: stalled.map((s: any) => s.stage),
        stalledTimeouts: stalled.map((s: any) => s.timeoutMs),
        events,
        elapsed,
        initializedBefore,
        initializedAfter,
        rowCount,
      };
    });

    expect(result.connectError).toBeNull();
    expect(result.stalledStages).toContain("ensureFolder");
    expect(result.stalledTimeouts.every((ms) => ms === 50)).toBe(true);
    expect(result.events).toContain("connect:error");
    expect(result.elapsed).toBeLessThan(2_000);
    expect(result.initializedBefore).toBe(true);
    expect(result.initializedAfter).toBe(true);
    expect(result.rowCount).toBeGreaterThanOrEqual(1);
  });

  test("subscribes to adapter invalidations and pulls on relay message", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      class PushAdapter extends MemoryAdapter {
        readonly name = "push-memory";
        readyCount = 0;
        unsubscribed = false;
        listener: ((payload: { type: string; path: string; ts: number }) => void) | null = null;
        subscribeToInvalidations(
          onInvalidate: (payload: { type: string; path: string; ts: number }) => void,
          hooks?: { onReady?: () => void },
        ): () => void {
          this.listener = onInvalidate;
          this.readyCount++;
          hooks?.onReady?.();
          return () => {
            this.unsubscribed = true;
            this.listener = null;
          };
        }
        push(path: string): void {
          this.listener?.({ type: "invalidation", path, ts: Date.now() });
        }
      }

      const adapter = new PushAdapter();
      const engine = new Interocitor(adapter, {
        batchWindowMs: 0,
        remotePath: "/MeshPush",
        pollInterval: 600_000,
        deviceId: "dev_push",
      });
      const events: string[] = [];
      engine.on((event: { type: string }) => events.push(event.type));

      await engine.init();
      await engine.connect();
      adapter.push("/MeshPush/changes/head.json");
      const deadline = Date.now() + 2_000;
      while (
        events.filter((type) => type === "sync:complete").length < 2 &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => {
          setTimeout(resolve, 25);
        });
      }
      await engine.disconnect();

      return {
        readyCount: adapter.readyCount,
        unsubscribed: adapter.unsubscribed,
        relaySubscribe: events.includes("relay:subscribe"),
        relayReady: events.includes("relay:ready"),
        relayMessage: events.includes("relay:message"),
        syncCompleteCount: events.filter((type) => type === "sync:complete").length,
      };
    });

    expect(result.readyCount).toBe(1);
    expect(result.unsubscribed).toBe(true);
    expect(result.relaySubscribe).toBe(true);
    expect(result.relayReady).toBe(true);
    expect(result.relayMessage).toBe(true);
    expect(result.syncCompleteCount).toBeGreaterThanOrEqual(2);
  });

  test("request budget: reconnect budget is observed and bounded", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      class CountingPushAdapter extends MemoryAdapter {
        name = "counting-push-memory";
        counts = {
          authenticate: 0,
          ensureFolder: 0,
          listFiles: 0,
          listFolders: 0,
          readFile: 0,
          writeFile: 0,
          deleteFile: 0,
          getFileMetadata: 0,
          subscribeToInvalidations: 0,
          unsubscribeRemoteInvalidations: 0,
        };
        listener: ((payload: { type: string; path: string; ts: number }) => void) | null = null;
        async authenticate() {
          this.counts.authenticate++;
          return await super.authenticate();
        }
        async ensureFolder(path: string) {
          this.counts.ensureFolder++;
          return await super.ensureFolder(path);
        }
        async listFiles(path: string) {
          this.counts.listFiles++;
          return await super.listFiles(path);
        }
        async listFolders(path: string) {
          this.counts.listFolders++;
          return await super.listFolders(path);
        }
        async readFile(path: string) {
          this.counts.readFile++;
          return await super.readFile(path);
        }
        async writeFile(path: string, data: Uint8Array | string) {
          this.counts.writeFile++;
          return await super.writeFile(path, data);
        }
        async deleteFile(path: string) {
          this.counts.deleteFile++;
          return await super.deleteFile(path);
        }
        async getFileMetadata(path: string) {
          this.counts.getFileMetadata++;
          return await super.getFileMetadata(path);
        }
        subscribeToInvalidations(
          onInvalidate: (payload: { type: string; path: string; ts: number }) => void,
          hooks?: { onReady?: () => void },
        ): () => void {
          this.counts.subscribeToInvalidations++;
          this.listener = onInvalidate;
          hooks?.onReady?.();
          return () => {
            this.counts.unsubscribeRemoteInvalidations++;
            this.listener = null;
          };
        }
        snapshotCounts() {
          return { ...this.counts };
        }
      }

      const adapter = new CountingPushAdapter();
      const engine = new Interocitor(adapter, {
        batchWindowMs: 0,
        remotePath: "/MeshBudget",
        pollInterval: 600_000,
        deviceId: "dev_budget",
      });
      await engine.init();
      await engine.connect();
      await engine.disconnect();
      const afterFirstSession = adapter.snapshotCounts();

      const engine2 = new Interocitor(adapter, {
        batchWindowMs: 0,
        remotePath: "/MeshBudget",
        pollInterval: 600_000,
        deviceId: "dev_budget",
      });
      await engine2.init();
      await engine2.connect();
      await engine2.disconnect();
      const afterSecondSession = adapter.snapshotCounts();

      return {
        firstSession: afterFirstSession,
        secondSessionDelta: {
          authenticate: afterSecondSession.authenticate - afterFirstSession.authenticate,
          ensureFolder: afterSecondSession.ensureFolder - afterFirstSession.ensureFolder,
          listFiles: afterSecondSession.listFiles - afterFirstSession.listFiles,
          listFolders: afterSecondSession.listFolders - afterFirstSession.listFolders,
          readFile: afterSecondSession.readFile - afterFirstSession.readFile,
          writeFile: afterSecondSession.writeFile - afterFirstSession.writeFile,
          deleteFile: afterSecondSession.deleteFile - afterFirstSession.deleteFile,
          getFileMetadata: afterSecondSession.getFileMetadata - afterFirstSession.getFileMetadata,
          subscribeToInvalidations:
            afterSecondSession.subscribeToInvalidations -
            afterFirstSession.subscribeToInvalidations,
          unsubscribeRemoteInvalidations:
            afterSecondSession.unsubscribeRemoteInvalidations -
            afterFirstSession.unsubscribeRemoteInvalidations,
        },
      };
    });

    expect(result.firstSession.authenticate).toBe(1);
    expect(result.firstSession.ensureFolder).toBe(4);
    expect(result.firstSession.listFiles).toBe(1);
    expect(result.firstSession.listFolders).toBe(0);
    expect(result.firstSession.readFile).toBe(2);
    expect(result.firstSession.writeFile).toBe(3);
    expect(result.firstSession.deleteFile).toBe(0);
    expect(result.firstSession.getFileMetadata).toBe(0);
    expect(result.secondSessionDelta.authenticate).toBe(0);
    expect(result.secondSessionDelta.ensureFolder).toBeGreaterThanOrEqual(0);
    expect(result.secondSessionDelta.listFiles).toBeGreaterThanOrEqual(0);
    expect(result.secondSessionDelta.listFolders).toBe(0);
    expect(result.secondSessionDelta.readFile).toBeGreaterThanOrEqual(0);
    expect(result.secondSessionDelta.writeFile).toBeLessThanOrEqual(1);
    expect(result.secondSessionDelta.deleteFile).toBe(0);
    expect(result.secondSessionDelta.getFileMetadata).toBe(0);
    expect(result.secondSessionDelta.subscribeToInvalidations).toBe(1);
    expect(result.secondSessionDelta.unsubscribeRemoteInvalidations).toBe(1);
  });

  test("request budget: invalidation bursts trigger at most one list and no writes when nothing changed", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      class CountingPushAdapter extends MemoryAdapter {
        name = "counting-push-memory";
        counts = {
          authenticate: 0,
          ensureFolder: 0,
          listFiles: 0,
          listFolders: 0,
          readFile: 0,
          writeFile: 0,
          deleteFile: 0,
          getFileMetadata: 0,
          subscribeToInvalidations: 0,
          unsubscribeRemoteInvalidations: 0,
        };
        listener: ((payload: { type: string; path: string; ts: number }) => void) | null = null;
        async authenticate() {
          this.counts.authenticate++;
          return await super.authenticate();
        }
        async ensureFolder(path: string) {
          this.counts.ensureFolder++;
          return await super.ensureFolder(path);
        }
        async listFiles(path: string) {
          this.counts.listFiles++;
          return await super.listFiles(path);
        }
        async listFolders(path: string) {
          this.counts.listFolders++;
          return await super.listFolders(path);
        }
        async readFile(path: string) {
          this.counts.readFile++;
          return await super.readFile(path);
        }
        async writeFile(path: string, data: Uint8Array | string) {
          this.counts.writeFile++;
          return await super.writeFile(path, data);
        }
        async deleteFile(path: string) {
          this.counts.deleteFile++;
          return await super.deleteFile(path);
        }
        async getFileMetadata(path: string) {
          this.counts.getFileMetadata++;
          return await super.getFileMetadata(path);
        }
        subscribeToInvalidations(
          onInvalidate: (payload: { type: string; path: string; ts: number }) => void,
          hooks?: { onReady?: () => void },
        ): () => void {
          this.counts.subscribeToInvalidations++;
          this.listener = onInvalidate;
          hooks?.onReady?.();
          return () => {
            this.counts.unsubscribeRemoteInvalidations++;
            this.listener = null;
          };
        }
        push(path: string): void {
          this.listener?.({ type: "invalidation", path, ts: Date.now() });
        }
        snapshotCounts() {
          return { ...this.counts };
        }
      }

      const adapter = new CountingPushAdapter();
      const engine = new Interocitor(adapter, {
        batchWindowMs: 0,
        remotePath: "/MeshBurstBudget",
        pollInterval: 600_000,
        deviceId: "dev_burst",
      });
      await engine.init();
      await engine.connect();
      const baseline = adapter.snapshotCounts();

      adapter.push("/MeshBurstBudget/changes/head.json");
      adapter.push("/MeshBurstBudget/changes/head.json");
      adapter.push("/MeshBurstBudget/changes/head.json");
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
      const afterBurst = adapter.snapshotCounts();
      await engine.disconnect();

      return {
        delta: {
          authenticate: afterBurst.authenticate - baseline.authenticate,
          ensureFolder: afterBurst.ensureFolder - baseline.ensureFolder,
          listFiles: afterBurst.listFiles - baseline.listFiles,
          listFolders: afterBurst.listFolders - baseline.listFolders,
          readFile: afterBurst.readFile - baseline.readFile,
          writeFile: afterBurst.writeFile - baseline.writeFile,
          deleteFile: afterBurst.deleteFile - baseline.deleteFile,
          getFileMetadata: afterBurst.getFileMetadata - baseline.getFileMetadata,
          subscribeToInvalidations:
            afterBurst.subscribeToInvalidations - baseline.subscribeToInvalidations,
          unsubscribeRemoteInvalidations:
            afterBurst.unsubscribeRemoteInvalidations - baseline.unsubscribeRemoteInvalidations,
        },
      };
    });

    expect(result.delta.authenticate).toBe(0);
    expect(result.delta.ensureFolder).toBe(0);
    expect(result.delta.listFiles).toBe(0);
    expect(result.delta.listFolders).toBe(0);
    expect(result.delta.readFile).toBeLessThanOrEqual(2);
    expect(result.delta.writeFile).toBe(0);
    expect(result.delta.deleteFile).toBe(0);
    expect(result.delta.getFileMetadata).toBe(0);
    expect(result.delta.subscribeToInvalidations).toBe(0);
    expect(result.delta.unsubscribeRemoteInvalidations).toBe(0);
  });

  test("request budget: repeated same-adapter setRemoteStorage is zero remote requests", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      class CountingAdapter extends MemoryAdapter {
        counts = {
          authenticate: 0,
          ensureFolder: 0,
          listFiles: 0,
          listFolders: 0,
          readFile: 0,
          writeFile: 0,
          deleteFile: 0,
          getFileMetadata: 0,
        };
        async authenticate() {
          this.counts.authenticate++;
          return await super.authenticate();
        }
        async ensureFolder(path: string) {
          this.counts.ensureFolder++;
          return await super.ensureFolder(path);
        }
        async listFiles(path: string) {
          this.counts.listFiles++;
          return await super.listFiles(path);
        }
        async listFolders(path: string) {
          this.counts.listFolders++;
          return await super.listFolders(path);
        }
        async readFile(path: string) {
          this.counts.readFile++;
          return await super.readFile(path);
        }
        async writeFile(path: string, data: Uint8Array | string) {
          this.counts.writeFile++;
          return await super.writeFile(path, data);
        }
        async deleteFile(path: string) {
          this.counts.deleteFile++;
          return await super.deleteFile(path);
        }
        async getFileMetadata(path: string) {
          this.counts.getFileMetadata++;
          return await super.getFileMetadata(path);
        }
        snapshotCounts() {
          return { ...this.counts };
        }
      }

      const adapter = new CountingAdapter();
      const engine = new Interocitor(adapter, {
        batchWindowMs: 0,
        remotePath: "/MeshSameAdapter",
        pollInterval: 600_000,
        deviceId: "dev_same_adapter",
      });
      await engine.init();
      const before = adapter.snapshotCounts();
      await engine.setRemoteStorage(adapter);
      const after = adapter.snapshotCounts();
      return {
        delta: {
          authenticate: after.authenticate - before.authenticate,
          ensureFolder: after.ensureFolder - before.ensureFolder,
          listFiles: after.listFiles - before.listFiles,
          listFolders: after.listFolders - before.listFolders,
          readFile: after.readFile - before.readFile,
          writeFile: after.writeFile - before.writeFile,
          deleteFile: after.deleteFile - before.deleteFile,
          getFileMetadata: after.getFileMetadata - before.getFileMetadata,
        },
      };
    });

    expect(result.delta.authenticate).toBe(0);
    expect(result.delta.ensureFolder).toBe(0);
    expect(result.delta.listFiles).toBe(0);
    expect(result.delta.listFolders).toBe(0);
    expect(result.delta.readFile).toBe(0);
    expect(result.delta.writeFile).toBe(0);
    expect(result.delta.deleteFile).toBe(0);
    expect(result.delta.getFileMetadata).toBe(0);
  });

  test("coalesces invalidation bursts without overlapping sync runs", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      class PushAdapter extends MemoryAdapter {
        readonly name = "push-memory";
        listener: ((payload: { type: string; path: string; ts: number }) => void) | null = null;
        subscribeToInvalidations(
          onInvalidate: (payload: { type: string; path: string; ts: number }) => void,
          hooks?: { onReady?: () => void },
        ): () => void {
          this.listener = onInvalidate;
          hooks?.onReady?.();
          return () => {
            this.listener = null;
          };
        }
        push(path: string): void {
          this.listener?.({ type: "invalidation", path, ts: Date.now() });
        }
      }

      const adapter = new PushAdapter();
      const engine = new Interocitor(adapter, {
        batchWindowMs: 0,
        remotePath: "/MeshBurst",
        pollInterval: 600_000,
        deviceId: "dev_burst",
      });
      let activeSyncs = 0;
      let maxConcurrentSyncs = 0;
      let invalidationMessages = 0;
      let syncCompletes = 0;
      engine.on((event: { type: string }) => {
        if (event.type === "relay:message") invalidationMessages++;
        if (event.type === "sync:start") {
          activeSyncs++;
          maxConcurrentSyncs = Math.max(maxConcurrentSyncs, activeSyncs);
        }
        if (event.type === "sync:complete" || event.type === "sync:error") {
          activeSyncs = Math.max(0, activeSyncs - 1);
          syncCompletes++;
        }
      });

      await engine.init();
      await engine.connect();
      syncCompletes = 0;
      invalidationMessages = 0;
      activeSyncs = 0;
      maxConcurrentSyncs = 0;

      adapter.push("/MeshBurst/changes/head.json");
      adapter.push("/MeshBurst/changes/head.json");
      adapter.push("/MeshBurst/changes/head.json");
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
      await engine.disconnect();

      return {
        invalidationMessages,
        syncCompletes,
        maxConcurrentSyncs,
      };
    });

    expect(result.invalidationMessages).toBe(3);
    expect(result.syncCompletes).toBeLessThanOrEqual(1);
    expect(result.maxConcurrentSyncs).toBeLessThanOrEqual(1);
  });

  test("flush writes one file per change and updates head", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const adapter = new MemoryAdapter();
      const engine = new Interocitor(adapter, {
        batchWindowMs: 0,
        remotePath: "/MeshFlush",
        pollInterval: 600_000,
        flushThreshold: 999,
        flushDebounce: 60_000,
        deviceId: "dev_writer",
      });

      await engine.init();
      await engine.connect();
      await engine.put("tasks", "t1", { title: "one" });
      await engine.put("tasks", "t2", { title: "two" });
      await engine.flush();
      await engine.disconnect();

      const dump = adapter.dump();
      const files = Object.keys(dump);
      return {
        files,
        headPath: files.find((path) => path.endsWith("/changes/head.json")),
        changeFileCount: files.filter((path) => /\/changes\/[^/]+-chg_[^/]+\.json$/.test(path))
          .length,
      };
    });

    expect(result.headPath).toBeTruthy();
    expect(result.changeFileCount).toBe(2);
  });

  test("two devices converge via change files", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor, readColumn } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const shared = new MemoryAdapter();

      const engineA = new Interocitor(shared, {
        batchWindowMs: 0,
        remotePath: "/MeshSync",
        pollInterval: 600_000,
        flushThreshold: 1,
        deviceId: "dev_a",
      });
      await engineA.init();
      await engineA.connect();
      await engineA.put("tasks", "r1", { title: "from a" });
      await engineA.flush();
      await engineA.disconnect();

      await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase("interocitor");
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      });

      const engineB = new Interocitor(shared, {
        batchWindowMs: 0,
        remotePath: "/MeshSync",
        pollInterval: 600_000,
        deviceId: "dev_b",
      });
      await engineB.init();
      await engineB.connect();
      const row = await engineB.loadRow({ table: "tasks", rowId: "r1" });
      await engineB.disconnect();

      return row ? readColumn(row, "title") : null;
    });

    expect(result).toBe("from a");
  });

  test("pull discovers an older queued change flushed behind the current head", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const {
        BrowserTestInterocitor: Interocitor,
        MemoryLocalStore,
        readColumn,
      } = await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const shared = new MemoryAdapter();
      const config = {
        batchWindowMs: 0,
        remotePath: "/MeshLateFlush",
        pollInterval: 600_000,
        flushDebounce: 600_000,
        flushThreshold: 999,
        keySource: null,
      };
      const left = new Interocitor(shared, {
        ...config,
        dbName: "late-flush-left",
        deviceId: "dev_left",
        localStore: new MemoryLocalStore(),
      });
      const right = new Interocitor(shared, {
        ...config,
        dbName: "late-flush-right",
        deviceId: "dev_right",
        localStore: new MemoryLocalStore(),
      });

      await left.connect();
      await right.connect();

      await left.put("tasks", "second", { done: false });
      await left.put("tasks", "third", { done: false });
      await left.flush();
      await right.pull();

      await right.put("tasks", "second", { done: true });
      await new Promise((resolve) => {
        setTimeout(resolve, 2);
      });
      await left.put("tasks", "third", { done: true });
      await left.flush();

      await right.pull();
      await right.flush();
      const lateChanges: any[] = [];
      left.on((event: any) => {
        if (event.type === "sync:late-change") lateChanges.push(event);
      });
      await left.pull();

      const leftSecond = await left.loadRow({ table: "tasks", rowId: "second" });
      const leftThird = await left.loadRow({ table: "tasks", rowId: "third" });
      const rightSecond = await right.loadRow({ table: "tasks", rowId: "second" });
      const rightThird = await right.loadRow({ table: "tasks", rowId: "third" });

      return {
        left: {
          second: leftSecond ? readColumn(leftSecond, "done") : null,
          third: leftThird ? readColumn(leftThird, "done") : null,
        },
        right: {
          second: rightSecond ? readColumn(rightSecond, "done") : null,
          third: rightThird ? readColumn(rightThird, "done") : null,
        },
        lateChanges,
      };
    });

    expect(result.left).toEqual({ second: true, third: true });
    expect(result.right).toEqual(result.left);
    expect(result.lateChanges).toEqual([
      expect.objectContaining({
        writerId: "dev_right",
        relation: "behind-global-high-water",
      }),
    ]);
  });

  test("failed publication leaves the exact durable outbox entry for retry", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor, MemoryLocalStore } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      class FailOneChangeWriteAdapter extends MemoryAdapter {
        failNextChange = true;
        override async writeFile(path: string, data: Uint8Array | string): Promise<void> {
          if (this.failNextChange && path.includes("/changes/") && path.endsWith(".json")) {
            this.failNextChange = false;
            throw new Error("simulated publication failure");
          }
          return super.writeFile(path, data);
        }
      }

      const adapter = new FailOneChangeWriteAdapter();
      const local = new MemoryLocalStore();
      const engine = new Interocitor(adapter, {
        batchWindowMs: 0,
        deviceId: "dev_crash_safe_flush",
        flushDebounce: 600_000,
        flushThreshold: 999,
        keySource: null,
        localStore: local,
        pollInterval: 600_000,
        remotePath: "/MeshCrashSafeFlush",
      });
      await engine.connect();
      await engine.put("tasks", "durable", { title: "never lost" });

      let error = "";
      try {
        await engine.flush();
      } catch (cause) {
        error = String(cause);
      }
      const afterFailure = (await local.peekOutbox()).map((entry) => entry.id);
      await engine.flush();
      const afterRetry = (await local.peekOutbox()).map((entry) => entry.id);
      const remoteChanges = Object.keys(adapter.dump()).filter(
        (path) => path.includes("/changes/") && path.includes("-chg_"),
      );

      return { afterFailure, afterRetry, error, remoteChanges };
    });

    expect(result.error).toContain("simulated publication failure");
    expect(result.afterFailure).toHaveLength(1);
    expect(result.afterRetry).toEqual([]);
    expect(result.remoteChanges).toHaveLength(1);
  });

  test("compaction waits for an explicit batch and snapshots its one published file", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor, MemoryLocalStore } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const adapter = new MemoryAdapter();
      const engine = new Interocitor(adapter, {
        batchWindowMs: 60_000,
        deviceId: "dev_compaction_cut",
        keySource: null,
        localStore: new MemoryLocalStore(),
        pollInterval: 600_000,
        remotePath: "/MeshCompactionCut",
        serverId: "dev_compaction_cut",
        serverManaged: true,
      });
      await engine.connect();

      let releaseBatch!: () => void;
      let firstWriteDone!: () => void;
      const firstWrite = new Promise<void>((resolve) => {
        firstWriteDone = resolve;
      });
      const batchGate = new Promise<void>((resolve) => {
        releaseBatch = resolve;
      });
      const batch = engine.batch(async () => {
        await engine.put("tasks", "first", { title: "first" });
        firstWriteDone();
        await batchGate;
        await engine.put("tasks", "second", { title: "second" });
      });
      await firstWrite;

      let compactCompleted = false;
      const compact = engine.compact().then(() => {
        compactCompleted = true;
      });
      await Promise.resolve();
      const completedBeforeBatch = compactCompleted;
      releaseBatch();
      await batch;
      await compact;

      const manifest = engine.getManifest();
      if (!manifest?.snapshotPath) throw new Error("snapshot missing");
      const snapshot = JSON.parse(adapter.dump()[manifest.snapshotPath]).snapshot;
      const remoteChanges = Object.keys(adapter.dump()).filter(
        (path) => path.includes("/changes/") && path.includes("-chg_"),
      );
      return {
        completedBeforeBatch,
        coveredChangeFiles: snapshot.coveredChangeFiles,
        rowIds: Object.keys(snapshot.tables.tasks ?? {}).toSorted(),
        remoteChanges,
      };
    });

    expect(result.completedBeforeBatch).toBe(false);
    expect(result.rowIds).toEqual(["first", "second"]);
    expect(result.coveredChangeFiles).toHaveLength(1);
    expect(result.remoteChanges).toHaveLength(0);
  });

  test("compaction never deletes a late file that the snapshot did not observe", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const {
        BrowserTestInterocitor: Interocitor,
        MemoryLocalStore,
        readColumn,
      } = await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      class LatePublishingAdapter extends MemoryAdapter {
        private latePublication: { snapshotPrefix: string; path: string; payload: string } | null =
          null;

        publishDuringSnapshot(snapshotPrefix: string, path: string, payload: string) {
          this.latePublication = { snapshotPrefix, path, payload };
        }

        override async writeFile(path: string, data: Uint8Array | string): Promise<void> {
          await super.writeFile(path, data);
          const late = this.latePublication;
          if (late && path.startsWith(late.snapshotPrefix)) {
            this.latePublication = null;
            await super.writeFile(late.path, new TextEncoder().encode(late.payload));
          }
        }
      }

      const remotePath = "/MeshCompactLatePublish";
      const adapter = new LatePublishingAdapter();
      const compactor = new Interocitor(adapter, {
        batchWindowMs: 0,
        dbName: "compact-late-compactor",
        deviceId: "dev_compactor",
        keySource: null,
        localStore: new MemoryLocalStore(),
        pollInterval: 600_000,
        remotePath,
        serverId: "dev_compactor",
        serverManaged: true,
      });
      await compactor.connect();
      await compactor.put("tasks", "captured", { title: "in snapshot" });
      await compactor.flush();

      const meshId = compactor.getMeshId();
      if (!meshId) throw new Error("mesh id missing");
      const lateHlc = "000000000000001-0000-dev_compactor";
      const lateFileName = `${lateHlc}-chg_late_during_compaction.json`;
      const latePath = `${remotePath}/changes/${lateFileName}`;
      const latePayload = JSON.stringify({
        meshId,
        kind: "change",
        entry: {
          id: "chg_late_during_compaction",
          ts: 1,
          device: "dev_compactor",
          hlc: lateHlc,
          ops: [
            {
              type: "upsert",
              table: "tasks",
              rowId: "late",
              columns: { title: { value: "published during compaction", hlc: lateHlc } },
            },
          ],
        },
      });
      adapter.publishDuringSnapshot(`${remotePath}/mainline/snapshot-`, latePath, latePayload);

      await compactor.compact();
      const manifest = compactor.getManifest();
      const dumpAfterCompact = adapter.dump();
      const snapshotPayload = JSON.parse(dumpAfterCompact[manifest?.snapshotPath ?? ""]);

      const reader = new Interocitor(adapter, {
        batchWindowMs: 0,
        dbName: "compact-late-reader",
        deviceId: "dev_reader",
        keySource: null,
        localStore: new MemoryLocalStore(),
        pollInterval: 600_000,
        remotePath,
        serverId: "dev_compactor",
      });
      await reader.connect();
      const captured = await reader.loadRow({ table: "tasks", rowId: "captured" });
      const late = await reader.loadRow({ table: "tasks", rowId: "late" });

      return {
        captured: captured ? readColumn(captured, "title") : null,
        coveredChangeFiles: snapshotPayload.snapshot.coveredChangeFiles,
        late: late ? readColumn(late, "title") : null,
        lateFileSurvivedPrune: Object.hasOwn(dumpAfterCompact, latePath),
        lateFileName,
      };
    });

    expect(result.captured).toBe("in snapshot");
    expect(result.late).toBe("published during compaction");
    expect(result.lateFileSurvivedPrune).toBe(true);
    expect(result.coveredChangeFiles).not.toContain(result.lateFileName);
  });

  test("rehydrate does not replay a snapshot-covered file when cleanup fails", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const {
        BrowserTestInterocitor: Interocitor,
        MemoryLocalStore,
        readColumn,
      } = await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      class RetainingAdapter extends MemoryAdapter {
        changeReads = 0;

        override async readFile(path: string): Promise<Uint8Array> {
          if (
            path.includes("/changes/") &&
            path.endsWith(".json") &&
            !path.endsWith("/head.json")
          ) {
            this.changeReads += 1;
          }
          return super.readFile(path);
        }

        override async deleteFile(path: string): Promise<void> {
          if (path.includes("/changes/")) return;
          return super.deleteFile(path);
        }
      }

      const adapter = new RetainingAdapter();
      const config = {
        batchWindowMs: 0,
        keySource: null,
        pollInterval: 600_000,
        remotePath: "/MeshRetainedCoveredChange",
        serverId: "dev_retained_compactor",
        serverManaged: true,
      };
      const compactor = new Interocitor(adapter, {
        ...config,
        deviceId: "dev_retained_compactor",
        localStore: new MemoryLocalStore(),
      });
      await compactor.connect();
      await compactor.put("tasks", "covered", { title: "snapshot value" });
      await compactor.flush();
      await compactor.compact();

      const dump = adapter.dump();
      const retainedCoveredFiles = Object.keys(dump).filter(
        (path) => path.includes("/changes/") && path.includes("-chg_"),
      );
      const readsBeforeRehydrate = adapter.changeReads;

      const reader = new Interocitor(adapter, {
        ...config,
        deviceId: "dev_retained_reader",
        localStore: new MemoryLocalStore(),
      });
      await reader.connect();
      const row = await reader.loadRow({ table: "tasks", rowId: "covered" });

      return {
        retainedCoveredFileCount: retainedCoveredFiles.length,
        replayReads: adapter.changeReads - readsBeforeRehydrate,
        title: row ? readColumn(row, "title") : null,
      };
    });

    expect(result.retainedCoveredFileCount).toBe(1);
    expect(result.replayReads).toBe(0);
    expect(result.title).toBe("snapshot value");
  });

  test("manual peer compaction removes covered immutable history", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor, MemoryLocalStore } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const remotePath = "/MeshPeerCheckpoint";
      const adapter = new MemoryAdapter();
      const peer = new Interocitor(adapter, {
        batchWindowMs: 0,
        compactAutoDeviceCount: 1,
        compactAutoSampleNumerator: 1,
        compactAutoThreshold: 1,
        deviceId: "dev_peer_checkpoint",
        keySource: null,
        localStore: new MemoryLocalStore(),
        pollInterval: 600_000,
        remotePath,
      });
      const autoSkipReasons: string[] = [];
      peer.on((event) => {
        if (event.type === "compact:auto:skip") autoSkipReasons.push(event.reason);
      });
      await peer.connect();
      await peer.put("tasks", "retained", { title: "immutable history" });
      await peer.flush();
      await peer.compact();

      const manifest = peer.getManifest();
      const changeFiles = Object.keys(adapter.dump()).filter(
        (path) => path.includes("/changes/") && path.includes("-chg_"),
      );
      return {
        changeFileCount: changeFiles.length,
        snapshotPath: manifest?.snapshotPath ?? "",
        autoSkipReasons,
      };
    });

    expect(result.changeFileCount).toBe(0);
    expect(result.snapshotPath).toContain("/mainline/snapshot-");
    expect(result.autoSkipReasons).toContain("peer-mode");
  });

  test("supports schema indexes + table.where queries", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor, types } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const adapter = new MemoryAdapter();
      const engine = new Interocitor(adapter, {
        batchWindowMs: 0,
        remotePath: "/MeshWhere",
        pollInterval: 600_000,
        deviceId: "dev_where",
        schema: {
          tables: {
            tasks: {
              fields: {
                status: types.index(types.string),
                priority: types.index(types.number),
              },
            },
          },
        },
      });

      await engine.init();
      await engine.connect();

      const tasks = engine.table("tasks");
      await tasks.put("t1", { title: "A", status: "open", priority: 1 } as any);
      await tasks.put("t2", { title: "B", status: "done", priority: 3 } as any);
      await tasks.put("t3", { title: "C", status: "open", priority: 2 } as any);

      const open = await tasks.where("status").equals("open" as any);
      const p2plus = await tasks.where("priority").aboveOrEqual(2 as any);
      const manifest = engine.getManifest();

      await engine.disconnect();
      return {
        openTitles: open.map((row: any) => row.title).toSorted(),
        p2plusTitles: p2plus.map((row: any) => row.title).toSorted(),
        schemaVersion: manifest?.schema,
      };
    });

    expect(result.openTitles).toEqual(["A", "C"]);
    expect(result.p2plusTitles).toEqual(["B", "C"]);
    expect(result.schemaVersion).toBe(1);
  });

  test("keeps indexed where range queries isolated to their table", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor, types } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const engine = new Interocitor(new MemoryAdapter(), {
        batchWindowMs: 0,
        remotePath: "/MeshWhereLeakRange",
        pollInterval: 600_000,
        deviceId: "dev_where_leak_range",
        schema: {
          tables: {
            alphaMeals: { fields: { date: types.index(types.string) } },
            cookedMeals: { fields: { date: types.index(types.string) } },
            mealEntries: { fields: { date: types.index(types.string) } },
          },
        },
      });

      await engine.init();
      await engine.connect();

      await engine.table("alphaMeals").put("alpha-1", {
        id: "alpha-1",
        date: "2026-05-01",
        beforeOnly: true,
      } as any);
      await engine.table("cookedMeals").put("cooked-1", {
        id: "cooked-1",
        date: "2026-05-02",
        targetOnly: true,
      } as any);
      await engine.table("mealEntries").put("entry-1", {
        id: "entry-1",
        date: "2026-05-03",
        afterOnly: true,
      } as any);

      const above = await engine
        .table("cookedMeals")
        .where("date")
        .above("2026-05-01" as any);
      const aboveOrEqual = await engine
        .table("cookedMeals")
        .where("date")
        .aboveOrEqual("2026-05-02" as any);
      const below = await engine
        .table("cookedMeals")
        .where("date")
        .below("2026-05-03" as any);
      const belowOrEqual = await engine
        .table("cookedMeals")
        .where("date")
        .belowOrEqual("2026-05-02" as any);
      const between = await engine
        .table("cookedMeals")
        .where("date")
        .between("2026-05-01" as any, "2026-05-03" as any);
      const startsWith = await engine.table("cookedMeals").where("date").startsWith("2026-05");

      await engine.disconnect();

      return {
        above: above.map((row: any) => ({
          id: row.id,
          targetOnly: row.targetOnly === true,
          beforeOnly: row.beforeOnly === true,
          afterOnly: row.afterOnly === true,
        })),
        aboveOrEqual: aboveOrEqual.map((row: any) => ({
          id: row.id,
          targetOnly: row.targetOnly === true,
          beforeOnly: row.beforeOnly === true,
          afterOnly: row.afterOnly === true,
        })),
        below: below.map((row: any) => ({
          id: row.id,
          targetOnly: row.targetOnly === true,
          beforeOnly: row.beforeOnly === true,
          afterOnly: row.afterOnly === true,
        })),
        belowOrEqual: belowOrEqual.map((row: any) => ({
          id: row.id,
          targetOnly: row.targetOnly === true,
          beforeOnly: row.beforeOnly === true,
          afterOnly: row.afterOnly === true,
        })),
        between: between.map((row: any) => ({
          id: row.id,
          targetOnly: row.targetOnly === true,
          beforeOnly: row.beforeOnly === true,
          afterOnly: row.afterOnly === true,
        })),
        startsWith: startsWith.map((row: any) => ({
          id: row.id,
          targetOnly: row.targetOnly === true,
          beforeOnly: row.beforeOnly === true,
          afterOnly: row.afterOnly === true,
        })),
      };
    });

    const expected = [{ id: "cooked-1", targetOnly: true, beforeOnly: false, afterOnly: false }];
    expect(result.above).toEqual(expected);
    expect(result.aboveOrEqual).toEqual(expected);
    expect(result.below).toEqual(expected);
    expect(result.belowOrEqual).toEqual(expected);
    expect(result.between).toEqual(expected);
    expect(result.startsWith).toEqual(expected);
  });

  test("keeps indexed where equality and anyOf queries isolated to their table", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor, types } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const engine = new Interocitor(new MemoryAdapter(), {
        batchWindowMs: 0,
        remotePath: "/MeshWhereLeakExact",
        pollInterval: 600_000,
        deviceId: "dev_where_leak_exact",
        schema: {
          tables: {
            cookedMeals: { fields: { date: types.index(types.string) } },
            mealEntries: { fields: { date: types.index(types.string) } },
          },
        },
      });

      await engine.init();
      await engine.connect();

      await engine.table("mealEntries").put("entry-same-date", {
        id: "entry-same-date",
        date: "2026-05-02",
        slot: "dinner",
        recipeId: "11ea811631",
      } as any);
      await engine.table("cookedMeals").put("cooked-same-date", {
        id: "cooked-same-date",
        date: "2026-05-02",
        title: "Dinner",
        recipeId: "11ea811631",
      } as any);
      await engine.table("mealEntries").put("entry-other-date", {
        id: "entry-other-date",
        date: "2026-05-03",
        slot: "lunch",
      } as any);

      const equals = await engine
        .table("cookedMeals")
        .where("date")
        .equals("2026-05-02" as any);
      const anyOf = await engine
        .table("cookedMeals")
        .where("date")
        .anyOf(["2026-05-02", "2026-05-03"] as any);

      await engine.disconnect();

      return {
        equals: equals.map((row: any) => ({
          id: row.id,
          hasCookedShape: row.title === "Dinner",
          hasMealEntryShape: row.slot !== undefined,
        })),
        anyOf: anyOf.map((row: any) => ({
          id: row.id,
          hasCookedShape: row.title === "Dinner",
          hasMealEntryShape: row.slot !== undefined,
        })),
      };
    });

    const expected = [{ id: "cooked-same-date", hasCookedShape: true, hasMealEntryShape: false }];
    expect(result.equals).toEqual(expected);
    expect(result.anyOf).toEqual(expected);
  });

  test("rejects unauthorized server writer in manifest", async ({ page }) => {
    const result = await page.evaluate(async () => {
      async function hashOf(obj: unknown): Promise<string> {
        const json = JSON.stringify(obj);
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json));
        const hex = Array.from(new Uint8Array(digest))
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
        return `sha256:${hex}`;
      }
      const { BrowserTestInterocitor: Interocitor } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const adapter = new MemoryAdapter();
      const now = new Date().toISOString();

      const globalPayload = {
        generation: 1,
        parentGeneration: 0,
        writtenBy: "evil_writer",
        writtenAt: now,
        version: 3,
        meshId: "mesh_bad",
        schema: 1,
        encrypted: false,
        server: { managed: true, relayUrl: null, serverId: "server_relay_1" },
        createdAt: now,
        epoch: 0,
        watermarkHlc: "",
        snapshotPath: null,
        deltaPath: null,
      };
      const globalManifest = { ...globalPayload, contentHash: await hashOf(globalPayload) };

      await adapter.writeFile("/Bad/manifest-1.json", JSON.stringify(globalManifest));
      await adapter.writeFile(
        "/Bad/manifest.json",
        JSON.stringify({ currentGeneration: 1, file: "manifest-1.json" }),
      );

      const engine = new Interocitor(adapter, {
        batchWindowMs: 0,
        remotePath: "/Bad",
        pollInterval: 600_000,
        serverId: "server_relay_1",
        deviceId: "dev_bad",
      });

      await engine.init();
      try {
        await engine.connect();
        return "no-error";
      } catch (error: any) {
        return String(error?.message ?? error);
      }
    });

    expect(result).toContain("Unauthorized manifest writer");
  });

  test("encrypted change files are mesh-bound and do not leak plaintext", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor, MemoryLocalStore, PortablePassphraseKeySource } =
        await import("/packages/core/dist/index.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");
      const { generateKey, keyToPassphrase } = await import("/packages/core/dist/crypto/keys.js");
      const { decryptEntry } = await import("/packages/core/dist/crypto/encryption.js");

      const key = await generateKey();
      const passphrase = await keyToPassphrase(key);
      const adapter = new MemoryAdapter();
      const engine = new Interocitor(adapter, {
        batchWindowMs: 0,
        remotePath: "/MeshEnc",
        pollInterval: 600_000,
        flushThreshold: 1,
        deviceId: "dev_enc",
        keySource: new PortablePassphraseKeySource({ portableKey: passphrase }),
        localStore: new MemoryLocalStore(),
      });

      await engine.init();
      await engine.connect();
      await engine.put("secrets", "s1", { text: "classified" });
      await engine.flush();
      const meshId = engine.getMeshId();
      await engine.disconnect();

      const dump = adapter.dump();
      const payload = Object.entries(dump).find(([path]) =>
        /\/changes\/[^/]+-chg_[^/]+\.json$/.test(path),
      );
      if (!payload) {
        return { ciphertext: "", meshId: null, kind: null, decrypted: null };
      }

      const ciphertext = payload[1];
      const decrypted = JSON.parse(await decryptEntry(key, ciphertext));
      return {
        ciphertext,
        meshId,
        kind: decrypted.kind,
        decryptedMeshId: decrypted.meshId,
        opsCount: Array.isArray(decrypted.entry?.ops) ? decrypted.entry.ops.length : 0,
        leakedPlaintext: ciphertext.includes("classified"),
      };
    });

    expect(result.leakedPlaintext).toBe(false);
    expect(result.kind).toBe("change");
    expect(result.decryptedMeshId).toBe(result.meshId);
    expect(result.opsCount).toBe(1);
  });

  test("encrypted snapshots are mesh-bound and do not leak plaintext", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor, MemoryLocalStore, PortablePassphraseKeySource } =
        await import("/packages/core/dist/index.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");
      const { generateKey, keyToPassphrase } = await import("/packages/core/dist/crypto/keys.js");
      const { decryptEntry } = await import("/packages/core/dist/crypto/encryption.js");

      const key = await generateKey();
      const passphrase = await keyToPassphrase(key);
      const adapter = new MemoryAdapter();

      const engine = new Interocitor(adapter, {
        batchWindowMs: 0,
        remotePath: "/MeshSnapshotFP",
        dbName: "mesh-snapshot-fp-db",
        pollInterval: 600_000,
        flushThreshold: 1,
        deviceId: "dev_snapshot_fp",
        keySource: new PortablePassphraseKeySource({ portableKey: passphrase }),
        localStore: new MemoryLocalStore(),
      });

      await engine.init();
      await engine.connect();
      await engine.put("notes", "n1", { text: "classified snapshot" });
      await engine.flush();
      await engine.compact();
      const meshId = engine.getMeshId();
      await engine.disconnect();

      const dump = adapter.dump();
      const payload = Object.entries(dump).find(([path]) => path.includes("/mainline/snapshot-1-"));
      if (!payload) {
        return {
          ciphertext: "",
          meshId: null,
          kind: null,
          snapshotMeshId: null,
          leakedPlaintext: true,
        };
      }

      const ciphertext = payload[1];
      const decrypted = JSON.parse(await decryptEntry(key, ciphertext));
      return {
        meshId,
        kind: decrypted.kind,
        snapshotMeshId: decrypted.meshId,
        tables: Object.keys(decrypted.snapshot?.tables ?? {}),
        leakedPlaintext: ciphertext.includes("classified snapshot"),
      };
    });

    expect(result.leakedPlaintext).toBe(false);
    expect(result.kind).toBe("snapshot");
    expect(result.snapshotMeshId).toBe(result.meshId);
    expect(result.tables).toContain("notes");
  });

  test("encrypted wrong-mesh snapshot data poisons the remote and cuts off sync", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor, MemoryLocalStore, PortablePassphraseKeySource } =
        await import("/packages/core/dist/index.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");
      const { generateKey, keyToPassphrase } = await import("/packages/core/dist/crypto/keys.js");

      const adapter = new MemoryAdapter();
      const key = await generateKey();
      const passphrase = await keyToPassphrase(key);

      const source = new Interocitor(adapter, {
        batchWindowMs: 0,
        remotePath: "/MeshSnapshotSource",
        dbName: "mesh-snapshot-source-db",
        pollInterval: 600_000,
        flushThreshold: 1,
        deviceId: "dev_snapshot_source",
        keySource: new PortablePassphraseKeySource({ portableKey: passphrase }),
        localStore: new MemoryLocalStore(),
      });
      await source.init();
      await source.connect();
      await source.put("notes", "n1", { text: "source snapshot payload" });
      await source.flush();
      await source.compact();
      await source.disconnect();

      const targetSeed = new Interocitor(adapter, {
        batchWindowMs: 0,
        remotePath: "/MeshSnapshotTarget",
        dbName: "mesh-snapshot-target-seed-db",
        pollInterval: 600_000,
        flushThreshold: 1,
        deviceId: "dev_snapshot_target_seed",
        keySource: new PortablePassphraseKeySource({ portableKey: passphrase }),
        localStore: new MemoryLocalStore(),
      });
      await targetSeed.init();
      await targetSeed.connect();
      await targetSeed.put("notes", "n1", { text: "target snapshot payload" });
      await targetSeed.flush();
      await targetSeed.compact();
      await targetSeed.disconnect();

      const dump = adapter.dump();
      const sourceSnapshot = Object.entries(dump).find(([path]) =>
        path.startsWith("/MeshSnapshotSource/mainline/snapshot-1-"),
      );
      const targetSnapshot = Object.entries(dump).find(([path]) =>
        path.startsWith("/MeshSnapshotTarget/mainline/snapshot-1-"),
      );
      if (!sourceSnapshot || !targetSnapshot) throw new Error("Snapshot file not found");
      await adapter.writeFile(targetSnapshot[0], sourceSnapshot[1]);

      await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase("interocitor");
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      });

      const target = new Interocitor(adapter, {
        batchWindowMs: 0,
        remotePath: "/MeshSnapshotTarget",
        dbName: "mesh-snapshot-target-reader-db",
        pollInterval: 600_000,
        deviceId: "dev_snapshot_target_reader",
        keySource: new PortablePassphraseKeySource({ portableKey: passphrase }),
        localStore: new MemoryLocalStore(),
      });
      await target.init();

      const events: Array<{ type: string; path?: string; message?: string }> = [];
      target.on((event) => {
        if (event.type === "remote:poisoned") {
          events.push({ type: event.type, path: event.path, message: event.error.message });
        }
      });

      let connectError = "no-error";
      try {
        await target.connect();
      } catch (error: any) {
        connectError = String(error?.message ?? error);
      }

      let followupRehydrateError = "no-error";
      try {
        await target.rehydrate();
      } catch (error: any) {
        followupRehydrateError = String(error?.message ?? error);
      }

      return {
        connectError,
        followupRehydrateError,
        poisonEventCount: events.length,
        poisonPath: events[0]?.path ?? null,
        poisonMessage: events[0]?.message ?? null,
      };
    });

    expect(result.connectError).toContain("Remote mesh mismatch");
    expect(result.followupRehydrateError).toContain("Remote mesh mismatch");
    expect(result.poisonEventCount).toBeGreaterThan(0);
    expect(result.poisonPath).toContain("/MeshSnapshotTarget/mainline/snapshot-1-");
    expect(result.poisonMessage).toContain("Remote mesh mismatch");
  });

  test("encrypted wrong-mesh data poisons the remote and cuts off sync", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor, MemoryLocalStore, PortablePassphraseKeySource } =
        await import("/packages/core/dist/index.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");
      const { generateKey, keyToPassphrase } = await import("/packages/core/dist/crypto/keys.js");

      const adapter = new MemoryAdapter();
      const key = await generateKey();
      const passphrase = await keyToPassphrase(key);

      const source = new Interocitor(adapter, {
        batchWindowMs: 0,
        remotePath: "/MeshSource",
        dbName: "mesh-source-db",
        pollInterval: 600_000,
        flushThreshold: 999,
        flushDebounce: 60_000,
        deviceId: "dev_source",
        keySource: new PortablePassphraseKeySource({ portableKey: passphrase }),
        localStore: new MemoryLocalStore(),
      });
      await source.init();
      await source.connect();
      await source.put("notes", "n1", { text: "poison me" });
      await source.flush();
      await source.disconnect();

      const targetSeed = new Interocitor(adapter, {
        batchWindowMs: 0,
        remotePath: "/MeshTarget",
        dbName: "mesh-target-seed-db",
        pollInterval: 600_000,
        deviceId: "dev_target_seed",
        keySource: new PortablePassphraseKeySource({ portableKey: passphrase }),
        localStore: new MemoryLocalStore(),
      });
      await targetSeed.init();
      await targetSeed.connect();
      await targetSeed.disconnect();

      const dump = adapter.dump();
      const sourceChange = Object.entries(dump).find(
        ([path]) => path.startsWith("/MeshSource/changes/") && /-chg_[^/]+\.json$/.test(path),
      );
      if (!sourceChange) throw new Error("Source change file not found");
      const poisonedPath = sourceChange[0].replace("/MeshSource/", "/MeshTarget/");
      await adapter.writeFile(poisonedPath, sourceChange[1]);

      const target = new Interocitor(adapter, {
        batchWindowMs: 0,
        remotePath: "/MeshTarget",
        dbName: "mesh-target-reader-db",
        pollInterval: 600_000,
        deviceId: "dev_target_reader",
        keySource: new PortablePassphraseKeySource({ portableKey: passphrase }),
        localStore: new MemoryLocalStore(),
      });
      await target.init();

      const events: Array<{ type: string; path?: string; message?: string }> = [];
      target.on((event) => {
        if (event.type === "remote:poisoned") {
          events.push({ type: event.type, path: event.path, message: event.error.message });
        }
      });

      let connectError = "no-error";
      try {
        await target.connect();
      } catch (error: any) {
        connectError = String(error?.message ?? error);
      }

      let followupPullError = "no-error";
      try {
        await target.pull();
      } catch (error: any) {
        followupPullError = String(error?.message ?? error);
      }

      return {
        connectError,
        followupPullError,
        poisonEventCount: events.length,
        poisonPath: events[0]?.path ?? null,
        poisonMessage: events[0]?.message ?? null,
      };
    });

    expect(result.connectError).toContain("Remote mesh mismatch");
    expect(result.followupPullError).toContain("Remote mesh mismatch");
    expect(result.poisonEventCount).toBeGreaterThan(0);
    expect(result.poisonPath).toContain("/MeshTarget/changes/");
    expect(result.poisonMessage).toContain("Remote mesh mismatch");
  });

  test("can start without a remote adapter and sync later", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor, readColumn } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const remote = new MemoryAdapter();

      const engine = new Interocitor({
        remotePath: "/MeshLateAttach",
        pollInterval: 600_000,
        flushDebounce: 60_000,
        flushThreshold: 999,
        deviceId: "dev_offline",
      });

      await engine.init();
      await engine.put("tasks", "late_1", { title: "offline first" });
      const beforeSync = await engine.loadRow({ table: "tasks", rowId: "late_1" });

      let connectError = "";
      try {
        await engine.connect();
      } catch (error: any) {
        connectError = String(error?.message ?? error);
      }

      await engine.setRemoteStorage(remote);
      await engine.connect();
      await engine.flush();
      await engine.disconnect();

      await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase("interocitor");
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      });

      const reader = new Interocitor(remote, {
        batchWindowMs: 0,
        remotePath: "/MeshLateAttach",
        pollInterval: 600_000,
        deviceId: "dev_late_reader",
      });
      await reader.init();
      await reader.connect();
      const synced = await reader.loadRow({ table: "tasks", rowId: "late_1" });
      const dump = remote.dump();
      await reader.disconnect();

      return {
        beforeSync: beforeSync ? readColumn(beforeSync, "title") : null,
        connectError,
        synced: synced ? readColumn(synced, "title") : null,
        changeFileCount: Object.keys(dump).filter((path) =>
          /\/changes\/[^/]+-chg_[^/]+\.json$/.test(path),
        ).length,
      };
    });

    expect(result.beforeSync).toBe("offline first");
    expect(result.connectError).toContain("No remote storage adapter configured");
    expect(result.synced).toBe("offline first");
    expect(result.changeFileCount).toBeGreaterThan(0);
  });

  test("setRemoteStorage migrates full local state to a new backend at runtime", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor, readColumn } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const remoteA = new MemoryAdapter();
      const remoteB = new MemoryAdapter();

      const engine = new Interocitor(remoteA, {
        batchWindowMs: 0,
        remotePath: "/MeshSwap",
        pollInterval: 600_000,
        flushDebounce: 5,
        flushThreshold: 1,
        deviceId: "dev_primary",
      });
      await engine.init();
      await engine.connect();
      await engine.put("tasks", "local_1", { title: "from primary" });
      await engine.flush();

      const peer = new Interocitor(remoteA, {
        batchWindowMs: 0,
        remotePath: "/MeshSwap",
        pollInterval: 600_000,
        flushDebounce: 5,
        flushThreshold: 1,
        deviceId: "dev_peer",
      });
      await peer.init();
      await peer.connect();
      await peer.put("tasks", "peer_1", { title: "from peer" });
      await peer.flush();
      await peer.disconnect();

      await engine.pull();
      await engine.setRemoteStorage(remoteB);
      await engine.put("tasks", "after_switch", { title: "after switch" });
      await engine.flush();
      await engine.disconnect();

      await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase("interocitor");
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      });

      const reader = new Interocitor(remoteB, {
        batchWindowMs: 0,
        remotePath: "/MeshSwap",
        pollInterval: 600_000,
        deviceId: "dev_b_reader",
      });
      await reader.init();
      await reader.connect();
      const localRow = await reader.loadRow({ table: "tasks", rowId: "local_1" });
      const peerRow = await reader.loadRow({ table: "tasks", rowId: "peer_1" });
      const switchedRow = await reader.loadRow({ table: "tasks", rowId: "after_switch" });
      await reader.disconnect();

      const dumpA = remoteA.dump();
      const dumpB = remoteB.dump();

      return {
        localTitle: localRow ? readColumn(localRow, "title") : null,
        peerTitle: peerRow ? readColumn(peerRow, "title") : null,
        switchedTitle: switchedRow ? readColumn(switchedRow, "title") : null,
        remoteAHasSwitchWrite: Object.values(dumpA).some((value) => value.includes("after switch")),
        remoteBChangeFileCount: Object.keys(dumpB).filter((path) =>
          /\/changes\/[^/]+-chg_[^/]+\.json$/.test(path),
        ).length,
      };
    });

    expect(result.localTitle).toBe("from primary");
    expect(result.peerTitle).toBe("from peer");
    expect(result.switchedTitle).toBe("after switch");
    expect(result.remoteAHasSwitchWrite).toBe(false);
    expect(result.remoteBChangeFileCount).toBeGreaterThanOrEqual(3);
  });

  test("can detach from multiple adapters and later rejoin the old adapter with concurrent changes", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor, readColumn } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const adapterA = new MemoryAdapter();
      const adapterB = new MemoryAdapter();

      const clientOne = new Interocitor({
        remotePath: "/MeshRoundTrip",
        dbName: "mesh-roundtrip-client-one",
        pollInterval: 600_000,
        flushDebounce: 5,
        flushThreshold: 1,
        deviceId: "dev_roundtrip_1",
      });
      await clientOne.init();
      await clientOne.put("tasks", "seed", { title: "seed offline" });

      await clientOne.setRemoteStorage(adapterA);
      await clientOne.connect();
      await clientOne.flush();
      await clientOne.setRemoteStorage(null);

      await clientOne.setRemoteStorage(adapterB);
      await clientOne.connect();
      await clientOne.flush();
      const dumpBAfterAttach = adapterB.dump();
      await clientOne.setRemoteStorage(null);

      const clientTwo = new Interocitor(adapterA, {
        batchWindowMs: 0,
        remotePath: "/MeshRoundTrip",
        dbName: "mesh-roundtrip-client-two",
        pollInterval: 600_000,
        flushDebounce: 5,
        flushThreshold: 1,
        deviceId: "dev_roundtrip_2",
      });
      await clientTwo.init();
      await clientTwo.connect();
      await clientTwo.put("tasks", "from_two", { title: "from old adapter" });
      await clientTwo.flush();

      await clientOne.put("tasks", "from_one_late", { title: "from first while detached" });
      const offlineRow = await clientOne.loadRow({ table: "tasks", rowId: "from_one_late" });

      await clientOne.setRemoteStorage(adapterA);
      await clientOne.connect();
      await clientOne.flush();
      await clientTwo.pull();

      const clientOneRows = await clientOne.query("tasks");
      const clientTwoRows = await clientTwo.query("tasks");
      const dumpA = adapterA.dump();
      const dumpBFinal = adapterB.dump();

      await clientTwo.disconnect();
      await clientOne.disconnect();

      const titles = (rows: any[]) =>
        rows
          .map((row) => readColumn(row, "title"))
          .filter(Boolean)
          .sort();

      return {
        offlineTitle: offlineRow ? readColumn(offlineRow, "title") : null,
        clientOneTitles: titles(clientOneRows),
        clientTwoTitles: titles(clientTwoRows),
        adapterBHasSeed: Object.values(dumpBAfterAttach).some((value) =>
          value.includes("seed offline"),
        ),
        adapterAHasMergedState:
          Object.values(dumpA).some((value) => value.includes("from old adapter")) &&
          Object.values(dumpA).some((value) => value.includes("from first while detached")),
        adapterBStayedDetached:
          !Object.values(dumpBFinal).some((value) => value.includes("from old adapter")) &&
          !Object.values(dumpBFinal).some((value) => value.includes("from first while detached")),
      };
    });

    expect(result.offlineTitle).toBe("from first while detached");
    expect(result.clientOneTitles).toEqual([
      "from first while detached",
      "from old adapter",
      "seed offline",
    ]);
    expect(result.clientTwoTitles).toEqual([
      "from first while detached",
      "from old adapter",
      "seed offline",
    ]);
    expect(result.adapterBHasSeed).toBe(true);
    expect(result.adapterAHasMergedState).toBe(true);
    expect(result.adapterBStayedDetached).toBe(true);
  });

  test("direct-cloud compaction works and clients rehydrate from snapshot", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor, readColumn } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const shared = new MemoryAdapter();

      const serverEngine = new Interocitor(shared, {
        batchWindowMs: 0,
        remotePath: "/MeshCompact",
        pollInterval: 600_000,
        flushThreshold: 1,
        deviceId: "dev_compactor",
      });
      await serverEngine.init();
      await serverEngine.connect();
      await serverEngine.put("notes", "n1", { text: "from snapshot" });
      await serverEngine.flush();
      await serverEngine.compact();
      await serverEngine.disconnect();

      await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase("interocitor");
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      });

      const clientEngine = new Interocitor(shared, {
        batchWindowMs: 0,
        remotePath: "/MeshCompact",
        pollInterval: 600_000,
        deviceId: "dev_client",
      });
      await clientEngine.init();
      await clientEngine.connect();
      const row = await clientEngine.loadRow({ table: "notes", rowId: "n1" });
      const dump = shared.dump();
      await clientEngine.disconnect();

      return {
        text: row ? readColumn(row, "text") : null,
        hasSnapshot: Object.keys(dump).some((path) => path.includes("/mainline/snapshot-1-")),
      };
    });

    expect(result.text).toBe("from snapshot");
    expect(result.hasSnapshot).toBe(true);
  });

  test("repeated compaction keeps one authoritative snapshot and stale readers retry it", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const {
        BrowserTestInterocitor: Interocitor,
        MemoryLocalStore,
        readColumn,
      } = await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const adapter = new MemoryAdapter();
      const remotePath = "/SnapshotLifecycleMesh";
      const compactor = new Interocitor(adapter, {
        remotePath,
        localStore: new MemoryLocalStore(),
        keySource: null,
        deviceId: "dev_snapshot_lifecycle_compactor",
        batchWindowMs: 0,
      });
      const staleReader = new Interocitor(adapter, {
        remotePath,
        localStore: new MemoryLocalStore(),
        keySource: null,
        deviceId: "dev_snapshot_lifecycle_reader",
        batchWindowMs: 0,
      });

      await compactor.connect();
      await compactor.put("notes", "n1", { text: "snapshot one" });
      await compactor.flush();
      await compactor.compact();
      await staleReader.connect();
      const staleSnapshotPath = staleReader.getManifest()?.snapshotPath;

      await compactor.put("notes", "n2", { text: "snapshot two" });
      await compactor.flush();
      await compactor.compact();
      const afterSecond = Object.keys(adapter.dump()).filter((path) =>
        path.includes("/mainline/snapshot-"),
      );
      const stalePathWasDeleted = staleSnapshotPath
        ? !Object.hasOwn(adapter.dump(), staleSnapshotPath)
        : false;

      await staleReader.rehydrate();
      const restored = await staleReader.loadRow({ table: "notes", rowId: "n2" });

      await compactor.compact();
      const afterThird = Object.keys(adapter.dump()).filter((path) =>
        path.includes("/mainline/snapshot-"),
      );
      const activeSnapshotPath = compactor.getManifest()?.snapshotPath;
      await staleReader.disconnect();
      await compactor.disconnect();

      return {
        afterSecond,
        afterThird,
        activeSnapshotPath,
        stalePathWasDeleted,
        restoredText: restored ? readColumn(restored, "text") : null,
      };
    });

    expect(result.afterSecond).toHaveLength(1);
    expect(result.afterThird).toEqual([result.activeSnapshotPath]);
    expect(result.stalePathWasDeleted).toBe(true);
    expect(result.restoredText).toBe("snapshot two");
  });

  test("a later compaction retries transient superseded-snapshot deletion failure", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor, MemoryLocalStore } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      class OnceFailingSnapshotDeleteAdapter extends MemoryAdapter {
        failed = false;

        override async deleteFile(path: string): Promise<void> {
          if (!this.failed && path.includes("/mainline/snapshot-")) {
            this.failed = true;
            throw new Error("simulated transient snapshot delete failure");
          }
          return super.deleteFile(path);
        }
      }

      const adapter = new OnceFailingSnapshotDeleteAdapter();
      const engine = new Interocitor(adapter, {
        remotePath: "/SnapshotCleanupRetryMesh",
        localStore: new MemoryLocalStore(),
        keySource: null,
        deviceId: "dev_snapshot_cleanup_retry",
        batchWindowMs: 0,
      });
      await engine.connect();
      await engine.compact();
      await engine.compact();
      const afterFailure = Object.keys(adapter.dump()).filter((path) =>
        path.includes("/mainline/snapshot-"),
      ).length;
      await engine.compact();
      const remaining = Object.keys(adapter.dump()).filter((path) =>
        path.includes("/mainline/snapshot-"),
      );
      const activeSnapshotPath = engine.getManifest()?.snapshotPath;
      await engine.disconnect();
      return { afterFailure, remaining, activeSnapshotPath };
    });

    expect(result.afterFailure).toBe(2);
    expect(result.remaining).toEqual([result.activeSnapshotPath]);
  });

  test("non-authorized client compaction is rejected in server-managed mode", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const engine = new Interocitor(new MemoryAdapter(), {
        remotePath: "/MeshCompactReject",
        serverManaged: true,
        serverId: "server_relay_1",
        pollInterval: 600_000,
        deviceId: "dev_not_server",
      });

      await engine.init();
      await engine.connect();
      try {
        await engine.compact();
        return "no-error";
      } catch (error: any) {
        return String(error?.message ?? error);
      } finally {
        await engine.disconnect();
      }
    });

    expect(result).toContain("authorized server writer");
  });

  test("constructor stays uninitialized until init/connect and lazy mesh config wins", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor, rowToPlain } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const adapter = new MemoryAdapter();
      const engine = new Interocitor(adapter, {
        batchWindowMs: 0,
        dbName: "lazy-config-db",
        appName: "Test App",
        logLevel: "debug",
      });

      const dumpBeforeInit = Object.keys(adapter.dump());
      engine.configureMesh({ remotePath: "/LazyMesh", encrypted: false, deviceId: "dev_lazy" });
      await engine.connect();
      await engine.put("tasks", "lazy_1", { title: "configured before connect" });
      await engine.flush();
      const row = await engine.loadRow({ table: "tasks", rowId: "lazy_1" });
      const deviceId = engine.getDeviceId();
      await engine.disconnect();

      return {
        dumpBeforeInit,
        dumpAfterConnect: Object.keys(adapter.dump()),
        deviceId,
        title: row ? rowToPlain(row).title : null,
      };
    });

    expect(result.dumpBeforeInit).toEqual([]);
    expect(result.dumpAfterConnect).toContain("/LazyMesh/manifest.json");
    expect(result.deviceId).toBe("dev_lazy");
    expect(result.title).toBe("configured before connect");
  });

  test("resolveInitialState can supply mesh settings before first connect", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor, rowToPlain } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const adapter = new MemoryAdapter();
      let calls = 0;
      const engine = new Interocitor(adapter, {
        batchWindowMs: 0,
        dbName: "resolve-initial-db",
        appName: "Test App",
        logLevel: "debug",
        resolveInitialState: async () => {
          calls += 1;
          return { remotePath: "/ResolvedMesh", encrypted: false, deviceId: "dev_resolved" };
        },
      });

      await engine.connect();
      await engine.put("tasks", "resolved_1", { title: "resolved config" });
      await engine.flush();
      const row = await engine.loadRow({ table: "tasks", rowId: "resolved_1" });
      await engine.disconnect();

      return {
        calls,
        files: Object.keys(adapter.dump()),
        deviceId: engine.getDeviceId(),
        title: row ? rowToPlain(row).title : null,
      };
    });

    expect(result.calls).toBe(1);
    expect(result.files).toContain("/ResolvedMesh/manifest.json");
    expect(result.deviceId).toBe("dev_resolved");
    expect(result.title).toBe("resolved config");
  });

  test("configureMesh after init is rejected to prevent stale pairing state", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const engine = new Interocitor(new MemoryAdapter(), {
        remotePath: "/FixedMesh",
        dbName: "fixed-mesh-db",
        appName: "Test App",
      });

      await engine.init();
      try {
        engine.configureMesh({ remotePath: "/OtherMesh", encrypted: false });
        return "no-error";
      } catch (error: any) {
        return String(error?.message ?? error);
      } finally {
        await engine.disconnect();
      }
    });

    expect(result).toContain("Cannot configure mesh after init()");
  });

  test("PortablePassphraseKeySource accepts a portable key before init", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor, MemoryLocalStore, PortablePassphraseKeySource } =
        await import("/packages/core/dist/index.js");
      const { generateKey, keyToPassphrase } = await import("/packages/core/dist/crypto/keys.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");
      const portableKey = await keyToPassphrase(await generateKey());
      const keySource = new PortablePassphraseKeySource({ generateIfMissing: false });
      keySource.setPortableKey(portableKey);
      const engine = new Interocitor(new MemoryAdapter(), {
        remotePath: "/PassphraseMesh",
        dbName: "passphrase-after-init-db",
        appName: "Test App",
        keySource,
        localStore: new MemoryLocalStore(),
      });

      await engine.init();
      const beforeConnect = {
        portableKey: keySource.getPortableKey(),
        expectedPortableKey: portableKey,
        encrypted: engine.isEncrypted(),
      };
      await engine.disconnect();
      return beforeConnect;
    });

    expect(result.portableKey).toBe(result.expectedPortableKey);
    expect(result.encrypted).toBe(true);
  });

  test("configureMesh is rejected while connected", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");
      const engine = new Interocitor(new MemoryAdapter(), {
        remotePath: "/ConnectedPassphraseMesh",
        dbName: "passphrase-connected-db",
        appName: "Test App",
      });

      await engine.connect();
      try {
        engine.configureMesh({ remotePath: "/TooLate" });
        return "no-error";
      } catch (error: any) {
        return String(error?.message ?? error);
      } finally {
        await engine.disconnect();
      }
    });

    expect(result).toContain("Cannot configure mesh while connected");
  });

  test("emits compact:warning when queued changes reach compactWarnThreshold", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const engine = new Interocitor(new MemoryAdapter(), {
        remotePath: "/WarnMesh",
        dbName: "warn-mesh-db",
        pollInterval: 600_000,
        flushThreshold: 9999,
        flushDebounce: 60_000,
        compactWarnThreshold: 3,
        compactAutoThreshold: 9999,
        autoCompact: false,
        batchWindowMs: 0,
      });

      const events: string[] = [];
      engine.on((e) => {
        events.push(e.type);
      });

      await engine.init();
      // No remote connect — warning fires on write, not connect

      await engine.put("tasks", "t1", { title: "one" });
      await engine.put("tasks", "t2", { title: "two" });
      const beforeThird = events.filter((e) => e === "compact:warning").length;
      await engine.put("tasks", "t3", { title: "three" });
      const afterThird = events.filter((e) => e === "compact:warning").length;
      // Warning fires exactly once even with more writes
      await engine.put("tasks", "t4", { title: "four" });
      const afterFourth = events.filter((e) => e === "compact:warning").length;

      await engine.disconnect();
      return { beforeThird, afterThird, afterFourth };
    });

    expect(result.beforeThird).toBe(0);
    expect(result.afterThird).toBe(1);
    expect(result.afterFourth).toBe(1); // no duplicate
  });

  test("emits compact:auto:skip with reason=not-connected when not connected", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const engine = new Interocitor(new MemoryAdapter(), {
        remotePath: "/SkipMesh",
        dbName: "skip-mesh-db",
        pollInterval: 600_000,
        flushThreshold: 2,
        flushDebounce: 60_000,
        compactWarnThreshold: 2,
        compactAutoThreshold: 2,
        compactAutoSampleNumerator: 10,
        compactAutoDeviceCount: 1,
        autoCompact: true,
        batchWindowMs: 0,
      });

      const skipEvents: any[] = [];
      engine.on((e) => {
        if (e.type === "compact:auto:skip") skipEvents.push(e);
      });

      await engine.init();
      // Do NOT connect — auto-compact should skip with not-connected

      await engine.put("tasks", "t1", { title: "one" });
      await engine.put("tasks", "t2", { title: "two" });
      // flush:threshold triggers doFlush which triggers maybeAutoCompact
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });

      await engine.disconnect();
      return { skipReasons: skipEvents.map((e) => e.reason) };
    });

    expect(result.skipReasons).toContain("not-connected");
  });

  test("emits compact:auto:skip with reason=disabled when autoCompact=false", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const adapter = new MemoryAdapter();
      const engine = new Interocitor(adapter, {
        batchWindowMs: 0,
        remotePath: "/DisabledMesh",
        dbName: "disabled-mesh-db",
        pollInterval: 600_000,
        flushThreshold: 9999,
        flushDebounce: 60_000,
        compactWarnThreshold: 9999,
        compactAutoThreshold: 2,
        compactAutoSampleNumerator: 10,
        compactAutoDeviceCount: 1,
        autoCompact: false,
      });

      const skipEvents: any[] = [];
      engine.on((e) => {
        if (e.type === "compact:auto:skip") skipEvents.push(e);
      });

      await engine.init();
      await engine.connect();
      await engine.put("tasks", "t1", { title: "one" });
      await engine.put("tasks", "t2", { title: "two" });
      await engine.flush();

      await engine.disconnect();
      return { skipReasons: skipEvents.map((e) => e.reason) };
    });

    expect(result.skipReasons).toContain("disabled");
  });

  test("compact:warning resets after flush drains outbox", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const adapter = new MemoryAdapter();
      const engine = new Interocitor(adapter, {
        batchWindowMs: 0,
        remotePath: "/ResetWarnMesh",
        dbName: "reset-warn-db",
        pollInterval: 600_000,
        flushThreshold: 9999,
        flushDebounce: 60_000,
        compactWarnThreshold: 2,
        compactAutoThreshold: 9999,
        autoCompact: false,
      });

      const warnings: number[] = [];
      engine.on((e) => {
        if (e.type === "compact:warning") warnings.push(Date.now());
      });

      await engine.init();
      await engine.connect();

      // trigger warning
      await engine.put("tasks", "t1", { title: "one" });
      await engine.put("tasks", "t2", { title: "two" });
      const warnCountBefore = warnings.length;

      // flush resets warning state
      await engine.flush();

      // new writes should warn again
      await engine.put("tasks", "t3", { title: "three" });
      await engine.put("tasks", "t4", { title: "four" });
      const warnCountAfter = warnings.length;

      await engine.disconnect();
      return { warnCountBefore, warnCountAfter };
    });

    expect(result.warnCountBefore).toBe(1);
    expect(result.warnCountAfter).toBe(2); // second warning after flush reset
  });

  test("two-phase write + manual compact + third client reads snapshot only", async ({ page }) => {
    // Phase 1: clientA writes 10 todos, flushes → 10 change files on remote
    // Phase 2: clientB pulls, sees 10 rows
    // Phase 3: clientA writes 20 more todos, flushes → 30 change files on remote
    // Phase 4: clientA checkpoints → 1 snapshot and removes its covered change files
    // Phase 5: fresh clientC restores the snapshot and sees all 30 rows
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor, readColumn } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const shared = new MemoryAdapter();
      const REMOTE = "/CompactTwoPhase";

      // helper: count change files (not head, not snapshot, not manifest)
      const countChangeFiles = (dump: Record<string, string>) =>
        Object.keys(dump).filter((p) => /\/changes\/[^/]+-chg_[^/]+\.json$/.test(p)).length;

      // helper: count snapshot files
      const countSnapshotFiles = (dump: Record<string, string>) =>
        Object.keys(dump).filter((p) => p.includes("/mainline/snapshot-")).length;

      // helper: clear IDB between device simulations
      const clearIDB = (name: string) =>
        new Promise<void>((resolve) => {
          const req = indexedDB.deleteDatabase(name);
          req.onsuccess = () => resolve();
          req.onerror = () => resolve();
          req.onblocked = () => resolve();
        });

      // ── Phase 1: clientA writes 10 todos ──────────────────────────────
      const engineA = new Interocitor(shared, {
        batchWindowMs: 0,
        remotePath: REMOTE,
        dbName: "phase-a",
        pollInterval: 600_000,
        flushThreshold: 9999,
        flushDebounce: 60_000,
        autoCompact: false,
        deviceId: "dev_a",
      });
      await engineA.init();
      await engineA.connect();
      for (let i = 0; i < 10; i++) {
        await engineA.put("todos", `todo-${i}`, { title: `todo ${i}`, done: false });
      }
      await engineA.flush();
      const changeFilesAfterPhase1 = countChangeFiles(shared.dump());
      await engineA.disconnect();

      // ── Phase 2: clientB pulls, sees 10 rows ─────────────────────────
      await clearIDB("phase-b");
      const engineB = new Interocitor(shared, {
        batchWindowMs: 0,
        remotePath: REMOTE,
        dbName: "phase-b",
        pollInterval: 600_000,
        autoCompact: false,
        deviceId: "dev_b",
      });
      await engineB.init();
      await engineB.connect();
      const rowsAfterPhase2 = (await engineB.table("todos").query()).length;
      await engineB.disconnect();

      // ── Phase 3: clientA writes 20 more todos ────────────────────────
      const engineA2 = new Interocitor(shared, {
        batchWindowMs: 0,
        remotePath: REMOTE,
        dbName: "phase-a",
        pollInterval: 600_000,
        flushThreshold: 9999,
        flushDebounce: 60_000,
        autoCompact: false,
        deviceId: "dev_a",
      });
      await engineA2.init();
      await engineA2.connect();
      for (let i = 10; i < 30; i++) {
        await engineA2.put("todos", `todo-${i}`, { title: `todo ${i}`, done: false });
      }
      await engineA2.flush();
      const changeFilesAfterPhase3 = countChangeFiles(shared.dump());
      const snapshotsBeforeCompact = countSnapshotFiles(shared.dump());

      // ── Phase 4: clientA compacts ─────────────────────────────────────
      await engineA2.compact();
      const changeFilesAfterCompact = countChangeFiles(shared.dump());
      const snapshotsAfterCompact = countSnapshotFiles(shared.dump());
      await engineA2.disconnect();

      // ── Phase 5: fresh clientC reads snapshot, sees all 30 rows ──────
      await clearIDB("phase-c");
      const engineC = new Interocitor(shared, {
        batchWindowMs: 0,
        remotePath: REMOTE,
        dbName: "phase-c",
        pollInterval: 600_000,
        autoCompact: false,
        deviceId: "dev_c",
      });
      await engineC.init();
      await engineC.connect();
      const rowsAfterPhase5 = (await engineC.table("todos").query()).length;
      const firstRow = await engineC.loadRow({ table: "todos", rowId: "todo-0" });
      const lastRow = await engineC.loadRow({ table: "todos", rowId: "todo-29" });
      await engineC.disconnect();

      return {
        changeFilesAfterPhase1, // expect 10
        rowsAfterPhase2, // expect 10
        changeFilesAfterPhase3, // expect 30
        snapshotsBeforeCompact, // expect 0
        changeFilesAfterCompact, // covered files were folded into mainline
        snapshotsAfterCompact, // expect 1
        rowsAfterPhase5, // expect 30
        firstRowTitle: firstRow ? readColumn(firstRow, "title") : null,
        lastRowTitle: lastRow ? readColumn(lastRow, "title") : null,
      };
    });

    expect(result.changeFilesAfterPhase1).toBe(10);
    expect(result.rowsAfterPhase2).toBe(10);
    expect(result.changeFilesAfterPhase3).toBe(30);
    expect(result.snapshotsBeforeCompact).toBe(0);
    expect(result.changeFilesAfterCompact).toBe(0);
    expect(result.snapshotsAfterCompact).toBe(1);
    expect(result.rowsAfterPhase5).toBe(30);
    expect(result.firstRowTitle).toBe("todo 0");
    expect(result.lastRowTitle).toBe("todo 29");
  });

  test("delayed compact: schedules check phase on first write, skips when below remote threshold", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const adapter = new MemoryAdapter();
      const engine = new Interocitor(adapter, {
        remotePath: "/DelayedMesh",
        dbName: "delayed-mesh-db",
        pollInterval: 600_000,
        flushThreshold: 9999,
        flushDebounce: 60_000,
        compactWarnThreshold: 9999,
        compactAutoThreshold: 9999,
        autoCompact: true,
        firstCompactDelayMs: 50,
        firstCompactDelayJitterMs: 0,
        secondCompactDelayMs: 50,
        secondCompactDelayJitterMs: 0,
        compactRemoteChangeThreshold: 5,
        batchWindowMs: 0,
        deviceId: "dev_delayed_check",
        serverId: "dev_delayed_check",
        serverManaged: true,
      });

      const events: any[] = [];
      engine.on((e) => {
        if (
          e.type === "compact:delayed:scheduled" ||
          e.type === "compact:delayed:check" ||
          e.type === "compact:auto:skip"
        ) {
          events.push(e);
        }
      });

      await engine.init();
      await engine.connect();
      await engine.put("tasks", "t1", { title: "one" });
      await engine.flush();
      await new Promise((resolve) => {
        setTimeout(resolve, 200);
      });
      await engine.disconnect();

      return {
        scheduledCheck: events.some(
          (e) => e.type === "compact:delayed:scheduled" && e.phase === "check",
        ),
        check: events.find((e) => e.type === "compact:delayed:check"),
        skipBelowThreshold: events.find(
          (e) => e.type === "compact:auto:skip" && e.reason === "below-remote-threshold",
        ),
      };
    });

    expect(result.scheduledCheck).toBe(true);
    expect(result.check?.remoteChangeFileCount).toBe(1);
    expect(result.skipBelowThreshold?.trigger).toBe("delayed");
  });

  test("delayed compact: arms second timer and runs when remote files exceed threshold", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const adapter = new MemoryAdapter();
      const engine = new Interocitor(adapter, {
        remotePath: "/DelayedRunMesh",
        dbName: "delayed-run-mesh-db",
        pollInterval: 600_000,
        flushThreshold: 9999,
        flushDebounce: 60_000,
        compactWarnThreshold: 9999,
        compactAutoThreshold: 9999,
        autoCompact: true,
        firstCompactDelayMs: 30,
        firstCompactDelayJitterMs: 0,
        secondCompactDelayMs: 30,
        secondCompactDelayJitterMs: 0,
        compactRemoteChangeThreshold: 2,
        batchWindowMs: 0,
        deviceId: "dev_delayed_run",
        serverId: "dev_delayed_run",
        serverManaged: true,
      });

      const events: any[] = [];
      engine.on((e) => {
        if (
          e.type === "compact:delayed:scheduled" ||
          e.type === "compact:delayed:check" ||
          e.type === "compact:auto:start" ||
          e.type === "compact:auto:complete"
        ) {
          events.push(e);
        }
      });

      await engine.init();
      await engine.connect();
      // 3 writes => 3 remote change files, above threshold (2)
      await engine.put("tasks", "t1", { title: "one" });
      await engine.put("tasks", "t2", { title: "two" });
      await engine.put("tasks", "t3", { title: "three" });
      await engine.flush();
      // Wait for full delayed pipeline: check + run
      await new Promise((resolve) => {
        setTimeout(resolve, 250);
      });
      await engine.disconnect();

      return {
        check: events.find((e) => e.type === "compact:delayed:check"),
        scheduledCompact: events.find(
          (e) => e.type === "compact:delayed:scheduled" && e.phase === "compact",
        ),
        start: events.find((e) => e.type === "compact:auto:start" && e.trigger === "delayed"),
        complete: events.find((e) => e.type === "compact:auto:complete" && e.trigger === "delayed"),
      };
    });

    expect(result.check?.remoteChangeFileCount).toBeGreaterThanOrEqual(3);
    expect(result.scheduledCompact).toBeDefined();
    expect(result.start?.remoteChangeFileCount).toBeGreaterThanOrEqual(3);
    expect(result.complete).toBeDefined();
  });

  test("compaction preserves tombstones because scalar acknowledgements cannot prove safe deletion", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor, MemoryLocalStore } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const adapter = new MemoryAdapter();
      const engine = new Interocitor(adapter, {
        remotePath: "/GcFloorMesh",
        dbName: "tombstone-snapshot-db",
        localStore: new MemoryLocalStore(),
        keySource: null,
        pollInterval: 600_000,
        flushThreshold: 9999,
        flushDebounce: 60_000,
        autoCompact: false,
        batchWindowMs: 0,
        deviceId: "dev_gc_a",
        serverId: "dev_gc_a",
        serverManaged: true,
      });

      await engine.init();
      await engine.connect();
      await engine.put("tasks", "gone", { title: "old" });
      await engine.flush();
      await engine.delete("tasks", "gone");
      await engine.flush();

      await engine.compact();
      await engine.compact();
      const manifest = engine.getManifest();
      const snapshotPayload = JSON.parse(adapter.dump()[manifest?.snapshotPath ?? ""]);
      const tombstone = snapshotPayload.snapshot.tables.tasks?.gone;

      await engine.disconnect();

      return {
        deleted: tombstone?._meta.deleted,
        hasGcFloor: Object.hasOwn(manifest ?? {}, "gcFloorHlc"),
      };
    });

    expect(result.deleted).toBe(true);
    expect(result.hasGcFloor).toBe(false);
  });

  test("old client publishes durable offline writes before restoring an advanced snapshot", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const {
        BrowserTestInterocitor: Interocitor,
        MemoryLocalStore,
        readColumn,
      } = await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const adapter = new MemoryAdapter();
      const remotePath = "/OfflineBeforeSnapshotMesh";
      const oldLocal = new MemoryLocalStore();
      const oldClient = new Interocitor(adapter, {
        remotePath,
        dbName: "offline-old-client-db",
        localStore: oldLocal,
        keySource: null,
        pollInterval: 600_000,
        flushThreshold: 9999,
        flushDebounce: 600_000,
        autoCompact: false,
        batchWindowMs: 0,
        deviceId: "dev_offline_old",
        serverId: "dev_offline_compactor",
        serverManaged: true,
      });

      await oldClient.connect();
      await oldClient.setRemoteStorage(null);
      await oldClient.put("tasks", "offline", { title: "durable offline write" });

      const compactor = new Interocitor(adapter, {
        remotePath,
        dbName: "offline-compactor-db",
        localStore: new MemoryLocalStore(),
        keySource: null,
        pollInterval: 600_000,
        flushThreshold: 9999,
        flushDebounce: 600_000,
        autoCompact: false,
        batchWindowMs: 0,
        deviceId: "dev_offline_compactor",
        serverId: "dev_offline_compactor",
        serverManaged: true,
      });

      await compactor.connect();
      await compactor.put("tasks", "canonical", { title: "snapshot state" });
      await compactor.flush();
      await compactor.compact();
      const pendingBeforeRestart = await oldLocal.peekPendingBatch();
      const outboxBeforeRestart = await oldLocal.outboxSize();
      const localEpochBeforeRestart = await oldLocal.getMeta("epoch");
      const remoteEpochBeforeRestart = compactor.getManifest()?.epoch;

      const restartedOldClient = new Interocitor(adapter, {
        remotePath,
        dbName: "offline-old-client-db",
        localStore: oldLocal,
        keySource: null,
        pollInterval: 600_000,
        flushThreshold: 9999,
        flushDebounce: 600_000,
        autoCompact: false,
        batchWindowMs: 0,
        deviceId: "dev_offline_old",
        serverId: "dev_offline_compactor",
        serverManaged: true,
      });

      await restartedOldClient.connect();
      const offline = await restartedOldClient.loadRow({ table: "tasks", rowId: "offline" });
      const canonical = await restartedOldClient.loadRow({ table: "tasks", rowId: "canonical" });
      const outboxSize = await oldLocal.outboxSize();
      const retainedChangeFileCount = Object.keys(adapter.dump()).filter(
        (path) => path.includes("/changes/") && path.includes("-chg_"),
      ).length;

      return {
        offline: offline ? readColumn(offline, "title") : null,
        canonical: canonical ? readColumn(canonical, "title") : null,
        outboxSize,
        retainedChangeFileCount,
        pendingBeforeRestart: Boolean(pendingBeforeRestart),
        outboxBeforeRestart,
        localEpochBeforeRestart,
        remoteEpochBeforeRestart,
      };
    });

    expect(result.pendingBeforeRestart).toBe(false);
    expect(result.outboxBeforeRestart).toBe(1);
    expect(result.localEpochBeforeRestart).toBeUndefined();
    expect(result.remoteEpochBeforeRestart).toBe(1);
    expect(result.offline).toBe("durable offline write");
    expect(result.canonical).toBe("snapshot state");
    expect(result.outboxSize).toBe(0);
    expect(result.retainedChangeFileCount).toBe(1);
  });

  test("expired offline client quarantines its outbox before restoring the snapshot", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const {
        BrowserTestInterocitor: Interocitor,
        MemoryLocalStore,
        readColumn,
      } = await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const adapter = new MemoryAdapter();
      const remotePath = "/ExpiredOfflineClientMesh";
      const oldLocal = new MemoryLocalStore();
      const common = {
        remotePath,
        keySource: null,
        pollInterval: 600_000,
        flushThreshold: 9999,
        flushDebounce: 600_000,
        autoCompact: false,
        batchWindowMs: 0,
        serverId: "dev_retention_compactor",
        serverManaged: true,
        retention: {
          compactAfterMs: 7 * 24 * 60 * 60 * 1_000,
          maxOfflineDurationMs: 30 * 24 * 60 * 60 * 1_000,
        },
      } as const;

      const oldClient = new Interocitor(adapter, {
        ...common,
        dbName: "expired-offline-client-db",
        deviceId: "dev_expired_offline",
        localStore: oldLocal,
      });
      await oldClient.connect();
      await oldClient.setRemoteStorage(null);
      await oldClient.put("tasks", "expired-local", { title: "must stay local" });
      await oldLocal.setMeta(
        "lastSuccessfulSyncAt",
        new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000).toISOString(),
      );

      const compactor = new Interocitor(adapter, {
        ...common,
        dbName: "expired-offline-compactor-db",
        deviceId: "dev_retention_compactor",
        localStore: new MemoryLocalStore(),
      });
      await compactor.connect();
      await compactor.put("tasks", "canonical", { title: "snapshot state" });
      await compactor.flush();
      await compactor.compact();

      const events: string[] = [];
      const restarted = new Interocitor(adapter, {
        ...common,
        dbName: "expired-offline-client-db",
        deviceId: "dev_expired_offline",
        localStore: oldLocal,
      });
      restarted.on((event) => events.push(event.type));
      await restarted.connect();

      const expiredLocal = await restarted.loadRow({ table: "tasks", rowId: "expired-local" });
      const canonical = await restarted.loadRow({ table: "tasks", rowId: "canonical" });
      const quarantine = await restarted.getQuarantinedOfflineChanges();
      const remoteChangeFiles = Object.keys(adapter.dump()).filter(
        (path) => path.includes("/changes/") && path.includes("-chg_"),
      );
      return {
        expiredLocal: expiredLocal ? readColumn(expiredLocal, "title") : null,
        canonical: canonical ? readColumn(canonical, "title") : null,
        quarantineCount: quarantine?.entries.length ?? 0,
        quarantinedTitle:
          quarantine?.entries[0]?.ops[0]?.type === "upsert"
            ? quarantine.entries[0].ops[0].columns.title?.value
            : null,
        outboxSize: await oldLocal.outboxSize(),
        remoteChangeFileCount: remoteChangeFiles.length,
        emittedExpiry: events.includes("offline:retention-expired"),
      };
    });

    expect(result.expiredLocal).toBeNull();
    expect(result.canonical).toBe("snapshot state");
    expect(result.quarantineCount).toBe(1);
    expect(result.quarantinedTitle).toBe("must stay local");
    expect(result.outboxSize).toBe(0);
    expect(result.remoteChangeFileCount).toBe(0);
    expect(result.emittedExpiry).toBe(true);
  });

  test("direct flush obeys a retention policy tightened while the client was offline", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor, MemoryLocalStore } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const adapter = new MemoryAdapter();
      const remotePath = "/TightenedRetentionMesh";
      const serverId = "retention_policy_server";
      const oldLocal = new MemoryLocalStore();
      const oldClient = new Interocitor(adapter, {
        remotePath,
        dbName: "tightened-retention-old-client",
        localStore: oldLocal,
        keySource: null,
        deviceId: "dev_tightened_retention_old",
        serverId,
        serverManaged: true,
        batchWindowMs: 0,
        flushDebounce: 60_000,
        retention: {
          compactAfterMs: 7 * 24 * 60 * 60_000,
          maxOfflineDurationMs: 30 * 24 * 60 * 60_000,
        },
      });
      await oldClient.connect();
      await oldClient.disconnect();
      await oldLocal.setMeta(
        "lastSuccessfulSyncAt",
        new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString(),
      );
      await oldClient.put("tasks", "stale-direct-flush", { title: "must not upload" });

      const policyWriter = new Interocitor(adapter, {
        remotePath,
        dbName: "tightened-retention-policy-writer",
        localStore: new MemoryLocalStore(),
        keySource: null,
        deviceId: serverId,
        serverId,
        serverManaged: true,
        batchWindowMs: 0,
        retention: {
          compactAfterMs: 7 * 24 * 60 * 60_000,
          maxOfflineDurationMs: 24 * 60 * 60_000,
        },
      });
      await policyWriter.connect();
      await policyWriter.compact();
      await policyWriter.disconnect();

      await oldClient.flush();
      const quarantine = await oldClient.getQuarantinedOfflineChanges();
      const remoteChangeFileCount = Object.keys(adapter.dump()).filter(
        (path) => path.includes("/changes/") && path.includes("-chg_"),
      ).length;
      return {
        manifestPolicy: oldClient.getManifest()?.retention,
        quarantinedIds: quarantine?.entries.map((entry) => entry.id) ?? [],
        outboxSize: await oldLocal.outboxSize(),
        remoteChangeFileCount,
      };
    });

    expect(result.manifestPolicy?.maxOfflineDurationMs).toBe(24 * 60 * 60_000);
    expect(result.quarantinedIds).toHaveLength(1);
    expect(result.outboxSize).toBe(0);
    expect(result.remoteChangeFileCount).toBe(0);
  });

  test("direct compact cannot snapshot a write expired by a tightened policy", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const {
        BrowserTestInterocitor: Interocitor,
        MemoryLocalStore,
        readColumn,
      } = await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const adapter = new MemoryAdapter();
      const remotePath = "/TightenedCompactRetentionMesh";
      const oldLocal = new MemoryLocalStore();
      const oldClient = new Interocitor(adapter, {
        remotePath,
        dbName: "tightened-compact-old-client",
        localStore: oldLocal,
        keySource: null,
        deviceId: "dev_tightened_compact_old",
        batchWindowMs: 0,
        flushDebounce: 60_000,
        retention: {
          compactAfterMs: 7 * 24 * 60 * 60_000,
          maxOfflineDurationMs: 30 * 24 * 60 * 60_000,
        },
      });
      await oldClient.connect();
      await oldClient.disconnect();
      await oldLocal.setMeta(
        "lastSuccessfulSyncAt",
        new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString(),
      );
      await oldClient.put("tasks", "expired-snapshot-row", { title: "must not enter snapshot" });

      const policyWriter = new Interocitor(adapter, {
        remotePath,
        dbName: "tightened-compact-policy-writer",
        localStore: new MemoryLocalStore(),
        keySource: null,
        deviceId: "dev_tightened_compact_policy",
        batchWindowMs: 0,
        retention: {
          compactAfterMs: 7 * 24 * 60 * 60_000,
          maxOfflineDurationMs: 24 * 60 * 60_000,
        },
      });
      await policyWriter.connect();
      await policyWriter.compact();
      await policyWriter.disconnect();

      await oldClient.compact();
      const staleLocalRow = await oldClient.loadRow({
        table: "tasks",
        rowId: "expired-snapshot-row",
      });
      const quarantine = await oldClient.getQuarantinedOfflineChanges();
      const manifest = oldClient.getManifest();
      const snapshotWire = JSON.parse(adapter.dump()[manifest?.snapshotPath ?? ""] ?? "{}");
      const snapshotRow = snapshotWire.snapshot?.tables?.tasks?.["expired-snapshot-row"];
      return {
        epoch: manifest?.epoch,
        staleLocalTitle: staleLocalRow ? readColumn(staleLocalRow, "title") : null,
        snapshotContainsExpiredRow: snapshotRow !== undefined,
        quarantineCount: quarantine?.entries.length ?? 0,
      };
    });

    expect(result.epoch).toBe(1);
    expect(result.staleLocalTitle).toBeNull();
    expect(result.snapshotContainsExpiredRow).toBe(false);
    expect(result.quarantineCount).toBe(1);
  });

  test("empty flush and disconnect do not bootstrap remote state", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor, MemoryLocalStore } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const adapter = new MemoryAdapter();
      const engine = new Interocitor(adapter, {
        remotePath: "/EmptyFlushMesh",
        dbName: "empty-flush-db",
        localStore: new MemoryLocalStore(),
        keySource: null,
        deviceId: "dev_empty_flush",
      });
      await engine.init();
      await engine.flush();
      await engine.disconnect();
      return Object.keys(adapter.dump());
    });

    expect(result).toEqual([]);
  });

  test("finite retention compacts an old uploaded change even when churn auto-compaction is disabled", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor, MemoryLocalStore } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      class OldChangeAdapter extends MemoryAdapter {
        override async listFiles(path: string) {
          const files = await super.listFiles(path);
          return files.map((file) =>
            file.name.includes("-chg_")
              ? { ...file, modifiedTime: new Date(Date.now() - 10_000).toISOString() }
              : file,
          );
        }
      }

      const adapter = new OldChangeAdapter();
      const engine = new Interocitor(adapter, {
        remotePath: "/RetentionDeadlineMesh",
        dbName: "retention-deadline-db",
        localStore: new MemoryLocalStore(),
        keySource: null,
        deviceId: "dev_retention_deadline",
        serverId: "dev_retention_deadline",
        serverManaged: true,
        autoCompact: false,
        batchWindowMs: 0,
        retention: { compactAfterMs: 1_000, maxOfflineDurationMs: 30_000 },
      });

      let resolveCompacted!: () => void;
      const compacted = new Promise<void>((resolve) => {
        resolveCompacted = resolve;
      });
      engine.on((event) => {
        if (event.type === "compact:retention:complete") resolveCompacted();
      });
      await engine.connect();
      await engine.put("tasks", "old-change", { title: "fold me" });
      await engine.flush();
      await Promise.race([
        compacted,
        new Promise<void>((_, reject) => {
          setTimeout(() => reject(new Error("retention compaction timed out")), 5_000);
        }),
      ]);

      const changeFileCount = Object.keys(adapter.dump()).filter(
        (path) => path.includes("/changes/") && path.includes("-chg_"),
      ).length;
      return {
        changeFileCount,
        epoch: engine.getManifest()?.epoch,
        retention: engine.getManifest()?.retention,
      };
    });

    expect(result.changeFileCount).toBe(0);
    expect(result.epoch).toBe(1);
    expect(result.retention).toEqual({ compactAfterMs: 1_000, maxOfflineDurationMs: 30_000 });
  });

  test("retention cleanup failure backs off instead of publishing snapshots in a tight loop", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor, MemoryLocalStore } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      class DeleteFailingAdapter extends MemoryAdapter {
        override async listFiles(path: string) {
          const files = await super.listFiles(path);
          return files.map((file) =>
            file.name.includes("-chg_")
              ? { ...file, modifiedTime: new Date(Date.now() - 10_000).toISOString() }
              : file,
          );
        }

        override async deleteFile(path: string) {
          if (path.includes("/changes/") && path.includes("-chg_")) {
            throw new Error("simulated delete outage");
          }
          return super.deleteFile(path);
        }
      }

      const adapter = new DeleteFailingAdapter();
      const engine = new Interocitor(adapter, {
        remotePath: "/RetentionDeleteFailureMesh",
        dbName: "retention-delete-failure-db",
        localStore: new MemoryLocalStore(),
        keySource: null,
        deviceId: "dev_retention_delete_failure",
        serverId: "dev_retention_delete_failure",
        serverManaged: true,
        autoCompact: false,
        batchWindowMs: 0,
        retention: { compactAfterMs: 20, maxOfflineDurationMs: 30_000 },
      });

      let resolveCompacted!: () => void;
      const compacted = new Promise<void>((resolve) => {
        resolveCompacted = resolve;
      });
      engine.on((event) => {
        if (event.type === "compact:retention:complete") resolveCompacted();
      });
      await engine.connect();
      await engine.put("tasks", "undeletable-change", { title: "retry later" });
      await engine.flush();
      await Promise.race([
        compacted,
        new Promise<void>((_, reject) => {
          setTimeout(() => reject(new Error("retention compaction timed out")), 5_000);
        }),
      ]);
      await new Promise((resolve) => {
        setTimeout(resolve, 150);
      });

      const snapshotCount = Object.keys(adapter.dump()).filter((path) =>
        path.includes("/mainline/snapshot-"),
      ).length;
      const epoch = engine.getManifest()?.epoch;
      await engine.disconnect();
      return { snapshotCount, epoch };
    });

    expect(result.snapshotCount).toBe(1);
    expect(result.epoch).toBe(1);
  });

  test("explicit rehydrate publishes a completed local mutation before replacing state", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const {
        BrowserTestInterocitor: Interocitor,
        MemoryLocalStore,
        readColumn,
      } = await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const adapter = new MemoryAdapter();
      const local = new MemoryLocalStore();
      const engine = new Interocitor(adapter, {
        batchWindowMs: 0,
        dbName: "explicit-rehydrate-durable-db",
        deviceId: "dev_explicit_rehydrate",
        keySource: null,
        localStore: local,
        pollInterval: 600_000,
        remotePath: "/ExplicitRehydrateDurableMesh",
        serverId: "dev_explicit_rehydrate",
        serverManaged: true,
      });

      await engine.connect();
      await engine.put("tasks", "snapshot", { title: "snapshot row" });
      await engine.flush();
      await engine.compact();
      await engine.put("tasks", "pending", { title: "must publish first" });
      await engine.rehydrate();

      const snapshot = await engine.loadRow({ table: "tasks", rowId: "snapshot" });
      const pending = await engine.loadRow({ table: "tasks", rowId: "pending" });
      const changeFileCount = Object.keys(adapter.dump()).filter(
        (path) => path.includes("/changes/") && path.includes("-chg_"),
      ).length;
      return {
        snapshot: snapshot ? readColumn(snapshot, "title") : null,
        pending: pending ? readColumn(pending, "title") : null,
        outboxSize: await local.outboxSize(),
        changeFileCount,
      };
    });

    expect(result.snapshot).toBe("snapshot row");
    expect(result.pending).toBe("must publish first");
    expect(result.outboxSize).toBe(0);
    expect(result.changeFileCount).toBe(1);
  });

  test("put after delete starts a fresh local row incarnation", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor, MemoryLocalStore } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const local = new MemoryLocalStore();
      const engine = new Interocitor(new MemoryAdapter(), {
        remotePath: "/ReinsertMesh",
        dbName: "reinsert-mesh-db",
        localStore: local,
        keySource: null,
        pollInterval: 600_000,
        flushThreshold: 9999,
        flushDebounce: 60_000,
        autoCompact: false,
        batchWindowMs: 0,
      });

      await engine.init();
      await engine.connect();
      await engine.put("tasks", "r1", { title: "old", stale: "must-not-return" });
      await engine.delete("tasks", "r1");
      const rawTombstone = await local.getRow("tasks", "r1");
      const localAfterDelete = await engine.loadRow(
        { table: "tasks", rowId: "r1" },
        { bypassCache: true },
      );
      await engine.put("tasks", "r1", { title: "new" });
      const localAfterReinsert = await engine.loadRow(
        { table: "tasks", rowId: "r1" },
        { bypassCache: true },
      );
      const query = await engine.table("tasks").query().load({ bypassCache: true });
      await engine.disconnect();

      return {
        tombstoneDeleted: rawTombstone?._meta.deleted,
        tombstoneDeletedHlc: rawTombstone?._meta.deletedHlc,
        tombstonePayload: rawTombstone?.payload,
        afterDelete: localAfterDelete,
        afterReinsert: localAfterReinsert,
        query,
      };
    });

    expect(result.tombstoneDeleted).toBe(true);
    expect(result.tombstoneDeletedHlc).toBeTruthy();
    expect(result.tombstonePayload).toEqual({});
    expect(result.afterDelete).toBeUndefined();
    expect(result.afterReinsert).toEqual(
      expect.objectContaining({
        _meta: expect.objectContaining({ deleted: false }),
        payload: { title: expect.objectContaining({ value: "new" }) },
      }),
    );
    expect(result.query).toHaveLength(1);
    expect(result.query[0]).toEqual(expect.objectContaining({ title: "new" }));
    expect(result.query[0]).not.toHaveProperty("stale");
  });

  test("db.batch(): consecutive writes inside a batch produce one ChangeEntry", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const adapter = new MemoryAdapter();
      const engine = new Interocitor(adapter, {
        remotePath: "/BatchMesh",
        dbName: "batch-mesh-db",
        pollInterval: 600_000,
        flushThreshold: 9999,
        flushDebounce: 60_000,
        autoCompact: false,
        batchWindowMs: 0,
      });

      await engine.init();
      await engine.connect();

      const before = Object.keys(adapter.dump()).filter((p) =>
        /\/changes\/[^/]+-chg_[^/]+\.json$/.test(p),
      ).length;

      await engine.batch(async () => {
        await engine.put("tasks", "b1", { title: "one" });
        await engine.put("tasks", "b2", { title: "two" });
        await engine.put("tasks", "b3", { title: "three" });
        await engine.delete("tasks", "b1");
      });
      await engine.flush();

      const after = Object.keys(adapter.dump()).filter((p) =>
        /\/changes\/[^/]+-chg_[^/]+\.json$/.test(p),
      ).length;
      await engine.disconnect();
      return { added: after - before };
    });

    expect(result.added).toBe(1);
  });

  test("implicit batching: writes within batchWindowMs collapse into one ChangeEntry", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");

      const adapter = new MemoryAdapter();
      const engine = new Interocitor(adapter, {
        remotePath: "/ImplicitBatchMesh",
        dbName: "implicit-batch-mesh-db",
        pollInterval: 600_000,
        flushThreshold: 9999,
        flushDebounce: 60_000,
        autoCompact: false,
        batchWindowMs: 50, // small but non-zero
      });

      await engine.init();
      await engine.connect();
      const before = Object.keys(adapter.dump()).filter((p) =>
        /\/changes\/[^/]+-chg_[^/]+\.json$/.test(p),
      ).length;

      // Three rapid writes without any awaited gap should join one batch
      await engine.put("tasks", "i1", { title: "one" });
      await engine.put("tasks", "i2", { title: "two" });
      await engine.put("tasks", "i3", { title: "three" });
      await engine.flush(); // forces pending batch + outbox to remote
      const afterRapid = Object.keys(adapter.dump()).filter((p) =>
        /\/changes\/[^/]+-chg_[^/]+\.json$/.test(p),
      ).length;

      // Now do two writes with a long gap between them — they should be 2 entries
      await engine.put("tasks", "g1", { title: "g-one" });
      await engine.flush();
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
      await engine.put("tasks", "g2", { title: "g-two" });
      await engine.flush();
      const afterGapped = Object.keys(adapter.dump()).filter((p) =>
        /\/changes\/[^/]+-chg_[^/]+\.json$/.test(p),
      ).length;

      await engine.disconnect();
      return {
        rapidAdded: afterRapid - before,
        gappedAdded: afterGapped - afterRapid,
      };
    });

    expect(result.rapidAdded).toBe(1); // 3 rapid writes → 1 file
    expect(result.gappedAdded).toBe(2); // 2 gapped writes → 2 files
  });
});
