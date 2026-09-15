import { expect, test } from "@playwright/test";

/* eslint-disable unicorn/consistent-function-scoping -- Browser-context helpers must be defined inside page.evaluate. */

const NAMESPACE = "passphrase-test";
const OTHER_NAMESPACE = "passphrase-test-other";

/** Fast work factor: these tests exercise policy, not PBKDF2's cost. */
const FAST = { iterations: 10_000, minimumIterations: 10_000 } as const;

const CREDS = {
  portableKey: "portable-key-material",
  deviceId: "device-1",
  meshId: "mesh-1",
};

test.beforeEach(async ({ page }) => {
  await page.goto("/packages/web/tests/e2e/fixtures/harness.html");
  await page.evaluate(
    ([namespace, other]) => {
      for (const ns of [namespace, other]) {
        localStorage.removeItem(`interocitor-creds-envelope:${ns}`);
        localStorage.removeItem(`interocitor-creds-passphrase:${ns}`);
      }
    },
    [NAMESPACE, OTHER_NAMESPACE],
  );
});

test.describe("PassphraseEnvelopeKeyProvider", () => {
  test("round-trips a credential record through localStorage ciphertext", async ({ page }) => {
    const result = await page.evaluate(
      async ([namespace, fast, creds]) => {
        const { PassphraseEnvelopeKeyProvider, EnvelopedCredentialStore } =
          await import("/packages/web/dist/index.js");
        const writer = new PassphraseEnvelopeKeyProvider(namespace, fast);
        await writer.unlock("correct horse battery staple");
        await new EnvelopedCredentialStore(namespace, "localStorage", writer).save(creds);

        // A fresh provider, as after a reload: nothing is carried in memory.
        const reader = new PassphraseEnvelopeKeyProvider(namespace, fast);
        await reader.unlock("correct horse battery staple");
        const loaded = await new EnvelopedCredentialStore(namespace, "localStorage", reader).load();

        const stored = localStorage.getItem(`interocitor-creds-envelope:${namespace}`) ?? "";
        return { loaded, leaksPortableKey: stored.includes(creds.portableKey) };
      },
      [NAMESPACE, FAST, CREDS] as const,
    );

    expect(result.loaded).toEqual(CREDS);
    expect(result.leaksPortableKey).toBe(false);
  });

  test("never persists the derived key or the passphrase", async ({ page }) => {
    const leaks = await page.evaluate(
      async ([namespace, fast]) => {
        const { PassphraseEnvelopeKeyProvider } = await import("/packages/web/dist/index.js");
        const provider = new PassphraseEnvelopeKeyProvider(namespace, fast);
        await provider.unlock("correct horse battery staple");
        const record = await provider.keyRecord();
        const dump = [...Object.entries(localStorage), ...Object.entries(sessionStorage)].map(
          ([key, value]) => `${key}=${String(value)}`,
        );
        return {
          dump: dump.join("\n").includes("correct horse"),
          hasRecord: record !== null,
          sessionKeys: Object.keys(sessionStorage).length,
        };
      },
      [NAMESPACE, FAST] as const,
    );

    expect(leaks.dump).toBe(false);
    expect(leaks.hasRecord).toBe(true);
    expect(leaks.sessionKeys).toBe(0);
  });

  test("derives a non-extractable key", async ({ page }) => {
    const info = await page.evaluate(
      async ([namespace, fast]) => {
        const { PassphraseEnvelopeKeyProvider } = await import("/packages/web/dist/index.js");
        const provider = new PassphraseEnvelopeKeyProvider(namespace, fast);
        await provider.unlock("correct horse battery staple");
        const key = await provider.getKey("encrypt");
        let exportError = "";
        try {
          await crypto.subtle.exportKey("raw", key);
        } catch (error) {
          exportError = (error as Error).name;
        }
        return { extractable: key.extractable, algorithm: key.algorithm.name, exportError };
      },
      [NAMESPACE, FAST] as const,
    );

    expect(info.extractable).toBe(false);
    expect(info.algorithm).toBe("AES-GCM");
    expect(info.exportError).not.toBe("");
  });

  test("a wrong passphrase fails as a wrong passphrase, not as absent credentials", async ({
    page,
  }) => {
    const result = await page.evaluate(
      async ([namespace, fast, creds]) => {
        const { PassphraseEnvelopeKeyProvider, EnvelopedCredentialStore, WrongPassphraseError } =
          await import("/packages/web/dist/index.js");
        const writer = new PassphraseEnvelopeKeyProvider(namespace, fast);
        await writer.unlock("correct horse battery staple");
        await new EnvelopedCredentialStore(namespace, "localStorage", writer).save(creds);

        const reader = new PassphraseEnvelopeKeyProvider(namespace, fast);
        const unlock = await reader
          .unlock("incorrect horse battery staple")
          .then(() => ({ name: "", instanceOf: false }))
          .catch((error: Error) => ({
            name: error.name,
            instanceOf: error instanceof WrongPassphraseError,
          }));

        // The store path must reject too, never resolve to null.
        const store = new EnvelopedCredentialStore(namespace, "localStorage", {
          getKey: () => reader.getKey("decrypt"),
        });
        const load = await store
          .load()
          .then((value) => ({ name: "", resolvedTo: value }))
          .catch((error: Error) => ({ name: error.name, resolvedTo: undefined }));

        return { unlock, load, unlocked: reader.isUnlocked() };
      },
      [NAMESPACE, FAST, CREDS] as const,
    );

    expect(result.unlock.name).toBe("WrongPassphraseError");
    expect(result.unlock.instanceOf).toBe(true);
    // Locked, not wrong-passphrase, because no passphrase could be requested —
    // either way it is a throw, never a resolved null.
    expect(result.load.name).toBe("PassphraseLockedError");
    expect(result.load.resolvedTo).toBeUndefined();
    expect(result.unlocked).toBe(false);
  });

  test("a wrong passphrase supplied through requestPassphrase still rejects the load", async ({
    page,
  }) => {
    const result = await page.evaluate(
      async ([namespace, fast, creds]) => {
        const { PassphraseEnvelopeKeyProvider, EnvelopedCredentialStore } =
          await import("/packages/web/dist/index.js");
        const writer = new PassphraseEnvelopeKeyProvider(namespace, fast);
        await writer.unlock("correct horse battery staple");
        await new EnvelopedCredentialStore(namespace, "localStorage", writer).save(creds);

        const reader = new PassphraseEnvelopeKeyProvider(namespace, {
          ...fast,
          requestPassphrase: () => "wrong phrase entirely",
        });
        return new EnvelopedCredentialStore(namespace, "localStorage", reader)
          .load()
          .then((value) => ({ name: "", resolvedTo: value }))
          .catch((error: Error) => ({ name: error.name, resolvedTo: undefined }));
      },
      [NAMESPACE, FAST, CREDS] as const,
    );

    expect(result.name).toBe("WrongPassphraseError");
    expect(result.resolvedTo).toBeUndefined();
  });

  test("a decrypt with no key record throws instead of reporting no credentials", async ({
    page,
  }) => {
    const result = await page.evaluate(
      async ([namespace, fast, creds]) => {
        const { PassphraseEnvelopeKeyProvider, EnvelopedCredentialStore } =
          await import("/packages/web/dist/index.js");
        const writer = new PassphraseEnvelopeKeyProvider(namespace, fast);
        await writer.unlock("correct horse battery staple");
        await new EnvelopedCredentialStore(namespace, "localStorage", writer).save(creds);

        // The ciphertext survives; only the KDF record is lost.
        localStorage.removeItem(`interocitor-creds-passphrase:${namespace}`);

        const reader = new PassphraseEnvelopeKeyProvider(namespace, {
          ...fast,
          requestPassphrase: () => "correct horse battery staple",
        });
        return new EnvelopedCredentialStore(namespace, "localStorage", reader)
          .load()
          .then((value) => ({ name: "", resolvedTo: value }))
          .catch((error: Error) => ({ name: error.name, resolvedTo: undefined }));
      },
      [NAMESPACE, FAST, CREDS] as const,
    );

    expect(result.name).toBe("MissingPassphraseKeyRecordError");
    expect(result.resolvedTo).toBeUndefined();
  });

  test("the cache expires from last use, not from unlock", async ({ page }) => {
    const result = await page.evaluate(
      async ([namespace]) => {
        const { PassphraseEnvelopeKeyProvider } = await import("/packages/web/dist/index.js");
        const sleep = (ms: number) =>
          new Promise((resolve) => {
            setTimeout(resolve, ms);
          });
        const provider = new PassphraseEnvelopeKeyProvider(namespace, {
          iterations: 10_000,
          minimumIterations: 10_000,
          idleTimeoutMs: 300,
        });
        await provider.unlock("correct horse battery staple");

        // Two uses inside the window keep pushing the deadline out past the
        // original unlock time.
        await sleep(200);
        await provider.getKey("encrypt");
        await sleep(200);
        await provider.getKey("encrypt");
        const stillUnlockedAfterUse = provider.isUnlocked();

        await sleep(450);
        const unlockedAfterIdle = provider.isUnlocked();

        const afterIdle = await provider
          .getKey("decrypt")
          .then(() => "")
          .catch((error: Error) => error.name);

        return { stillUnlockedAfterUse, unlockedAfterIdle, afterIdle };
      },
      [NAMESPACE] as const,
    );

    expect(result.stillUnlockedAfterUse).toBe(true);
    expect(result.unlockedAfterIdle).toBe(false);
    expect(result.afterIdle).toBe("PassphraseLockedError");
  });

  test("lock() and clear() drop the cache but keep the record", async ({ page }) => {
    const result = await page.evaluate(
      async ([namespace, fast]) => {
        const { PassphraseEnvelopeKeyProvider } = await import("/packages/web/dist/index.js");
        const provider = new PassphraseEnvelopeKeyProvider(namespace, fast);
        await provider.unlock("correct horse battery staple");

        await provider.lock();
        const afterLock = provider.isUnlocked();
        const lockedError = await provider
          .getKey("decrypt")
          .then(() => "")
          .catch((error: Error) => error.name);

        await provider.unlock("correct horse battery staple");
        await provider.clear();
        const afterClear = provider.isUnlocked();
        const recordSurvives =
          localStorage.getItem(`interocitor-creds-passphrase:${namespace}`) !== null;

        // Re-unlocking with the same phrase still works: clear() is not a wipe.
        await provider.unlock("correct horse battery staple");
        const reUnlocked = provider.isUnlocked();

        await provider.deleteKeyRecord();
        const recordGone =
          localStorage.getItem(`interocitor-creds-passphrase:${namespace}`) === null;

        return { afterLock, lockedError, afterClear, recordSurvives, reUnlocked, recordGone };
      },
      [NAMESPACE, FAST] as const,
    );

    expect(result).toEqual({
      afterLock: false,
      lockedError: "PassphraseLockedError",
      afterClear: false,
      recordSurvives: true,
      reUnlocked: true,
      recordGone: true,
    });
  });

  test("rejects a record relabeled into another credential namespace", async ({ page }) => {
    const result = await page.evaluate(
      async ([namespace, other, fast]) => {
        const { PassphraseEnvelopeKeyProvider } = await import("/packages/web/dist/index.js");
        const provider = new PassphraseEnvelopeKeyProvider(namespace, fast);
        await provider.unlock("correct horse battery staple");
        const raw = localStorage.getItem(`interocitor-creds-passphrase:${namespace}`)!;

        // Copied verbatim into another namespace: the stored `namespace` field
        // still says where it came from.
        localStorage.setItem(`interocitor-creds-passphrase:${other}`, raw);
        const copied = await new PassphraseEnvelopeKeyProvider(other, fast)
          .unlock("correct horse battery staple")
          .then(() => "")
          .catch((error: Error) => error.name);

        // Relabeled as well, so only AAD is left to catch it.
        const record = JSON.parse(raw) as { namespace: string };
        record.namespace = other;
        localStorage.setItem(`interocitor-creds-passphrase:${other}`, JSON.stringify(record));
        const relabeled = await new PassphraseEnvelopeKeyProvider(other, fast)
          .unlock("correct horse battery staple")
          .then(() => "")
          .catch((error: Error) => error.name);

        return { copied, relabeled };
      },
      [NAMESPACE, OTHER_NAMESPACE, FAST] as const,
    );

    expect(result.copied).toBe("PassphraseNamespaceMismatchError");
    expect(result.relabeled).toBe("WrongPassphraseError");
  });

  test("rejects a record whose public KDF parameters were edited", async ({ page }) => {
    const result = await page.evaluate(
      async ([namespace, fast]) => {
        const { PassphraseEnvelopeKeyProvider } = await import("/packages/web/dist/index.js");
        await new PassphraseEnvelopeKeyProvider(namespace, fast).unlock("correct horse");
        const key = `interocitor-creds-passphrase:${namespace}`;
        const record = JSON.parse(localStorage.getItem(key)!) as {
          kdf: { iterations: number };
        };
        record.kdf.iterations = fast.iterations + 1;
        localStorage.setItem(key, JSON.stringify(record));

        return new PassphraseEnvelopeKeyProvider(namespace, {
          iterations: fast.iterations + 1,
          minimumIterations: 1000,
        })
          .unlock("correct horse")
          .then(() => "")
          .catch((error: Error) => error.name);
      },
      [NAMESPACE, FAST] as const,
    );

    expect(result).toBe("WrongPassphraseError");
  });

  test("an old record still opens after the accepted minimum is raised beneath it", async ({
    page,
  }) => {
    const result = await page.evaluate(
      async ([namespace, creds]) => {
        const { PassphraseEnvelopeKeyProvider, EnvelopedCredentialStore } =
          await import("/packages/web/dist/index.js");
        const writer = new PassphraseEnvelopeKeyProvider(namespace, {
          iterations: 30_000,
          minimumIterations: 10_000,
        });
        await writer.unlock("correct horse battery staple");
        await new EnvelopedCredentialStore(namespace, "localStorage", writer).save(creds);

        // The build later raises its floor — still under the record's own count.
        const raised = new PassphraseEnvelopeKeyProvider(namespace, {
          iterations: 60_000,
          minimumIterations: 20_000,
        });
        await raised.unlock("correct horse battery staple");
        const loaded = await new EnvelopedCredentialStore(namespace, "localStorage", raised).load();
        const usedIterations = (await raised.keyRecord())?.kdf.iterations;

        // Raised above the record's count: refused loudly, not silently.
        const tooWeak = await new PassphraseEnvelopeKeyProvider(namespace, {
          iterations: 60_000,
          minimumIterations: 50_000,
        })
          .unlock("correct horse battery staple")
          .then(() => "")
          .catch((error: Error) => error.name);

        return { loaded, usedIterations, tooWeak };
      },
      [NAMESPACE, CREDS] as const,
    );

    expect(result.loaded).toEqual(CREDS);
    expect(result.usedIterations).toBe(30_000);
    expect(result.tooWeak).toBe("InvalidPassphraseKeyRecordError");
  });

  test("provisions only once across concurrent getKey calls", async ({ page }) => {
    const result = await page.evaluate(
      async ([namespace, fast]) => {
        const { PassphraseEnvelopeKeyProvider } = await import("/packages/web/dist/index.js");
        let prompts = 0;
        const provider = new PassphraseEnvelopeKeyProvider(namespace, {
          ...fast,
          requestPassphrase: () => {
            prompts += 1;
            return "correct horse battery staple";
          },
        });
        const keys = await Promise.all([
          provider.getKey("encrypt"),
          provider.getKey("encrypt"),
          provider.getKey("encrypt"),
        ]);
        return { prompts, same: keys[0] === keys[1] && keys[1] === keys[2] };
      },
      [NAMESPACE, FAST] as const,
    );

    expect(result).toEqual({ prompts: 1, same: true });
  });
});
