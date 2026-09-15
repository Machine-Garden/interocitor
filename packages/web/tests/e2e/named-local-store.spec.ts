import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/packages/web/tests/e2e/fixtures/harness.html");
});

test.describe("createNamedLocalStore", () => {
  test("keeps a healthy store on its current generation", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { createNamedLocalStore, getActiveLocalDatabaseName } =
        await import("/packages/web/dist/index.js");

      // In-memory pointer store so the test does not touch real localStorage.
      const pointerMemory = new Map<string, string>();
      const pointer = {
        get: (key: string) => pointerMemory.get(key) ?? null,
        set: (key: string, value: string) => {
          pointerMemory.set(key, value);
        },
      };

      const rotations: any[] = [];
      const degradations: any[] = [];
      const store = createNamedLocalStore({
        baseName: "IDBRotationTest",
        pointerStore: pointer,
        openTimeoutMs: 200,
        onLocalDegraded: (info: any) => {
          degradations.push(info.reason);
        },
        onRotated: (info: any) => {
          rotations.push(info);
        },
      });

      await store.open();
      const initialName = getActiveLocalDatabaseName("IDBRotationTest", pointer);

      await store.setMeta("canary", "healthy");
      const meta = await store.getMeta("canary");
      const finalName = getActiveLocalDatabaseName("IDBRotationTest", pointer);

      return {
        credentialNamespace: store.credentialNamespace,
        physicalDatabaseName: store.activeDatabaseName,
        initialName,
        finalName,
        rotations,
        degradations,
        meta,
      };
    });

    expect(result.initialName).toBe("IDBRotationTest");
    expect(result.finalName).toBe("IDBRotationTest");
    expect(result.credentialNamespace).toBe("IDBRotationTest");
    expect(result.physicalDatabaseName).toBe("IDBRotationTest");
    expect(result.meta).toBe("healthy");
    expect(result.rotations).toEqual([]);
    expect(result.degradations).toEqual([]);
  });

  test("persists rotation pointer across new store instances", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { createNamedLocalStore, getActiveLocalDatabaseName } =
        await import("/packages/web/dist/index.js");
      const pointerMemory = new Map<string, string>();
      const pointer = {
        get: (key: string) => pointerMemory.get(key) ?? null,
        set: (key: string, value: string) => {
          pointerMemory.set(key, value);
        },
      };

      // Pretend a previous session already rotated to v3.
      pointerMemory.set("interocitor:dbName:RotationPersistence", "RotationPersistence-v3");
      const store = createNamedLocalStore({
        baseName: "RotationPersistence",
        pointerStore: pointer,
        openTimeoutMs: 200,
      });
      await store.open();
      const observedName = getActiveLocalDatabaseName("RotationPersistence", pointer);
      return { observedName };
    });

    expect(result.observedName).toBe("RotationPersistence-v3");
  });

  test("explicitly rotates to a fresh physical generation before replacement", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { getActiveLocalDatabaseName, rotateLocalDatabaseName } =
        await import("/packages/web/dist/index.js");
      const pointerMemory = new Map<string, string>();
      const pointer = {
        get: (key: string) => pointerMemory.get(key) ?? null,
        set: (key: string, value: string) => {
          pointerMemory.set(key, value);
        },
      };

      const first = rotateLocalDatabaseName("Household", pointer);
      const second = rotateLocalDatabaseName("Household", pointer);
      return {
        first,
        second,
        active: getActiveLocalDatabaseName("Household", pointer),
      };
    });

    expect(result.first.from).toBe("Household");
    expect(result.first.to).toMatch(/^Household-v2-[0-9a-f]{16}$/);
    expect(result.second.from).toBe(result.first.to);
    expect(result.second.to).toMatch(/^Household-v3-[0-9a-f]{16}$/);
    expect(result.second.to).not.toBe(result.first.to);
    expect(result.active).toBe(result.second.to);
  });

  test("does not parse an unrelated suffix as a generation counter", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { rotateLocalDatabaseName } = await import("/packages/web/dist/index.js");
      const pointerMemory = new Map([["interocitor:dbName:Household", "Household-vault-v99"]]);
      return rotateLocalDatabaseName("Household", {
        get: (key) => pointerMemory.get(key) ?? null,
        set: (key, value) => pointerMemory.set(key, value),
      });
    });

    expect(result.from).toBe("Household-vault-v99");
    expect(result.to).toMatch(/^Household-v2-[0-9a-f]{16}$/);
  });

  test("rejects a physical generation wherever stable credential identity is required", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const { UnstableCredentialNamespaceError, createNamedLocalStore, createWebCredentialStore } =
        await import("/packages/web/dist/index.js");
      const physicalName = "Household-v2-0123456789abcdef";
      const errorCodes: string[] = [];
      for (const create of [
        () => createNamedLocalStore({ baseName: physicalName }),
        () => createWebCredentialStore(physicalName),
      ]) {
        try {
          create();
        } catch (error) {
          if (error instanceof UnstableCredentialNamespaceError) errorCodes.push(error.code);
        }
      }
      return errorCodes;
    });

    expect(result).toEqual(["UNSTABLE_CREDENTIAL_NAMESPACE", "UNSTABLE_CREDENTIAL_NAMESPACE"]);
  });

  test("opens a rotated generation without versionchanging or deleting a live old page", async ({
    context,
    page,
  }) => {
    const baseName = `LiveOldGeneration-${crypto.randomUUID()}`;
    const replacementPage = await context.newPage();
    await replacementPage.goto("/packages/web/tests/e2e/fixtures/harness.html");
    try {
      await page.evaluate(async (name) => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open(name, 2);
          request.onupgradeneeded = () => request.result.createObjectStore("old-data");
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        let versionChanges = 0;
        db.onversionchange = () => {
          versionChanges += 1;
        };
        Object.assign(window, {
          liveOldDatabase: db,
          readOldVersionChanges: () => versionChanges,
        });
      }, baseName);

      const replacement = await replacementPage.evaluate(async (name) => {
        const { createNamedLocalStore, getActiveLocalDatabaseName, rotateLocalDatabaseName } =
          await import("/packages/web/dist/index.js");
        const rotation = rotateLocalDatabaseName(name);
        const store = createNamedLocalStore({ baseName: name, openTimeoutMs: 2_000 });
        const degradations: string[] = [];
        const checkedStore = createNamedLocalStore({
          baseName: name,
          openTimeoutMs: 2_000,
          onLocalDegraded: (info: any) => degradations.push(info.reason),
        });
        await store.open();
        await store.setMeta("durable", "yes");
        store.close();
        await checkedStore.open();
        const durable = await checkedStore.getMeta("durable");
        checkedStore.close();
        return {
          rotation,
          active: getActiveLocalDatabaseName(name),
          durable,
          degradations,
        };
      }, baseName);
      await page.waitForTimeout(100);
      const old = await page.evaluate(() => ({
        versionChanges: (
          window as typeof window & { readOldVersionChanges: () => number }
        ).readOldVersionChanges(),
        stillOpen: Array.from(
          (window as typeof window & { liveOldDatabase: IDBDatabase }).liveOldDatabase
            .objectStoreNames,
        ).includes("old-data"),
      }));

      expect(replacement.rotation.to).toMatch(new RegExp(`^${baseName}-v2-[0-9a-f]{16}$`));
      expect(replacement.active).toBe(replacement.rotation.to);
      expect(replacement.durable).toBe("yes");
      expect(replacement.degradations).toEqual([]);
      expect(old).toEqual({ versionChanges: 0, stillOpen: true });
    } finally {
      await page.evaluate(() => {
        (window as typeof window & { liveOldDatabase?: IDBDatabase }).liveOldDatabase?.close();
      });
      await replacementPage.close();
    }
  });
});

test.describe("resetLocalDatabaseWithDeadline", () => {
  test("returns deterministic outcomes within the deadline", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { resetLocalDatabaseWithDeadline } = await import("/packages/web/dist/index.js");
      // Deleting a non-existent DB is a success in IndexedDB.
      const outcome = await resetLocalDatabaseWithDeadline(
        `nonexistent-${crypto.randomUUID()}`,
        1_000,
      );
      return { outcome };
    });

    expect(result.outcome).toBe("deleted");
  });

  test("reports blocked while the queued deletion completes after release", async ({
    context,
    page,
  }) => {
    const dbName = `delayed-delete-${crypto.randomUUID()}`;
    const resetPage = await context.newPage();
    await resetPage.goto("/packages/web/tests/e2e/fixtures/harness.html");
    try {
      await page.evaluate(async (name) => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open(name, 1);
          request.onupgradeneeded = () => request.result.createObjectStore("sentinel");
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        (window as typeof window & { deleteBlocker?: IDBDatabase }).deleteBlocker = db;
      }, dbName);
      const outcome = await resetPage.evaluate(async (name) => {
        const { resetLocalDatabaseWithDeadline } = await import("/packages/web/dist/index.js");
        return resetLocalDatabaseWithDeadline(name, 1_000);
      }, dbName);
      expect(outcome).toBe("blocked");

      await page.evaluate(() => {
        (window as typeof window & { deleteBlocker?: IDBDatabase }).deleteBlocker?.close();
      });
      const afterRelease = await resetPage.evaluate(async (name) => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 150);
        });
        return new Promise<{ version: number; stores: string[] }>((resolve, reject) => {
          const request = indexedDB.open(name);
          request.onsuccess = () => {
            const db = request.result;
            const result = { version: db.version, stores: Array.from(db.objectStoreNames) };
            db.close();
            resolve(result);
          };
          request.onerror = () => reject(request.error);
        });
      }, dbName);
      expect(afterRelease).toEqual({ version: 1, stores: [] });
    } finally {
      await resetPage.close();
    }
  });
});
