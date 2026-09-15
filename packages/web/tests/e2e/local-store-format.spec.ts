import { expect, test } from "@playwright/test";

// The store-format seam.
//
// Two things are proved here, and both are about existing installs in the
// field, which hold plaintext IndexedDB databases written before any of this
// machinery existed:
//
// 1. A format transition works end to end. A synthetic "v_next" format
//    migrates legacy plaintext data into a *fresh physical generation*,
//    carrying rows, tombstones, outbox, the open pending batch, cursors and
//    meta, and leaving the source database untouched.
// 2. Every way the decision procedure can fail is a typed error and a
//    no-op — never an unhandled exception, never a silent deletion.

const FORMAT_MODULE = "/packages/web/dist/storage/named-local-store.js";

test.beforeEach(async ({ page }) => {
  await page.goto("/packages/web/tests/e2e/fixtures/harness.html");
});

test.describe("store format seam", () => {
  test("stamps an unstamped legacy database as legacy without touching its data", async ({
    page,
  }) => {
    const baseName = `FormatStamp-${crypto.randomUUID()}`;
    const result = await page.evaluate(async (name) => {
      const { IndexedDbLocalStore } = await import(
        "/packages/web/dist/storage/indexed-db-local-store.js"
      );
      const { createNamedLocalStore, LEGACY_PLAINTEXT_ROWS_FORMAT, STORE_FORMAT_META_KEY } =
        await import("/packages/web/dist/storage/named-local-store.js");

      // A database exactly as an install in the field has it: rows, no format
      // stamp, nothing that knows the seam exists.
      const legacy = new IndexedDbLocalStore(name);
      await legacy.open();
      await legacy.putRow({
        _meta: { table: "tasks", rowId: "a", deleted: false, schemaVersion: 1 },
        payload: { title: { value: "Alpha", hlc: "h1" } },
      } as any);
      await legacy.setMeta("meshId", "mesh_original");
      const stampBefore = await legacy.getMeta(STORE_FORMAT_META_KEY);
      legacy.close();

      const pointerMemory = new Map<string, string>();
      const pointer = {
        get: (key: string) => pointerMemory.get(key) ?? null,
        set: (key: string, value: string) => void pointerMemory.set(key, value),
      };
      const store = createNamedLocalStore({
        baseName: name,
        pointerStore: pointer,
        openTimeoutMs: 2_000,
      });
      await store.open();
      const row = await store.getRow("tasks", "a");
      const out = {
        stampBefore,
        stampAfter: await store.getMeta(STORE_FORMAT_META_KEY),
        format: store.storeFormat,
        legacyId: LEGACY_PLAINTEXT_ROWS_FORMAT,
        // The physical generation must NOT move: stamping is not a migration.
        activeDatabaseName: store.activeDatabaseName,
        title: (row as any)?.payload?.title?.value,
        meshId: await store.getMeta("meshId"),
      };
      store.close();
      return out;
    }, baseName);

    expect(result.stampBefore).toBeUndefined();
    expect(result.stampAfter).toBe(result.legacyId);
    expect(result.format).toBe(result.legacyId);
    expect(result.activeDatabaseName).toBe(baseName);
    expect(result.title).toBe("Alpha");
    expect(result.meshId).toBe("mesh_original");
  });

  test("migrates legacy plaintext data into a synthetic v_next format end to end", async ({
    page,
  }) => {
    const baseName = `FormatMigrate-${crypto.randomUUID()}`;
    const result = await page.evaluate(async (name) => {
      const { IndexedDbLocalStore } = await import(
        "/packages/web/dist/storage/indexed-db-local-store.js"
      );
      const { createNamedLocalStore, copyLocalStoreState, STORE_FORMAT_META_KEY } = await import(
        "/packages/web/dist/storage/named-local-store.js"
      );

      // ── Seed a realistic legacy generation ────────────────────────
      const legacy = new IndexedDbLocalStore(name);
      await legacy.open();
      await legacy.putRows([
        {
          _meta: { table: "tasks", rowId: "a", deleted: false, schemaVersion: 1 },
          payload: { title: { value: "Alpha", hlc: "h1" } },
        },
        // A tombstone. Dropping it in a migration resurrects a deleted row.
        {
          _meta: {
            table: "tasks",
            rowId: "gone",
            deleted: true,
            deletedHlc: "h9",
            schemaVersion: 1,
          },
          payload: {},
        },
      ] as any);
      // Unpushed change history: an outbox entry AND an open pending batch.
      await legacy.pushOutbox({ id: "chg_out", ts: 1, device: "dev", hlc: "h2", ops: [] } as any);
      await legacy.commitLocalMutation(
        {
          _meta: { table: "tasks", rowId: "b", deleted: false, schemaVersion: 1 },
          payload: { title: { value: "Bravo", hlc: "h3" } },
        } as any,
        {
          id: "chg_pending",
          ts: 2,
          device: "dev",
          hlc: "h3",
          ops: [{ type: "delete", table: "tasks", rowId: "z", hlc: "h3" }],
        } as any,
      );
      await legacy.setCursor("peer_a", 42);
      await legacy.setMeta("meshId", "mesh_original");
      legacy.close();

      // ── Open wanting v_next ───────────────────────────────────────
      const migrations: any[] = [];
      const vNext = {
        id: "v_next",
        requiresFreshGeneration: true,
        migrateFrom: {
          "plaintext-rows-v1": async (ctx: any) => {
            migrations.push({
              from: ctx.from,
              to: ctx.to,
              inPlace: ctx.inPlace,
              sourceDatabaseName: ctx.sourceDatabaseName,
              targetDatabaseName: ctx.targetDatabaseName,
            });
            await copyLocalStoreState(ctx.source, ctx.target);
            // Stand in for "re-encode every row"; the shape of the rewrite is
            // the future format's business, not the seam's.
            await ctx.target.setMeta("v_next:reencoded", true);
          },
        },
      };

      const pointerMemory = new Map<string, string>();
      const pointer = {
        get: (key: string) => pointerMemory.get(key) ?? null,
        set: (key: string, value: string) => void pointerMemory.set(key, value),
      };
      const migratedEvents: any[] = [];
      const store = createNamedLocalStore({
        baseName: name,
        pointerStore: pointer,
        openTimeoutMs: 2_000,
        storeFormat: "v_next",
        formats: [vNext],
        onFormatMigrated: (info: any) => migratedEvents.push(info),
      });
      await store.open();

      const pending = await store.peekPendingBatch();
      const out = {
        migrations,
        migratedEvents,
        format: store.storeFormat,
        stamp: await store.getMeta(STORE_FORMAT_META_KEY),
        activeDatabaseName: store.activeDatabaseName,
        pointer: pointerMemory.get(`interocitor:dbName:${name}`),
        rowIds: (await store.getAllRows()).map((r: any) => r._meta.rowId).sort(),
        tombstoned: (await store.getAllRows()).some(
          (r: any) => r._meta.rowId === "gone" && r._meta.deleted === true,
        ),
        outboxIds: (await store.peekOutbox()).map((e: any) => e.id),
        pendingId: (pending as any)?.id,
        pendingOps: (pending as any)?.ops?.length,
        cursor: await store.getCursor("peer_a"),
        meshId: await store.getMeta("meshId"),
        reencoded: await store.getMeta("v_next:reencoded"),
      };
      store.close();

      // ── The source generation must still be intact ────────────────
      const source = new IndexedDbLocalStore(name);
      await source.open();
      const sourceState = {
        rows: (await source.getAllRows()).length,
        outbox: await source.outboxSize(),
        stamp: await source.getMeta(STORE_FORMAT_META_KEY),
      };
      source.close();

      return { ...out, sourceState };
    }, baseName);

    // A fresh physical generation, because an in-place rewrite could never
    // retroactively protect bytes already on disk.
    expect(result.activeDatabaseName).toMatch(new RegExp(`^${baseName}-v2-[0-9a-f]{16}$`));
    expect(result.pointer).toBe(result.activeDatabaseName);
    expect(result.migrations).toHaveLength(1);
    expect(result.migrations[0]).toMatchObject({
      from: "plaintext-rows-v1",
      to: "v_next",
      inPlace: false,
      sourceDatabaseName: baseName,
      targetDatabaseName: result.activeDatabaseName,
    });
    expect(result.migratedEvents).toHaveLength(1);

    expect(result.format).toBe("v_next");
    expect(result.stamp).toBe("v_next");
    expect(result.reencoded).toBe(true);

    // Everything the remote has never seen came across.
    expect(result.rowIds).toEqual(["a", "b", "gone"]);
    expect(result.tombstoned).toBe(true);
    expect(result.outboxIds).toEqual(["chg_out"]);
    expect(result.pendingId).toBe("chg_pending");
    expect(result.pendingOps).toBe(1);
    expect(result.cursor).toBe(42);
    expect(result.meshId).toBe("mesh_original");

    // And the old generation was retained, not deleted.
    expect(result.sourceState.rows).toBe(3);
    expect(result.sourceState.outbox).toBe(1);
    expect(result.sourceState.stamp).toBeUndefined();
  });

  test("refuses cleanly, and changes nothing, when the recorded format is unknown", async ({
    page,
  }) => {
    const baseName = `FormatUnknown-${crypto.randomUUID()}`;
    const result = await page.evaluate(async (name) => {
      const { IndexedDbLocalStore } = await import(
        "/packages/web/dist/storage/indexed-db-local-store.js"
      );
      const { createNamedLocalStore, STORE_FORMAT_META_KEY } = await import(
        "/packages/web/dist/storage/named-local-store.js"
      );

      // A newer build wrote this database, then the user loaded an older one.
      const written = new IndexedDbLocalStore(name);
      await written.open();
      await written.setMeta(STORE_FORMAT_META_KEY, "sealed-mailbox-v7");
      await written.putRow({
        _meta: { table: "tasks", rowId: "a", deleted: false, schemaVersion: 1 },
        payload: { title: { value: "Alpha", hlc: "h1" } },
      } as any);
      written.close();

      const pointerMemory = new Map<string, string>();
      const pointer = {
        get: (key: string) => pointerMemory.get(key) ?? null,
        set: (key: string, value: string) => void pointerMemory.set(key, value),
      };
      const store = createNamedLocalStore({
        baseName: name,
        pointerStore: pointer,
        openTimeoutMs: 2_000,
      });
      let code: string | undefined;
      let recordedFormat: string | undefined;
      try {
        await store.open();
      } catch (error: any) {
        code = error?.code;
        recordedFormat = error?.recordedFormat;
      }
      store.close();

      const after = new IndexedDbLocalStore(name);
      await after.open();
      const survived = {
        rows: (await after.getAllRows()).length,
        stamp: await after.getMeta(STORE_FORMAT_META_KEY),
      };
      after.close();
      return {
        code,
        recordedFormat,
        survived,
        pointer: pointerMemory.get(`interocitor:dbName:${name}`),
      };
    }, baseName);

    expect(result.code).toBe("UNKNOWN_STORE_FORMAT");
    expect(result.recordedFormat).toBe("sealed-mailbox-v7");
    // Not upgraded, not rotated past, not deleted.
    expect(result.survived).toEqual({ rows: 1, stamp: "sealed-mailbox-v7" });
    expect(result.pointer).toBe(baseName);
  });

  test("refuses cleanly when no migration path reaches the desired format", async ({ page }) => {
    const baseName = `FormatNoPath-${crypto.randomUUID()}`;
    const result = await page.evaluate(async (name) => {
      const { IndexedDbLocalStore } = await import(
        "/packages/web/dist/storage/indexed-db-local-store.js"
      );
      const { createNamedLocalStore } = await import(
        "/packages/web/dist/storage/named-local-store.js"
      );
      const legacy = new IndexedDbLocalStore(name);
      await legacy.open();
      await legacy.putRow({
        _meta: { table: "tasks", rowId: "a", deleted: false, schemaVersion: 1 },
        payload: { title: { value: "Alpha", hlc: "h1" } },
      } as any);
      legacy.close();

      const pointerMemory = new Map<string, string>();
      const store = createNamedLocalStore({
        baseName: name,
        pointerStore: {
          get: (key: string) => pointerMemory.get(key) ?? null,
          set: (key: string, value: string) => void pointerMemory.set(key, value),
        },
        openTimeoutMs: 2_000,
        storeFormat: "island_format",
        // Registered, reachable from nothing.
        formats: [{ id: "island_format", requiresFreshGeneration: true }],
      });
      let code: string | undefined;
      try {
        await store.open();
      } catch (error: any) {
        code = error?.code;
      }
      store.close();
      return { code, pointer: pointerMemory.get(`interocitor:dbName:${name}`) };
    }, baseName);

    expect(result.code).toBe("UNSUPPORTED_STORE_FORMAT_UPGRADE");
    expect(result.pointer).toBe(baseName);
  });

  test("leaves the source and the pointer alone when a migration throws", async ({ page }) => {
    const baseName = `FormatFail-${crypto.randomUUID()}`;
    const result = await page.evaluate(async (name) => {
      const { IndexedDbLocalStore } = await import(
        "/packages/web/dist/storage/indexed-db-local-store.js"
      );
      const { createNamedLocalStore } = await import(
        "/packages/web/dist/storage/named-local-store.js"
      );
      const legacy = new IndexedDbLocalStore(name);
      await legacy.open();
      await legacy.putRow({
        _meta: { table: "tasks", rowId: "a", deleted: false, schemaVersion: 1 },
        payload: { title: { value: "Alpha", hlc: "h1" } },
      } as any);
      await legacy.pushOutbox({ id: "chg_out", ts: 1, device: "dev", hlc: "h2", ops: [] } as any);
      legacy.close();

      const pointerMemory = new Map<string, string>();
      const store = createNamedLocalStore({
        baseName: name,
        pointerStore: {
          get: (key: string) => pointerMemory.get(key) ?? null,
          set: (key: string, value: string) => void pointerMemory.set(key, value),
        },
        openTimeoutMs: 2_000,
        storeFormat: "v_broken",
        formats: [
          {
            id: "v_broken",
            requiresFreshGeneration: true,
            migrateFrom: {
              "plaintext-rows-v1": async () => {
                throw new Error("re-encode failed halfway");
              },
            },
          },
        ],
      });
      let code: string | undefined;
      let causeMessage: string | undefined;
      try {
        await store.open();
      } catch (error: any) {
        code = error?.code;
        causeMessage = error?.cause?.message;
      }
      store.close();

      const after = new IndexedDbLocalStore(name);
      await after.open();
      const survived = {
        rows: (await after.getAllRows()).length,
        outbox: await after.outboxSize(),
      };
      after.close();
      return {
        code,
        causeMessage,
        survived,
        pointer: pointerMemory.get(`interocitor:dbName:${name}`),
      };
    }, baseName);

    expect(result.code).toBe("STORE_FORMAT_MIGRATION_FAILED");
    expect(result.causeMessage).toBe("re-encode failed halfway");
    expect(result.survived).toEqual({ rows: 1, outbox: 1 });
    // The app is still pointed at its real data.
    expect(result.pointer).toBe(baseName);
  });

  test("a globally registered format is reachable without per-store wiring", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { registerStoreFormat, getStoreFormat, listStoreFormats, unregisterStoreFormat } =
        await import("/packages/web/dist/storage/named-local-store.js");
      registerStoreFormat({
        id: "registry_probe",
        migrateFrom: { "plaintext-rows-v1": async () => {} },
      });
      const seen = getStoreFormat("registry_probe") !== undefined;
      const listed = listStoreFormats().includes("registry_probe");
      let builtinRejected = false;
      try {
        registerStoreFormat({ id: "plaintext-rows-v1" });
      } catch {
        builtinRejected = true;
      }
      unregisterStoreFormat("registry_probe");
      return {
        seen,
        listed,
        builtinRejected,
        goneAfterUnregister: getStoreFormat("registry_probe") === undefined,
        builtinStillThere: getStoreFormat("plaintext-rows-v1") !== undefined,
      };
    });

    expect(result).toEqual({
      seen: true,
      listed: true,
      builtinRejected: true,
      goneAfterUnregister: true,
      builtinStillThere: true,
    });
  });
});
