# Recovery API reference

`@interocitor/core` recovery wrappers let a portable-key mesh restore its
connection details and portable key without storing the recovery phrase
remotely. The APIs below define wrapper creation, immutable publication,
lookup, restoration, and deletion.

For the create/restore procedure, use [Recovery phrases](recovery.md). For
threat analysis, use the [security model](security-model.md).

Recovery wrappers apply only to portable-key meshes. They preserve an
encrypted copy of `remotePath`, `portableKey`, and optional manifest
`meshId`. They do not contain storage-provider credentials or a separate
Cloudflare Worker route address.

## Functions

| API | Result | Rejection conditions |
| --- | --- | --- |
| `recoveryLocator(phrase)` | Stable 43-character base64url locator for the normalized phrase; mesh identity and wrapper salt are not inputs | Empty phrase or Web Crypto failure |
| `createRecoveryWrapper(phrase, credentials)` | In-memory `RecoveryWrapper` with a random salt and IV | Empty phrase, missing `remotePath`/`portableKey`, or Web Crypto failure |
| `unwrapRecoveryWrapper(phrase, wrapper)` | Authenticated `RecoveredMeshCredentials` | Unsupported/malformed wrapper, locator mismatch, failed AES-GCM authentication, or invalid decrypted fields |
| `publishRecoveryWrapper(adapter, wrapper)` | Serialized wrapper written through the adapter | Invalid wrapper or adapter write failure |
| `recoverMeshCredentials(adapter, phrase)` | Wrapper lookup, download, validation, and decryption in one call | Adapter read failure plus every `unwrapRecoveryWrapper` rejection |

`publishRecoveryWrapper` does not define overwrite semantics. Generic
adapters use their normal `writeFile` behavior; the Cloudflare Worker
recovery route accepts only the first write for a locator.

Because the same normalized phrase always produces the same locator, phrase
reuse within one adapter namespace is a collision. A generic adapter may
replace another mesh's wrapper; the Worker returns `409`. Applications must
generate a unique high-entropy phrase for each mesh and replacement wrapper.

## Credential result

`RecoveredMeshCredentials` contains:

| Field | Required | Meaning |
| --- | --- | --- |
| `remotePath` | Yes | Remote root supplied to `Interocitor` |
| `portableKey` | Yes | High-entropy base58 input for `PortablePassphraseKeySource` |
| `meshId` | No | Manifest mesh identity known when the wrapper was created |

`meshId` is not necessarily a Cloudflare Worker route address. A named
deployment already knows an address such as `main`; a provisioned
deployment must recover its address from application-owned connection or
account data.

## Wrapper format

`RecoveryWrapper` is JSON with this public shape:

| Field | Value |
| --- | --- |
| `v` | `1` |
| `alg` | `AES-GCM` |
| `kdf.root` | `PBKDF2-HMAC-SHA-256` and the accepted iteration count |
| `kdf.kek` | `HKDF-SHA-256` and a per-wrapper base64url salt |
| `locator` | Phrase-derived 43-character base64url lookup capability |
| `iv` | Random 96-bit AES-GCM IV encoded as base64url |
| `ciphertext` | Authenticated encrypted credential JSON encoded as base64url |
| `createdAt` | Client-recorded ISO timestamp; informational and not authenticated |

Phrase normalization uses Unicode NFKD, trims leading/trailing whitespace, and
collapses internal whitespace runs to one space. Version 1 derives a recovery
root with 600,000 PBKDF2-HMAC-SHA-256 iterations, then derives the locator and
AES-GCM KEK separately. AES-GCM associated data contains the locator and
per-wrapper salt. Fixed version/algorithm/KDF identifiers are validated before
decryption; `createdAt` is not associated data. A copied wrapper and locator
permit offline phrase guesses, so the application must generate a
high-entropy phrase.

## Storage adapter behavior

Generic `StorageAdapter` implementations store the serialized wrapper at:

~~~text
/.interocitor/recovery/<locator>.json
~~~

An adapter can implement `RecoveryStorageAdapter` instead:

| Method | Contract |
| --- | --- |
| `readRecoveryWrapper(locator)` | Return serialized wrapper bytes for a validated locator |
| `writeRecoveryWrapper(locator, data)` | Store serialized wrapper bytes for a validated locator |

`CloudflareAdapter` implements that extension when configured with:

| Option | Default | Behavior |
| --- | --- | --- |
| `recoveryBaseUrl` | None | Required by recovery reads/writes; identifies the Worker recovery route without a mesh address |
| `recoveryToken` | `token` | Bearer used for recovery requests; when omitted, the adapter reuses its normal token |

The Worker implementation, including immutable PUT behavior, request limits,
statuses, middleware boundary, and audit events, is defined by the
[Worker recovery-route reference](../../workers/docs/runtime-options.md#recovery-wrapper-route).

## Replacement, deletion, and revocation

`RecoveryStorageAdapter` has no delete method, and core exposes no
delete-wrapper function. Removal is a provider- or host-administration
operation.

Use a new random phrase to replace a wrapper. It derives a new locator and
works with both generic overwrite-capable adapters and the immutable Worker
route. After verifying the new wrapper, delete the old object out of band when
required.

Deleting a wrapper prevents later reads of that object but cannot revoke a
portable key already recovered or copied. Key revocation requires creating a
new mesh with new key material and migrating the data.

`recoverMeshCredentials(adapter, wrongPhrase)` usually fails during the read
for the wrong phrase-derived locator. Direct `unwrapRecoveryWrapper` can
distinguish a locator mismatch because the caller already supplies a wrapper.
