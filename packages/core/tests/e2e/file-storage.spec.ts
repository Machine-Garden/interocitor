import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/packages/core/tests/e2e/fixtures/harness.html");
  await page.evaluate(async () => {
    indexedDB.deleteDatabase("interocitor");
    localStorage.removeItem("interocitor-key");
  });
});

test.describe("durable file storage", () => {
  test("putFile/getFile/deleteFile round-trips encrypted bytes and metadata", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor, types } = await import("/packages/core/dist/index.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");
      const { generateKey, keyToPassphrase } = await import("/packages/core/dist/crypto/keys.js");
      const { MemoryLocalStore } = await import("/packages/core/dist/storage/memory-store.js");
      const { PortablePassphraseKeySource } =
        await import("/packages/core/dist/crypto/key-source.js");

      const schema = {
        tables: {
          notes: {
            fields: { text: types.string },
          },
        },
      };

      const passphrase = await keyToPassphrase(await generateKey());
      const engine = new Interocitor({
        appName: "FileTest",
        dbName: "file-test",
        schema,
        remotePath: "/mesh",
        keySource: new PortablePassphraseKeySource({ portableKey: passphrase }),
        localStore: new MemoryLocalStore(),
      });
      await engine.init();
      const adapter = new MemoryAdapter();
      await engine.setRemoteStorage(adapter);
      await engine.connect();

      const source = new TextEncoder().encode("hello encrypted file");
      const meta = await engine.putFile("docs/hello.txt", source, "text/plain");
      const stored = adapter.dump()["/mesh/files/docs/hello.txt"];
      const read = await engine.getFile("docs/hello.txt");
      const readMeta = await engine.getFileMetadata("docs/hello.txt");
      await engine.deleteFile("docs/hello.txt");
      const afterDelete = await engine.getFileMetadata("docs/hello.txt");

      return {
        uploadedByDeviceId: meta.uploadedByDeviceId,
        contentType: readMeta?.contentType,
        plaintextSize: readMeta?.plaintextSize,
        storedSize: readMeta?.storedSize,
        readText: new TextDecoder().decode(read),
        encryptedAtRest: !stored.includes("hello encrypted file"),
        afterDelete,
      };
    });

    expect(result.uploadedByDeviceId).toBeTruthy();
    expect(result.contentType).toBe("text/plain");
    expect(result.plaintextSize).toBe("hello encrypted file".length);
    expect(result.storedSize).toBeGreaterThan(result.plaintextSize!);
    expect(result.readText).toBe("hello encrypted file");
    expect(result.encryptedAtRest).toBe(true);
    expect(result.afterDelete).toBeNull();
  });

  test("a types.file column stores an immutable reference that getFile verifies", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor, types, toFileRef, FileIntegrityError } =
        await import("/packages/core/dist/index.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");
      const { generateKey, keyToPassphrase } = await import("/packages/core/dist/crypto/keys.js");
      const { MemoryLocalStore } = await import("/packages/core/dist/storage/memory-store.js");
      const { PortablePassphraseKeySource } =
        await import("/packages/core/dist/crypto/key-source.js");

      const schema = {
        tables: {
          readings: {
            fields: { label: types.string, entities: types.file },
          },
        },
      };

      const passphrase = await keyToPassphrase(await generateKey());
      const engine = new Interocitor({
        appName: "FileRefTest",
        dbName: "file-ref-test",
        schema,
        remotePath: "/mesh",
        keySource: new PortablePassphraseKeySource({ portableKey: passphrase }),
        localStore: new MemoryLocalStore(),
      });
      await engine.init();
      await engine.setRemoteStorage(new MemoryAdapter());
      await engine.connect();

      const first = JSON.stringify([{ name: "Aya", kind: "person" }]);
      const meta = await engine.putFile("readings/f3/entities.json", first, "application/json");
      const ref = toFileRef("readings/f3/entities.json", meta);
      const readings = engine.table("readings");
      const id = await readings.add({ label: "f3", entities: ref });
      const row = await readings.row(id);

      const viaRef = new TextDecoder().decode(await engine.getFile(row!.entities));
      const metaViaRef = await engine.getFileMetadata(row!.entities);

      // Overwrite the path: the old reference must now be refused, not served.
      const second = JSON.stringify([{ name: "Bo", kind: "person" }]);
      const meta2 = await engine.putFile("readings/f3/entities.json", second, "application/json");
      let staleError: unknown = null;
      try {
        await engine.getFile(row!.entities);
      } catch (err) {
        staleError = err;
      }
      const viaPath = new TextDecoder().decode(await engine.getFile("readings/f3/entities.json"));

      return {
        digestLength: meta.digest?.length,
        ref,
        rowRef: row!.entities,
        viaRef,
        metaPath: metaViaRef?.path,
        digestChanged: meta2.digest !== meta.digest,
        staleIsIntegrityError: staleError instanceof FileIntegrityError,
        staleCode: (staleError as { code?: string } | null)?.code,
        viaPath,
      };
    });

    expect(result.digestLength).toBe(64);
    expect(result.ref).toEqual({
      path: "readings/f3/entities.json",
      digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      size: JSON.stringify([{ name: "Aya", kind: "person" }]).length,
      contentType: "application/json",
    });
    expect(result.rowRef).toEqual(result.ref);
    expect(result.viaRef).toBe(JSON.stringify([{ name: "Aya", kind: "person" }]));
    expect(result.metaPath).toBe("/mesh/files/readings/f3/entities.json");
    expect(result.digestChanged).toBe(true);
    expect(result.staleIsIntegrityError).toBe(true);
    expect(result.staleCode).toBe("FILE_INTEGRITY");
    expect(result.viaPath).toBe(JSON.stringify([{ name: "Bo", kind: "person" }]));
  });

  test("sealed files expose taint and defer decryption until caller opens with the extra key", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor, types } = await import("/packages/core/dist/index.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");
      const { generateKey, keyToPassphrase } = await import("/packages/core/dist/crypto/keys.js");
      const { MemoryLocalStore } = await import("/packages/core/dist/storage/memory-store.js");
      const { PortablePassphraseKeySource } =
        await import("/packages/core/dist/crypto/key-source.js");

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
      const engine = new Interocitor({
        appName: "SealedFileTest",
        dbName: "sealed-file-test",
        schema,
        remotePath: "/mesh",
        keySource: new PortablePassphraseKeySource({ portableKey: meshPassphrase }),
        localStore: new MemoryLocalStore(),
      });
      await engine.init();
      await engine.setRemoteStorage(new MemoryAdapter());
      await engine.connect();

      const source = new TextEncoder().encode("group-only file");
      const meta = await engine.putFile("docs/group.txt", source, "text/plain", {
        taint: "group1",
        key: groupKey,
      });
      const readMeta = await engine.getFileMetadata("docs/group.txt");
      const sealed = await engine.openFile("docs/group.txt");

      let getFileError = "";
      try {
        await engine.getFile("docs/group.txt");
      } catch (err) {
        getFileError = err instanceof Error ? err.message : String(err);
      }

      let missingKeyError = "";
      try {
        await sealed.open();
      } catch (err) {
        missingKeyError = err instanceof Error ? err.message : String(err);
      }

      let wrongKeyError = "";
      try {
        await sealed.open(wrongKey);
      } catch (err) {
        wrongKeyError = err instanceof Error ? err.name : String(err);
      }

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

    expect(result.metaTaint).toBe("group1");
    expect(result.readMetaTaint).toBe("group1");
    expect(result.sealedTaint).toBe("group1");
    expect(result.sealedContentType).toBe("text/plain");
    expect(result.getFileError).toContain("tainted with group1");
    expect(result.missingKeyError).toContain("matching key is required");
    expect(result.wrongKeyError).toBeTruthy();
    expect(result.openedText).toBe("group-only file");
  });
});
