import { expect, test } from "@playwright/test";

/* eslint-disable unicorn/consistent-function-scoping -- Browser-context helpers must be defined inside page.evaluate. */

test.beforeEach(async ({ page }) => {
  await page.goto("/packages/web/tests/e2e/fixtures/harness.html");
  await page.evaluate(() => {
    localStorage.removeItem("interocitor-secret:crypto-test");
  });
});

test.describe("BrowserStorageSecretStore", () => {
  test("persists and restores exported key bytes from localStorage", async ({ page }) => {
    const result = await page.evaluate(async () => {
      function toHex(bytes: Uint8Array): string {
        return Array.from(bytes)
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
      }
      const { generateKey, exportKeyRaw } = await import("/packages/core/dist/crypto/keys.js");
      const { BrowserStorageSecretStore } = await import("/packages/web/dist/index.js");
      const raw = await exportKeyRaw(await generateKey());
      const store = new BrowserStorageSecretStore("crypto-test");
      await store.save(raw);
      const restored = await store.load();
      return { match: restored !== null && toHex(raw) === toHex(restored) };
    });

    expect(result.match).toBe(true);
  });

  test("load returns null when no secret is stored", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { BrowserStorageSecretStore } = await import("/packages/web/dist/index.js");
      return new BrowserStorageSecretStore("crypto-test").load();
    });

    expect(result).toBeNull();
  });

  test("clear removes the stored secret", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { generateKey, exportKeyRaw } = await import("/packages/core/dist/crypto/keys.js");
      const { BrowserStorageSecretStore } = await import("/packages/web/dist/index.js");
      const store = new BrowserStorageSecretStore("crypto-test");
      await store.save(await exportKeyRaw(await generateKey()));
      await store.clear();
      return store.load();
    });

    expect(result).toBeNull();
  });
});
