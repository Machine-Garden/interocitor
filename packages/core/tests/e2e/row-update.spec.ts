/**
 * Update semantics tests.
 *
 * Locks the contract added in the row-shape refactor:
 *  - patch overwrites only the listed fields, leaves others alone
 *  - replace nulls every payload field absent from `data`
 *  - replace never touches engine `_meta` (table/rowId/deleted/...)
 *  - replace tolerates user fields named `_table`, `_rowId`, `_meta`, etc.
 *  - HLC is monotonic across same-field rewrites
 *  - delete then put resurrects the row
 *  - outbox queues exactly one op per put/delete
 *  - row cache invalidates on patch and replace
 */
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/packages/core/tests/e2e/fixtures/harness.html");
});

test.describe("Table.patch — partial update", () => {
  test("patch overwrites only listed fields; absent fields untouched", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");
      const engine = new Interocitor(new MemoryAdapter(), {
        remotePath: "/U1",
        pollInterval: 600_000,
        deviceId: "dev_a",
      });
      await engine.init();
      await engine.connect();
      const tasks = engine.table("tasks");
      await tasks.patch("t1", { title: "A", status: "open", priority: 1 });
      await tasks.patch("t1", { title: "B" });
      const out = await tasks.row("t1");
      await engine.disconnect();
      return out as any;
    });
    expect(result.title).toBe("B");
    expect(result.status).toBe("open");
    expect(result.priority).toBe(1);
  });
});

test.describe("Table.replace — full overwrite", () => {
  test("nulls fields absent from data", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");
      const engine = new Interocitor(new MemoryAdapter(), {
        remotePath: "/U2",
        pollInterval: 600_000,
        deviceId: "dev_a",
      });
      await engine.init();
      await engine.connect();
      const tasks = engine.table("tasks");
      await tasks.patch("t1", { title: "A", status: "open", priority: 1 });
      // replace omits status and priority — both should null out.
      await tasks.replace("t1", { title: "B" } as any);
      const out = await tasks.row("t1");
      await engine.disconnect();
      return out as any;
    });
    expect(result.title).toBe("B");
    expect(result.status).toBeNull();
    expect(result.priority).toBeNull();
  });

  test("never touches engine _meta (table/rowId/deleted) — meta is a separate namespace", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");
      const engine = new Interocitor(new MemoryAdapter(), {
        remotePath: "/U3",
        pollInterval: 600_000,
        deviceId: "dev_a",
      });
      await engine.init();
      await engine.connect();
      const tasks = engine.table("tasks");
      await tasks.patch("t1", { title: "A" });
      await tasks.replace("t1", { title: "B" } as any);
      // Read raw row from local store via engine.loadRow; meta must still be intact.
      const raw: any = await (engine as any).loadRow({ table: "tasks", rowId: "t1" });
      await engine.disconnect();
      return {
        meta: raw?._meta,
        payloadKeys: raw ? Object.keys(raw.payload) : [],
      };
    });
    expect(result.meta).toMatchObject({
      table: "tasks",
      rowId: "t1",
      deleted: false,
      schemaVersion: 0,
    });
    // Payload contains the new title; previous fields nulled (still present, value=null).
    expect(result.payloadKeys.toSorted()).toEqual(["title"]);
  });

  test("tolerates user payload keys named _table, _rowId, _meta, payload — meta isolation", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");
      const engine = new Interocitor(new MemoryAdapter(), {
        remotePath: "/U4",
        pollInterval: 600_000,
        deviceId: "dev_a",
      });
      await engine.init();
      await engine.connect();
      const weeks = engine.table("weekPlans");
      // Reserved-looking application fields remain ordinary row data.
      await weeks.replace("w1", {
        _table: "oldname",
        _rowId: "w1",
        _meta: { foo: 1 },
        payload: { x: 1 },
        weekId: "w1",
        plan: { mon: ["x"] },
      } as any);
      const raw: any = await (engine as any).loadRow({ table: "weekPlans", rowId: "w1" });
      const typed = await weeks.row("w1");
      await engine.disconnect();
      return {
        // engine meta must be untouched and reflect the engine view, not user input
        engineTable: raw?._meta.table,
        engineRowId: raw?._meta.rowId,
        // user fields stored in payload
        payloadHasUnderscoreTable: "_table" in (raw?.payload ?? {}),
        payloadUnderscoreTableValue: raw?.payload?._table?.value,
        payloadHasUnderscoreRowId: "_rowId" in (raw?.payload ?? {}),
        payloadHasUnderscoreMeta: "_meta" in (raw?.payload ?? {}),
        payloadHasPayload: "payload" in (raw?.payload ?? {}),
        payloadWeekId: raw?.payload?.weekId?.value,
        // typed projection includes user-named fields verbatim
        typedKeys: Object.keys(typed ?? {}).toSorted(),
      };
    });
    expect(result.engineTable).toBe("weekPlans");
    expect(result.engineRowId).toBe("w1");
    expect(result.payloadHasUnderscoreTable).toBe(true);
    expect(result.payloadUnderscoreTableValue).toBe("oldname");
    expect(result.payloadHasUnderscoreRowId).toBe(true);
    expect(result.payloadHasUnderscoreMeta).toBe(true);
    expect(result.payloadHasPayload).toBe(true);
    expect(result.payloadWeekId).toBe("w1");
    // typed projection shape
    expect(result.typedKeys).toEqual(["_meta", "_rowId", "_table", "payload", "plan", "weekId"]);
  });
});

test.describe("HLC monotonicity", () => {
  test("rewriting same field bumps the column HLC strictly forward", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");
      const engine = new Interocitor(new MemoryAdapter(), {
        remotePath: "/U5",
        pollInterval: 600_000,
        deviceId: "dev_a",
      });
      await engine.init();
      await engine.connect();
      const tasks = engine.table("tasks");
      await tasks.patch("t1", { title: "a" });
      const r1: any = await (engine as any).loadRow({ table: "tasks", rowId: "t1" });
      const hlc1 = r1.payload.title.hlc;
      await tasks.patch("t1", { title: "b" });
      const r2: any = await (engine as any).loadRow({ table: "tasks", rowId: "t1" });
      const hlc2 = r2.payload.title.hlc;
      await tasks.patch("t1", { title: "c" });
      const r3: any = await (engine as any).loadRow({ table: "tasks", rowId: "t1" });
      const hlc3 = r3.payload.title.hlc;
      await engine.disconnect();
      return { hlc1, hlc2, hlc3 };
    });
    expect(result.hlc1 < result.hlc2).toBe(true);
    expect(result.hlc2 < result.hlc3).toBe(true);
  });
});

test.describe("Tombstone resurrection", () => {
  test("delete then put restores the row with deleted=false", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");
      const engine = new Interocitor(new MemoryAdapter(), {
        remotePath: "/U6",
        pollInterval: 600_000,
        deviceId: "dev_a",
      });
      await engine.init();
      await engine.connect();
      const tasks = engine.table("tasks");
      await tasks.patch("t1", { title: "A" });
      await tasks.delete("t1");
      const afterDelete: any = await (engine as any).loadRow({ table: "tasks", rowId: "t1" });
      await tasks.patch("t1", { title: "B" });
      const afterRevive: any = await (engine as any).loadRow({ table: "tasks", rowId: "t1" });
      await engine.disconnect();
      return {
        deletedAfterDelete: !afterDelete, // loadRow filters tombstones to undefined
        afterRevive: afterRevive
          ? { deleted: afterRevive._meta.deleted, title: afterRevive.payload.title.value }
          : null,
      };
    });
    expect(result.deletedAfterDelete).toBe(true);
    expect(result.afterRevive).toEqual({ deleted: false, title: "B" });
  });
});

test.describe("Outbox accounting", () => {
  test("one op per patch, one op per delete", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor, MemoryLocalStore } = await import("/packages/core/dist/index.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");
      // Fresh DB per test to isolate the outbox count.
      await new Promise<void>((res) => {
        const r = indexedDB.deleteDatabase("outbox-count");
        r.onsuccess = () => res();
        r.onerror = () => res();
        r.onblocked = () => res();
      });
      const local = new MemoryLocalStore();
      const engine = new Interocitor(new MemoryAdapter(), {
        remotePath: "/U7",
        pollInterval: 600_000,
        deviceId: "dev_a",
        keySource: null,
        localStore: local,
        batchWindowMs: 0,
      });
      await engine.init();
      await engine.connect();
      const tasks = engine.table("tasks");
      await tasks.patch("t1", { title: "A" });
      await tasks.patch("t1", { title: "B" });
      await tasks.delete("t1");
      const drained = await (local as any).drainOutbox();
      await engine.disconnect();
      return drained.length;
    });
    expect(result).toBe(3);
  });
});

test.describe("Row cache invalidation", () => {
  test("patch invalidates the row cache, replace too", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { BrowserTestInterocitor: Interocitor } =
        await import("/packages/core/tests/e2e/fixtures/core-browser-api.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");
      const engine = new Interocitor(new MemoryAdapter(), {
        remotePath: "/U8",
        pollInterval: 600_000,
        deviceId: "dev_a",
      });
      await engine.init();
      await engine.connect();
      const tasks = engine.table("tasks");
      await tasks.patch("t1", { title: "A" });
      const handle = tasks.row("t1");
      const v1 = await handle;
      await tasks.patch("t1", { title: "B" });
      const v2 = await handle;
      await tasks.replace("t1", { title: "C" } as any);
      const v3 = await handle;
      await engine.disconnect();
      return { v1: (v1 as any)?.title, v2: (v2 as any)?.title, v3: (v3 as any)?.title };
    });
    expect(result.v1).toBe("A");
    expect(result.v2).toBe("B");
    expect(result.v3).toBe("C");
  });
});
