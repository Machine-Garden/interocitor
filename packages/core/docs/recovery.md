# Recovery phrases

Use a recovery phrase to restore the existing portable key for a mesh when a
device no longer has its local credential record. Your application generates,
displays, and validates the phrase; Interocitor treats it as opaque text and
never sends it to the remote.

Recovery is optional for portable-key meshes. It does not
change row, snapshot, or file ciphertext: the recovery wrapper contains an
encrypted copy of the portable mesh key and connection details.

The TypeScript snippets on this page are partial application flows. Storage
login, UI, local-store construction, and application-specific phrase
generation remain application responsibilities and are outside the snippets.

## Create a recovery wrapper

Create the wrapper only after the mesh is connected, so it carries the
authoritative mesh ID. Display the phrase once and have the user record it in
a password manager or on paper. Do not log it or upload it. Generate a new
phrase for every mesh and every replacement wrapper.

```ts
import {
  createRecoveryWrapper,
  publishRecoveryWrapper,
} from '@interocitor/core';

// Generate and show this in application code.
const phrase = phraseGeneratedByYourApp;
const portableKey = keySource.getPortableKey();
const meshId = db.getMeshId();
if (!portableKey || !meshId) throw new Error('Connect the mesh before enabling recovery');

const wrapper = await createRecoveryWrapper(phrase, {
  remotePath,
  portableKey,
  meshId,
});

await publishRecoveryWrapper(adapter, wrapper);
```

For WebDAV and other generic storage adapters, the wrapper is an opaque JSON
file at `/.interocitor/recovery/<opaque-locator>.json`. The locator is derived
on the client from the recovery phrase; it is not the phrase and reveals no
mesh ID.

Interocitor accepts any non-empty phrase after Unicode/whitespace
normalization. The application must generate and validate a high-entropy
format; for example, a 12-word BIP-39 phrase represents 128 bits plus its
checksum. Do not accept user-chosen words.

The normalized phrase alone determines the locator. It is not namespaced by
`meshId`, `remotePath`, or wrapper salt. Reusing a phrase in the same adapter
storage namespace therefore targets the same object:

- a generic adapter may overwrite the earlier wrapper through its normal
  `writeFile` behavior;
- the Interocitor Worker route rejects a second write to that locator with
  `409`.

Phrase uniqueness is an application invariant. Do not reuse a recovery phrase
across meshes or wrapper generations.

## Recover on a new device

The recovering app must still know how to reach and authenticate to the
storage provider. The phrase restores mesh identity and encryption material;
it does not restore WebDAV credentials, Google OAuth, or application login.

```ts
import {
  Interocitor,
  PortablePassphraseKeySource,
  recoverMeshCredentials,
} from '@interocitor/core';

const recovered = await recoverMeshCredentials(adapter, phraseFromUser);

const db = new Interocitor(adapter, {
  dbName: 'case-vault',
  remotePath: recovered.remotePath,
  localStore,
  keySource: new PortablePassphraseKeySource({
    portableKey: recovered.portableKey,
    credentialStore,
  }),
});

await db.init();
await db.connect();
```

After `recoverMeshCredentials` returns, the app has the values needed
to recreate `PortablePassphraseKeySource` and the engine's remote root.
The app still owns local credential persistence and any confirmation required
before saving the recovered key.

A wrong phrase derives a different lookup locator. The common failure is
therefore an adapter not-found/read error before any wrapper can be decrypted.
`unwrapRecoveryWrapper` reports a phrase mismatch only when the application
already has a specific wrapper and calls it directly.

## Rotate or remove a wrapper

Core exposes wrapper reads and writes, but no delete operation.

To replace a wrapper:

1. Generate a new random phrase. A new phrase creates a new locator.
2. Publish the new wrapper and verify recovery through that locator.
3. Remove the old object through the storage provider or host administration
   when policy requires it.

This sequence is required by the immutable Worker recovery route. A generic
adapter may permit overwriting one locator, but relying on that behavior makes
the flow adapter-specific and risks same-phrase collisions.

Removing a wrapper prevents future recovery through that object. It does not
revoke a portable key already recovered or copied. Rotate a compromised
portable key by creating a new mesh and migrating the data.

## Cloudflare Workers

Workers expose `/<mountPrefix>/recovery/<locator>` for wrappers, outside the
mesh-specific `/io/<address>` route. Configure `CloudflareAdapter` with that
known recovery endpoint when recovering a forgotten mesh ID:

```ts
const recoveryAdapter = new CloudflareAdapter({
  // A placeholder is sufficient for recovery; no /io request is made yet.
  baseUrl: 'https://worker.example/sync/io/recovery',
  recoveryBaseUrl: 'https://worker.example/sync/recovery',
  recoveryToken: tokenIssuedForRecoveryNamespace,
});

const recovered = await recoverMeshCredentials(recoveryAdapter, phraseFromUser);
```

`recoveryToken` is forwarded as a bearer header. The recovery route is
capability-addressed by its opaque locator and does not pass mesh middleware.
When a deployment also requires request authentication, route
`createInterocitorMount(...)` manually and apply host policy before delegating
`/recovery/*`; issue `tokenIssuedForRecoveryNamespace` through that policy.
`withInterocitor(...)` is appropriate when locator possession is the complete
recovery access rule.

The recovered `meshId` is the identity stored in the manifest. It is not
necessarily the Worker route `<address>`. A deployment using a stable name
such as `main` already knows that address; an application using provisioned
addresses must restore the address from its own account or connection
configuration before constructing the normal `CloudflareAdapter`.

For the exact GET/PUT statuses, size limit, middleware boundary, and audit
events, see the [Worker recovery-route reference](../../workers/docs/runtime-options.md#recovery-wrapper-route).

For exact function results, rejection conditions, wrapper fields, derivation
parameters, and adapter storage modes, see the
[Recovery API reference](recovery-reference.md).

## Security and revocation

The phrase is converted locally into a hardened recovery root. That root
derives both an opaque locator and the AES-GCM KEK used to unwrap the stored
record. The wrapper has a random salt. AES-GCM associated data authenticates
the locator and that salt; fixed version and algorithm fields are validated
before decryption.

The remote sees the locator, ciphertext, version, algorithm and KDF metadata,
salt, IV, and client-recorded `createdAt`. The timestamp is informational and
is not authenticated. A copied wrapper can be used to test guessed phrases
offline, so the application must generate high-entropy phrases randomly;
never allow user-chosen recovery words.

For exact fields and failure behavior, use the
[Recovery API reference](recovery-reference.md).
