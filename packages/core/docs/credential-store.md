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
| default `createWebCredentialStore(dbName)`                        | plaintext `localStorage` JSON                                                                     | None                                       | Same origin until browser data is cleared              |

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

Stores the credential record in `localStorage`.

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
- `clear()` MUST remove every record this store wrote for this `dbName`.
  It MAY keep the global device id; the default stores do.

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
