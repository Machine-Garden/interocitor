import { expect, test } from "@playwright/test";

/* eslint-disable unicorn/consistent-function-scoping -- Browser-context helpers must be defined inside page.evaluate. */

/**
 * Envelope key rotation, and the backward compatibility it must not cost.
 *
 * `CredentialEnvelopeKeyRequest.keyId` tells a key provider which key an
 * envelope is written under, or was written under. Without it a provider that
 * holds a current key plus previous keys has to guess, and a wrong guess is a
 * terminal `CredentialUnreadableError`.
 *
 * These tests pin both halves of the contract: a rotating provider can select
 * a historical key, and a provider that never heard of the field behaves
 * exactly as it did before.
 */

const CREDS = { portableKey: "portable-key-abc", deviceId: "device-1", meshId: "mesh-9" };

const DB_NAMES = [
  "rotate-db",
  "rotate-blind-db",
  "ignore-db",
  "ignore-zero-arity-db",
  "derive-db",
  "v1-static-db",
  "v2-static-db",
  "aad-ns-a",
  "aad-ns-b",
  "aad-keyid-db",
];

test.beforeEach(async ({ page }) => {
  await page.goto("/packages/web/tests/e2e/fixtures/harness.html");
  await page.evaluate((names) => {
    for (const name of names) localStorage.removeItem(`interocitor-creds-envelope:${name}`);
  }, DB_NAMES);
});

test.describe("key rotation through CredentialEnvelopeKeyRequest.keyId", () => {
  test("a provider selects a previous key by keyId and re-wraps on the next write", async ({
    page,
  }) => {
    const result = await page.evaluate(async (creds) => {
      const { EnvelopedCredentialStore } = await import("/packages/web/dist/credential-store.js");

      const newKey = (): Promise<CryptoKey> =>
        crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      const keys = new Map<string, CryptoKey>([
        ["app-key-1", await newKey()],
        ["app-key-2", await newKey()],
      ]);

      // The userspace rotation shape: one current id, a set of retained
      // previous keys, and selection driven by the requested keyId.
      let current = "app-key-1";
      const seen: { purpose: string; keyId: string | undefined }[] = [];
      const provider = {
        get envelopeKeyId(): string {
          return current;
        },
        async getKey(
          purpose?: "encrypt" | "decrypt",
          request?: { keyId?: string },
        ): Promise<CryptoKey> {
          seen.push({ purpose: purpose ?? "(none)", keyId: request?.keyId });
          const key = keys.get(request?.keyId ?? current);
          if (!key) throw new Error(`no key for ${request?.keyId}`);
          return key;
        },
      };

      const store = new EnvelopedCredentialStore("rotate-db", "localStorage", provider);
      await store.save(creds);
      const written = JSON.parse(localStorage.getItem("interocitor-creds-envelope:rotate-db")!);

      // Rotation happens: the app now ships app-key-2 and retains app-key-1.
      current = "app-key-2";
      const loadedAfterRotation = await store.load();

      // Upgrade in place: the next write re-wraps under the current key.
      await store.save(loadedAfterRotation!);
      const rewrapped = JSON.parse(localStorage.getItem("interocitor-creds-envelope:rotate-db")!);
      const loadedAfterRewrap = await store.load();

      // With the previous key dropped, the re-wrapped envelope still opens.
      keys.delete("app-key-1");
      const loadedWithoutPrevious = await store.load();

      return {
        writtenKeyId: written.keyId,
        loadedAfterRotation,
        rewrappedKeyId: rewrapped.keyId,
        rewrappedCiphertextChanged: rewrapped.ciphertext !== written.ciphertext,
        loadedAfterRewrap,
        loadedWithoutPrevious,
        seen,
      };
    }, CREDS);

    expect(result.writtenKeyId).toBe("app-key-1");
    expect(result.loadedAfterRotation).toEqual(CREDS);
    expect(result.rewrappedKeyId).toBe("app-key-2");
    expect(result.rewrappedCiphertextChanged).toBe(true);
    expect(result.loadedAfterRewrap).toEqual(CREDS);
    expect(result.loadedWithoutPrevious).toEqual(CREDS);
    expect(result.seen).toEqual([
      { purpose: "encrypt", keyId: "app-key-1" },
      { purpose: "decrypt", keyId: "app-key-1" },
      { purpose: "encrypt", keyId: "app-key-2" },
      { purpose: "decrypt", keyId: "app-key-2" },
      { purpose: "decrypt", keyId: "app-key-2" },
    ]);
  });

  test("without the keyId a rotated provider cannot open the previous envelope", async ({
    page,
  }) => {
    // The regression this field exists to prevent: the same provider, blind to
    // the requested keyId, strands the record it wrote yesterday.
    const result = await page.evaluate(async (creds) => {
      const { EnvelopedCredentialStore } = await import("/packages/web/dist/credential-store.js");
      const { credentialAvailabilityOf } = await import("/packages/web/dist/webauthn.js");

      const newKey = (): Promise<CryptoKey> =>
        crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      const keys = new Map<string, CryptoKey>([
        ["app-key-1", await newKey()],
        ["app-key-2", await newKey()],
      ]);

      let current = "app-key-1";
      const provider = {
        get envelopeKeyId(): string {
          return current;
        },
        // Deliberately ignores `request`: always answers with the current key.
        async getKey(): Promise<CryptoKey> {
          return keys.get(current)!;
        },
      };

      const store = new EnvelopedCredentialStore("rotate-blind-db", "localStorage", provider);
      await store.save(creds);
      current = "app-key-2";
      try {
        await store.load();
        return null;
      } catch (error) {
        return credentialAvailabilityOf(error);
      }
    }, CREDS);

    expect(result).toBe("unreadable");
  });

  test("a deriving provider receives the keyId on both encrypt and decrypt", async ({ page }) => {
    const result = await page.evaluate(async (creds) => {
      const { EnvelopedCredentialStore } = await import("/packages/web/dist/credential-store.js");

      const seeds = new Map<string, Uint8Array>([
        ["seed-1", crypto.getRandomValues(new Uint8Array(32))],
        ["seed-2", crypto.getRandomValues(new Uint8Array(32))],
      ]);
      let current = "seed-1";
      const seen: { purpose: string; keyId: string | undefined }[] = [];

      const provider = {
        get envelopeKeyId(): string {
          return current;
        },
        async getKey(): Promise<CryptoKey> {
          throw new Error("this provider always derives");
        },
        async deriveKey(request: {
          purpose: string;
          dbName: string;
          salt: Uint8Array;
          keyId?: string;
        }): Promise<CryptoKey> {
          seen.push({ purpose: request.purpose, keyId: request.keyId });
          const seed = seeds.get(request.keyId ?? current);
          if (!seed) throw new Error(`no seed for ${request.keyId}`);
          const ikm = await crypto.subtle.importKey(
            "raw",
            seed.buffer as ArrayBuffer,
            "HKDF",
            false,
            ["deriveKey"],
          );
          return crypto.subtle.deriveKey(
            {
              name: "HKDF",
              hash: "SHA-256",
              salt: request.salt as Uint8Array<ArrayBuffer>,
              info: new TextEncoder().encode(`app|${request.dbName}`),
            },
            ikm,
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"],
          );
        },
      };

      const store = new EnvelopedCredentialStore("derive-db", "localStorage", provider);
      await store.save(creds);
      const written = JSON.parse(localStorage.getItem("interocitor-creds-envelope:derive-db")!);
      current = "seed-2";
      const loadedAfterRotation = await store.load();
      return { written, loadedAfterRotation, seen };
    }, CREDS);

    expect(result.written.v).toBe(2);
    expect(result.written.kdf).toEqual({ name: "HKDF-SHA-256", salt: expect.any(String) });
    expect(result.written.keyId).toBe("seed-1");
    expect(result.loadedAfterRotation).toEqual(CREDS);
    expect(result.seen).toEqual([
      { purpose: "encrypt", keyId: "seed-1" },
      { purpose: "decrypt", keyId: "seed-1" },
    ]);
  });
});

test.describe("providers written before keyId existed", () => {
  test("a one-argument getKey provider round-trips and still sees only purpose", async ({
    page,
  }) => {
    const result = await page.evaluate(async (creds) => {
      const { EnvelopedCredentialStore } = await import("/packages/web/dist/credential-store.js");
      const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
      ]);
      const purposes: (string | undefined)[] = [];
      // Exactly the shape an application wrote against the original interface.
      const provider = {
        envelopeKeyId: "legacy-provider",
        async getKey(purpose?: "encrypt" | "decrypt"): Promise<CryptoKey> {
          purposes.push(purpose);
          return key;
        },
      };

      const store = new EnvelopedCredentialStore("ignore-db", "localStorage", provider);
      await store.save(creds);
      const loaded = await store.load();
      const envelope = JSON.parse(localStorage.getItem("interocitor-creds-envelope:ignore-db")!);
      return { loaded, purposes, envelope };
    }, CREDS);

    expect(result.loaded).toEqual(CREDS);
    expect(result.purposes).toEqual(["encrypt", "decrypt"]);
    expect(result.envelope.v).toBe(2);
    expect(result.envelope.keyId).toBe("legacy-provider");
  });

  test("a zero-argument getKey provider round-trips unchanged", async ({ page }) => {
    const result = await page.evaluate(async (creds) => {
      const { EnvelopedCredentialStore } = await import("/packages/web/dist/credential-store.js");
      const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
      ]);
      // No `envelopeKeyId` either: the envelope must still record "custom".
      const store = new EnvelopedCredentialStore("ignore-zero-arity-db", "localStorage", {
        getKey: async (): Promise<CryptoKey> => key,
      });
      await store.save(creds);
      const envelope = JSON.parse(
        localStorage.getItem("interocitor-creds-envelope:ignore-zero-arity-db")!,
      );
      return { loaded: await store.load(), envelope };
    }, CREDS);

    expect(result.loaded).toEqual(CREDS);
    expect(result.envelope.keyId).toBe("custom");
  });

  test("StaticEnvelopeKeyProvider still round-trips a v2 envelope", async ({ page }) => {
    const result = await page.evaluate(async (creds) => {
      const { EnvelopedCredentialStore, StaticEnvelopeKeyProvider } =
        await import("/packages/web/dist/credential-store.js");
      const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
      ]);
      const store = new EnvelopedCredentialStore(
        "v2-static-db",
        "localStorage",
        new StaticEnvelopeKeyProvider(key),
      );
      await store.save(creds);
      const envelope = JSON.parse(localStorage.getItem("interocitor-creds-envelope:v2-static-db")!);
      return { loaded: await store.load(), envelope };
    }, CREDS);

    expect(result.loaded).toEqual(CREDS);
    expect(result.envelope.v).toBe(2);
    expect(result.envelope.keyId).toBe("static");
    expect(result.envelope.kdf).toBeUndefined();
  });

  test("an already-stored v1 envelope still decrypts and reports the provider's current keyId", async ({
    page,
  }) => {
    const result = await page.evaluate(async (creds) => {
      const { EnvelopedCredentialStore } = await import("/packages/web/dist/credential-store.js");
      const encodeBase64 = (bytes: Uint8Array): string => {
        let binary = "";
        for (const byte of bytes) binary += String.fromCodePoint(byte);
        return btoa(binary);
      };

      // Field state: a v1 envelope encrypted directly under the provider key,
      // with no AAD and no recorded keyId.
      const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
      ]);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        new TextEncoder().encode(JSON.stringify(creds)),
      );
      localStorage.setItem(
        "interocitor-creds-envelope:v1-static-db",
        JSON.stringify({
          v: 1,
          alg: "AES-GCM",
          iv: encodeBase64(iv),
          ciphertext: encodeBase64(new Uint8Array(ciphertext)),
        }),
      );

      const seen: { purpose: string | undefined; keyId: string | undefined }[] = [];
      const provider = {
        envelopeKeyId: "app-key-7",
        async getKey(
          purpose?: "encrypt" | "decrypt",
          request?: { keyId?: string },
        ): Promise<CryptoKey> {
          seen.push({ purpose, keyId: request?.keyId });
          return key;
        },
      };

      const store = new EnvelopedCredentialStore("v1-static-db", "localStorage", provider);
      const loaded = await store.load();
      await store.save(loaded!);
      const upgraded = JSON.parse(localStorage.getItem("interocitor-creds-envelope:v1-static-db")!);
      return { loaded, upgraded, reloaded: await store.load(), seen };
    }, CREDS);

    expect(result.loaded).toEqual(CREDS);
    expect(result.upgraded.v).toBe(2);
    expect(result.upgraded.keyId).toBe("app-key-7");
    expect(result.reloaded).toEqual(CREDS);
    // v1 records no keyId, so the request carries the provider's current id.
    expect(result.seen[0]).toEqual({ purpose: "decrypt", keyId: "app-key-7" });
  });
});

test.describe("AAD binding survives the keyId plumbing", () => {
  test("an envelope does not open under a different credential namespace", async ({ page }) => {
    const result = await page.evaluate(async (creds) => {
      const { EnvelopedCredentialStore, StaticEnvelopeKeyProvider } =
        await import("/packages/web/dist/credential-store.js");
      const { credentialAvailabilityOf } = await import("/packages/web/dist/webauthn.js");
      const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
      ]);
      const provider = new StaticEnvelopeKeyProvider(key);
      await new EnvelopedCredentialStore("aad-ns-a", "localStorage", provider).save(creds);

      // Same key, same ciphertext, different namespace.
      localStorage.setItem(
        "interocitor-creds-envelope:aad-ns-b",
        localStorage.getItem("interocitor-creds-envelope:aad-ns-a")!,
      );
      try {
        await new EnvelopedCredentialStore("aad-ns-b", "localStorage", provider).load();
        return null;
      } catch (error) {
        return credentialAvailabilityOf(error);
      }
    }, CREDS);

    expect(result).toBe("unreadable");
  });

  test("an envelope does not open under a different keyId, even with the right key", async ({
    page,
  }) => {
    const result = await page.evaluate(async (creds) => {
      const { EnvelopedCredentialStore } = await import("/packages/web/dist/credential-store.js");
      const { credentialAvailabilityOf } = await import("/packages/web/dist/webauthn.js");

      // One key, two ids: isolates the AAD binding from key selection, so a
      // failure here can only be the keyId no longer being authenticated.
      const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
      ]);
      let current = "app-key-1";
      const provider = {
        get envelopeKeyId(): string {
          return current;
        },
        async getKey(): Promise<CryptoKey> {
          return key;
        },
      };

      const store = new EnvelopedCredentialStore("aad-keyid-db", "localStorage", provider);
      await store.save(creds);
      const recordKey = "interocitor-creds-envelope:aad-keyid-db";
      const envelope = JSON.parse(localStorage.getItem(recordKey)!);
      const honest = await store.load();

      // Relabel the envelope under another key id without touching ciphertext.
      current = "app-key-2";
      localStorage.setItem(recordKey, JSON.stringify({ ...envelope, keyId: "app-key-2" }));
      try {
        await store.load();
        return { honest, availability: null };
      } catch (error) {
        return { honest, availability: credentialAvailabilityOf(error) };
      }
    }, CREDS);

    expect(result.honest).toEqual(CREDS);
    expect(result.availability).toBe("unreadable");
  });
});
