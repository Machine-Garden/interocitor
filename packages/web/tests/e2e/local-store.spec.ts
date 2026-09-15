import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/packages/web/tests/e2e/fixtures/harness.html");
  await page.evaluate(async () => {
    // Delete the database before each test to ensure clean state
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase("interocitor");
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => resolve(); // best effort
    });
  });
});

test("a real cross-page upgrade blocker may drain within the WebKit grace", async ({
  context,
  page,
}) => {
  const dbName = `interocitor-blocked-release-${crypto.randomUUID()}`;
  const challenger = await context.newPage();
  await challenger.goto("/packages/web/tests/e2e/fixtures/harness.html");
  try {
    await page.evaluate(async (name) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name, 1);
        request.onupgradeneeded = () => request.result.createObjectStore("legacy");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      (window as typeof window & { blocker?: IDBDatabase }).blocker = db;
    }, dbName);

    const opening = challenger.evaluate(async (name) => {
      const { IndexedDbLocalStore } = await import("/packages/web/dist/index.js");
      const started = performance.now();
      const store = new IndexedDbLocalStore(name);
      await store.open();
      const result = { elapsed: performance.now() - started, version: (store as any).db.version };
      store.close();
      return result;
    }, dbName);
    await page.waitForTimeout(150);
    await page.evaluate(() => {
      (window as typeof window & { blocker?: IDBDatabase }).blocker?.close();
    });
    const result = await opening;
    expect(result.version).toBe(2);
    expect(result.elapsed).toBeLessThan(1_000);
  } finally {
    await challenger.close();
  }
});

test("a persistent cross-page upgrade blocker rejects after a bounded grace", async ({
  context,
  page,
}) => {
  const dbName = `interocitor-blocked-timeout-${crypto.randomUUID()}`;
  const challenger = await context.newPage();
  await challenger.goto("/packages/web/tests/e2e/fixtures/harness.html");
  try {
    await page.evaluate(async (name) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name, 1);
        request.onupgradeneeded = () => request.result.createObjectStore("legacy");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      (window as typeof window & { blocker?: IDBDatabase }).blocker = db;
    }, dbName);
    const result = await challenger.evaluate(async (name) => {
      const { IndexedDbLocalStore } = await import("/packages/web/dist/index.js");
      const started = performance.now();
      try {
        await new IndexedDbLocalStore(name).open();
        return { elapsed: performance.now() - started, message: "" };
      } catch (error) {
        return {
          elapsed: performance.now() - started,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }, dbName);
    expect(result.elapsed).toBeGreaterThanOrEqual(900);
    expect(result.elapsed).toBeLessThan(2_000);
    expect(result.message).toContain("request cannot be cancelled and may still finish later");
  } finally {
    await page.evaluate(() => {
      (window as typeof window & { blocker?: IDBDatabase }).blocker?.close();
    });
    await challenger.close();
  }
});

test("a timed-out resilient open cannot later retain a ghost IndexedDB connection", async ({
  context,
  page,
}) => {
  const dbName = `interocitor-abandoned-open-${crypto.randomUUID()}`;
  const challenger = await context.newPage();
  await challenger.goto("/packages/web/tests/e2e/fixtures/harness.html");
  try {
    await page.evaluate(async (name) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name, 1);
        request.onupgradeneeded = () => request.result.createObjectStore("legacy");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      (window as typeof window & { blocker?: IDBDatabase }).blocker = db;
    }, dbName);

    const fallback = await challenger.evaluate(async (name) => {
      const { IndexedDbLocalStore, createResilientLocalStore } =
        await import("/packages/web/dist/index.js");
      const primary = new IndexedDbLocalStore(name);
      const store = createResilientLocalStore({
        dbName: name,
        openTimeoutMs: 50,
        primaryFactory: () => primary,
      });
      const originalError = console.error;
      console.error = () => {};
      try {
        await store.open();
      } finally {
        console.error = originalError;
      }
      Object.assign(window, {
        abandonedPrimary: primary,
        resilientFallback: store,
      });
      return { degraded: (store as any).__degraded === true };
    }, dbName);
    expect(fallback.degraded).toBe(true);

    // Release after the resilient deadline but before openDB's own blocked
    // grace expires. The uncancellable request will now succeed late.
    await page.waitForTimeout(100);
    await page.evaluate(() => {
      (window as typeof window & { blocker?: IDBDatabase }).blocker?.close();
    });
    await challenger.waitForTimeout(250);

    const result = await challenger.evaluate(async (name) => {
      const abandoned = (
        window as typeof window & {
          abandonedPrimary: { db?: IDBDatabase | null };
          resilientFallback: { close(): void };
        }
      ).abandonedPrimary;
      const retainedGhost = Boolean(abandoned.db);

      // A higher-version open must not wait for a discarded store to process
      // versionchange. This models a page becoming suspended after fallback.
      const upgraded = await new Promise<number>((resolve, reject) => {
        const request = indexedDB.open(name, 3);
        request.onupgradeneeded = () => {};
        request.onsuccess = () => {
          const version = request.result.version;
          request.result.close();
          resolve(version);
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error("late ghost blocked the replacement upgrade"));
      });
      (
        window as typeof window & { resilientFallback: { close(): void } }
      ).resilientFallback.close();
      return { retainedGhost, upgraded };
    }, dbName);

    expect(result).toEqual({ retainedGhost: false, upgraded: 3 });
  } finally {
    await page.evaluate(() => {
      (window as typeof window & { blocker?: IDBDatabase }).blocker?.close();
    });
    await challenger.close();
  }
});

// ─── Basic row CRUD ──────────────────────────────────────────────────

test.describe("IndexedDbLocalStore — row operations", () => {
  test("putRow + getRow round-trip", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { IndexedDbLocalStore } = await import("/packages/web/dist/index.js");
      const store = new IndexedDbLocalStore();
      await store.open();

      const row = {
        _meta: { table: "tasks", rowId: "t1", deleted: false, schemaVersion: 1 },
        payload: { title: { value: "Test", hlc: "000001000000000000-0000-dev_a" } },
      };
      await store.putRow(row);
      const retrieved = await store.getRow("tasks", "t1");

      store.close();
      return retrieved;
    });

    expect(result).toBeTruthy();
    expect(result._meta.table).toBe("tasks");
    expect(result._meta.rowId).toBe("t1");
    expect(result.payload.title.value).toBe("Test");
  });

  test("getRow returns undefined for missing row", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { IndexedDbLocalStore } = await import("/packages/web/dist/index.js");
      const store = new IndexedDbLocalStore();
      await store.open();
      const row = await store.getRow("nope", "nope");
      store.close();
      return row;
    });

    expect(result).toBeUndefined();
  });

  test("putRows writes multiple rows atomically", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { IndexedDbLocalStore } = await import("/packages/web/dist/index.js");
      const store = new IndexedDbLocalStore();
      await store.open();

      await store.putRows([
        { _meta: { table: "t", rowId: "r1", deleted: false, schemaVersion: 1 }, payload: {} },
        { _meta: { table: "t", rowId: "r2", deleted: false, schemaVersion: 1 }, payload: {} },
        { _meta: { table: "t", rowId: "r3", deleted: false, schemaVersion: 1 }, payload: {} },
      ]);
      const all = await store.getAllRows();
      store.close();
      return all.length;
    });

    expect(result).toBe(3);
  });

  test("getTable returns only rows for that table (excluding deleted)", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { IndexedDbLocalStore } = await import("/packages/web/dist/index.js");
      const store = new IndexedDbLocalStore();
      await store.open();

      await store.putRows([
        { _meta: { table: "meals", rowId: "m1", deleted: false, schemaVersion: 1 }, payload: {} },
        { _meta: { table: "meals", rowId: "m2", deleted: true, schemaVersion: 1 }, payload: {} },
        { _meta: { table: "tasks", rowId: "t1", deleted: false, schemaVersion: 1 }, payload: {} },
      ]);

      const meals = await store.getTable("meals");
      const tasks = await store.getTable("tasks");
      store.close();
      return { meals: meals.length, tasks: tasks.length };
    });

    expect(result.meals).toBe(1); // m2 is deleted, excluded
    expect(result.tasks).toBe(1);
  });

  test("clearRows removes all rows but keeps other stores", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { IndexedDbLocalStore } = await import("/packages/web/dist/index.js");
      const store = new IndexedDbLocalStore();
      await store.open();

      await store.putRow({
        _meta: { table: "t", rowId: "r1", deleted: false, schemaVersion: 1 },
        payload: {},
      });
      await store.setMeta("key", "value");
      await store.clearRows();

      const rows = await store.getAllRows();
      const meta = await store.getMeta("key");
      store.close();
      return { rowCount: rows.length, metaPreserved: meta === "value" };
    });

    expect(result.rowCount).toBe(0);
    expect(result.metaPreserved).toBe(true);
  });

  test("queryWhere uses schema indexes for equality/range lookups", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { IndexedDbLocalStore } = await import("/packages/web/dist/index.js");
      const store = new IndexedDbLocalStore("interocitor-indexed", undefined, {
        version: 1,
        tables: {
          tasks: {
            fields: {
              status: { type: { kind: "string" }, index: true },
              priority: { type: { kind: "number" }, index: true },
            },
          },
        },
      });
      await store.open();

      await store.putRows([
        {
          _meta: { table: "tasks", rowId: "t1", deleted: false, schemaVersion: 1 },
          payload: { status: { value: "open", hlc: "0" }, priority: { value: 1, hlc: "0" } },
        },
        {
          _meta: { table: "tasks", rowId: "t2", deleted: false, schemaVersion: 1 },
          payload: { status: { value: "done", hlc: "0" }, priority: { value: 3, hlc: "0" } },
        },
        {
          _meta: { table: "tasks", rowId: "t3", deleted: false, schemaVersion: 1 },
          payload: { status: { value: "open", hlc: "0" }, priority: { value: 2, hlc: "0" } },
        },
      ] as any);

      const open = await store.queryWhere("tasks", {
        field: "status",
        op: "equals",
        value: "open",
      } as any);
      const range = await store.queryWhere("tasks", {
        field: "priority",
        op: "between",
        lower: 2,
        upper: 3,
      } as any);

      store.close();
      return {
        open: open.map((r) => r._meta.rowId).toSorted(),
        range: range.map((r) => r._meta.rowId).toSorted(),
      };
    });

    expect(result.open).toEqual(["t1", "t3"]);
    expect(result.range).toEqual(["t2", "t3"]);
  });

  test("queryWhere falls back to table scan when field is not indexed", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { IndexedDbLocalStore } = await import("/packages/web/dist/index.js");
      const store = new IndexedDbLocalStore("interocitor-scan", undefined, {
        version: 1,
        tables: {
          tasks: {
            fields: {
              status: { type: { kind: "string" }, index: true },
            },
          },
        },
      });
      await store.open();

      await store.putRows([
        {
          _meta: { table: "tasks", rowId: "t1", deleted: false, schemaVersion: 1 },
          payload: { title: { value: "alpha", hlc: "0" } },
        },
        {
          _meta: { table: "tasks", rowId: "t2", deleted: false, schemaVersion: 1 },
          payload: { title: { value: "bravo", hlc: "0" } },
        },
      ] as any);

      const startsWithA = await store.queryWhere("tasks", {
        field: "title",
        op: "startsWith",
        value: "a",
      } as any);

      store.close();
      return startsWithA.map((r) => r._meta.rowId);
    });

    expect(result).toEqual(["t1"]);
  });

  test("the explicit indexes array configures local queries", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { IndexedDbLocalStore } = await import("/packages/web/dist/index.js");
      const store = new IndexedDbLocalStore("interocitor-explicit-indexes", undefined, {
        version: 1,
        tables: {
          tasks: {
            indexes: [{ name: "by_status", field: "status" }],
          },
        },
      });
      await store.open();

      await store.putRows([
        {
          _meta: { table: "tasks", rowId: "t1", deleted: false, schemaVersion: 1 },
          payload: { status: { value: "open", hlc: "0" } },
        },
        {
          _meta: { table: "tasks", rowId: "t2", deleted: false, schemaVersion: 1 },
          payload: { status: { value: "done", hlc: "0" } },
        },
      ] as any);

      const open = await store.queryWhere("tasks", {
        field: "status",
        op: "equals",
        value: "open",
      } as any);
      store.close();
      return open.map((row) => row._meta.rowId);
    });

    expect(result).toEqual(["t1"]);
  });

  test("creates a fresh current database without a repair-version reopen", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { IndexedDbLocalStore } = await import("/packages/web/dist/index.js");
      const dbName = "interocitor-fresh-current-version";
      await new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase(dbName);
        request.onsuccess = request.onerror = request.onblocked = () => resolve();
      });

      const store = new IndexedDbLocalStore(dbName, undefined, {
        tables: {
          tasks: {
            fields: {
              status: { type: { kind: "string" }, index: true },
            },
          },
        },
      });
      await store.open();
      const version = (store as any).db?.version ?? null;
      const fingerprint = await store.getMeta("interocitor:cache:fingerprint");
      store.close();
      return { version, fingerprint };
    });

    expect(result.version).toBe(2);
    expect(typeof result.fingerprint).toBe("string");
  });

  test("repairs a missing fingerprint in place when indexes are already correct", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const { IndexedDbLocalStore } = await import("/packages/web/dist/index.js");
      const dbName = "interocitor-missing-fingerprint";
      const schema = {
        tables: {
          tasks: {
            fields: {
              status: { type: { kind: "string" }, index: true },
            },
          },
        },
      } as any;
      const initial = new IndexedDbLocalStore(dbName, undefined, schema);
      await initial.open();
      initial.close();

      const raw = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(dbName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const transaction = raw.transaction("meta", "readwrite");
        transaction.objectStore("meta").delete("interocitor:cache:fingerprint");
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      raw.close();

      const reopened = new IndexedDbLocalStore(dbName, undefined, schema);
      await reopened.open();
      const version = (reopened as any).db?.version ?? null;
      const fingerprint = await reopened.getMeta("interocitor:cache:fingerprint");
      reopened.close();
      return { version, fingerprint };
    });

    expect(result.version).toBe(2);
    expect(typeof result.fingerprint).toBe("string");
  });

  test("auto-repairs schema indexes when schema changes without version bump", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { IndexedDbLocalStore } = await import("/packages/web/dist/index.js");
      const dbName = "interocitor-auto-repair";

      const initial = new IndexedDbLocalStore(dbName, undefined, {
        tables: {
          tasks: {
            fields: {
              title: { type: { kind: "string" } },
            },
          },
        },
      });
      await initial.open();
      await initial.putRows([
        {
          _meta: { table: "tasks", rowId: "t1", deleted: false, schemaVersion: 1 },
          payload: { status: { value: "open", hlc: "0" }, title: { value: "alpha", hlc: "0" } },
        },
        {
          _meta: { table: "tasks", rowId: "t2", deleted: false, schemaVersion: 1 },
          payload: { status: { value: "done", hlc: "0" }, title: { value: "bravo", hlc: "0" } },
        },
      ] as any);
      initial.close();

      const upgraded = new IndexedDbLocalStore(dbName, undefined, {
        tables: {
          tasks: {
            fields: {
              title: { type: { kind: "string" } },
              status: { type: { kind: "string" }, index: true },
            },
          },
        },
      });
      await upgraded.open();
      const open = await upgraded.queryWhere("tasks", {
        field: "status",
        op: "equals",
        value: "open",
      } as any);
      const idbVersion = (upgraded as any).db?.version ?? null;
      const fingerprint = await upgraded.getMeta("interocitor:cache:fingerprint");
      upgraded.close();

      return {
        rows: open.map((row) => row._meta.rowId),
        idbVersion,
        fingerprint,
      };
    });

    expect(result.rows).toEqual(["t1"]);
    expect(result.idbVersion).toBeGreaterThan(1);
    expect(typeof result.fingerprint).toBe("string");
  });

  test("auto-repairs multiple schema indexes in a single reopen", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { IndexedDbLocalStore } = await import("/packages/web/dist/index.js");
      const dbName = "interocitor-auto-repair-multi";

      const initial = new IndexedDbLocalStore(dbName, undefined, {
        tables: {
          tasks: {
            fields: {
              title: { type: { kind: "string" } },
            },
          },
        },
      });
      await initial.open();
      await initial.putRows([
        {
          _meta: { table: "tasks", rowId: "t1", deleted: false, schemaVersion: 1 },
          payload: {
            status: { value: "open", hlc: "0" },
            priority: { value: 1, hlc: "0" },
            title: { value: "alpha", hlc: "0" },
          },
        },
        {
          _meta: { table: "tasks", rowId: "t2", deleted: false, schemaVersion: 1 },
          payload: {
            status: { value: "done", hlc: "0" },
            priority: { value: 3, hlc: "0" },
            title: { value: "bravo", hlc: "0" },
          },
        },
        {
          _meta: { table: "tasks", rowId: "t3", deleted: false, schemaVersion: 1 },
          payload: {
            status: { value: "open", hlc: "0" },
            priority: { value: 2, hlc: "0" },
            title: { value: "gamma", hlc: "0" },
          },
        },
      ] as any);
      initial.close();

      const upgraded = new IndexedDbLocalStore(dbName, undefined, {
        tables: {
          tasks: {
            fields: {
              title: { type: { kind: "string" } },
              status: { type: { kind: "string" }, index: true },
              priority: { type: { kind: "number" }, index: true },
            },
          },
        },
      });
      await upgraded.open();
      const open = await upgraded.queryWhere("tasks", {
        field: "status",
        op: "equals",
        value: "open",
      } as any);
      const range = await upgraded.queryWhere("tasks", {
        field: "priority",
        op: "aboveOrEqual",
        value: 2,
      } as any);
      const idbVersion = (upgraded as any).db?.version ?? null;
      upgraded.close();

      return {
        open: open.map((row) => row._meta.rowId).toSorted(),
        range: range.map((row) => row._meta.rowId).toSorted(),
        idbVersion,
      };
    });

    expect(result.open).toEqual(["t1", "t3"]);
    expect(result.range).toEqual(["t2", "t3"]);
    expect(result.idbVersion).toBeGreaterThan(1);
  });

  test("recreates a same-name index when its key path is wrong", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { IndexedDbLocalStore } = await import("/packages/web/dist/index.js");
      const dbName = `interocitor-wrong-index-shape-${crypto.randomUUID()}`;
      const schema = {
        tables: {
          tasks: {
            fields: { status: { type: { kind: "string" }, index: true } },
          },
        },
      } as any;
      const initial = new IndexedDbLocalStore(dbName, undefined, schema);
      await initial.open();
      const currentVersion = (initial as any).db.version as number;
      initial.close();

      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(dbName, currentVersion + 1);
        request.onupgradeneeded = () => {
          const rows = request.transaction!.objectStore("rows");
          rows.deleteIndex("idx:tasks:by_status");
          rows.createIndex("idx:tasks:by_status", ["_meta.table", "payload.title.value"]);
        };
        request.onsuccess = () => {
          request.result.close();
          resolve();
        };
        request.onerror = () => reject(request.error);
      });

      const repaired = new IndexedDbLocalStore(dbName, undefined, schema);
      await repaired.open();
      const rows = (repaired as any).db.transaction("rows", "readonly").objectStore("rows");
      const index = rows.index("idx:tasks:by_status");
      const keyPath = Array.isArray(index.keyPath) ? index.keyPath : [index.keyPath];
      const version = (repaired as any).db.version;
      repaired.close();
      return { keyPath, version, damagedVersion: currentVersion + 1 };
    });

    expect(result.keyPath).toEqual(["_meta.table", "payload.status.value"]);
    expect(result.version).toBeGreaterThan(result.damagedVersion);
  });

  test("repairs a missing physical index before querying", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { IndexedDbLocalStore } = await import("/packages/web/dist/index.js");
      const dbName = "interocitor-missing-index-fallback";

      const initial = new IndexedDbLocalStore(dbName, undefined, {
        tables: {
          tasks: {
            fields: {
              title: { type: { kind: "string" } },
            },
          },
        },
      });
      await initial.open();
      await initial.putRows([
        {
          _meta: { table: "tasks", rowId: "t1", deleted: false, schemaVersion: 1 },
          payload: { status: { value: "open", hlc: "0" }, title: { value: "alpha", hlc: "0" } },
        },
        {
          _meta: { table: "tasks", rowId: "t2", deleted: false, schemaVersion: 1 },
          payload: { status: { value: "done", hlc: "0" }, title: { value: "bravo", hlc: "0" } },
        },
      ] as any);
      initial.close();

      const upgraded = new IndexedDbLocalStore(dbName, undefined, {
        tables: {
          tasks: {
            fields: {
              title: { type: { kind: "string" } },
              status: { type: { kind: "string" }, index: true },
            },
          },
        },
      });
      await upgraded.open();

      const damagedVersion = (upgraded as any).db.version + 1;
      upgraded.close();
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(dbName, damagedVersion);
        request.onupgradeneeded = () => {
          request.transaction!.objectStore("rows").deleteIndex("idx:tasks:by_status");
        };
        request.onsuccess = () => {
          request.result.close();
          resolve();
        };
        request.onerror = () => reject(request.error);
      });

      const repaired = new IndexedDbLocalStore(dbName, undefined, {
        tables: {
          tasks: {
            fields: {
              title: { type: { kind: "string" } },
              status: { type: { kind: "string" }, index: true },
            },
          },
        },
      });
      await repaired.open();
      try {
        const open = await repaired.queryWhere("tasks", {
          field: "status",
          op: "equals",
          value: "open",
        } as any);
        const repairedVersion = (repaired as any).db.version;
        repaired.close();
        return {
          rows: open.map((row) => row._meta.rowId),
          threw: false,
          repairedVersion,
          damagedVersion,
        };
      } catch (error) {
        repaired.close();
        return {
          rows: [],
          threw: true,
          message: String((error as Error)?.message ?? error),
        };
      }
    });

    expect(result.threw).toBe(false);
    expect(result.rows).toEqual(["t1"]);
    expect(result.repairedVersion).toBeGreaterThan(result.damagedVersion);
  });
});

// ─── Outbox ──────────────────────────────────────────────────────────

test.describe("IndexedDbLocalStore — outbox", () => {
  test("pushOutbox + drainOutbox FIFO semantics", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { IndexedDbLocalStore } = await import("/packages/web/dist/index.js");
      const store = new IndexedDbLocalStore();
      await store.open();

      await store.pushOutbox({ id: "a", ts: 1, device: "d", hlc: "0", ops: [] } as any);
      await store.pushOutbox({ id: "b", ts: 2, device: "d", hlc: "0", ops: [] } as any);

      const sizeBefore = await store.outboxSize();
      const drained = await store.drainOutbox();
      const sizeAfter = await store.outboxSize();

      store.close();
      return {
        sizeBefore,
        sizeAfter,
        ids: drained.map((e) => e.id),
      };
    });

    expect(result.sizeBefore).toBe(2);
    expect(result.sizeAfter).toBe(0); // drain clears outbox
    expect(result.ids).toEqual(["a", "b"]);
  });

  test("drainOutbox returns empty array when outbox is empty", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { IndexedDbLocalStore } = await import("/packages/web/dist/index.js");
      const store = new IndexedDbLocalStore();
      await store.open();
      const drained = await store.drainOutbox();
      store.close();
      return drained;
    });

    expect(result).toEqual([]);
  });
});

// ─── Cursors ─────────────────────────────────────────────────────────

test.describe("IndexedDbLocalStore — cursors", () => {
  test("getCursor returns 0 for unknown device", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { IndexedDbLocalStore } = await import("/packages/web/dist/index.js");
      const store = new IndexedDbLocalStore();
      await store.open();
      const cursor = await store.getCursor("dev_unknown");
      store.close();
      return cursor;
    });

    expect(result).toBe(0);
  });

  test("setCursor + getCursor round-trip", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { IndexedDbLocalStore } = await import("/packages/web/dist/index.js");
      const store = new IndexedDbLocalStore();
      await store.open();
      await store.setCursor("dev_a", 42);
      await store.setCursor("dev_b", 99);
      const a = await store.getCursor("dev_a");
      const b = await store.getCursor("dev_b");
      store.close();
      return { a, b };
    });

    expect(result.a).toBe(42);
    expect(result.b).toBe(99);
  });

  test("getAllCursors returns full map", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { IndexedDbLocalStore } = await import("/packages/web/dist/index.js");
      const store = new IndexedDbLocalStore();
      await store.open();
      await store.setCursor("dev_a", 10);
      await store.setCursor("dev_b", 20);
      const all = await store.getAllCursors();
      store.close();
      return all;
    });

    expect(result).toEqual({ dev_a: 10, dev_b: 20 });
  });
});

// ─── Meta ────────────────────────────────────────────────────────────

test.describe("IndexedDbLocalStore — meta", () => {
  test("setMeta + getMeta round-trip for various types", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { IndexedDbLocalStore } = await import("/packages/web/dist/index.js");
      const store = new IndexedDbLocalStore();
      await store.open();

      await store.setMeta("string", "hello");
      await store.setMeta("number", 42);
      await store.setMeta("object", { a: 1 });

      const s = await store.getMeta("string");
      const n = await store.getMeta("number");
      const o = await store.getMeta("object");
      const missing = await store.getMeta("nope");

      store.close();
      return { s, n, o, missing };
    });

    expect(result.s).toBe("hello");
    expect(result.n).toBe(42);
    expect(result.o).toEqual({ a: 1 });
    expect(result.missing).toBeUndefined();
  });
});

// ─── clearAll ────────────────────────────────────────────────────────

test.describe("IndexedDbLocalStore — clearAll", () => {
  test("nukes every object store", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { IndexedDbLocalStore } = await import("/packages/web/dist/index.js");
      const store = new IndexedDbLocalStore();
      await store.open();

      await store.putRow({
        _meta: { table: "t", rowId: "r", deleted: false, schemaVersion: 1 },
        payload: {},
      });
      await store.pushOutbox({ id: "x", ts: 0, device: "d", hlc: "0", ops: [] } as any);
      await store.setCursor("dev_a", 5);
      await store.setMeta("k", "v");

      await store.clearAll();

      const rows = await store.getAllRows();
      const outbox = await store.drainOutbox();
      const cursor = await store.getCursor("dev_a");
      const meta = await store.getMeta("k");

      store.close();
      return { rows: rows.length, outbox: outbox.length, cursor, meta };
    });

    expect(result.rows).toBe(0);
    expect(result.outbox).toBe(0);
    expect(result.cursor).toBe(0);
    expect(result.meta).toBeUndefined();
  });

  test("resetLocalDatabase deletes a named IndexedDB database", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { IndexedDbLocalStore, resetLocalDatabase } =
        await import("/packages/web/dist/index.js");
      const dbName = `interocitor-reset-test-${crypto.randomUUID()}`;
      const store = new IndexedDbLocalStore(dbName);
      await store.open();
      try {
        await store.putRow({
          _meta: { table: "t", rowId: "r", deleted: false, schemaVersion: 1 },
          payload: {},
        });
      } finally {
        store.close();
      }

      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
      await resetLocalDatabase(dbName);

      const reopened = new IndexedDbLocalStore(dbName);
      await reopened.open();
      const rows = await reopened.getAllRows();
      reopened.close();
      await resetLocalDatabase(dbName);
      return rows.length;
    });

    expect(result).toBe(0);
  });

  test("operations fail deterministically when the database connection is closing", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const { IndexedDbLocalStore } = await import("/packages/web/dist/index.js");
      const dbName = `interocitor-closing-test-${crypto.randomUUID()}`;
      const store = new IndexedDbLocalStore(dbName);
      await store.open();
      await store.putRow({
        _meta: { table: "t", rowId: "seed", deleted: false, schemaVersion: 1 },
        payload: {},
      });

      const db = (store as any).db as IDBDatabase;
      const tx = db.transaction("rows", "readonly");
      const req = tx.objectStore("rows").get("t\u0000seed");
      db.close();
      let requestOutcome = "pending";
      await new Promise<void>((resolve) => {
        req.onsuccess = () => {
          requestOutcome = "success";
          resolve();
        };
        req.onerror = () => {
          requestOutcome = String(req.error?.message ?? req.error ?? "error");
          resolve();
        };
      });

      let thrownMessage = "";
      try {
        await store.getAllRows();
      } catch (error) {
        thrownMessage = error instanceof Error ? error.message : String(error);
      }

      return { requestOutcome, thrownMessage };
    });

    expect(result.thrownMessage).toContain("closing");
  });
});
