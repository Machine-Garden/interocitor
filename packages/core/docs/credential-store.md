# Credential store

The credential store is where a `MeshKeySource` may persist its portable
key material, **device id**, and the **mesh id anchor** between sessions.
Without it, every reload would force a re-pair or another key handoff.

For routine browser setup, start with the package README. This page covers the
persistence contract and implementation choices. For the difference between
portable shared keys and bound shared keys, see
[Shared key scenarios](shared-key-scenarios.md).

## Why it exists

Two reasons:

1. **Reload survival.** A user opens the app, the `MeshKeySource` needs the
   same portable key component and device id it used yesterday.
2. **Mesh anchor.** Each `dbName` records the `meshId` it last connected
   to. On the next connect the engine compares stored `meshId` against
   the live one and refuses to silently reuse a stale key. This catches
   "same `dbName`, new mesh" mistakes early instead of poisoning the
   remote.

## Interface

```ts
interface StoredCredentials {
  portableKey: string;
  deviceId: string;
  meshId?: string; // anchor, written after manifest is known
}

interface CredentialStore {
  save(creds: StoredCredentials): Promise<void>;
  load(): Promise<StoredCredentials | null>;
  clear(): Promise<void>;
}
```

The built-in key sources declare whether they have durable credential storage.
Durable sources expose that store to the engine through the required
`MeshKeySource.loadPersistedCredentials()` inspection hook. That
hook reads the existing record without adopting its key, so mesh-anchor and
explicit-key conflicts are checked before the engine overwrites credentials.
Custom key sources declare `credentialPersistence: "durable"` and implement the
same hook. Sources with no persistence declare `credentialPersistence: "none"`
and may omit it. Inspection and required saves fail closed with
`CredentialPersistenceError`; a malformed durable source fails with
`MeshKeySourceContractError`.

## Built-in implementations

Browser apps normally call `createWebCredentialStore(...)`. Construct one of
the concrete classes directly only when the application needs to control that
implementation rather than select a factory storage mode.

| Class / factory option                                            | Backing store                                                                                     | Auth gate                                  | Reload scope                                           |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------ |
| `LocalStorageCredentialStore` / `{ storage: 'localStorage' }`     | `localStorage` plaintext JSON                                                                     | None                                       | Same origin until browser data is cleared              |
| `SessionStorageCredentialStore` / `{ storage: 'sessionStorage' }` | `sessionStorage` plaintext JSON                                                                   | None                                       | Same tab/session                                       |
| `MemoryCredentialStore` / `{ storage: 'memory' }`                 | JS memory                                                                                         | None                                       | Current engine/process only                            |
| `WebAuthnCredentialStore` / `{ storage: 'passkey' }`              | WebAuthn `largeBlob` / OS keychain                                                                | Touch ID / Face ID / Windows Hello         | Passkey/platform credential lifetime                   |
| `EnvelopedCredentialStore` / `{ envelope: ... }`                  | AES-GCM encrypted record in memory, browser storage, backend, or custom `CredentialEnvelopeStore` | Depends on `CredentialEnvelopeKeyProvider` | Envelope-store lifetime plus envelope-key availability |
| default `createWebCredentialStore(credentialNamespace)`           | plaintext `localStorage` JSON                                                                     | None                                       | Same origin until browser data is cleared              |

Core never wires a browser default automatically. Runtime code constructs a
store explicitly when it builds a `MeshKeySource`, for example to:

- pin a specific implementation (e.g. memory-only or passkey-backed);
- wrap the credential with a key obtained from a passkey, native app integration, or app keystore, while storing the encrypted envelope locally, in memory, or behind a backend/custom `CredentialEnvelopeStore`;
- run tests that need a deterministic store;
- disable persistence entirely by using a `MeshKeySource` that keeps key material in memory only.

## Use cases

### Default browser persistence

```ts
const credentialStore = createWebCredentialStore("case-vault");
```

Stores the credential record in `localStorage`. The argument is the stable
encryption-domain namespace, not necessarily a physical database name. With
`createNamedLocalStore`, pass `localStore.credentialNamespace`; never pass its
rotatable `activeDatabaseName` or the result of
`getActiveLocalDatabaseName(...)`. Cache rotation must not change key custody.

### Memory-only key material

```ts
const credentialStore = createWebCredentialStore("case-vault", {
  storage: "memory",
});
```

No key material is persisted. Reloading the page requires a portable key
component from somewhere else: a join token, backend session, native app integration, or another device.

### Tab-session key material

```ts
const credentialStore = createWebCredentialStore("case-vault", {
  storage: "sessionStorage",
});
```

The credential survives reloads in the same tab/session but is not available to
new tabs after the session ends.

### Passkey/biometric-only credential

```ts
const credentialStore = createWebCredentialStore("case-vault", {
  storage: "passkey",
  displayName: "Case Vault",
});
```

The credential record lives in WebAuthn `largeBlob`. Browser storage may hold a
credential-id hint, but not the credential payload itself.

### Encrypted envelope from backend or memory

```ts
const credentialStore = createWebCredentialStore("case-vault", {
  envelope: {
    store: {
      async save(envelope) {
        await fetch("/api/interocitor/credential-envelope", {
          method: "PUT",
          body: JSON.stringify(envelope),
        });
      },
      async load() {
        const res = await fetch("/api/interocitor/credential-envelope");
        return res.status === 404 ? null : await res.json();
      },
      async clear() {
        await fetch("/api/interocitor/credential-envelope", { method: "DELETE" });
      },
    },
    keyProvider: new WebAuthnEnvelopeKeyProvider("case-vault", location.hostname, "Case Vault"),
  },
});
```

The encrypted envelope can come from a backend, app memory, native storage, or
any custom `CredentialEnvelopeStore`. The unwrap key can come from passkey /
biometrics, native app integration, or a key obtained by the app from elsewhere.

If the app needs a second protected secret that is not the Interocitor
credential record, use `WebAuthnBlobStore` from `@interocitor/web` instead of
overloading the credential-store API.

## Application-supplied app keys

`CredentialEnvelopeKeyProvider` is a seam the **application** owns. The obvious
thing to put behind it — beyond a passkey or a passphrase — is an
application-supplied secret: a value your bundle carries, or one your server
hands the client at sign-in. Wrap the credential record with it and a stolen
envelope is inert without it.

Interocitor deliberately ships no app-key provider. Whether the app key is a
constant compiled into your bundle or a per-user secret delivered by your
server changes what it is worth by an enormous margin, and only the application
knows which one it has. Shipping a class named `AppKeyEnvelopeKeyProvider`
would make the two look interchangeable. They are not. The recipe below is ten
lines; read [What an app key actually buys](#what-an-app-key-actually-buys)
before deciding it is a security control.

### The recipe

```ts
import { EnvelopedCredentialStore, StaticEnvelopeKeyProvider } from "@interocitor/web";

// APP_KEY_BYTES: 32 bytes your application supplies. A bundled constant, or
// bytes fetched from your server at sign-in — see the honest framing below.
const appKey = await crypto.subtle.importKey("raw", APP_KEY_BYTES, "AES-GCM", false, [
  "encrypt",
  "decrypt",
]);

const credentialStore = new EnvelopedCredentialStore(
  "case-vault",
  "localStorage",
  new StaticEnvelopeKeyProvider(appKey),
);
```

`extractable: false` is the load-bearing argument: after `importKey` returns,
no code path — yours, or an attacker's running in your page — can read the key
back out of the `CryptoKey`. Zero `APP_KEY_BYTES` once it is imported.

The factory form is equivalent and takes the same provider:

```ts
const credentialStore = createWebCredentialStore("case-vault", {
  envelope: { storage: "localStorage", keyProvider: new StaticEnvelopeKeyProvider(appKey) },
});
```

`localStorage` now holds an AES-GCM envelope under
`interocitor-creds-envelope:case-vault` instead of a plaintext credential
record. The ciphertext is bound by AAD to the credential namespace, the key
provider's `envelopeKeyId`, and the per-envelope salt, so it cannot be replayed
into another namespace or under another provider.

### Rotating the app key

`StaticEnvelopeKeyProvider` holds exactly one key, which is all a first
deployment needs. Rotation needs a provider that holds the **current** key plus
the **previous** keys, and that is told which one to use.

That is what `keyId` on `CredentialEnvelopeKeyRequest` is for. The envelope
records the provider's `envelopeKeyId` and binds it into the AAD;
`EnvelopedCredentialStore` hands that same value back to the provider:

- on **encrypt**, the id the new envelope will be written under — the
  provider's own current `envelopeKeyId`;
- on **decrypt**, the id recorded in the envelope being opened.

Without it, a provider gets one `getKey`/`deriveKey` call and no second chance:
a wrong guess is a terminal `CredentialUnreadableError`. Rotating a bundled app
key would strand every stored credential in the fleet at once.

```ts
import {
  CredentialUnavailableError,
  type CredentialEnvelopeKeyProvider,
  type CredentialEnvelopeKeyPurpose,
  type CredentialEnvelopeKeyRequest,
} from "@interocitor/web";

class AppKeyProvider implements CredentialEnvelopeKeyProvider {
  /** `keys` holds the current key and every previous key still in the retention window. */
  constructor(
    private readonly current: string,
    private readonly keys: Map<string, CryptoKey>,
  ) {}

  /** Read on every write: the id the next envelope is recorded under. */
  get envelopeKeyId(): string {
    return this.current;
  }

  async getKey(
    _purpose?: CredentialEnvelopeKeyPurpose,
    request?: CredentialEnvelopeKeyRequest,
  ): Promise<CryptoKey> {
    const id = request?.keyId ?? this.current;
    const key = this.keys.get(id);
    // Fail loudly. Returning the wrong key produces an indistinguishable
    // "tampered ciphertext" error three frames later.
    if (!key) throw new CredentialUnavailableError(`No app key for envelope key id "${id}"`);
    return key;
  }
}

const provider = new AppKeyProvider(
  "app-key-2",
  new Map([
    ["app-key-1", previousKey],
    ["app-key-2", currentKey],
  ]),
);
```

Ship `app-key-2` and existing installs keep opening their `app-key-1`
envelopes. Re-wrapping is **upgrade in place**, the same shape the v1 → v2
envelope migration uses: `save()` always writes under the current
`envelopeKeyId`, so the next write the engine makes — the `meshId` anchor on
the next `connect()`, at the latest — re-wraps the record under `app-key-2` and
records the new id. Nothing scans or rewrites storage eagerly.

Retiring a previous key is therefore a product decision, not a deploy step. An
install that never comes back keeps its envelope on the old id forever, and
dropping that key from the map makes the credential unopenable — the user must
re-pair. Keep a previous key for at least as long as you are willing to
support a returning client.

Two compatibility notes:

- **v1 envelopes record no `keyId`.** The decrypt request for one carries the
  provider's _current_ id, which is exactly the key a provider would have
  returned before this field existed.
- **`keyId` is optional, and `getKey`'s `request` is a second optional
  parameter.** A provider written against the original
  `getKey(purpose?)` signature — including `StaticEnvelopeKeyProvider` — keeps
  compiling and keeps behaving identically; it simply ignores the extra
  argument. Implement the parameter only when you need rotation.

### What an app key actually buys

Be precise about this, because the pattern is easy to oversell.

**A bundled app key is public.** It ships in your JavaScript. An attacker
downloads your bundle exactly the way every user does, and extracts the
constant. There is no obfuscation that changes this — only the time to the
first extraction. And the extraction is permanent and fleet-wide: one person
pulling the constant out of your bundle removes the protection for your entire
install base, not for one user. Rotating afterwards protects future envelopes;
it does nothing for envelopes already harvested.

**What it does buy is cost against bulk, opportunistic harvesting.** A
commodity infostealer that scrapes `localStorage` across thousands of profiles
gets nothing usable from yours without a per-application extraction step. That
is a real and worthwhile increase in the attacker's unit cost. It is **not** a
defense against an attacker who has decided to target your application
specifically; for that attacker the app key is a few minutes of work, once.

**A browser extension is not stopped by it.** It is true that an extension's
content script runs in an isolated world and cannot read your page's JavaScript
variables, so it cannot simply pluck the `CryptoKey` out of your closure. That
is not the relevant path. An extension can fetch your bundle from your origin
like any other client and extract the constant, or inject into the `MAIN` world
and run in your page's own context. Your page's CSP does not constrain
extensions. Treat "an extension is installed" as "the app key is available to
the attacker".

**A per-user, server-delivered app key is materially stronger**, and the
difference is categorical rather than incremental:

- it is **not public** — there is no artifact every user downloads that
  contains it;
- it is **revocable** — you stop serving it to a compromised account and that
  account's stored envelopes stop opening;
- it is **rate-limitable** — fetching it is an authenticated server call you
  can throttle, log, and alert on;
- it **does not generalise** — extracting one user's key gains nothing against
  any other user.

**And it protects the credential, not the local replica.** The envelope covers
the mesh credential record only. The IndexedDB row store is plaintext
regardless of which key provider you choose — see
[Local store format and browser exposure](../../web/docs/local-store-format.md),
Part 1. An attacker with a copy of the browser profile reads your rows, your
outbox, and your change history without touching the envelope. What the app key
contains is the **live sync capability**: the ability to keep syncing as that
device, read future remote writes, and publish new ones. That is containment,
not local confidentiality, and it is worth saying to your users in those terms.

### The offline tension

The strong form and the local-first requirement pull against each other, and
there is no arrangement that satisfies both.

A per-user, server-delivered app key is strong precisely because it is not
resident on the device. But a local-first application must **cold-start
offline**: a user opens the app on a plane, the engine needs the mesh
credential to read and write the local replica, and the credential is inside an
envelope whose key is on a server that cannot be reached. Making that work
means caching the app key locally — which puts it back in the same browser
profile as the credential it protects, available to whoever copies that
profile.

This is a product decision. Pick one deliberately and say which you picked:

**Memory-only (strong; cannot cold-start offline).** Fetch the app key at
sign-in, import it non-extractable, hold it in a module-scoped variable, never
persist it. Every cold start requires the network. A reload while offline
leaves the app unable to open the credential; the honest UX is a "sign in to
continue" screen, not a silent failure — and definitely not a fallback that
mints a fresh mesh identity. Suits applications where a session already implies
connectivity.

**Cached (weaker; cold-starts offline).** Persist the fetched key alongside the
envelope. Against a full profile copy this collapses to roughly the bundled
case: the attacker has the envelope and the key in the same place. It retains
one advantage the bundled key never has — the cached value is still per-user
and still revocable, so extracting it compromises one user, and a server-side
revocation takes effect on the next refresh. Bound the damage with a short
cache lifetime and a refresh on every successful online start: the shorter the
window, the closer the cached mode sits to the memory-only mode.

A middle position worth naming: cache the key but keep the _credential_ behind
a second, device-held gate — a passkey via `WebAuthnEnvelopeKeyProvider`, or a
passphrase via `PassphraseEnvelopeKeyProvider` (see
[Passphrase envelope keys](../../web/docs/passphrase-envelope.md)). A profile
copy then yields the cached app key but still not the credential, and the
offline cold start is a biometric prompt rather than a network round trip.

## Storage layout

### `LocalStorageCredentialStore`

One JSON record per `dbName`:

```
localStorage["interocitor-creds:<dbName>"]
  = { "portableKey": "...", "deviceId": "...", "meshId": "..." }
```

The credential record is scoped by `dbName`. It stores the portable key material,
device id, and optional mesh anchor together.

### `WebAuthnCredentialStore`

The blob lives in the OS keychain via WebAuthn `largeBlob`. A small
hint in `localStorage` records the credential ID so the engine can find
the right credential on reload:

```
localStorage["interocitor-cred:<dbName>"] = base64(rawId)
```

Reading the blob may require a fresh user gesture (Touch ID / Face ID).
Browser apps should call `load()` from an explicit user action when they
choose WebAuthn storage.

### `dbName` is the key

`dbName` is the **local database name**, not the mesh name. Keep it
stable. One credential record per `dbName` forever. The mesh identity
lives **inside** the record (`meshId` field).

The temptation to embed `meshId` into `dbName` (e.g.
`dbName: "todos-${meshId}"`) is wrong: every re‑pair would orphan a new
record in `localStorage`, none of them ever cleaned up. The current
design upserts the single record and refuses stale meshes via the
anchor check.

## Lifecycle

```
construct engine ──► keySource.load()
                       │
                       ▼
               resolve mesh key ──► resolveEncryption()
                                            │
                                            ▼
                                          init() done
                                            │
                                            ▼
                                       connect()
                                            │
                                            ▼
                              loadOrCreateManifest()
                                            │
                                            ▼
                              assertCredentialMeshParity()
                                            │
              ┌──── stored.meshId == active ─┴─── stored.meshId != active
              ▼                                            ▼
        persistCredentials()                        throw MeshCredentialMismatchError
        (writes meshId anchor)                      emit 'credentials:meshMismatch'
```

## Events

| Event                      | When                                    | What to do                                                                                                    |
| -------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `credentials:restored`     | After silent or biometric load succeeds | Optional UI: "signed in as …"                                                                                 |
| `credentials:persisted`    | After `persistCredentials()` writes     | Useful in tests                                                                                               |
| `credentials:conflict`     | Stored `deviceId` differs from active   | Almost always a test artifact                                                                                 |
| `credentials:meshMismatch` | Stored `meshId` differs from live mesh  | Stop the connection and require an explicit re-pair/recovery choice; do not reconnect the same cleared engine |
| `encryption:resolved`      | Key material is now ready               | Safe to call `connect()`                                                                                      |

### Clearing credentials safely

`engine.clearCredentials()` clears the configured key source, its persisted
credential record, and the current engine's resolved encryption state. It does
not delete local rows or outbox entries, select a replacement mesh, or install
new key material.

Use it only as one step in an explicit reset or re-pair flow:

1. Disconnect the current engine.
2. Confirm which remote mesh and key material the user intends to use.
3. Call `clearCredentials()`.
4. Discard that engine instance.
5. Construct a new engine with the intended `remotePath`, `keySource`, local
   store, and `joinExistingMeshPolicy`, then call `init()` and `connect()`.

Calling `connect()` again on the same cleared instance can present an
unencrypted engine to an encrypted mesh and fail with
`MeshEncryptionMismatchError`. If the replacement mesh differs from locally
cached state, remember that the default join policy clears local rows and
queued writes; see
[Joining an existing mesh with local state](api-reference.md#joining-an-existing-mesh-with-local-state).

Clearing only the credential is not enough to reuse the same local database
under another mesh key. Prefer a fresh, isolated `dbName`. Reusing one requires
the application to disconnect every instance and erase the entire old local
store before constructing the replacement engine; otherwise initialization
throws `CredentialReplacementRequiredError` without changing durable state.

## Disabling persistence

```ts
const engine = new Interocitor(adapter, {
  dbName: "demo",
  localStore,
  keySource: new PortablePassphraseKeySource({
    portableKey,
    credentialStore: new MemoryCredentialStore(),
  }),
});
```

Useful for:

- demos and tests where reload is not required;
- apps that manage their own keystore and inject key material on every load.

## Custom implementations

```ts
class MyCustomStore implements CredentialStore {
  async save(creds) {
    /* write to OS keychain via native app integration */
  }
  async load() {
    /* read from OS keychain */
  }
  async clear() {
    /* delete from OS keychain */
  }
}

const engine = new Interocitor(adapter, {
  dbName: "case-vault",
  localStore,
  keySource: new PortablePassphraseKeySource({
    portableKey,
    credentialStore: new MyCustomStore(),
  }),
});
```

Contract:

- `save()` is called from `init()` (once credentials resolve) and from
  `connect()` (to write the `meshId` anchor). It MUST upsert: writing
  the same `dbName` twice replaces the earlier record.
- `load()` should document whether it can prompt. Browser apps using WebAuthn
  should call it from a user action.
- `clear()` MUST remove every record this store wrote for this `dbName` that
  it is able to remove, and MUST document anything it cannot. It MAY keep the
  global device id; the default stores do. A store whose custody belongs to
  the platform is necessarily narrower: `WebAuthnBlobStore.clear()` — and so
  `WebAuthnCredentialStore.clear()` and `WebAuthnEnvelopeKeyProvider` — removes
  only the browser-side credential-id hints. It cannot delete the
  platform-managed credential or the `largeBlob` inside it, so the credential
  record survives `clear()` and remains readable by a later ceremony. See
  [WebAuthn blob store](../../web/docs/webauthn-blob-store.md).

## What can go wrong

- **Lost portable key, no usable credential store, no other device, and no
  recovery wrapper.** The mesh is unreadable because no remaining source can
  reproduce the key. A wrapper published before loss can restore the portable
  key; see [Recovery phrases](recovery.md).
- **Two `dbName`s, one mesh.** The credential store does not enforce
  uniqueness across dbNames. Two engines on the same origin can both
  hold the same mesh's key. Usually fine, but writes from both will be
  attributed to two different device ids.
- **Stale `meshId` anchor after manual remote wipe.** If you deleted
  the remote folder out of band, the engine sees a fresh manifest
  (different `meshId`) and throws `MeshCredentialMismatchError`. Confirm the
  new mesh, then follow the disconnect, clear, and newly configured engine
  procedure above. A bare `clearCredentials()` followed by reconnecting the
  same engine is not sufficient.
- **Origin change.** `localStorage` is origin‑scoped. Moving the app to
  a different domain loses the credential record; user must re‑pair.
- **WebAuthn-only device, user denies biometric.** `load()` returns
  `null`; the app must provide a recovery or re-pairing flow.
