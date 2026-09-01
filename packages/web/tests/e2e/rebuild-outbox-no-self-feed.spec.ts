/**
 * Regression: reload must not self-feed local state back into remote work.
 *
 * Contract under test:
 *   client makes a few changes, flushes, disconnects, then reloads
 *   with the same local DB and a fresh adapter instance. After minimal
 *   adapter auth, the reload should probe remote head and list immutable
 *   change filenames, while exact receipts suppress payload downloads:
 *     - no remote writes
 *     - no change-file reads
 *     - no outbox re-push from canonical local rows
 */
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/packages/web/tests/e2e/fixtures/harness.html");
  await page.evaluate(async () => {
    localStorage.clear();
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase("rebuild-outbox-no-self-feed");
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  });
});

test("reload after local writes reads head and performs no extra remote activity", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { Interocitor } = await import("/packages/core/dist/index.js");
    const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");
    const { IndexedDbLocalStore } =
      await import("/packages/web/dist/storage/indexed-db-local-store.js");

    const localCalls = {
      pushOutbox: 0,
      drainOutbox: 0,
      getAllRows: 0,
      outboxSize: 0,
    };

    class CountingLocalStore extends IndexedDbLocalStore {
      async pushOutbox(...args: unknown[]) {
        localCalls.pushOutbox++;
        // @ts-expect-error base class call-through for browser-side test wrapper
        return super.pushOutbox(...args);
      }
      async drainOutbox(...args: unknown[]) {
        localCalls.drainOutbox++;
        // @ts-expect-error base class call-through for browser-side test wrapper
        return super.drainOutbox(...args);
      }
      async getAllRows(...args: unknown[]) {
        localCalls.getAllRows++;
        // @ts-expect-error base class call-through for browser-side test wrapper
        return super.getAllRows(...args);
      }
      async outboxSize(...args: unknown[]) {
        localCalls.outboxSize++;
        // @ts-expect-error base class call-through for browser-side test wrapper
        return super.outboxSize(...args);
      }
    }

    const remoteCalls = {
      authenticate: 0,
      ensureFolder: 0,
      listFiles: 0,
      readFile: 0,
      writeFile: 0,
      deleteFile: 0,
      getFileMetadata: 0,
    };
    const readPaths: string[] = [];
    const writePaths: string[] = [];

    const createCountingRemote = (inner: InstanceType<typeof MemoryAdapter>) =>
      new Proxy(inner, {
        get(target, prop, receiver) {
          const original = Reflect.get(target, prop, receiver);
          if (typeof prop === "string" && prop in remoteCalls && typeof original === "function") {
            return (...args: unknown[]) => {
              remoteCalls[prop as keyof typeof remoteCalls]++;
              if (prop === "readFile") readPaths.push(args[0] as string);
              if (prop === "writeFile") writePaths.push(args[0] as string);
              return (original as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          return original;
        },
      });

    const seedRemoteFromDump = async (dump: Record<string, string>) => {
      const seeded = new MemoryAdapter();
      for (const [path, body] of Object.entries(dump)) {
        await seeded.writeFile(path, body);
      }
      return seeded;
    };

    const firstInner = new MemoryAdapter();
    const firstRemote = createCountingRemote(firstInner);

    const baseConfig = {
      remotePath: "/ReloadNoExtra",
      dbName: "rebuild-outbox-no-self-feed",
      pollInterval: 600_000,
      flushDebounce: 600_000,
      flushThreshold: 9999,
      deviceId: "dev_reload_no_extra",
      keySource: null,
      autoCompact: false,
      batchWindowMs: 0,
    } as const;

    // First session: write a few legitimate changes and flush them once.
    const first = new Interocitor(firstRemote as any, {
      ...baseConfig,
      localStore: new CountingLocalStore("rebuild-outbox-no-self-feed"),
    });
    await first.init();
    await first.connect();
    await first.put("tasks", "r1", { title: "one" });
    await first.put("tasks", "r2", { title: "two" });
    await first.put("tasks", "r3", { title: "three" });
    await first.flush();
    await first.disconnect();

    const firstDump = firstInner.dump();
    const changeFiles = Object.keys(firstDump)
      .filter((p) => /\/changes\/[^/]+-chg_[^/]+\.json$/.test(p))
      .toSorted();

    // Fresh adapter instance, same remote contents. This models client code
    // that reconstructs an adapter from handshake config/baseUrl on reload,
    // then calls setRemoteStorage(adapter) before db.connect().
    const reloadInner = await seedRemoteFromDump(firstDump);
    const reloadRemote = createCountingRemote(reloadInner);
    const beforeReloadRemote = { ...remoteCalls };
    const beforeReloadLocal = { ...localCalls };
    readPaths.length = 0;
    writePaths.length = 0;

    // Reload: new engine instance, same local DB, fresh unauthenticated adapter.
    const reload = new Interocitor(reloadRemote as any, {
      ...baseConfig,
      localStore: new CountingLocalStore("rebuild-outbox-no-self-feed"),
    });
    await reload.init();
    await reload.connect();
    const rowsAfterReload = await reload.query("tasks");
    const afterReloadRemote = { ...remoteCalls };
    const afterReloadLocal = { ...localCalls };
    await reload.disconnect();

    const remoteDelta = Object.fromEntries(
      Object.keys(remoteCalls).map((k) => [
        k,
        afterReloadRemote[k as keyof typeof remoteCalls] -
          beforeReloadRemote[k as keyof typeof remoteCalls],
      ]),
    ) as typeof remoteCalls;
    const localDelta = Object.fromEntries(
      Object.keys(localCalls).map((k) => [
        k,
        afterReloadLocal[k as keyof typeof localCalls] -
          beforeReloadLocal[k as keyof typeof localCalls],
      ]),
    ) as typeof localCalls;

    return {
      changeFiles,
      remoteDelta,
      localDelta,
      readPaths,
      writePaths,
      rowCount: rowsAfterReload.length,
      allFilesAfterReload: Object.keys(reloadInner.dump()).toSorted(),
    };
  });

  expect(result.changeFiles).toHaveLength(3);
  expect(result.rowCount).toBe(3);

  // The reload steady-state contract: fresh adapter auth, then one head read
  // proves no remote change.
  expect(result.readPaths).toEqual(["/ReloadNoExtra/changes/head.json"]);
  expect(result.remoteDelta.authenticate).toBe(1);
  expect(result.remoteDelta.readFile).toBe(1);

  // Pull still lists immutable filenames so exact receipts can prove every
  // retained file was already observed, but it does not download them.
  expect(result.remoteDelta.ensureFolder).toBe(0);
  expect(result.remoteDelta.listFiles).toBe(1);
  expect(result.remoteDelta.writeFile).toBe(0);
  expect(result.remoteDelta.deleteFile).toBe(0);
  expect(result.remoteDelta.getFileMetadata).toBe(0);
  expect(result.writePaths).toEqual([]);

  // Most importantly: no local rows were scanned and pushed back to outbox.
  expect(result.localDelta.pushOutbox).toBe(0);
  expect(result.localDelta.getAllRows).toBe(0);
});
