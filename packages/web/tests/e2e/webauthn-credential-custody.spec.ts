import { expect, test } from "@playwright/test";

/* eslint-disable unicorn/consistent-function-scoping -- Browser-context helpers must be defined inside page.evaluate. */

/**
 * A scriptable stand-in for a platform authenticator.
 *
 * Playwright's virtual authenticator cannot express the cases this suite is
 * about: a credential that answers a discoverable read for the wrong
 * namespace, a `largeBlob` write that reports `written: false`, or a blob left
 * behind in the pre-header format. The stub keeps blobs in a map so a test can
 * inspect exactly what reached "the keychain".
 */
function installFakeAuthenticator(): void {
  const toB64 = (bytes: Uint8Array): string => {
    let binary = "";
    for (const byte of bytes) binary += String.fromCodePoint(byte);
    return btoa(binary);
  };
  const fromB64 = (value: string): Uint8Array =>
    Uint8Array.from(atob(value), (c) => c.codePointAt(0)!);

  const blobs = new Map<string, Uint8Array | null>();
  const state = {
    /** "ok" | "decline" | "null-assertion" | "write-fail" */
    mode: "ok",
    /** Credential id the browser picks when `allowCredentials` is omitted. */
    discoverable: null as string | null,
    lastAllowCredentials: null as string[] | null,
    ceremonies: [] as string[],
    seedCredential(blob: number[] | null): string {
      const id = toB64(crypto.getRandomValues(new Uint8Array(16)));
      blobs.set(id, blob === null ? null : Uint8Array.from(blob));
      return id;
    },
    readBlob(id: string): number[] | null {
      const blob = blobs.get(id);
      return blob ? [...blob] : null;
    },
  };
  (globalThis as unknown as { __fake: typeof state }).__fake = state;

  const assertion = (id: string, results: unknown): unknown => ({
    rawId: fromB64(id).buffer,
    getClientExtensionResults: () => results,
  });

  Object.defineProperty(navigator, "credentials", {
    configurable: true,
    value: {
      async create(): Promise<unknown> {
        state.ceremonies.push("create");
        if (state.mode === "decline") throw new DOMException("declined", "NotAllowedError");
        const id = state.seedCredential(null);
        return assertion(id, { largeBlob: { supported: true } });
      },
      async get(options: { publicKey: Record<string, unknown> }): Promise<unknown> {
        const publicKey = options.publicKey;
        const descriptors = publicKey.allowCredentials as { id: ArrayBuffer }[] | undefined;
        const allow = descriptors
          ? descriptors.map((descriptor) => toB64(new Uint8Array(descriptor.id)))
          : null;
        const extensions = publicKey.extensions as
          | { largeBlob?: { write?: Uint8Array; read?: boolean } }
          | undefined;
        const write = extensions?.largeBlob?.write;
        state.lastAllowCredentials = allow;
        state.ceremonies.push(write ? "write" : "read");

        if (state.mode === "decline") throw new DOMException("declined", "NotAllowedError");
        if (state.mode === "null-assertion") return null;

        const id = allow
          ? (allow.find((candidate) => blobs.has(candidate)) ?? null)
          : state.discoverable;
        if (!id || !blobs.has(id)) {
          throw new DOMException("no matching credential", "NotAllowedError");
        }

        if (write) {
          if (state.mode === "write-fail") {
            return assertion(id, { largeBlob: { written: false } });
          }
          blobs.set(id, new Uint8Array(write));
          return assertion(id, { largeBlob: { written: true } });
        }
        const blob = blobs.get(id);
        return assertion(id, {
          largeBlob: blob ? { blob: new Uint8Array(blob).buffer } : {},
        });
      },
    },
  });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installFakeAuthenticator);
  await page.goto("/packages/web/tests/e2e/fixtures/harness.html");
  await page.evaluate(() => localStorage.clear());
});

const CREDS = { portableKey: "portable-key-abc", deviceId: "device-1", meshId: "mesh-9" };

test.describe("WebAuthn blob namespace tagging", () => {
  test("save frames the payload with a versioned namespace header", async ({ page }) => {
    const result = await page.evaluate(async (creds) => {
      const { WebAuthnCredentialStore } = await import("/packages/web/dist/credential-store.js");
      const fake = (globalThis as unknown as { __fake: any }).__fake;
      const store = new WebAuthnCredentialStore("tagging-db");
      await store.save(creds);
      const [id] = JSON.parse(localStorage.getItem("interocitor-cred-registry:tagging-db")!).map(
        (ref: { id: string }) => ref.id,
      );
      const blob = fake.readBlob(id) as number[];
      const header = String.fromCodePoint(...blob.slice(0, 4));
      const namespaceLength = (blob[5] << 8) | blob[6];
      return {
        header,
        version: blob[4],
        namespace: String.fromCodePoint(...blob.slice(7, 7 + namespaceLength)),
        loaded: await store.load(),
      };
    }, CREDS);

    expect(result.header).toBe("IOCB");
    expect(result.version).toBe(1);
    expect(result.namespace).toBe("tagging-db");
    expect(result.loaded).toEqual(CREDS);
  });

  test("load rejects a blob tagged for another namespace", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { WebAuthnCredentialStore, WebAuthnEnvelopeKeyProvider } =
        await import("/packages/web/dist/credential-store.js");
      const { credentialAvailabilityOf } = await import("/packages/web/dist/webauthn.js");
      const fake = (globalThis as unknown as { __fake: any }).__fake;

      // The envelope-key provider enrolls under "<db>:envelope-key" and stores
      // raw key material there.
      await new WebAuthnEnvelopeKeyProvider("swap-db").getKey("encrypt");
      const envelopeCredentialId = JSON.parse(
        localStorage.getItem("interocitor-cred-registry:swap-db:envelope-key")!,
      )[0].id;

      // The user clears site data. The passkey survives in the keychain and is
      // the only discoverable credential for this relying party.
      localStorage.clear();
      fake.discoverable = envelopeCredentialId;

      try {
        await new WebAuthnCredentialStore("swap-db").load();
        return { threw: false, availability: null, message: "" };
      } catch (error) {
        return {
          threw: true,
          availability: credentialAvailabilityOf(error),
          message: (error as Error).message,
        };
      }
    });

    expect(result.threw).toBe(true);
    expect(result.availability).toBe("unreadable");
    expect(result.message).toContain("swap-db:envelope-key");
  });

  test("allowCredentials stays populated when the attachment filter matches nothing", async ({
    page,
  }) => {
    const result = await page.evaluate(async (creds) => {
      const { WebAuthnBlobStore } = await import("/packages/web/dist/webauthn.js");
      const fake = (globalThis as unknown as { __fake: any }).__fake;
      const store = new WebAuthnBlobStore("filtered-ns", { authenticatorAttachment: "platform" });
      await store.save(new TextEncoder().encode(JSON.stringify(creds)));

      fake.lastAllowCredentials = null;
      // No cross-platform ref is remembered, but a platform one is: the read
      // must still be constrained to known credentials.
      await store.load({ authenticatorAttachment: "cross-platform" });
      return { allowCredentials: fake.lastAllowCredentials };
    }, CREDS);

    expect(result.allowCredentials).not.toBeNull();
    expect(result.allowCredentials).toHaveLength(1);
  });
});

test.describe("credential availability taxonomy", () => {
  test("a declined ceremony is unavailable, never absent", async ({ page }) => {
    const result = await page.evaluate(async (creds) => {
      const { WebAuthnCredentialStore } = await import("/packages/web/dist/credential-store.js");
      const { credentialAvailabilityOf } = await import("/packages/web/dist/webauthn.js");
      const fake = (globalThis as unknown as { __fake: any }).__fake;
      const store = new WebAuthnCredentialStore("declined-db");
      await store.save(creds);

      fake.mode = "decline";
      const outcomes: (string | null)[] = [];
      try {
        const loaded = await store.load();
        outcomes.push(loaded === null ? "null" : "loaded");
      } catch (error) {
        outcomes.push(credentialAvailabilityOf(error));
      }

      fake.mode = "null-assertion";
      try {
        const loaded = await store.load();
        outcomes.push(loaded === null ? "null" : "loaded");
      } catch (error) {
        outcomes.push(credentialAvailabilityOf(error));
      }
      return outcomes;
    }, CREDS);

    expect(result).toEqual(["unavailable", "unavailable"]);
  });

  test("a credential holding no blob is absent", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { WebAuthnCredentialStore } = await import("/packages/web/dist/credential-store.js");
      const fake = (globalThis as unknown as { __fake: any }).__fake;
      const id = fake.seedCredential(null);
      localStorage.setItem(
        "interocitor-cred-registry:empty-db",
        JSON.stringify([{ id, authenticatorAttachment: "platform", createdAt: Date.now() }]),
      );
      return new WebAuthnCredentialStore("empty-db").load();
    });

    expect(result).toBeNull();
  });

  test("bytes that are not a credential record are unreadable", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { WebAuthnCredentialStore } = await import("/packages/web/dist/credential-store.js");
      const { credentialAvailabilityOf } = await import("/packages/web/dist/webauthn.js");
      const fake = (globalThis as unknown as { __fake: any }).__fake;
      // An untagged blob of raw AES key bytes: exactly what the old
      // envelope-key format wrote.
      const id = fake.seedCredential([...crypto.getRandomValues(new Uint8Array(32))]);
      localStorage.setItem(
        "interocitor-cred-registry:raw-bytes-db",
        JSON.stringify([{ id, authenticatorAttachment: "platform", createdAt: Date.now() }]),
      );
      try {
        await new WebAuthnCredentialStore("raw-bytes-db").load();
        return null;
      } catch (error) {
        return credentialAvailabilityOf(error);
      }
    });

    expect(result).toBe("unreadable");
  });
});

test.describe("clear destroys the stored blob", () => {
  test("overwrites the blob, drops the hints, and reports the surviving passkey", async ({
    page,
  }) => {
    const result = await page.evaluate(async (creds) => {
      const { WebAuthnCredentialStore } = await import("/packages/web/dist/credential-store.js");
      const fake = (globalThis as unknown as { __fake: any }).__fake;
      const store = new WebAuthnCredentialStore("clear-db");
      await store.save(creds);
      const id = JSON.parse(localStorage.getItem("interocitor-cred-registry:clear-db")!)[0].id;

      const report = await store.clearWithReport();
      const blobAfter = fake.readBlob(id) as number[];

      // The passkey is still in the keychain; a discoverable read now finds an
      // emptied namespace rather than a readable portable key.
      fake.discoverable = id;
      const reloaded = await new WebAuthnCredentialStore("clear-db").load();

      return {
        report,
        blobLength: blobAfter.length,
        blobHeader: String.fromCodePoint(...blobAfter.slice(0, 4)),
        hintsGone:
          localStorage.getItem("interocitor-cred-registry:clear-db") === null &&
          localStorage.getItem("interocitor-cred:clear-db") === null,
        reloaded,
      };
    }, CREDS);

    expect(result.report.residualRisk).toBe("credential-only");
    expect(result.report.overwritten).toHaveLength(1);
    expect(result.report.notOverwritten).toHaveLength(0);
    expect(result.report.message).toContain("passkey settings");
    expect(result.blobHeader).toBe("IOCB");
    // Header only: the payload is gone.
    expect(result.blobLength).toBe(7 + "clear-db".length);
    expect(result.hintsGone).toBe(true);
    expect(result.reloaded).toBeNull();
  });

  test("throws when a known credential could not be overwritten", async ({ page }) => {
    const result = await page.evaluate(async (creds) => {
      const { WebAuthnCredentialStore } = await import("/packages/web/dist/credential-store.js");
      const fake = (globalThis as unknown as { __fake: any }).__fake;
      const store = new WebAuthnCredentialStore("stubborn-db");
      await store.save(creds);
      const id = JSON.parse(localStorage.getItem("interocitor-cred-registry:stubborn-db")!)[0].id;

      fake.mode = "write-fail";
      try {
        await store.clear();
        return { threw: false, code: null, residualRisk: null, blobIntact: false };
      } catch (error) {
        const blob = fake.readBlob(id) as number[];
        return {
          threw: true,
          code: (error as { code?: string }).code ?? null,
          residualRisk: (error as { result?: { residualRisk: string } }).result?.residualRisk,
          blobIntact: blob.length > 7 + "stubborn-db".length,
        };
      }
    }, CREDS);

    expect(result.threw).toBe(true);
    expect(result.code).toBe("WEBAUTHN_RESIDUAL_CREDENTIAL");
    expect(result.residualRisk).toBe("blob-may-survive");
    expect(result.blobIntact).toBe(true);
  });

  test("reports `unknown` when no local credential reference survives", async ({ page }) => {
    const result = await page.evaluate(async (creds) => {
      const { WebAuthnCredentialStore } = await import("/packages/web/dist/credential-store.js");
      const fake = (globalThis as unknown as { __fake: any }).__fake;
      await new WebAuthnCredentialStore("orphan-db").save(creds);
      const id = JSON.parse(localStorage.getItem("interocitor-cred-registry:orphan-db")!)[0].id;
      const blobBefore = (fake.readBlob(id) as number[]).length;

      localStorage.clear();
      const report = await new WebAuthnCredentialStore("orphan-db").clearWithReport();
      return {
        report,
        blobUnchanged: (fake.readBlob(id) as number[]).length === blobBefore,
      };
    }, CREDS);

    // The documented gap: with the hints gone there is nothing to address a
    // write ceremony to, so the blob survives and clear() says so.
    expect(result.report.residualRisk).toBe("unknown");
    expect(result.report.knownCredentials).toBe(0);
    expect(result.report.message).toContain("passkey settings");
    expect(result.blobUnchanged).toBe(true);
  });

  test("EnvelopedCredentialStore.clear() clears the envelope and the key provider", async ({
    page,
  }) => {
    const result = await page.evaluate(async (creds) => {
      const { EnvelopedCredentialStore, MemoryCredentialEnvelopeStore } =
        await import("/packages/web/dist/credential-store.js");
      const calls: string[] = [];
      const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
      ]);
      const keyProvider = {
        envelopeKeyId: "spy",
        async getKey() {
          return key;
        },
        async clear() {
          calls.push("clear");
        },
      };
      const envelopeStore = new MemoryCredentialEnvelopeStore("wired-db");
      const store = new EnvelopedCredentialStore("wired-db", envelopeStore, keyProvider);
      await store.save(creds);
      await store.clear();
      return { calls, envelope: await envelopeStore.load() };
    }, CREDS);

    expect(result.calls).toEqual(["clear"]);
    expect(result.envelope).toBeNull();
  });
});

test.describe("envelope crypto hygiene", () => {
  test("envelope keys are non-extractable on both paths", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { WebAuthnEnvelopeKeyProvider } =
        await import("/packages/web/dist/credential-store.js");
      const provider = new WebAuthnEnvelopeKeyProvider("extractable-db");
      const encryptKey = await provider.getKey("encrypt");
      const decryptKey = await provider.getKey("decrypt");
      const derived = await provider.deriveKey({
        purpose: "decrypt",
        dbName: "extractable-db",
        salt: crypto.getRandomValues(new Uint8Array(16)),
      });
      return {
        encrypt: encryptKey.extractable,
        decrypt: decryptKey.extractable,
        derived: derived.extractable,
      };
    });

    expect(result).toEqual({ encrypt: false, decrypt: false, derived: false });
  });

  test("a v2 envelope records its KDF and derives a distinct KEK per salt", async ({ page }) => {
    const result = await page.evaluate(async (creds) => {
      const { EnvelopedCredentialStore, WebAuthnEnvelopeKeyProvider } =
        await import("/packages/web/dist/credential-store.js");
      const store = new EnvelopedCredentialStore(
        "kdf-db",
        "localStorage",
        new WebAuthnEnvelopeKeyProvider("kdf-db"),
      );
      await store.save(creds);
      const first = JSON.parse(localStorage.getItem("interocitor-creds-envelope:kdf-db")!);
      await store.save(creds);
      const second = JSON.parse(localStorage.getItem("interocitor-creds-envelope:kdf-db")!);
      return { first, second, loaded: await store.load() };
    }, CREDS);

    expect(result.first.v).toBe(2);
    expect(result.first.kdf).toEqual({ name: "HKDF-SHA-256", salt: expect.any(String) });
    expect(result.first.keyId).toBe("webauthn-largeblob");
    // Rewriting rotates the salt, so the same seed yields a different KEK.
    expect(result.second.kdf.salt).not.toBe(result.first.kdf.salt);
    expect(result.loaded).toEqual(CREDS);
  });

  test("the ciphertext is bound to its credential namespace", async ({ page }) => {
    const result = await page.evaluate(async (creds) => {
      const { EnvelopedCredentialStore, StaticEnvelopeKeyProvider } =
        await import("/packages/web/dist/credential-store.js");
      const { credentialAvailabilityOf } = await import("/packages/web/dist/webauthn.js");
      const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
      ]);
      const keyProvider = new StaticEnvelopeKeyProvider(key);
      await new EnvelopedCredentialStore("aad-a", "localStorage", keyProvider).save(creds);

      // Same key, same ciphertext, different credential namespace.
      localStorage.setItem(
        "interocitor-creds-envelope:aad-b",
        localStorage.getItem("interocitor-creds-envelope:aad-a")!,
      );
      try {
        await new EnvelopedCredentialStore("aad-b", "localStorage", keyProvider).load();
        return null;
      } catch (error) {
        return credentialAvailabilityOf(error);
      }
    }, CREDS);

    expect(result).toBe("unreadable");
  });

  test("a missing envelope is absent, a failing key provider is unavailable", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { EnvelopedCredentialStore, MemoryCredentialEnvelopeStore } =
        await import("/packages/web/dist/credential-store.js");
      const { credentialAvailabilityOf } = await import("/packages/web/dist/webauthn.js");
      const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
      ]);
      const envelopeStore = new MemoryCredentialEnvelopeStore("absent-db");
      const working = new EnvelopedCredentialStore("absent-db", envelopeStore, {
        envelopeKeyId: "flaky",
        getKey: async () => key,
      });
      const absent = await working.load();

      await working.save({ portableKey: "p", deviceId: "d" });
      const failing = new EnvelopedCredentialStore("absent-db", envelopeStore, {
        envelopeKeyId: "flaky",
        getKey: async (): Promise<CryptoKey> => {
          throw new Error("biometric prompt dismissed");
        },
      });
      try {
        await failing.load();
        return { absent, availability: null };
      } catch (error) {
        return { absent, availability: credentialAvailabilityOf(error) };
      }
    });

    expect(result.absent).toBeNull();
    expect(result.availability).toBe("unavailable");
  });
});

test.describe("migration from the previous on-disk formats", () => {
  test("a v1 envelope decrypts and is re-saved as v2", async ({ page }) => {
    const result = await page.evaluate(async (creds) => {
      const { EnvelopedCredentialStore, WebAuthnEnvelopeKeyProvider } =
        await import("/packages/web/dist/credential-store.js");
      const fake = (globalThis as unknown as { __fake: any }).__fake;
      const encodeBase64 = (bytes: Uint8Array): string => {
        let binary = "";
        for (const byte of bytes) binary += String.fromCodePoint(byte);
        return btoa(binary);
      };

      // Field state: an untagged 32-byte blob that IS the KEK, plus a v1
      // envelope encrypted under it with no AAD.
      const seed = crypto.getRandomValues(new Uint8Array(32));
      const id = fake.seedCredential([...seed]);
      localStorage.setItem(
        "interocitor-cred-registry:v1-db:envelope-key",
        JSON.stringify([{ id, authenticatorAttachment: "platform", createdAt: Date.now() }]),
      );
      const legacyKey = await crypto.subtle.importKey(
        "raw",
        seed.buffer as ArrayBuffer,
        "AES-GCM",
        false,
        ["encrypt", "decrypt"],
      );
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        legacyKey,
        new TextEncoder().encode(JSON.stringify(creds)),
      );
      localStorage.setItem(
        "interocitor-creds-envelope:v1-db",
        JSON.stringify({
          v: 1,
          alg: "AES-GCM",
          iv: encodeBase64(iv),
          ciphertext: encodeBase64(new Uint8Array(ciphertext)),
        }),
      );

      const store = new EnvelopedCredentialStore(
        "v1-db",
        "localStorage",
        new WebAuthnEnvelopeKeyProvider("v1-db"),
      );
      const loaded = await store.load();
      await store.save(loaded!);
      const upgraded = JSON.parse(localStorage.getItem("interocitor-creds-envelope:v1-db")!);
      return { loaded, upgraded, reloaded: await store.load() };
    }, CREDS);

    expect(result.loaded).toEqual(CREDS);
    expect(result.upgraded.v).toBe(2);
    expect(result.upgraded.kdf.name).toBe("HKDF-SHA-256");
    expect(result.upgraded.keyId).toBe("webauthn-largeblob");
    expect(result.reloaded).toEqual(CREDS);
  });

  test("an untagged blob loads and is re-tagged in place", async ({ page }) => {
    const result = await page.evaluate(async (creds) => {
      const { WebAuthnCredentialStore } = await import("/packages/web/dist/credential-store.js");
      const fake = (globalThis as unknown as { __fake: any }).__fake;
      const id = fake.seedCredential([...new TextEncoder().encode(JSON.stringify(creds))]);
      localStorage.setItem(
        "interocitor-cred-registry:legacy-db",
        JSON.stringify([{ id, authenticatorAttachment: "platform", createdAt: Date.now() }]),
      );
      const before = String.fromCodePoint(...(fake.readBlob(id) as number[]).slice(0, 4));

      const store = new WebAuthnCredentialStore("legacy-db");
      const loaded = await store.load();
      const after = fake.readBlob(id) as number[];
      return {
        before,
        loaded,
        afterHeader: String.fromCodePoint(...after.slice(0, 4)),
        reloaded: await store.load(),
      };
    }, CREDS);

    expect(result.before).toBe('{"po');
    expect(result.loaded).toEqual(CREDS);
    expect(result.afterHeader).toBe("IOCB");
    expect(result.reloaded).toEqual(CREDS);
  });

  test("a cleared localStorage still resolves through a discoverable credential", async ({
    page,
  }) => {
    const result = await page.evaluate(async (creds) => {
      const { WebAuthnCredentialStore } = await import("/packages/web/dist/credential-store.js");
      const fake = (globalThis as unknown as { __fake: any }).__fake;
      // Untagged blob, no hints at all: the shape a field deployment is in
      // after the user clears site data.
      const id = fake.seedCredential([...new TextEncoder().encode(JSON.stringify(creds))]);
      fake.discoverable = id;

      const store = new WebAuthnCredentialStore("no-hints-db");
      const loaded = await store.load();
      const retagged = String.fromCodePoint(...(fake.readBlob(id) as number[]).slice(0, 4));
      return {
        loaded,
        retagged,
        hintRestored: localStorage.getItem("interocitor-cred:no-hints-db") === id,
        allowCredentialsOnSecondRead: await (async () => {
          fake.lastAllowCredentials = null;
          await store.load();
          return fake.lastAllowCredentials;
        })(),
      };
    }, CREDS);

    expect(result.loaded).toEqual(CREDS);
    expect(result.retagged).toBe("IOCB");
    // The hint is rebuilt from the assertion, so later reads are constrained
    // again instead of accepting any discoverable credential.
    expect(result.hintRestored).toBe(true);
    expect(result.allowCredentialsOnSecondRead).not.toBeNull();
  });
});
