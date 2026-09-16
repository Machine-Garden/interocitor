import { expect, test } from "@playwright/test";

/* eslint-disable unicorn/consistent-function-scoping -- Browser-context helpers must be defined inside page.evaluate. */

/**
 * Credential errors have to survive a *second copy* of this package.
 *
 * A consumer's tree can hold two copies of `@interocitor/web` — a duplicate
 * install, pnpm isolation, or a bundler that emitted the module into two
 * chunks. None of those is prevented by a peerDependency range, and under all
 * of them an error thrown by copy A fails `instanceof` in copy B. The
 * envelope store then flattens it into a generic "the store could not be
 * consulted", the caller reads that as "nothing stored", mints a fresh mesh
 * key, and forks the mesh.
 *
 * Every test below therefore builds its error the way the *other* copy would
 * have: the same own fields, on a prototype chain this copy has never seen.
 */

const NAMESPACE = "credential-error-identity";

const CREDS = {
  portableKey: "portable-key-material",
  deviceId: "device-1",
  meshId: "mesh-1",
};

type ForeignCopy = (error: Error) => Error;

/** Reach the helper `installForeignCopyHelper` put on the page. */
declare const fromAnotherCopy: ForeignCopy;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "fromAnotherCopy", {
      value: (error: Error): Error => {
        class ForeignError extends Error {}
        const foreign = new ForeignError(error.message);
        for (const key of Object.getOwnPropertyNames(error)) {
          if (key === "stack") continue;
          Object.defineProperty(foreign, key, Object.getOwnPropertyDescriptor(error, key)!);
        }
        return foreign;
      },
    });
  });
  await page.goto("/packages/web/tests/e2e/fixtures/harness.html");
  await page.evaluate((namespace) => {
    localStorage.removeItem(`interocitor-creds-envelope:${namespace}`);
    localStorage.removeItem(`interocitor-creds-passphrase:${namespace}`);
  }, NAMESPACE);
});

test.describe("credential errors across module copies", () => {
  test("every passphrase-envelope failure carries a distinct stable code", async ({ page }) => {
    const codes = await page.evaluate(async () => {
      const {
        PassphraseEnvelopeError,
        WrongPassphraseError,
        PassphraseLockedError,
        MissingPassphraseKeyRecordError,
        InvalidPassphraseKeyRecordError,
        PassphraseNamespaceMismatchError,
      } = await import("/packages/web/dist/index.js");

      return {
        base: new PassphraseEnvelopeError("unavailable", "x").code,
        wrong: new WrongPassphraseError().code,
        locked: new PassphraseLockedError().code,
        missing: new MissingPassphraseKeyRecordError("ns").code,
        invalid: new InvalidPassphraseKeyRecordError("too weak").code,
        mismatch: new PassphraseNamespaceMismatchError("a", "b").code,
      };
    });

    // These strings are the public contract; changing one is a breaking change.
    expect(codes).toEqual({
      base: "PASSPHRASE_ENVELOPE",
      wrong: "PASSPHRASE_ENVELOPE_WRONG_PASSPHRASE",
      locked: "PASSPHRASE_ENVELOPE_LOCKED",
      missing: "PASSPHRASE_ENVELOPE_KEY_RECORD_MISSING",
      invalid: "PASSPHRASE_ENVELOPE_KEY_RECORD_INVALID",
      mismatch: "PASSPHRASE_ENVELOPE_NAMESPACE_MISMATCH",
    });
    expect(new Set(Object.values(codes)).size).toBe(Object.keys(codes).length);
  });

  test("the credential predicates match errors from another copy", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const {
        isCredentialAccessError,
        isPassphraseEnvelopeError,
        credentialAvailabilityOf,
        CredentialUnavailableError,
        CredentialUnreadableError,
        WrongPassphraseError,
        PassphraseLockedError,
        MissingPassphraseKeyRecordError,
        InvalidPassphraseKeyRecordError,
        PassphraseNamespaceMismatchError,
      } = await import("/packages/web/dist/index.js");

      const taxonomy: (Error & { availability?: string })[] = [
        new CredentialUnavailableError("no authenticator"),
        new CredentialUnreadableError("corrupt record"),
        new WrongPassphraseError(),
        new PassphraseLockedError(),
        new MissingPassphraseKeyRecordError("ns"),
        new InvalidPassphraseKeyRecordError("too weak"),
        new PassphraseNamespaceMismatchError("a", "b"),
      ];

      return taxonomy.map((error) => {
        const foreign = fromAnotherCopy(error);
        return {
          name: error.name,
          // Guard the guard: a "foreign" copy that still shared the class
          // identity would make every assertion below meaningless.
          sharesIdentity: foreign instanceof (error.constructor as ErrorConstructor),
          own: isCredentialAccessError(error),
          foreign: isCredentialAccessError(foreign),
          availability: credentialAvailabilityOf(foreign),
          expectedAvailability: error.availability ?? null,
          envelopeOwn: isPassphraseEnvelopeError(error),
          envelopeForeign: isPassphraseEnvelopeError(foreign),
        };
      });
    });

    expect(result).toHaveLength(7);
    for (const row of result) {
      expect(row.sharesIdentity, `${row.name} did not get a foreign identity`).toBe(false);
      expect(row.own, `${row.name} is not matched in its own copy`).toBe(true);
      expect(row.foreign, `${row.name} is not matched across copies`).toBe(true);
      // The availability distinction has to survive too: it is what tells a
      // caller "re-prompt" from "repair", and neither of them is "absent".
      expect(row.availability, `${row.name} lost its availability`).toBe(row.expectedAvailability);
    }
    // The envelope family predicate recognises its own five, and nothing else.
    expect(result.filter((row) => row.envelopeForeign)).toHaveLength(5);
    expect(result.filter((row) => row.envelopeOwn)).toHaveLength(5);
  });

  test("the predicates keep matching everything they matched before", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { isCredentialAccessError, isPassphraseEnvelopeError } =
        await import("/packages/web/dist/index.js");

      return {
        // A hand-rolled stand-in built against the documented codes, with no
        // `availability` at all. It passed before; it must still pass.
        bareUnavailableCode: isCredentialAccessError({ code: "CREDENTIAL_UNAVAILABLE" }),
        bareUnreadableCode: isCredentialAccessError({ code: "CREDENTIAL_UNREADABLE" }),
        // ...and the negatives stay negative.
        plainError: isCredentialAccessError(new Error("boom")),
        availabilityWithoutCode: isCredentialAccessError({ availability: "unreadable" }),
        nullish: isCredentialAccessError(null) || isCredentialAccessError(void 0),
        envelopePlainError: isPassphraseEnvelopeError(new Error("boom")),
        envelopeOtherTaxonomy: isPassphraseEnvelopeError({ code: "CREDENTIAL_UNAVAILABLE" }),
      };
    });

    expect(result).toEqual({
      bareUnavailableCode: true,
      bareUnreadableCode: true,
      plainError: false,
      availabilityWithoutCode: false,
      nullish: false,
      envelopePlainError: false,
      envelopeOtherTaxonomy: false,
    });
  });

  test("a wrong passphrase from another copy is not flattened into 'nothing stored'", async ({
    page,
  }) => {
    // The load path end to end: a credential record exists, and the key
    // provider — living in the other copy — reports that the passphrase does
    // not open it. Before the fix, `requireKey`'s `instanceof` check missed
    // and the caller was told the store could not be consulted at all.
    const result = await page.evaluate(
      async ([namespace, creds]) => {
        const { EnvelopedCredentialStore, WrongPassphraseError, credentialAvailabilityOf } =
          await import("/packages/web/dist/index.js");

        const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
          "encrypt",
          "decrypt",
        ]);
        await new EnvelopedCredentialStore(namespace, "localStorage", {
          envelopeKeyId: "test-key",
          getKey: async () => key,
        }).save(creds);

        const refusal = fromAnotherCopy(new WrongPassphraseError());
        const store = new EnvelopedCredentialStore(namespace, "localStorage", {
          envelopeKeyId: "test-key",
          getKey: async () => {
            throw refusal;
          },
        });

        return store.load().then(
          () => ({ outcome: "resolved" }),
          (error: Error & { code?: string }) => ({
            outcome: "rejected",
            name: error.name,
            code: error.code ?? null,
            availability: credentialAvailabilityOf(error),
            same: error === refusal,
            // The record is still on disk: whatever the caller was told, it
            // was never "there is nothing here".
            envelopeStillStored: Boolean(
              localStorage.getItem(`interocitor-creds-envelope:${namespace}`),
            ),
          }),
        );
      },
      [NAMESPACE, CREDS] as const,
    );

    expect(result).toEqual({
      outcome: "rejected",
      name: "WrongPassphraseError",
      code: "PASSPHRASE_ENVELOPE_WRONG_PASSPHRASE",
      availability: "unreadable",
      same: true,
      envelopeStillStored: true,
    });
  });

  test("a locked provider from another copy still reports itself as locked", async ({ page }) => {
    // The save path: `requireKey` is the first thing a write touches. A
    // provider that simply has no passphrase cached must not arrive as a
    // broken key provider.
    const result = await page.evaluate(
      async ([namespace, creds]) => {
        const { EnvelopedCredentialStore, PassphraseLockedError } =
          await import("/packages/web/dist/index.js");

        const locked = fromAnotherCopy(new PassphraseLockedError());
        return new EnvelopedCredentialStore(namespace, "localStorage", {
          envelopeKeyId: "test-key",
          getKey: async () => {
            throw locked;
          },
        })
          .save(creds)
          .then(
            () => ({ name: "", code: null as string | null, same: false }),
            (error: Error & { code?: string }) => ({
              name: error.name,
              code: error.code ?? null,
              same: error === locked,
            }),
          );
      },
      [NAMESPACE, CREDS] as const,
    );

    expect(result).toEqual({
      name: "PassphraseLockedError",
      code: "PASSPHRASE_ENVELOPE_LOCKED",
      same: true,
    });
  });
});
