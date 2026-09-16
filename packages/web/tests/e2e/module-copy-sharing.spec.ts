import { expect, test } from "@playwright/test";

// State that must be shared between two copies of @interocitor/web.
//
// A bundler that emits one module into two chunks, or a tree holding two
// installs of this package, gives each copy its own module-level state. The
// browser reproduces that exactly: two `import()` calls for one built file
// under different URLs are two module instances, while their own relative
// imports still resolve to the single shared graph.
//
// Both assertions below fail when the state lives in a module-level Map.

test.beforeEach(async ({ page }) => {
  await page.goto("/packages/web/tests/e2e/fixtures/harness.html");
});

test.describe("duplicated package copies", () => {
  test("a store format registered through one copy is known to the other", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const base = "/packages/web/dist/storage/named-local-store.js";
      const [copyA, copyB] = await Promise.all([
        import(`${base}?copy=a`),
        import(`${base}?copy=b`),
      ]);

      copyA.registerStoreFormat({ id: "cross_copy_probe", requiresFreshGeneration: false });

      const seenByB = copyB.getStoreFormat("cross_copy_probe") !== undefined;
      const listedByB = copyB.listStoreFormats().includes("cross_copy_probe");

      // Teardown through the other copy has to reach the same registry too.
      copyB.unregisterStoreFormat("cross_copy_probe");
      const goneFromA = copyA.getStoreFormat("cross_copy_probe") === undefined;

      return {
        seenByB,
        listedByB,
        goneFromA,
        builtinIsOneObject:
          copyA.getStoreFormat("plaintext-rows-v1") === copyB.getStoreFormat("plaintext-rows-v1"),
      };
    });

    expect(result.seenByB).toBe(true);
    expect(result.listedByB).toBe(true);
    expect(result.goneFromA).toBe(true);
    expect(result.builtinIsOneObject).toBe(true);
  });

  test("the in-memory slot tier is one store across copies", async ({ page }) => {
    const result = await page.evaluate(async () => {
      // The memory tier is only the whole slot store where localStorage is
      // absent — SSR, private mode, a partitioned worker. With localStorage
      // present it merely mirrors, which would hide a split memory map.
      const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
      Object.defineProperty(globalThis, "localStorage", {
        value: undefined,
        configurable: true,
      });
      try {
        const base = "/packages/web/dist/storage/resilient-store.js";
        const [copyA, copyB] = await Promise.all([
          import(`${base}?copy=a`),
          import(`${base}?copy=b`),
        ]);

        // The marker a copy misses is the one that lets a degrade-to-memory
        // silently discard writes the remote has never seen.
        copyA.setUnpushedLocalWrites("CrossCopyProbe", true, copyA.createDefaultSlotStore());
        const dirtyForB = copyB.hasUnpushedLocalWrites(
          "CrossCopyProbe",
          copyB.createDefaultSlotStore(),
        );

        copyB.setUnpushedLocalWrites("CrossCopyProbe", false, copyB.createDefaultSlotStore());
        const rawForA = copyA.createDefaultSlotStore().get("interocitor:unpushed:CrossCopyProbe");

        return { dirtyForB, rawForA };
      } finally {
        if (original) Object.defineProperty(globalThis, "localStorage", original);
      }
    });

    expect(result.dirtyForB).toBe(true);
    expect(result.rawForA).toBe("0");
  });
});
