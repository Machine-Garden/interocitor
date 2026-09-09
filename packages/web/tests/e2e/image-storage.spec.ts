import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/packages/web/tests/e2e/fixtures/harness.html");
  await page.evaluate(async () => {
    indexedDB.deleteDatabase("interocitor");
  });
});

test("putImage/getImage/getImageBlobUrl handles data URLs and revokable blob URLs", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { Interocitor, types } = await import("/packages/core/dist/index.js");
    const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");
    const { generateKey, keyToPassphrase } = await import("/packages/core/dist/crypto/keys.js");
    const { MemoryLocalStore } = await import("/packages/core/dist/storage/memory-store.js");
    const { PortablePassphraseKeySource } =
      await import("/packages/core/dist/crypto/key-source.js");
    const { putImage, getImage, getImageBlobUrl } = await import("/packages/web/dist/index.js");

    const schema = {
      tables: {
        images: {
          fields: { path: types.string },
        },
      },
    };

    const passphrase = await keyToPassphrase(await generateKey());
    const engine = new Interocitor({
      appName: "ImageTest",
      dbName: "image-test",
      schema,
      remotePath: "/mesh",
      keySource: new PortablePassphraseKeySource({ portableKey: passphrase }),
      localStore: new MemoryLocalStore(),
    });
    await engine.init();
    await engine.setRemoteStorage(new MemoryAdapter());
    await engine.connect();

    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="red"/></svg>';
    const dataUrl = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    const meta = await putImage(engine, "avatars/me.svg", dataUrl);
    const image = await getImage(engine, "avatars/me.svg");
    const view = await getImageBlobUrl(engine, "avatars/me.svg");
    const urlBeforeRevoke = view.url;
    view.revoke();
    const afterReads = await engine.getFileMetadata("avatars/me.svg");

    return {
      metaType: meta.contentType,
      imageType: image.contentType,
      blobType: image.blob.type,
      text: await image.blob.text(),
      urlBeforeRevoke,
      useCount: afterReads?.useCount,
    };
  });

  expect(result.metaType).toBe("image/svg+xml");
  expect(result.imageType).toBe("image/svg+xml");
  expect(result.blobType).toBe("image/svg+xml");
  expect(result.text).toContain("<svg");
  expect(result.urlBeforeRevoke).toMatch(/^blob:/);
  expect(result.useCount).toBeGreaterThanOrEqual(1);
});
