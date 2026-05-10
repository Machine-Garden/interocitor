import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/packages/core/tests/e2e/fixtures/harness.html');
  await page.evaluate(async () => {
    indexedDB.deleteDatabase('interocitor');
    localStorage.removeItem('interocitor-key');
  });
});

test.describe('durable file and image storage', () => {
  test('putFile/getFile/deleteFile round-trips encrypted bytes and metadata', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor, types } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');
      const { generateKey, keyToPassphrase } = await import('/packages/core/dist/crypto/keys.js');

      const schema = {
        tables: {
          notes: {
            fields: { text: types.string },
          },
        },
      };

      const passphrase = await keyToPassphrase(await generateKey());
      const engine = new Interocitor({ appName: 'FileTest', dbName: 'file-test', schema, encrypted: true, remotePath: '/mesh', passphrase });
      await engine.init();
      const adapter = new MemoryAdapter();
      await engine.setRemoteStorage(adapter);
      await engine.connect();

      const source = new TextEncoder().encode('hello encrypted file');
      const meta = await engine.putFile('docs/hello.txt', source, 'text/plain');
      const stored = adapter.dump()['/mesh/files/docs/hello.txt'];
      const read = await engine.getFile('docs/hello.txt');
      const readMeta = await engine.getFileMetadata('docs/hello.txt');
      await engine.deleteFile('docs/hello.txt');
      const afterDelete = await engine.getFileMetadata('docs/hello.txt');

      return {
        uploadedByDeviceId: meta.uploadedByDeviceId,
        contentType: readMeta?.contentType,
        plaintextSize: readMeta?.plaintextSize,
        storedSize: readMeta?.storedSize,
        readText: new TextDecoder().decode(read),
        encryptedAtRest: !stored.includes('hello encrypted file'),
        afterDelete,
      };
    });

    expect(result.uploadedByDeviceId).toBeTruthy();
    expect(result.contentType).toBe('text/plain');
    expect(result.plaintextSize).toBe('hello encrypted file'.length);
    expect(result.storedSize).toBeGreaterThan(result.plaintextSize!);
    expect(result.readText).toBe('hello encrypted file');
    expect(result.encryptedAtRest).toBe(true);
    expect(result.afterDelete).toBeNull();
  });

  test('putImage/getImage/getImageBlobUrl handles data URLs and revokable blob URLs', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor, types } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');
      const { generateKey, keyToPassphrase } = await import('/packages/core/dist/crypto/keys.js');

      const schema = {
        tables: {
          images: {
            fields: { path: types.string },
          },
        },
      };

      const passphrase = await keyToPassphrase(await generateKey());
      const engine = new Interocitor({ appName: 'ImageTest', dbName: 'image-test', schema, encrypted: true, remotePath: '/mesh', passphrase });
      await engine.init();
      await engine.setRemoteStorage(new MemoryAdapter());
      await engine.connect();

      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="red"/></svg>';
      const dataUrl = `data:image/svg+xml,${encodeURIComponent(svg)}`;
      const meta = await engine.putImage('avatars/me.svg', dataUrl);
      const image = await engine.getImage('avatars/me.svg');
      const view = await engine.getImageBlobUrl('avatars/me.svg');
      const urlBeforeRevoke = view.url;
      view.revoke();
      const afterReads = await engine.getFileMetadata('avatars/me.svg');

      return {
        metaType: meta.contentType,
        imageType: image.contentType,
        blobType: image.blob.type,
        text: new TextDecoder().decode(image.data),
        urlBeforeRevoke,
        useCount: afterReads?.useCount,
      };
    });

    expect(result.metaType).toBe('image/svg+xml');
    expect(result.imageType).toBe('image/svg+xml');
    expect(result.blobType).toBe('image/svg+xml');
    expect(result.text).toContain('<svg');
    expect(result.urlBeforeRevoke).toMatch(/^blob:/);
    expect(result.useCount).toBeGreaterThanOrEqual(1);
  });
});
