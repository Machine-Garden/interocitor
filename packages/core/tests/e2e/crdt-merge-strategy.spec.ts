import { expect, test } from "@playwright/test";

/* eslint-disable unicorn/consistent-function-scoping -- Browser-context helpers must be defined inside page.evaluate. */

test.beforeEach(async ({ page }) => {
  await page.goto("/packages/core/tests/e2e/fixtures/harness.html");
});

test.describe("merge strategy — convergent LWW", () => {
  test("newer HLC wins and an older late mutation loses", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { applyOp, readColumn } = await import("/packages/core/dist/core/crdt.js");
      const tables: Record<string, Record<string, any>> = {};
      const schema = { version: 1, tables: { t: {} } };

      applyOp(
        tables,
        {
          type: "upsert",
          table: "t",
          rowId: "r1",
          columns: { name: { value: "newer", hlc: "000002000000000000-0000-dev_b" } },
        },
        1,
        schema,
      );
      const changed = applyOp(
        tables,
        {
          type: "upsert",
          table: "t",
          rowId: "r1",
          columns: { name: { value: "older", hlc: "000001000000000000-0000-dev_a" } },
        },
        1,
        schema,
      );

      return { value: readColumn(tables.t.r1, "name"), changed: changed !== null };
    });

    expect(result).toEqual({ value: "newer", changed: false });
  });

  test("configured and schema-less databases have the same LWW default", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { applyOp, readColumn } = await import("/packages/core/dist/core/crdt.js");

      const resolve = (schema?: any) => {
        const tables: Record<string, Record<string, any>> = {};
        applyOp(
          tables,
          {
            type: "upsert",
            table: "t",
            rowId: "r1",
            columns: { value: { value: "newer", hlc: "000002000000000000-0000-dev_b" } },
          },
          1,
          schema,
        );
        applyOp(
          tables,
          {
            type: "upsert",
            table: "t",
            rowId: "r1",
            columns: { value: { value: "older", hlc: "000001000000000000-0000-dev_a" } },
          },
          1,
          schema,
        );
        return readColumn(tables.t.r1, "value");
      };

      return {
        configured: resolve({ version: 1, tables: { t: {} } }),
        schemaLess: resolve(),
      };
    });

    expect(result).toEqual({ configured: "newer", schemaLess: "newer" });
  });

  test("table and field configuration can state LWW explicitly", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { applyOp, readColumn } = await import("/packages/core/dist/core/crdt.js");
      const tables: Record<string, Record<string, any>> = {};
      const schema = {
        version: 1,
        mergeStrategy: "lww" as const,
        tables: {
          t: {
            merge: {
              strategy: "lww" as const,
              fields: { status: "lww" as const },
            },
          },
        },
      };

      applyOp(
        tables,
        {
          type: "upsert",
          table: "t",
          rowId: "r1",
          columns: {
            title: { value: "old", hlc: "000001000000000000-0000-dev_a" },
            status: { value: "old", hlc: "000001000000000000-0000-dev_a" },
          },
        },
        1,
        schema,
      );
      applyOp(
        tables,
        {
          type: "upsert",
          table: "t",
          rowId: "r1",
          columns: {
            title: { value: "new", hlc: "000002000000000000-0000-dev_b" },
            status: { value: "new", hlc: "000002000000000000-0000-dev_b" },
          },
        },
        1,
        schema,
      );

      return {
        title: readColumn(tables.t.r1, "title"),
        status: readColumn(tables.t.r1, "status"),
      };
    });

    expect(result).toEqual({ title: "new", status: "new" });
  });

  test("equal HLC and equal structured value is an idempotent replay", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { applyOp } = await import("/packages/core/dist/core/crdt.js");
      const tables: Record<string, Record<string, any>> = {};
      const hlc = "000001000000000000-0000-dev_a";
      const op = (value: unknown) => ({
        type: "upsert" as const,
        table: "t",
        rowId: "r1",
        columns: { value: { value, hlc } },
      });

      applyOp(tables, op({ b: [2], a: 1 }), 1);
      return applyOp(tables, op({ a: 1, b: [2] }), 1) === null;
    });

    expect(result).toBe(true);
  });

  test("equal HLC with a different value is protocol corruption", async ({ page }) => {
    const error = await page.evaluate(async () => {
      const { applyOp } = await import("/packages/core/dist/core/crdt.js");
      const tables: Record<string, Record<string, any>> = {};
      const hlc = "000001000000000000-0000-dev_a";
      applyOp(
        tables,
        {
          type: "upsert",
          table: "t",
          rowId: "r1",
          columns: { value: { value: "first", hlc } },
        },
        1,
      );
      try {
        applyOp(
          tables,
          {
            type: "upsert",
            table: "t",
            rowId: "r1",
            columns: { value: { value: "different", hlc } },
          },
          1,
        );
        return null;
      } catch (caught) {
        return caught instanceof Error ? caught.message : String(caught);
      }
    });

    expect(error).toContain("Conflicting values share HLC");
  });
});

test.describe("merge strategy — rejected perspective-dependent policies", () => {
  for (const strategy of ["local-wins", "remote-wins"]) {
    test(`${strategy} fails loudly`, async ({ page }) => {
      const error = await page.evaluate(async (legacyStrategy) => {
        const { applyOp } = await import("/packages/core/dist/core/crdt.js");
        const tables: Record<string, Record<string, any>> = {};
        try {
          applyOp(
            tables,
            {
              type: "upsert",
              table: "t",
              rowId: "r1",
              columns: { value: { value: "value", hlc: "000001000000000000-0000-dev_a" } },
            },
            1,
            { tables: { t: { merge: legacyStrategy } } } as any,
          );
          return null;
        } catch (caught) {
          return caught instanceof Error ? caught.message : String(caught);
        }
      }, strategy);

      expect(error).toContain(`Unsupported replicated merge strategy "${strategy}"`);
    });
  }
});

test.describe("merge strategy — custom convergent function", () => {
  test("receives context and can produce a merged value", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { applyOp, readColumn } = await import("/packages/core/dist/core/crdt.js");
      const tables: Record<string, Record<string, any>> = {};
      let context: any = null;
      const max = (existing: any, incoming: any, ctx: any) => {
        context = ctx;
        return existing.value >= incoming.value ? existing : incoming;
      };
      const schema = { version: 1, tables: { counters: { merge: max } } };

      applyOp(
        tables,
        {
          type: "upsert",
          table: "counters",
          rowId: "c1",
          columns: { count: { value: 5, hlc: "000001000000000000-0000-dev_a" } },
        },
        1,
        schema,
      );
      applyOp(
        tables,
        {
          type: "upsert",
          table: "counters",
          rowId: "c1",
          columns: { count: { value: 3, hlc: "000002000000000000-0000-dev_b" } },
        },
        1,
        schema,
      );

      return { value: readColumn(tables.counters.c1, "count"), context };
    });

    expect(result).toEqual({
      value: 5,
      context: { table: "counters", rowId: "c1", field: "count" },
    });
  });
});

test.describe("merge strategy — tombstones", () => {
  test("delete and resurrection use HLC order", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { applyOp, readColumn } = await import("/packages/core/dist/core/crdt.js");
      const tables: Record<string, Record<string, any>> = {};
      applyOp(
        tables,
        {
          type: "upsert",
          table: "t",
          rowId: "r1",
          columns: { name: { value: "created", hlc: "000001000000000000-0000-dev_a" } },
        },
        1,
      );
      applyOp(
        tables,
        {
          type: "delete",
          table: "t",
          rowId: "r1",
          hlc: "000002000000000000-0000-dev_b",
        },
        1,
      );
      applyOp(
        tables,
        {
          type: "upsert",
          table: "t",
          rowId: "r1",
          columns: { name: { value: "resurrected", hlc: "000003000000000000-0000-dev_c" } },
        },
        1,
      );

      return {
        deleted: tables.t.r1._meta.deleted,
        value: readColumn(tables.t.r1, "name"),
      };
    });

    expect(result).toEqual({ deleted: false, value: "resurrected" });
  });
});

test("applyChangeEntry preserves the LWW schema policy", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { applyChangeEntry, readColumn } = await import("/packages/core/dist/core/crdt.js");
    const tables: Record<string, Record<string, any>> = {};
    const schema = { version: 1, tables: { t: { merge: "lww" as const } } };

    applyChangeEntry(
      tables,
      {
        id: "chg_new",
        ts: 2,
        device: "dev_b",
        hlc: "000002000000000000-0000-dev_b",
        ops: [
          {
            type: "upsert",
            table: "t",
            rowId: "r1",
            columns: { name: { value: "newer", hlc: "000002000000000000-0000-dev_b" } },
          },
        ],
      },
      1,
      schema,
    );
    const affected = applyChangeEntry(
      tables,
      {
        id: "chg_old",
        ts: 1,
        device: "dev_a",
        hlc: "000001000000000000-0000-dev_a",
        ops: [
          {
            type: "upsert",
            table: "t",
            rowId: "r1",
            columns: { name: { value: "older", hlc: "000001000000000000-0000-dev_a" } },
          },
        ],
      },
      1,
      schema,
    );

    return { value: readColumn(tables.t.r1, "name"), affectedCount: affected.length };
  });

  expect(result).toEqual({ value: "newer", affectedCount: 0 });
});
