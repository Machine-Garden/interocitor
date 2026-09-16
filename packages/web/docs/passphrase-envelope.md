# Passphrase envelope keys

`@interocitor/web` exposes `PassphraseEnvelopeKeyProvider`, a
`CredentialEnvelopeKeyProvider` that derives the AES-GCM key-encryption key for
an encrypted credential envelope from a passphrase the user types.

```ts
import {
  PassphraseEnvelopeKeyProvider,
  createWebCredentialStore,
  isPassphraseEnvelopeError,
} from "@interocitor/web";

const keyProvider = new PassphraseEnvelopeKeyProvider("case-vault");
await keyProvider.unlock(await promptUserForPassphrase());

const credentialStore = createWebCredentialStore("case-vault", {
  envelope: { storage: "localStorage", keyProvider },
});
```

The credential record still lives in localStorage, but as ciphertext. The
passphrase is not stored anywhere; only public derivation parameters are.

## What this protects against, and what it does not

It protects the credential record against **an attacker who copies the browser
profile off disk** — a stolen laptop, a backup, a forensic image, a shared
machine's profile directory. Without the passphrase, the localStorage envelope
is opaque, and recovering it costs an offline PBKDF2 guessing campaign.

It does **not** protect against:

- **Hostile first-party JavaScript.** Anything running on the origin after
  unlock can ask the provider for the key, or simply ask the credential store
  for the credentials. XSS, a compromised dependency, or a malicious extension
  with script access all defeat this completely.
- **Anything at all while the cache is warm.** Between unlock and lock, the
  derived key is a live `CryptoKey` in the page. The idle timeout shortens that
  window; it does not remove it.
- **An attacker who can watch the passphrase being typed** — keyloggers,
  shoulder surfing, a compromised input method.
- **A weak passphrase.** The work factor buys time proportional to the
  passphrase's entropy. It does not create entropy.

Custody choices are compared in
[`@interocitor/core`'s credential-store guide](../../core/docs/credential-store.md).
For key material that should never be recoverable from disk material at all,
prefer `storage: 'passkey'` or `WebAuthnEnvelopeKeyProvider`, where the platform
holds the secret.

### Do not point this at a remote envelope store

`createWebCredentialStore` accepts `envelope.store` pointing at a **backend**
(see [credential-store.md](../../core/docs/credential-store.md), "Encrypted
envelope from backend or memory"). Combining that with a user-chosen passphrase
changes the offline-guessing math completely:

- With a **local** envelope, an attacker has to steal one device's profile to
  get one ciphertext to guess against.
- With a **server-side** envelope, every ciphertext for every user sits in one
  place. One breach — or one curious operator — hands the attacker the whole
  corpus, and a human-chosen passphrase behind 600 000 PBKDF2 iterations is not
  a serious obstacle at that scale.

So: **local envelope stores only**, unless the passphrase is high-entropy and
machine-generated (for example the same base58 material the recovery-phrase flow
produces), in which case it is no longer a passphrase and should not be typed
from memory.

## Failure is loud and specific

The single rule this module exists to uphold: **a credential record that exists
but cannot be opened never looks like "no credentials."** A caller that reads
absence as "first run" mints a fresh mesh key and forks the mesh.

Every failure path therefore throws, and each throws something distinguishable:

| Error                              | `code`                                   | Means                                                                |
| ---------------------------------- | ---------------------------------------- | -------------------------------------------------------------------- |
| `WrongPassphraseError`             | `PASSPHRASE_ENVELOPE_WRONG_PASSPHRASE`   | The phrase did not authenticate the stored record.                   |
| `PassphraseLockedError`            | `PASSPHRASE_ENVELOPE_LOCKED`             | No key is cached and no passphrase could be obtained.                |
| `MissingPassphraseKeyRecordError`  | `PASSPHRASE_ENVELOPE_KEY_RECORD_MISSING` | A decrypt was asked for, but the key record is gone.                 |
| `PassphraseNamespaceMismatchError` | `PASSPHRASE_ENVELOPE_NAMESPACE_MISMATCH` | The record belongs to a different credential namespace.              |
| `InvalidPassphraseKeyRecordError`  | `PASSPHRASE_ENVELOPE_KEY_RECORD_INVALID` | The record is malformed, unsupported, or below the accepted minimum. |

All of them extend `PassphraseEnvelopeError`, which extends
`CredentialAccessError`. Handle them; do not treat a rejected `load()` as an
empty store.

```ts
try {
  const credentials = await credentialStore.load();
} catch (error) {
  if (isPassphraseEnvelopeError(error) && error.code === "PASSPHRASE_ENVELOPE_WRONG_PASSPHRASE") {
    return promptAgain();
  }
  throw error; // Never fall through to "start a new mesh".
}
```

Each `code` is stable across releases, and the predicates — `isCredentialAccessError`,
`isPassphraseEnvelopeError` — check it as well as `instanceof`. Prefer them:
`instanceof` alone answers "no" when the error crosses a package boundary into
a second copy of `@interocitor/web`, and "no" on this path means "nothing
stored", which forks the mesh.

A wrong passphrase is caught by a **verifier**: a fixed plaintext encrypted
under the derived key when the record is provisioned. Decrypting it proves the
passphrase before any credential ciphertext is touched, so the failure is
reported as a wrong passphrase rather than as a bare `OperationError` from
somewhere deep inside the store.

## Cache policy

| Behaviour                | Choice                                                                           |
| ------------------------ | -------------------------------------------------------------------------------- |
| What is cached           | The derived `CryptoKey` only. Never the passphrase string.                       |
| Extractability           | `extractable: false`. Nothing ever needs to export a KEK.                        |
| Persistence              | Memory only. Never localStorage, never sessionStorage, never IndexedDB.          |
| Expiry                   | Idle timeout from **last use**, default 5 minutes, `idleTimeoutMs` to change it. |
| Manual control           | `lock()`, `clear()` (same thing), `dispose()`, `deleteKeyRecord()`.              |
| Lock when page is hidden | `lockOnHide`, **off** by default.                                                |

`idleTimeoutMs: 0` or `Infinity` disables expiry — the key then lives until
`lock()` or page unload. Expiry is enforced both by a timer and lazily on every
read, because background tabs throttle timers and the timer alone cannot be
trusted.

**On the passphrase string.** The provider derives the key and drops its
reference immediately. That is the most any JavaScript can do: strings are
immutable and garbage-collected, so the bytes may sit in the heap until the GC
gets to them, and may have been copied by the input element, the event system,
or the JIT along the way. Treat "the passphrase is not retained" as an
architectural statement, not a memory-scrubbing guarantee.

**Why `lockOnHide` defaults to off.** `visibilitychange` fires on every tab
switch, and on mobile every app switch; `pagehide` fires on bfcache navigation.
Locking on those re-prompts users constantly and interrupts a sync that would
otherwise finish in a backgrounded tab. Turn it on for shared or kiosk
machines, where that friction is exactly the point.

`clear()` — the optional method on the `CredentialEnvelopeKeyProvider` contract
— deliberately only drops the cache. It is reachable from generic credential
teardown, and destroying the key record there would strand an envelope that is
still on disk. Use `deleteKeyRecord()` to destroy the record on purpose, and
clear the envelope in the same step.

## Key derivation

One PBKDF2-HMAC-SHA-256 stage, straight to a 256-bit AES-GCM key.

| Parameter  | Value                                                                       |
| ---------- | --------------------------------------------------------------------------- |
| Salt       | 16 random bytes per install, prefixed with a fixed domain separator.        |
| Iterations | 600 000 for new records; existing records accepted at or above 210 000.     |
| Passphrase | NFKD-normalized, trimmed, internal whitespace collapsed. Empty is rejected. |
| AAD        | `interocitor.passphrase.envelope.v1\|<namespace>\|<salt>\|<iterations>`     |

This follows `@interocitor/core`'s recovery wrapper
(`packages/core/src/crypto/recovery.ts`) with three deliberate differences:

1. **Random per-install salt, not a fixed one.** The recovery wrapper's salt is
   fixed because its lookup locator has to derive from the phrase alone. There
   is no locator here, so there is no reason to hand attackers a precomputation
   target shared across every install.
2. **Stored iteration count, not a pinned one.** The recovery wrapper compares
   `iterations` for equality, which means its work factor can never be raised
   without a format bump. A record here carries the count it was written with
   and is accepted at or above `MINIMUM_PASSPHRASE_KDF_ITERATIONS`. Raising the
   default applies to new records without orphaning old ones; raising the
   minimum is the separate, deliberate act of refusing old ones.
3. **One KDF stage, not PBKDF2-then-HKDF.** The second stage exists in recovery
   to fan one phrase-derived root out into a locator and a KEK. Only a KEK is
   needed here.

### Why 600 000 iterations

Measured with WebCrypto PBKDF2-HMAC-SHA-256 in headless Chromium 147 on an
Apple-silicon Mac (median of three, warmed):

| Iterations | Time  |
| ---------- | ----- |
| 100 000    | 6 ms  |
| 310 000    | 18 ms |
| 600 000    | 35 ms |
| 1 000 000  | 58 ms |

A full `unlock()` at the default — record load, derivation, verifier decrypt —
measures 35-39 ms on the same machine.

Chromium runs WebCrypto off the main thread, and CDP CPU throttling up to 20x
did not move these numbers, so the cost is unlock _latency_, not main-thread
jank. It is also paid once per unlock rather than once per `load()`, because the
derived key is cached for the idle window.

Scaling by the 8-15x that a low-end Android phone typically gives against this
class of machine puts 600 000 at roughly 0.3-0.5 s — inside the budget for a
one-time unlock, and well under the 1-2 s a user reads as a stall. Since the
attacker is doing offline guessing against a copied profile, which is exactly
what OWASP's 600 000 figure for PBKDF2-HMAC-SHA-256 addresses, there is no
reason to spend less than the recovery wrapper does.

### AAD binding

The verifier's additional authenticated data binds the credential namespace,
the salt, and the iteration count. `EnvelopedCredentialStore` passes no AAD of
its own, so this is where namespace binding happens: a record lifted out of one
credential namespace and relabeled as another fails to authenticate instead of
quietly deriving a key for somebody else's envelope. A record that still carries
its original namespace is caught earlier, by
`PassphraseNamespaceMismatchError`; one that has been relabeled as well fails
AAD and surfaces as `WrongPassphraseError`, because from outside the two cases
are not distinguishable.

## The stored record

Nothing in it is secret, which is why it can sit in the same localStorage as the
envelope it describes, under `interocitor-creds-passphrase:<namespace>`:

```jsonc
{
  "v": 1,
  "namespace": "case-vault",
  "kdf": { "name": "PBKDF2-HMAC-SHA-256", "iterations": 600000, "salt": "…" },
  "verifier": { "iv": "…", "ciphertext": "…" },
  "createdAt": "2026-09-16T00:00:00.000Z",
}
```

Deleting it makes every envelope encrypted under it permanently unopenable.
Editing it makes the next unlock fail; it does not weaken the derivation, since
the iteration count is both bound by AAD and floored by
`minimumIterations`, and an implausible count is rejected outright.

## API

```ts
const provider = new PassphraseEnvelopeKeyProvider(credentialNamespace, options);

await provider.unlock(passphrase); // derive + cache; provisions on first use
provider.isUnlocked(); // boolean
await provider.getKey("encrypt" | "decrypt"); // CredentialEnvelopeKeyProvider
await provider.keyRecord(); // public parameters, or null
await provider.lock(); // drop the cached key
await provider.clear(); // same as lock()
await provider.dispose(); // lock + detach lockOnHide listeners
await provider.deleteKeyRecord(); // destructive
```

| Option              | Default        | Meaning                                                          |
| ------------------- | -------------- | ---------------------------------------------------------------- |
| `requestPassphrase` | none           | Called when `getKey` runs while locked; return `null` to refuse. |
| `idleTimeoutMs`     | `300_000`      | Idle window, measured from last use.                             |
| `iterations`        | `600_000`      | Work factor for newly provisioned records.                       |
| `minimumIterations` | `210_000`      | Lowest work factor accepted in an existing record.               |
| `storage`           | `localStorage` | Where the public key record lives.                               |
| `recordStore`       | none           | Custom `PassphraseKeyRecordStore`; overrides `storage`.          |
| `lockOnHide`        | `false`        | Lock on `pagehide` / `visibilitychange`.                         |

`getKey` serializes concurrent callers, so two parallel `load()`s cost one
derivation and one prompt.

Without `requestPassphrase`, a locked provider throws `PassphraseLockedError`
rather than prompting — call `unlock()` from your own UI. With it, the callback
is the prompt, and it is told whether it is being asked to provision a new
record (`provisioning: true`) or to open an existing one.

## Changing the passphrase

There is no in-place rekey. To change it: read the credentials with the old
passphrase, `deleteKeyRecord()`, clear the envelope, `unlock()` with the new
passphrase to provision a fresh record, and save the credentials again. Doing it
in that order means a failure at any step leaves either the old record or no
record — never a record that cannot open the envelope beside it.
