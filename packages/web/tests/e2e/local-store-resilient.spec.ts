import { expect, test } from "@playwright/test";

// Antifragility contract: open() must never hang. The resilient wrapper
// degrades silently to an in-memory store on timeout / failure / missing IDB
// and the engine continues to function (cloud is the source of truth, local
// is just a cache).

test.beforeEach(async ({ page }) => {
  await page.goto("/packages/web/tests/e2e/fixtures/harness.html");
});

test.describe("Resilient LocalStore", () => {
  test("MemoryLocalStore round-trips rows, outbox, cursors, and meta", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { MemoryLocalStore } = await import("/packages/core/dist/storage/memory-store.js");
      const store = new MemoryLocalStore();
      await store.open();

      await store.putRow({
        _meta: { table: "t", rowId: "r1", deleted: false, schemaVersion: 1 },
        payload: { title: { value: "hello", hlc: "0" } },
      } as any);
      await store.pushOutbox({ id: "e1", ts: 1, device: "d", hlc: "0", ops: [] } as any);
      await store.setCursor("peer", 42);
      await store.setMeta("k", "v");

      const row = await store.getRow("t", "r1");
      const tableNames = await store.getTableNames();
      const drained = await store.drainOutbox();
      const cursor = await store.getCursor("peer");
      const meta = await store.getMeta("k");

      return {
        rowTitle: (row as any)?.payload?.title?.value,
        tableNames,
        drainedIds: drained.map((d) => d.id),
        cursor,
        meta,
      };
    });

    expect(result.rowTitle).toBe("hello");
    expect(result.tableNames).toEqual(["t"]);
    expect(result.drainedIds).toEqual(["e1"]);
    expect(result.cursor).toBe(42);
    expect(result.meta).toBe("v");
  });

  test("createResilientLocalStore falls back to memory when primary open() hangs past deadline", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const { createResilientLocalStore } = await import("/packages/web/dist/index.js");

      // Primary that never resolves — simulates blocked IDB / suspended tab.
      const hangingPrimary = {
        open: () =>
          new Promise<void>(() => {
            /* never resolves */
          }),
        close: () => {
          /* noop */
        },
        getRow: async () => {},
        putRow: async () => {},
        putRows: async () => {},
        getTable: async () => [],
        queryWhere: async () => [],
        getAllRows: async () => [],
        clearRows: async () => {},
        getTableNames: async () => [],
        pushOutbox: async () => {},
        pushOutboxEntries: async () => {},
        drainOutbox: async () => [],
        outboxSize: async () => 0,
        getCursor: async () => 0,
        setCursor: async () => {},
        getAllCursors: async () => ({}),
        getMeta: async () => {},
        setMeta: async () => {},
        clearAll: async () => {},
      };

      // Capture console.error so we can assert the diagnostic was emitted.
      const errors: string[] = [];
      const origError = console.error;
      console.error = (...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
      };

      const start = performance.now();
      const store = createResilientLocalStore({
        openTimeoutMs: 50, // tight to keep test fast
        primaryFactory: () => hangingPrimary as any,
      });

      try {
        await store.open();
        const elapsed = performance.now() - start;

        // Must succeed via fallback — engine writes should still work.
        await store.putRow({
          _meta: { table: "t", rowId: "r1", deleted: false, schemaVersion: 1 },
          payload: { title: { value: "fallback", hlc: "0" } },
        } as any);
        const back = await store.getRow("t", "r1");

        return {
          openedWithinBudget: elapsed < 500,
          elapsedMs: Math.round(elapsed),
          degraded: (store as any).__degraded === true,
          errorLogged: errors.some((e) => e.includes("LocalStore degraded to memory")),
          rowSurvived: (back as any)?.payload?.title?.value === "fallback",
        };
      } finally {
        console.error = origError;
      }
    });

    expect(result.openedWithinBudget).toBe(true);
    expect(result.degraded).toBe(true);
    expect(result.errorLogged).toBe(true);
    expect(result.rowSurvived).toBe(true);
  });

  test("createResilientLocalStore uses primary normally when it opens promptly", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const { createResilientLocalStore } = await import("/packages/web/dist/index.js");
      const { MemoryLocalStore } = await import("/packages/core/dist/storage/memory-store.js");

      // Stand in a "primary" that's actually a memory store — ensures the
      // happy path still goes through the primary, not the fallback.
      const primary = new MemoryLocalStore();
      const store = createResilientLocalStore({
        openTimeoutMs: 1000,
        primaryFactory: () => primary,
      });
      await store.open();

      await store.putRow({
        _meta: { table: "t", rowId: "r1", deleted: false, schemaVersion: 1 },
        payload: { title: { value: "primary", hlc: "0" } },
      } as any);

      // Reading via the wrapper and via the primary directly must agree:
      // proves no fallback was created.
      const viaWrapper = await store.getRow("t", "r1");
      const viaPrimary = await primary.getRow("t", "r1");

      return {
        degraded: (store as any).__degraded === true,
        viaWrapper: (viaWrapper as any)?.payload?.title?.value,
        viaPrimary: (viaPrimary as any)?.payload?.title?.value,
        sameInstance: viaWrapper === viaPrimary,
      };
    });

    expect(result.degraded).toBe(false);
    expect(result.viaWrapper).toBe("primary");
    expect(result.viaPrimary).toBe("primary");
    expect(result.sameInstance).toBe(true);
  });

  test("createResilientLocalStore does NOT fall back when primary is slow but reports progress", async ({
    page,
  }) => {
    // Simulates a real IndexedDB upgrade that takes longer than the deadline
    // but is making progress (onupgradeneeded fired). Resilient wrapper must
    // disarm the deadline and wait for completion — otherwise legitimate
    // schema upgrades on slow devices would falsely trigger memory mode.
    const result = await page.evaluate(async () => {
      const { createResilientLocalStore } = await import("/packages/web/dist/index.js");

      let primaryResolveOpen: (() => void) | null = null;
      const slowButProgressingPrimary = {
        // Accept the optional progress callback (matches LocalStore.open).
        open: (onProgress?: () => void) =>
          new Promise<void>((resolve) => {
            // Signal progress almost immediately — within the deadline window.
            setTimeout(() => onProgress?.(), 20);
            // Then take much longer than the deadline to actually finish.
            // Without progress-aware deadline this would trigger memory fallback.
            primaryResolveOpen = resolve;
            setTimeout(() => resolve(), 250);
          }),
        close: () => {},
        getRow: async () => {},
        putRow: async () => {},
        putRows: async () => {},
        getTable: async () => [],
        queryWhere: async () => [],
        getAllRows: async () => [],
        clearRows: async () => {},
        getTableNames: async () => [],
        pushOutbox: async () => {},
        pushOutboxEntries: async () => {},
        drainOutbox: async () => [],
        outboxSize: async () => 0,
        getCursor: async () => 0,
        setCursor: async () => {},
        getAllCursors: async () => ({}),
        getMeta: async () => "primary-was-used",
        setMeta: async () => {},
        clearAll: async () => {},
      };

      const origError = console.error;
      let degradedLogged = false;
      console.error = (...args: unknown[]) => {
        if (args.some((a) => String(a).includes("LocalStore degraded"))) degradedLogged = true;
      };
      try {
        const store = createResilientLocalStore({
          openTimeoutMs: 50, // shorter than the 250ms open
          primaryFactory: () => slowButProgressingPrimary as any,
        });
        await store.open();
        const meta = await store.getMeta("any");
        return {
          degraded: (store as any).__degraded === true,
          degradedLogged,
          // Proves the primary was actually used (memory-store would return undefined).
          primaryUsed: meta === "primary-was-used",
          primaryFinished: primaryResolveOpen !== null,
        };
      } finally {
        console.error = origError;
      }
    });

    expect(result.degraded).toBe(false);
    expect(result.degradedLogged).toBe(false);
    expect(result.primaryUsed).toBe(true);
    expect(result.primaryFinished).toBe(true);
  });

  test("createResilientLocalStore falls back when primary open() throws synchronously", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const { createResilientLocalStore } = await import("/packages/web/dist/index.js");

      const throwingPrimary = {
        open: async () => {
          throw new Error("IndexedDB open blocked: another tab");
        },
        close: () => {},
        getRow: async () => {},
        putRow: async () => {},
        putRows: async () => {},
        getTable: async () => [],
        queryWhere: async () => [],
        getAllRows: async () => [],
        clearRows: async () => {},
        getTableNames: async () => [],
        pushOutbox: async () => {},
        pushOutboxEntries: async () => {},
        drainOutbox: async () => [],
        outboxSize: async () => 0,
        getCursor: async () => 0,
        setCursor: async () => {},
        getAllCursors: async () => ({}),
        getMeta: async () => {},
        setMeta: async () => {},
        clearAll: async () => {},
      };

      const origError = console.error;
      console.error = () => {
        /* swallow for cleaner test output */
      };
      try {
        const store = createResilientLocalStore({
          openTimeoutMs: 1000,
          primaryFactory: () => throwingPrimary as any,
        });
        await store.open();
        await store.setMeta("k", "survived");
        const meta = await store.getMeta("k");
        return {
          degraded: (store as any).__degraded === true,
          metaSurvived: meta === "survived",
        };
      } finally {
        console.error = origError;
      }
    });

    expect(result.degraded).toBe(true);
    expect(result.metaSurvived).toBe(true);
  });

  test("createResilientLocalStore degrades and retries when an opened primary starts closing", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const { createResilientLocalStore } = await import("/packages/web/dist/index.js");

      let getMetaCalls = 0;
      const closingPrimary = {
        open: async () => {},
        close: () => {},
        getRow: async () => {},
        putRow: async () => {},
        putRows: async () => {},
        getTable: async () => [],
        queryWhere: async () => [],
        getAllRows: async () => [],
        clearRows: async () => {},
        getTableNames: async () => [],
        pushOutbox: async () => {},
        pushOutboxEntries: async () => {},
        drainOutbox: async () => [],
        outboxSize: async () => 0,
        getCursor: async () => 0,
        setCursor: async () => {},
        getAllCursors: async () => ({}),
        getMeta: async () => {
          getMetaCalls++;
          throw new DOMException("The database connection is closing.", "InvalidStateError");
        },
        setMeta: async () => {},
        clearAll: async () => {},
      };

      const origError = console.error;
      let degradedLogged = false;
      console.error = (...args: unknown[]) => {
        if (args.some((a) => String(a).includes("LocalStore degraded to memory")))
          degradedLogged = true;
      };
      try {
        const store = createResilientLocalStore({
          openTimeoutMs: 1000,
          primaryFactory: () => closingPrimary as any,
        });
        await store.open();
        const firstMeta = await store.getMeta("k");
        await store.setMeta("fresh", "survived-after-closing");
        const freshMeta = await store.getMeta("fresh");
        return {
          degraded: (store as any).__degraded === true,
          degradedLogged,
          firstMeta,
          freshMeta,
          getMetaCalls,
        };
      } finally {
        console.error = origError;
      }
    });

    expect(result.degraded).toBe(true);
    expect(result.degradedLogged).toBe(true);
    expect(result.firstMeta).toBeUndefined();
    expect(result.freshMeta).toBe("survived-after-closing");
    expect(result.getMetaCalls).toBe(1);
  });

  test("Interocitor remains usable when an opened primary starts closing during init", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor, MemoryLocalStore } = await import("/packages/core/dist/index.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");
      const { createResilientLocalStore } = await import("/packages/web/dist/index.js");

      class OneShotClosingLocalStore extends MemoryLocalStore {
        private failedOnce = false;

        async setMeta(key: string, value: unknown): Promise<void> {
          if (!this.failedOnce) {
            this.failedOnce = true;
            throw new DOMException("The database connection is closing.", "InvalidStateError");
          }
          await super.setMeta(key, value);
        }
      }

      const degradationReasons: string[] = [];
      const originalError = console.error;
      console.error = () => {};
      try {
        const engine = new Interocitor(new MemoryAdapter(), {
          remotePath: "/InitSurvivesClosing",
          pollInterval: 600_000,
          deviceId: "init-survival",
          keySource: null,
          localStore: createResilientLocalStore({
            dbName: "init-survives-closing",
            openTimeoutMs: 200,
            primaryFactory: () => new OneShotClosingLocalStore(),
            onDegraded: (info) => degradationReasons.push(info.reason),
          }),
        });

        let error: string | null = null;
        try {
          await engine.init();
          await engine.connect();
          await engine.put("tasks", "after-degrade", { title: "init survived" });
          await engine.flush();
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught);
        }
        const rowCount = (await engine.query("tasks")).length;
        const ready = engine.isReady();
        await engine.disconnect();
        return { error, ready, rowCount, degradationReasons };
      } finally {
        console.error = originalError;
      }
    });

    expect(result).toEqual({
      error: null,
      ready: true,
      rowCount: 1,
      degradationReasons: ["idb-handle-closing"],
    });
  });
});
