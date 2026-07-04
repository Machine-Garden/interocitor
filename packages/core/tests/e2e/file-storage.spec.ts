import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/packages/core/tests/e2e/fixtures/harness.html');
  await page.evaluate(async () => {
    indexedDB.deleteDatabase('interocitor');
    localStorage.removeItem('interocitor-key');
  });
});

test.describe('durable file storage', () => {
  test('putFile/getFile/deleteFile round-trips encrypted bytes and metadata', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor, types } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');
      const { generateKey, keyToPassphrase } = await import('/packages/core/dist/crypto/keys.js');
      const { MemoryLocalStore } = await import('/packages/core/dist/storage/memory-store.js');
      const { PortablePassphraseKeySource } = await import('/packages/core/dist/crypto/key-source.js');

      const schema = {
        tables: {
          notes: {
            fields: { text: types.string },
          },
        },
      };

      const passphrase = await keyToPassphrase(await generateKey());
      const engine = new Interocitor({ appName: 'FileTest', dbName: 'file-test', schema, remotePath: '/mesh', keySource: new PortablePassphraseKeySource({ portableKey: passphrase }), localStore: new MemoryLocalStore() });
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

  test('sealed files expose taint and defer decryption until caller opens with the extra key', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor, types } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');
      const { generateKey, keyToPassphrase } = await import('/packages/core/dist/crypto/keys.js');
      const { MemoryLocalStore } = await import('/packages/core/dist/storage/memory-store.js');
      const { PortablePassphraseKeySource } = await import('/packages/core/dist/crypto/key-source.js');

      const schema = {
        tables: {
          files: {
            fields: { path: types.string, taint: types.string },
          },
        },
      };

      const meshPassphrase = await keyToPassphrase(await generateKey());
      const groupKey = await generateKey();
      const wrongKey = await generateKey();
      const engine = new Interocitor({ appName: 'SealedFileTest', dbName: 'sealed-file-test', schema, remotePath: '/mesh', keySource: new PortablePassphraseKeySource({ portableKey: meshPassphrase }), localStore: new MemoryLocalStore() });
      await engine.init();
      await engine.setRemoteStorage(new MemoryAdapter());
      await engine.connect();

      const source = new TextEncoder().encode('group-only file');
      const meta = await engine.putFile('docs/group.txt', source, 'text/plain', { taint: 'group1', key: groupKey });
      const readMeta = await engine.getFileMetadata('docs/group.txt');
      const sealed = await engine.openFile('docs/group.txt');

      let getFileError = '';
      try { await engine.getFile('docs/group.txt'); } catch (err) { getFileError = err instanceof Error ? err.message : String(err); }

      let missingKeyError = '';
      try { await sealed.open(); } catch (err) { missingKeyError = err instanceof Error ? err.message : String(err); }

      let wrongKeyError = '';
      try { await sealed.open(wrongKey); } catch (err) { wrongKeyError = err instanceof Error ? err.name : String(err); }

      const opened = await sealed.open(groupKey);

      return {
        metaTaint: meta.taint,
        readMetaTaint: readMeta?.taint,
        sealedTaint: sealed.taint,
        sealedContentType: sealed.metadata.contentType,
        getFileError,
        missingKeyError,
        wrongKeyError,
        openedText: new TextDecoder().decode(opened),
      };
    });

    expect(result.metaTaint).toBe('group1');
    expect(result.readMetaTaint).toBe('group1');
    expect(result.sealedTaint).toBe('group1');
    expect(result.sealedContentType).toBe('text/plain');
    expect(result.getFileError).toContain('tainted with group1');
    expect(result.missingKeyError).toContain('matching key is required');
    expect(result.wrongKeyError).toBeTruthy();
    expect(result.openedText).toBe('group-only file');
  });
});
