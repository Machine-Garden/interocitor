# Credential store

The credential store is where the engine persists the **passphrase**,
**device id**, and the **mesh id anchor** between sessions. Without it,
every reload would force a re‑pair.

This is the deep document. The README has the day‑to‑day usage.

## Why it exists

Two reasons:

1. **Reload survival.** A user opens the app, the engine needs the same
   AES key it used yesterday. The key is derived from the passphrase, so
   the passphrase has to live somewhere durable on the device.
2. **Mesh anchor.** Each `dbName` records the `meshId` it last connected
   to. On the next connect the engine compares stored `meshId` against
   the live one and refuses to silently reuse a stale key. This catches
   "same `dbName`, new mesh" mistakes early instead of poisoning the
   remote.

## Interface

```ts
interface StoredCredentials {
  passphrase: string;
  deviceId: string;
  meshId?: string;          // anchor, written after manifest is known
}

interface CredentialStore {
  save(creds: StoredCredentials): Promise<void>;
  load(): Promise<StoredCredentials | null>;
  clear(): Promise<void>;
}
```

## Built‑in implementations

| Class | Backing store | Auth gate | Survives Safari ITP / cache wipe |
| --- | --- | --- | --- |
| `@interocitor/web` `LocalStorageCredentialStore` | `localStorage` | None | No |
| `@interocitor/web` `WebAuthnCredentialStore` | WebAuthn `largeBlob` (OS keychain) | Touch ID / Face ID | Yes |
| `@interocitor/web` `createWebCredentialStore(...)` | WebAuthn if available, else localStorage | Mixed | Best‑effort |

Core never wires a browser default automatically. Runtime code constructs a
store explicitly when it wants to:

- pin a specific implementation (e.g. force biometrics);
- run tests that need a deterministic store;
- disable persistence entirely (`credentialStore: null`).

## Storage layout

### `LocalStorageCredentialStore`

One JSON record per `dbName`:

```
localStorage["interocitor-creds:<dbName>"]
  = { "passphrase": "...", "deviceId": "...", "meshId": "..." }
```

A global device id lives at `localStorage["interocitor-device-id"]` so
new dbNames on the same origin reuse the same physical device id.

A legacy split format is still **read** for migration:

```
localStorage["interocitor-key:<dbName>"]    // old: passphrase only
localStorage["interocitor-device-id"]        // old: global device id
```

The first successful `save()` upgrades to the unified record and clears
the legacy entry.

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
construct engine ──► credentialStore.load()
                       │
                       ▼
                  apply passphrase ──► resolveEncryption()
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

| Event | When | What to do |
| --- | --- | --- |
| `credentials:restored` | After silent or biometric load succeeds | Optional UI: "signed in as …" |
| `credentials:persisted` | After `persistCredentials()` writes | Useful in tests |
| `credentials:conflict` | Stored `deviceId` differs from active | Almost always a test artifact |
| `credentials:meshMismatch` | Stored `meshId` differs from live mesh | Show a "this key belongs to a different mesh" UI; offer `clearCredentials()` |
| `encryption:resolved` | Key material is now ready | Safe to call `connect()` |

## Disabling persistence

```ts
const engine = new Interocitor(adapter, {
  dbName: 'demo',
  localStore,
  credentialStore: null,    // passphrase lives only in memory
});
```

Useful for:

- demos and tests where reload is not required;
- apps that manage their own keystore and pass the passphrase via
  `setPassphrase()` on every load.

## Custom implementations

```ts
class MyCustomStore implements CredentialStore {
  async save(creds) { /* write to OS keychain via native bridge */ }
  async load()      { /* read from OS keychain */ }
  async clear()     { /* delete from OS keychain */ }
}

const engine = new Interocitor(adapter, {
  dbName: 'meal-planner',
  localStore,
  credentialStore: new MyCustomStore(),
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

- **Lost passphrase, no biometrics, no other device.** The mesh is
  unreadable. There is no recovery path inside the library — the data
  is encrypted end‑to‑end and the key is gone.
- **Two `dbName`s, one mesh.** The credential store does not enforce
  uniqueness across dbNames. Two engines on the same origin can both
  hold the same mesh's key. Usually fine, but writes from both will be
  attributed to two different device ids.
- **Stale `meshId` anchor after manual remote wipe.** If you deleted
  the remote folder out of band, the engine sees a fresh manifest
  (different `meshId`) and throws `MeshCredentialMismatchError`. Call
  `engine.clearCredentials()` and reconnect.
- **Origin change.** `localStorage` is origin‑scoped. Moving the app to
  a different domain loses the credential record; user must re‑pair.
- **WebAuthn‑only device, user denies biometric.** `load()` returns
  `null`, engine asks the app for a passphrase. Provide a UI.
