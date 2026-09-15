import { expect, test } from "@playwright/test";

// The local store is only a disposable cache while it holds re-fetchable rows.
// The outbox and the pendingOps batch are change history the remote has never
// seen, and the two "keep the app alive" mechanisms — degrade-to-memory and
// rotate-to-a-new-database-name — both discard the database they are applied
// to. Every test here fails if either of them can drop a non-empty outbox.
//
// The resilience behaviour itself is not weakened: the same mechanisms still
// fire for a genuinely disposable (clean) cache.

const RESILIENT = "/packages/web/dist/storage/resilient-store.js";
const NAMED = "/packages/web/dist/storage/named-local-store.js";
const IDB = "/packages/web/dist/storage/indexed-db-local-store.js";
const RESET = "/packages/web/dist/storage/reset.js";

test.beforeEach(async ({ page }) => {
  await page.goto("/packages/web/tests/e2e/fixtures/harness.html");
});

// A LocalStore whose open() never settles — a wedged platform, a blocked
// upgrade, a suspended tab. This is exactly what the 300ms deadline exists for.
const HANGING_PRIMARY = `{
  open: () => new Promise(() => {}),
  close: () => {},
  withLock: (_n, op) => op(),
  getRow: async () => {}, getRows: async () => [], putRow: async () => {},
  putRows: async () => {}, getTable: async () => [], queryWhere: async () => [],
  getAllRows: async () => [], clearRows: async () => {}, getTableNames: async () => [],
  commitLocalMutation: async () => {}, peekPendingBatch: async () => null,
  promotePendingBatch: async () => null, pushOutbox: async () => {},
  pushOutboxEntries: async () => {}, peekOutbox: async () => [],
  acknowledgeOutbox: async () => {}, drainOutbox: async () => [], outboxSize: async () => 0,
  getCursor: async () => 0, setCursor: async () => {}, getAllCursors: async () => ({}),
  getMeta: async () => {}, setMeta: async () => {}, clearAll: async () => {},
}`;

test.describe("unpushed writes block a degrade to memory", () => {
  test("refuses to degrade a database that holds a non-empty outbox", async ({ page }) => {
    const dbName = `DegradeGuard-${crypto.randomUUID()}`;
    const result = await page.evaluate(
      async ([name, hangingSource]) => {
        const { createResilientLocalStore, hasUnpushedLocalWrites } = await import(
          "/packages/web/dist/storage/resilient-store.js"
        );
        const { IndexedDbLocalStore } = await import(
          "/packages/web/dist/storage/indexed-db-local-store.js"
        );
        const memory = new Map<string, string>();
        const slots = {
          get: (key: string) => memory.get(key) ?? null,
          set: (key: string, value: string) => void memory.set(key, value),
        };

        // A real database with a real unpushed write in it.
        const durable = createResilientLocalStore({
          dbName: name,
          unpushedSlots: slots,
          openTimeoutMs: 2_000,
          primaryFactory: () => new IndexedDbLocalStore(name),
        });
        await durable.open();
        await durable.pushOutbox({ id: "chg_1", ts: 1, device: "dev", hlc: "h1", ops: [] } as any);
        const markedAfterWrite = hasUnpushedLocalWrites(name, slots);
        durable.close();

        // Next session: the platform is wedged. The old code would have
        // silently swapped in an empty MemoryLocalStore and carried on.
        // eslint-disable-next-line no-eval
        const hanging = eval(`(${hangingSource})`);
        const errors: string[] = [];
        const origError = console.error;
        console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
        const refused: string[] = [];
        let code: string | undefined;
        let operation: string | undefined;
        let causeMessage: string | undefined;
        try {
          const wedged = createResilientLocalStore({
            dbName: name,
            unpushedSlots: slots,
            openTimeoutMs: 50,
            primaryFactory: () => hanging,
            onDegradeRefused: (info: any) => refused.push(info.reason),
          });
          try {
            await wedged.open();
          } catch (error: any) {
            code = error?.code;
            operation = error?.operation;
            causeMessage = String(error?.cause?.message ?? "");
          }
          return {
            markedAfterWrite,
            code,
            operation,
            causeMessage,
            refused,
            degradedSilently: errors.some((e) => e.includes("degraded to memory")),
            stillMarked: hasUnpushedLocalWrites(name, slots),
          };
        } finally {
          console.error = origError;
        }
      },
      [dbName, HANGING_PRIMARY] as const,
    );

    expect(result.markedAfterWrite).toBe(true);
    expect(result.code).toBe("UNPUSHED_LOCAL_WRITES");
    expect(result.operation).toBe("degrade-to-memory");
    // The underlying failure is preserved for diagnosis, not swallowed.
    expect(result.causeMessage).toContain("stalled with no progress");
    expect(result.refused).toEqual(["idb-open-stalled-or-unavailable"]);
    expect(result.degradedSilently).toBe(false);
    // The marker must survive the refusal, or the next attempt would discard.
    expect(result.stillMarked).toBe(true);
  });

  test("still degrades a genuinely disposable cache", async ({ page }) => {
    const result = await page.evaluate(
      async ([hangingSource]) => {
        const { createResilientLocalStore } = await import(
          "/packages/web/dist/storage/resilient-store.js"
        );
        const memory = new Map<string, string>();
        const slots = {
          get: (key: string) => memory.get(key) ?? null,
          set: (key: string, value: string) => void memory.set(key, value),
        };
        // eslint-disable-next-line no-eval
        const hanging = eval(`(${hangingSource})`);
        const origError = console.error;
        console.error = () => {};
        try {
          const store = createResilientLocalStore({
            dbName: `Disposable-${crypto.randomUUID()}`,
            unpushedSlots: slots,
            openTimeoutMs: 50,
            primaryFactory: () => hanging,
          });
          await store.open();
          await store.setMeta("k", "kept-working");
          return {
            degraded: (store as any).__degraded === true,
            meta: await store.getMeta("k"),
          };
        } finally {
          console.error = origError;
        }
      },
      [HANGING_PRIMARY] as const,
    );

    expect(result.degraded).toBe(true);
    expect(result.meta).toBe("kept-working");
  });

  test("refuses a post-open degrade while the outbox is non-empty", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { createResilientLocalStore } = await import(
        "/packages/web/dist/storage/resilient-store.js"
      );
      const { MemoryLocalStore } = await import("/packages/core/dist/storage/memory-store.js");
      const memory = new Map<string, string>();
      const slots = {
        get: (key: string) => memory.get(key) ?? null,
        set: (key: string, value: string) => void memory.set(key, value),
      };

      // A primary that works until its handle dies mid-session — the second
      // recovery path, where the wrapper retries the operation on memory.
      const inner = new MemoryLocalStore();
      await inner.open();
      let dead = false;
      const primary: any = new Proxy(inner, {
        get(target, prop, receiver) {
          if (dead && prop !== "close" && prop !== "open") {
            return () => Promise.reject(new Error("The database connection is closing."));
          }
          return Reflect.get(target, prop, receiver);
        },
      });

      const store = createResilientLocalStore({
        dbName: `PostOpenGuard-${crypto.randomUUID()}`,
        unpushedSlots: slots,
        openTimeoutMs: 1_000,
        primaryFactory: () => primary,
      });
      await store.open();
      await store.pushOutbox({ id: "chg_1", ts: 1, device: "dev", hlc: "h1", ops: [] } as any);
      dead = true;

      const origError = console.error;
      console.error = () => {};
      try {
        let code: string | undefined;
        try {
          await store.putRow({
            _meta: { table: "t", rowId: "r", deleted: false, schemaVersion: 1 },
            payload: {},
          } as any);
        } catch (error: any) {
          code = error?.code;
        }
        return { code, degraded: (store as any).__degraded === true };
      } finally {
        console.error = origError;
      }
    });

    expect(result.code).toBe("UNPUSHED_LOCAL_WRITES");
    // Crucially: it did NOT swap in an empty memory store behind the outbox.
    expect(result.degraded).toBe(false);
  });

  test("marks an install whose outbox predates the marker, at its very first open", async ({
    page,
  }) => {
    const dbName = `LegacyOutbox-${crypto.randomUUID()}`;
    const result = await page.evaluate(async (name) => {
      const { createResilientLocalStore, hasUnpushedLocalWrites } = await import(
        "/packages/web/dist/storage/resilient-store.js"
      );
      const { IndexedDbLocalStore } = await import(
        "/packages/web/dist/storage/indexed-db-local-store.js"
      );
      // Written entirely outside the wrapper: this is an existing install.
      const legacy = new IndexedDbLocalStore(name);
      await legacy.open();
      await legacy.pushOutbox({ id: "chg_old", ts: 1, device: "dev", hlc: "h1", ops: [] } as any);
      legacy.close();

      const memory = new Map<string, string>();
      const slots = {
        get: (key: string) => memory.get(key) ?? null,
        set: (key: string, value: string) => void memory.set(key, value),
      };
      const before = hasUnpushedLocalWrites(name, slots);
      const store = createResilientLocalStore({
        dbName: name,
        unpushedSlots: slots,
        openTimeoutMs: 2_000,
        primaryFactory: () => new IndexedDbLocalStore(name),
      });
      await store.open();
      const after = hasUnpushedLocalWrites(name, slots);
      // Draining returns the entries to the caller; the store no longer holds
      // them, so it becomes disposable again.
      await store.drainOutbox();
      const afterDrain = hasUnpushedLocalWrites(name, slots);
      store.close();
      return { before, after, afterDrain };
    }, dbName);

    expect(result).toEqual({ before: false, after: true, afterDrain: false });
  });
});

test.describe("unpushed writes block rotation and reset", () => {
  test("refuses to rotate away from a generation holding unpushed writes", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { rotateLocalDatabaseName } = await import(
        "/packages/web/dist/storage/named-local-store.js"
      );
      const { setUnpushedLocalWrites } = await import(
        "/packages/web/dist/storage/resilient-store.js"
      );
      const memory = new Map<string, string>();
      const slots = {
        get: (key: string) => memory.get(key) ?? null,
        set: (key: string, value: string) => void memory.set(key, value),
      };
      const pointerMemory = new Map<string, string>();
      const pointer = {
        get: (key: string) => pointerMemory.get(key) ?? null,
        set: (key: string, value: string) => void pointerMemory.set(key, value),
      };

      setUnpushedLocalWrites("Household", true, slots);
      let code: string | undefined;
      let dbName: string | undefined;
      let operation: string | undefined;
      try {
        rotateLocalDatabaseName("Household", pointer, { unpushedSlots: slots });
      } catch (error: any) {
        code = error?.code;
        dbName = error?.dbName;
        operation = error?.operation;
      }
      const pointerAfterRefusal = pointer.get("interocitor:dbName:Household");

      // The explicit "I accept the loss" gesture still works.
      const forced = rotateLocalDatabaseName("Household", pointer, {
        unpushedSlots: slots,
        force: true,
      });
      return { code, dbName, operation, pointerAfterRefusal, forced };
    });

    expect(result.code).toBe("UNPUSHED_LOCAL_WRITES");
    expect(result.dbName).toBe("Household");
    expect(result.operation).toBe("rotate");
    // The pointer never moved: the app is still on its real data.
    expect(result.pointerAfterRefusal).toBeNull();
    expect(result.forced.to).toMatch(/^Household-v2-[0-9a-f]{16}$/);
  });

  test("a named store marks its own physical generation, so every guard downstream fires", async ({
    page,
  }) => {
    const baseName = `RotateOnDegrade-${crypto.randomUUID()}`;
    const result = await page.evaluate(async (name) => {
      const { createNamedLocalStore } = await import(
        "/packages/web/dist/storage/named-local-store.js"
      );
      const { IndexedDbLocalStore } = await import(
        "/packages/web/dist/storage/indexed-db-local-store.js"
      );
      const memory = new Map<string, string>();
      const slots = {
        get: (key: string) => memory.get(key) ?? null,
        set: (key: string, value: string) => void memory.set(key, value),
      };
      const pointerMemory = new Map<string, string>();
      const pointer = {
        get: (key: string) => pointerMemory.get(key) ?? null,
        set: (key: string, value: string) => void pointerMemory.set(key, value),
      };

      const { hasUnpushedLocalWrites } = await import(
        "/packages/web/dist/storage/resilient-store.js"
      );
      const { rotateLocalDatabaseName } = await import(
        "/packages/web/dist/storage/named-local-store.js"
      );

      const rotations: any[] = [];
      const store = createNamedLocalStore({
        baseName: name,
        pointerStore: pointer,
        unpushedSlots: slots,
        openTimeoutMs: 2_000,
        onRotated: (info: any) => rotations.push(info),
      });
      await store.open();
      const cleanWhileEmpty = hasUnpushedLocalWrites(store.activeDatabaseName, slots);
      await store.pushOutbox({ id: "chg_1", ts: 1, device: "dev", hlc: "h1", ops: [] } as any);
      const markedAfterWrite = hasUnpushedLocalWrites(store.activeDatabaseName, slots);
      const activeDatabaseName = store.activeDatabaseName;
      store.close();

      // The marker is keyed by the *physical* generation the named store is
      // actually on, which is what makes the rotation and reset guards fire on
      // the right database.
      let rotateCode: string | undefined;
      try {
        rotateLocalDatabaseName(name, pointer, { unpushedSlots: slots });
      } catch (error: any) {
        rotateCode = error?.code;
      }

      const verify = new IndexedDbLocalStore(name);
      await verify.open();
      const outbox = await verify.outboxSize();
      verify.close();

      return {
        cleanWhileEmpty,
        markedAfterWrite,
        activeDatabaseName,
        rotateCode,
        rotations,
        pointer: pointer.get(`interocitor:dbName:${name}`),
        outbox,
      };
    }, baseName);

    expect(result.cleanWhileEmpty).toBe(false);
    expect(result.markedAfterWrite).toBe(true);
    expect(result.activeDatabaseName).toBe(baseName);
    expect(result.rotateCode).toBe("UNPUSHED_LOCAL_WRITES");
    expect(result.rotations).toEqual([]);
    // The pointer never moved; the write is still exactly where the user left it.
    expect(result.pointer).toBe(baseName);
    expect(result.outbox).toBe(1);
  });

  test("refuses to delete a database holding unpushed writes unless forced", async ({ page }) => {
    const dbName = `ResetGuard-${crypto.randomUUID()}`;
    const result = await page.evaluate(async (name) => {
      const { resetLocalDatabase, resetLocalDatabaseWithDeadline } = await import(
        "/packages/web/dist/storage/reset.js"
      );
      const { setUnpushedLocalWrites, hasUnpushedLocalWrites } = await import(
        "/packages/web/dist/storage/resilient-store.js"
      );
      const { IndexedDbLocalStore } = await import(
        "/packages/web/dist/storage/indexed-db-local-store.js"
      );
      const memory = new Map<string, string>();
      const slots = {
        get: (key: string) => memory.get(key) ?? null,
        set: (key: string, value: string) => void memory.set(key, value),
      };

      const store = new IndexedDbLocalStore(name);
      await store.open();
      await store.pushOutbox({ id: "chg_1", ts: 1, device: "dev", hlc: "h1", ops: [] } as any);
      store.close();
      setUnpushedLocalWrites(name, true, slots);

      const deadlineOutcome = await resetLocalDatabaseWithDeadline(name, 1_000, {
        unpushedSlots: slots,
      });
      let code: string | undefined;
      try {
        await resetLocalDatabase(name, { unpushedSlots: slots });
      } catch (error: any) {
        code = error?.code;
      }

      const survivor = new IndexedDbLocalStore(name);
      await survivor.open();
      const survivedOutbox = await survivor.outboxSize();
      survivor.close();

      const forcedOutcome = await resetLocalDatabaseWithDeadline(name, 1_000, {
        unpushedSlots: slots,
        force: true,
      });
      return {
        deadlineOutcome,
        code,
        survivedOutbox,
        forcedOutcome,
        // A deleted database must not leave a dirty marker behind to poison
        // a future database that reuses the name.
        markerAfterForce: hasUnpushedLocalWrites(name, slots),
      };
    }, dbName);

    expect(result.deadlineOutcome).toBe("refused-unpushed-writes");
    expect(result.code).toBe("UNPUSHED_LOCAL_WRITES");
    expect(result.survivedOutbox).toBe(1);
    expect(result.forcedOutcome).toBe("deleted");
    expect(result.markerAfterForce).toBe(false);
  });
});

test.describe("a format migration carries unpushed writes rather than stranding them", () => {
  test("moves the outbox to the new generation and marks it there", async ({ page }) => {
    const baseName = `MigrateOutbox-${crypto.randomUUID()}`;
    const result = await page.evaluate(async (name) => {
      const { createNamedLocalStore, copyLocalStoreState } = await import(
        "/packages/web/dist/storage/named-local-store.js"
      );
      const { hasUnpushedLocalWrites } = await import(
        "/packages/web/dist/storage/resilient-store.js"
      );
      const memory = new Map<string, string>();
      const slots = {
        get: (key: string) => memory.get(key) ?? null,
        set: (key: string, value: string) => void memory.set(key, value),
      };
      const pointerMemory = new Map<string, string>();
      const pointer = {
        get: (key: string) => pointerMemory.get(key) ?? null,
        set: (key: string, value: string) => void pointerMemory.set(key, value),
      };

      const legacy = createNamedLocalStore({
        baseName: name,
        pointerStore: pointer,
        unpushedSlots: slots,
        openTimeoutMs: 2_000,
      });
      await legacy.open();
      await legacy.pushOutbox({ id: "chg_1", ts: 1, device: "dev", hlc: "h1", ops: [] } as any);
      legacy.close();

      const upgraded = createNamedLocalStore({
        baseName: name,
        pointerStore: pointer,
        unpushedSlots: slots,
        openTimeoutMs: 2_000,
        storeFormat: "v_next",
        formats: [
          {
            id: "v_next",
            requiresFreshGeneration: true,
            migrateFrom: {
              "plaintext-rows-v1": (ctx: any) => copyLocalStoreState(ctx.source, ctx.target),
            },
          },
        ],
      });
      await upgraded.open();
      const out = {
        activeDatabaseName: upgraded.activeDatabaseName,
        outboxIds: (await upgraded.peekOutbox()).map((e: any) => e.id),
        newGenerationMarked: hasUnpushedLocalWrites(upgraded.activeDatabaseName, slots),
      };
      upgraded.close();
      return out;
    }, baseName);

    expect(result.activeDatabaseName).not.toBe(baseName);
    expect(result.outboxIds).toEqual(["chg_1"]);
    // The successor inherits the obligation, so it too cannot be discarded.
    expect(result.newGenerationMarked).toBe(true);
  });
});
