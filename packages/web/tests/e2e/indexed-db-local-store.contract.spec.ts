/* eslint-disable unicorn/consistent-function-scoping -- Browser-context helpers must be defined inside page.evaluate. */

import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/packages/web/tests/e2e/fixtures/harness.html");
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase("interocitor-web-contract");
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => resolve();
    });
  });
});

test("IndexedDbLocalStore satisfies the LocalStore contract and persists across reopen", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { IndexedDbLocalStore } = await import("/packages/web/dist/index.js");

    const row = (
      table: string,
      rowId: string,
      fields: Record<string, unknown>,
      deleted = false,
    ) => {
      const payload: Record<string, { value: unknown; hlc: string }> = {};
      let i = 0;
      for (const [key, value] of Object.entries(fields)) {
        payload[key] = { value, hlc: `2024-01-01T00:00:00.000Z-${i++}:dev` };
      }
      return {
        _meta: {
          table,
          rowId,
          deleted,
          schemaVersion: 1,
          ...(deleted ? { deletedHlc: "2024-01-01T00:00:00.000Z-9:dev" } : {}),
        },
        payload,
      };
    };

    const store = new IndexedDbLocalStore("interocitor-web-contract");
    await store.open();
    await store.putRows([
      row("tasks", "a", { title: "Alpha", status: "open", priority: 1 }),
      row("tasks", "b", { title: "Bravo", status: "done", priority: 2 }),
      row("tasks", "deleted", { title: "Removed", status: "open", priority: 3 }, true),
    ]);
    await store.pushOutbox({ id: "chg_1", ts: 1, device: "dev", hlc: "h1", ops: [] });
    await store.pushOutboxEntries([{ id: "chg_2", ts: 2, device: "dev", hlc: "h2", ops: [] }]);
    await store.setCursor("dev_a", 42);
    await store.setMeta("meshId", "mesh_1");

    const visibleRows = await store.getTable("tasks");
    const allRows = await store.getAllRows();
    const doneRows = await store.queryWhere("tasks", {
      field: "status",
      op: "equals",
      value: "done",
    });
    const outboxBeforeDrain = await store.outboxSize();
    const drained = await store.drainOutbox();
    store.close();

    const reopened = new IndexedDbLocalStore("interocitor-web-contract");
    await reopened.open();
    const persistedRows = await reopened.getAllRows();
    const persistedCursor = await reopened.getCursor("dev_a");
    const persistedMeta = await reopened.getMeta("meshId");
    await reopened.clearAll();
    const emptyRows = await reopened.getAllRows();
    const emptyCursors = await reopened.getAllCursors();
    const emptyMeta = await reopened.getMeta("meshId");
    reopened.close();

    return {
      visibleCount: visibleRows.length,
      allCount: allRows.length,
      doneIds: doneRows.map((r: any) => r._meta.rowId),
      outboxBeforeDrain,
      drainedIds: drained.map((entry: any) => entry.id),
      persistedCount: persistedRows.length,
      persistedCursor,
      persistedMeta,
      emptyRows,
      emptyCursors,
      emptyMeta,
    };
  });

  expect(result.visibleCount).toBe(2);
  expect(result.allCount).toBe(3);
  expect(result.doneIds).toEqual(["b"]);
  expect(result.outboxBeforeDrain).toBe(2);
  expect(result.drainedIds).toEqual(["chg_1", "chg_2"]);
  expect(result.persistedCount).toBe(3);
  expect(result.persistedCursor).toBe(42);
  expect(result.persistedMeta).toBe("mesh_1");
  expect(result.emptyRows).toEqual([]);
  expect(result.emptyCursors).toEqual({});
  expect(result.emptyMeta).toBeUndefined();
});

test("IndexedDbLocalStore atomically stages mutations and acknowledges only published IDs", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { IndexedDbLocalStore } = await import("/packages/web/dist/index.js");
    const dbName = "interocitor-web-contract";
    const row = {
      _meta: { table: "tasks", rowId: "durable", deleted: false, schemaVersion: 1 },
      payload: { title: { value: "never lost", hlc: "2024-01-01T00:00:00.000Z-0:dev" } },
    };
    const first = { id: "chg_1", ts: 1, device: "dev", hlc: "h1", ops: [] };
    const second = { id: "chg_2", ts: 2, device: "dev", hlc: "h2", ops: [] };

    const store = new IndexedDbLocalStore(dbName);
    await store.open();
    await store.commitLocalMutation(row, first);
    store.close();

    const reopened = new IndexedDbLocalStore(dbName);
    await reopened.open();
    const stagedRow = await reopened.getRow("tasks", "durable");
    const stagedBatch = await reopened.peekPendingBatch();
    await reopened.promotePendingBatch();
    const publicationCut = await reopened.peekOutbox();
    await reopened.pushOutbox(second);
    await reopened.acknowledgeOutbox(publicationCut.map((entry: any) => entry.id));
    await reopened.acknowledgeOutbox(publicationCut.map((entry: any) => entry.id));
    const remaining = await reopened.peekOutbox();
    reopened.close();

    return {
      stagedTitle: stagedRow?.payload.title.value,
      stagedBatchId: (stagedBatch as any)?.id,
      remainingIds: remaining.map((entry: any) => entry.id),
    };
  });

  expect(result.stagedTitle).toBe("never lost");
  expect(result.stagedBatchId).toBe("chg_1");
  expect(result.remainingIds).toEqual(["chg_2"]);
});
