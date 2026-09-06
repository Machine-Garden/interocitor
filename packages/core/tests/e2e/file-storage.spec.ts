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
      const remotePaths = Object.keys(adapter.dump());
      const storedPath = remotePaths.find((p) => p.startsWith("/mesh/files/"))!;
      const stored = adapter.dump()[storedPath];
      const remoteMeta = await adapter.getStoredFileMetadata(storedPath);
      const read = await engine.getFile("docs/hello.txt");
      const readMeta = await engine.getFileMetadata("docs/hello.txt");
      await engine.deleteFile("docs/hello.txt");
      const afterDelete = await engine.getFileMetadata("docs/hello.txt");

      return {
        uploadedByDeviceId: meta.uploadedByDeviceId,
        metaPath: meta.path,
        storedPath,
        remoteMetaKeys: Object.keys(remoteMeta ?? {}).filter(
          (k) => remoteMeta?.[k as keyof typeof remoteMeta] !== undefined,
        ),
        contentType: readMeta?.contentType,
        plaintextSize: readMeta?.plaintextSize,
        storedSize: readMeta?.storedSize,
        digest: readMeta?.digest,
        readText: new TextDecoder().decode(read),
        encryptedAtRest: !stored.includes("hello encrypted file") && !stored.includes("text/plain"),
        afterDelete,
        remoteFiles: remotePaths.filter((p) => p.startsWith("/mesh/files/")).length,
      };
    });

    expect(result.uploadedByDeviceId).toBeTruthy();
    // The remote sees a keyed hash, never the application path.
    expect(result.remoteFiles).toBe(1);
    expect(result.storedPath).toMatch(/^\/mesh\/files\/[0-9a-f]{64}$/);
    expect(result.storedPath).not.toContain("hello");
    expect(result.metaPath).toBe(result.storedPath);
    // Adapter-held metadata carries nothing about the plaintext.
    expect(result.remoteMetaKeys).not.toContain("contentType");
    expect(result.remoteMetaKeys).not.toContain("taint");
    expect(result.remoteMetaKeys).not.toContain("plaintextSize");
    expect(result.remoteMetaKeys).not.toContain("digest");
    expect(result.contentType).toBe("text/plain");
    expect(result.plaintextSize).toBe("hello encrypted file".length);
    expect(result.storedSize).toBeGreaterThan(result.plaintextSize!);
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
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
    expect(result.metaPath).toMatch(/^\/mesh\/files\/[0-9a-f]{64}$/);
    expect(result.digestChanged).toBe(true);
    expect(result.staleIsIntegrityError).toBe(true);
    expect(result.staleCode).toBe("FILE_INTEGRITY");
    expect(result.viaPath).toBe(JSON.stringify([{ name: "Bo", kind: "person" }]));
  });

  test("a second device with the same key resolves the same hidden path; another mesh key cannot", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor, types } = await import("/packages/core/dist/index.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");
      const { generateKey, keyToPassphrase } = await import("/packages/core/dist/crypto/keys.js");
      const { MemoryLocalStore } = await import("/packages/core/dist/storage/memory-store.js");
      const { PortablePassphraseKeySource } =
        await import("/packages/core/dist/crypto/key-source.js");

      const schema = { tables: { notes: { fields: { text: types.string } } } };
      const passphrase = await keyToPassphrase(await generateKey());
      const adapter = new MemoryAdapter();
      const open = async (dbName: string, portableKey: string) => {
        const engine = new Interocitor({
          appName: "HiddenPathTest",
          dbName,
          schema,
          remotePath: "/mesh",
          keySource: new PortablePassphraseKeySource({ portableKey }),
          localStore: new MemoryLocalStore(),
        });
        await engine.init();
        await engine.setRemoteStorage(adapter);
        await engine.connect();
        return engine;
      };

      const alice = await open("hidden-alice", passphrase);
      await alice.putFile("photos/beach.jpg", new TextEncoder().encode("jpeg bytes"), "image/jpeg");
      const bob = await open("hidden-bob", passphrase);
      const viaBob = new TextDecoder().decode(await bob.getFile("photos/beach.jpg"));

      const stranger = await open("hidden-stranger", await keyToPassphrase(await generateKey()));
      const strangerSees = await stranger.getFileMetadata("photos/beach.jpg");

      return {
        viaBob,
        strangerSees,
        remoteFiles: Object.keys(adapter.dump()).filter((p) => p.includes("/files/")),
      };
    });

    expect(result.viaBob).toBe("jpeg bytes");
    expect(result.strangerSees).toBeNull();
    expect(result.remoteFiles).toHaveLength(1);
  });

  test("an unencrypted mesh keeps plain paths and readable headers", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor, types } = await import("/packages/core/dist/index.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");
      const { MemoryLocalStore } = await import("/packages/core/dist/storage/memory-store.js");

      const engine = new Interocitor({
        appName: "PlainFileTest",
        dbName: "plain-file-test",
        schema: { tables: { notes: { fields: { text: types.string } } } },
        remotePath: "/mesh",
        keySource: null,
        localStore: new MemoryLocalStore(),
      });
      await engine.init();
      const adapter = new MemoryAdapter();
      await engine.setRemoteStorage(adapter);
      await engine.connect();

      await engine.putFile("docs/plain.txt", "plain text", "text/plain");
      const stored = adapter.dump()["/mesh/files/docs/plain.txt"];
      const meta = await engine.getFileMetadata("docs/plain.txt");
      return {
        storedPresent: stored !== undefined,
        storedHasText: stored?.includes("plain text") ?? false,
        contentType: meta?.contentType,
        readText: new TextDecoder().decode(await engine.getFile("docs/plain.txt")),
      };
    });

    expect(result.storedPresent).toBe(true);
    expect(result.storedHasText).toBe(true);
    expect(result.contentType).toBe("text/plain");
    expect(result.readText).toBe("plain text");
  });

  test("a sealed file cannot be replaced or deleted without its extra key", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor } = await import("/packages/core/dist/index.js");
      const { MemoryAdapter } = await import("/packages/core/dist/adapters/memory.js");
      const { generateKey, keyToPassphrase } = await import("/packages/core/dist/crypto/keys.js");
      const { MemoryLocalStore } = await import("/packages/core/dist/storage/memory-store.js");
      const { PortablePassphraseKeySource } =
        await import("/packages/core/dist/crypto/key-source.js");

      const groupKey = await generateKey();
      const wrongKey = await generateKey();
      const engine = new Interocitor({
        appName: "SealGuardTest",
        dbName: "seal-guard-test",
        schema: { tables: {} },
        remotePath: "/mesh",
        keySource: new PortablePassphraseKeySource({
          portableKey: await keyToPassphrase(await generateKey()),
        }),
        localStore: new MemoryLocalStore(),
      });
      await engine.init();
      const adapter = new MemoryAdapter();
      await engine.setRemoteStorage(adapter);
      await engine.connect();

      const attempt = async (run: () => Promise<unknown>) => {
        try {
          await run();
          return "ok";
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      };
      const seal = (key: CryptoKey) => ({ taint: "group1", key });
      await engine.putFile("docs/sealed.txt", "v1", "text/plain", seal(groupKey));
      const plainOverwrite = await attempt(() => engine.putFile("docs/sealed.txt", "v2"));
      const wrongKeyOverwrite = await attempt(() =>
        engine.putFile("docs/sealed.txt", "v2", "text/plain", seal(wrongKey)),
      );
      const plainDelete = await attempt(() => engine.deleteFile("docs/sealed.txt"));
      const rightOverwrite = await attempt(() =>
        engine.putFile("docs/sealed.txt", "v2", "text/plain", seal(groupKey)),
      );
      const stillThere = new TextDecoder().decode(
        await (await engine.openFile("docs/sealed.txt")).open(groupKey),
      );
      const rightDelete = await attempt(() =>
        engine.deleteFile("docs/sealed.txt", { key: groupKey }),
      );
      const remaining = Object.keys(adapter.dump()).filter((p) => p.startsWith("/mesh/files/"));
      return {
        plainOverwrite,
        wrongKeyOverwrite,
        plainDelete,
        rightOverwrite,
        stillThere,
        rightDelete,
        remaining,
      };
    });
    expect(result.plainOverwrite).toContain("sealed");
    expect(result.wrongKeyOverwrite).toContain("sealed");
    expect(result.plainDelete).toContain("sealed");
    expect(result.rightOverwrite).toBe("ok");
    expect(result.stillThere).toBe("v2");
    expect(result.rightDelete).toBe("ok");
    expect(result.remaining).toEqual([]);
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
