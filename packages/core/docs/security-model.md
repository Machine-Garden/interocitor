# Security model

With a non-null `keySource`, `@interocitor/core` encrypts row changes,
snapshots, and ordinary durable files before a remote adapter receives them.
Routing and operational metadata remain visible, and authorized client code
can read plaintext.

The threat model below defines the attacker and protection boundaries. For a
short orientation, use the package README. For shared-key deployment modes and
auditor-facing scenarios, see
[Shared key scenarios](shared-key-scenarios.md).

## What encryption protects

When a mesh is configured with a non-null `keySource`, the engine uses
**AES‑GCM with a 256‑bit key**. The `keySource` is responsible for producing
the final mesh key material. In practice that means either:

- a **portable shared key** source such as `PortablePassphraseKeySource`; or
- a **bound shared key** source such as `BoundSharedKeySource`.

See [Shared key scenarios](shared-key-scenarios.md) for the supported
configurations and what each one means for database-dump exposure and
credential portability.

Every change file, snapshot, and durable app file is encrypted **before** it leaves the device. The remote sees only an `EncryptedEnvelope` blob:

```
version | iv (12 bytes) | ciphertext (incl. AES-GCM tag)
```

What this gives you:

- **Confidentiality of row contents.** Field names, field values, and
  table names are inside the encrypted payload. The remote cannot read
  them without the final mesh key.
- **Confidentiality of durable file contents.** `putFile()` encrypts file
  bytes with the mesh key before adapter upload when the mesh has a non-null `keySource`.
  Browser image helpers in `@interocitor/web` delegate to this API.
- **Integrity of each entry.** AES‑GCM is authenticated; flipped bits in
  ciphertext fail to decrypt and trigger a `decode:error` →
  `remote:poisoned` flow.

## What encryption does not protect

The crypto is end‑to‑end at the row/change, snapshot, and durable-file payload
boundaries. Routing and operational metadata around those payloads is
plaintext on the remote.

- **Protocol object names and durable-file paths.** Change files are named
  `<HLC>-chg_<id>.json`; the HLC encodes a wall-clock timestamp and a device
  id. Snapshot and manifest names have fixed protocol roles. These are not
  client-facing filenames. A durable file path, however, comes from the path
  supplied to `putFile()` and is visible to the remote. Use an opaque,
  application-generated path rather than a real filename when that name is
  sensitive.
- **Folder layout.** The remote folder structure (`changes/`, `mainline/`,
  `devices/`, `files/`, `manifest.json`) is fixed and visible.
- **Manifest contents.** `manifest.json` and `manifest-<gen>.json` are
  **not encrypted**. They contain `meshId`, `schema`, `epoch`,
  `watermarkHlc`, `writtenBy` (device id), `writtenAt`, encryption mode,
  and `server` config. Treat the manifest as public.
- **Device list.** `devices/<deviceId>.json` files contain
  `displayName`, `deviceType`, last-seen and acknowledgement timestamps.
  These metadata files are plaintext, and the device id also appears in the
  file name.
- **Sizes & timing.** Sync file sizes leak row sizes. Durable file object
  sizes leak approximate attachment/image sizes. Write/read timing leaks
  user activity patterns.
- **Portable key strength.** If a `keySource` uses a portable base58 key,
  that value must be high entropy. The engine maps the base58 value
  directly to 32 random bytes — there is **no KDF stretching** (no PBKDF2,
  no Argon2). Generated portable keys are safe; short human-chosen values
  are not.
- **Local store.** Rows live in IndexedDB (browser) or SQLite (Swift) in
  plaintext. An attacker with code execution on the device reads them
  directly. Encryption is for the cloud, not for the device.
- **Credential store at rest.** A browser `PortablePassphraseKeySource`
  may persist its portable key component through `createWebCredentialStore(dbName)`.
  The default path writes that credential record to `localStorage` in plain text. Use `MemoryCredentialStore`,
  `SessionStorageCredentialStore`, `WebAuthnCredentialStore`, or
  `EnvelopedCredentialStore` with a passkey/native/external
  `CredentialEnvelopeKeyProvider` and a local, memory-only, backend, or
  custom `CredentialEnvelopeStore` when device-side credential exposure
  matters. See [Credential store](credential-store.md).
- **Recovery phrases.** An optional recovery wrapper can store an encrypted
  copy of portable mesh credentials on the remote. The application-generated
  phrase and derived KEK remain on the client. The remote sees an opaque
  locator, version and algorithm/KDF metadata, salt, IV, ciphertext, and a
  client-recorded timestamp. A copied wrapper allows offline guesses, so
  recovery words must be randomly generated and never user-chosen. See
  [Recovery phrases](recovery.md).

## What metadata the remote can still observe

Even with encryption on, a remote with full access to the bucket sees:

| Signal                  | Source                                                 | What it reveals                                                                                              |
| ----------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Mesh ID                 | `manifest.meshId`                                      | Logical identity recorded by the mesh manifest                                                               |
| Worker mesh address     | `/io/<address>`                                        | D1/R2 namespace selected by the host; it may be a stable name or checksummed ID                              |
| Durable file path       | `files/<app path>`                                     | Application-supplied path; it reveals a real filename if the application puts one there                      |
| Device IDs              | `devices/<id>.json`, change‑file names                 | One value per device joined to the mesh                                                                      |
| Device metadata         | `devices/<id>.json`                                    | Plaintext device ID, optional `displayName`/type, last-seen time, and compaction acknowledgements            |
| Schema version          | `manifest.schema`                                      | Optional logical compatibility marker when app code sets `schema.version`                                    |
| Write timestamps        | `<HLC>-chg_<id>.json` names                            | Activity timeline per device                                                                                 |
| Write rate              | File creation rate                                     | Bursts and idle periods                                                                                      |
| Row size distribution   | File sizes                                             | Approximate row sizes                                                                                        |
| Snapshot epoch & size   | `mainline/snapshot-<epoch>-<serverId>.json`            | When compactions happen and how big the dataset is                                                           |
| Compaction author       | `manifest.writtenBy`, `serverId` in snapshot file name | Which device compacted                                                                                       |
| Number of devices       | `devices/` listing                                     | Mesh size                                                                                                    |
| Recovery-wrapper record | `/.interocitor/recovery/` or Worker recovery route     | Stable opaque locator plus wrapper crypto metadata, ciphertext, and timestamp; not recovery words or mesh ID |

If any of these are sensitive in your threat model, encryption alone is
not enough — you need a transport that hides metadata (e.g. a relay that
re‑bundles change files) and that is **out of scope** for this library.

## What encryption does not stop the remote from doing

A malicious or compromised remote can:

- **Drop your writes.** Refuse to accept `writeFile`, or accept and then
  delete. The engine retries on the next flush, but a remote that
  silently drops everything is undetectable from the client.
- **Roll back state.** Serve an old `manifest.json` pointer or an old
  snapshot. The client trusts the manifest pointer; there is no
  client‑side proof of monotonicity. (Sync will detect missing change
  files on the next pull, but a clean rollback to an earlier consistent
  generation is silent.)
- **Withhold change files.** Skip files in a `listFiles` response.
  Affected rows simply look stale to the device that didn't see them.
  Other devices may see the full set, leading to divergence.
- **Duplicate a retained change file.** Exact filename receipts suppress a
  true replay. Publishing the same logical payload under a new filename still
  passes through idempotent CRDT merge; ciphertext mutation is rejected by
  AES‑GCM.
- **Poison the manifest.** Write a manifest the client cannot decrypt or
  whose content hash does not match. The engine emits `decode:error`
  and `remote:poisoned`; sync stops until manually recovered.

These are inherent to the "cloud is a mailbox" model. Mitigations live
at the policy layer: pick a remote whose operator you trust to _not_ do
these things (your own WebDAV, your own R2 bucket, your user's Google
Drive).

## Identity & authentication

- **Device identity** is a client-generated UUIDv7 carried by the local runtime
  and credential store. There is no remote registration step. Anyone with write
  access to the remote can claim any device id.
- **Manifest mesh identity** is generated by the client and recorded in
  `manifest.meshId`. It detects accidental credential reuse against a
  different mesh; it is not requester authentication.
- **Worker mesh address integrity** is deployment policy. A Worker can admit
  stable names such as `main`, checksummed IDs issued under its
  `meshSecret`, or both. Address integrity decides which namespaces
  exist; `meshMiddleware` separately decides what a request may do.
- **Portable key material is capability-bearing.** In the portable shared-key
  scenario, knowing the portable key is sufficient to read and write the mesh.
  Loss of the portable key = loss of the mesh unless another device or a
  previously published recovery wrapper can restore it.
  Theft of the portable key = silent compromise; rotate by creating a new mesh
  and migrating data out of the old one.

## Recommendations

| Goal                                           | Setting                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Protect row contents from the storage operator | Configure a non-null `keySource`                                                                                   |
| Generate strong portable key material          | Use high-entropy generated base58 material                                                                         |
| Resist portable-key exfiltration on the device | Use `WebAuthnCredentialStore` or an enveloped credential store                                                     |
| Limit which Worker namespaces may be created   | Configure integrity gates; use checksummed IDs with a deployment `meshSecret` when the application provisions them |
| Limit who can compact                          | `serverManaged: true` + dedicated `serverId`                                                                       |
| Detect remote poisoning early                  | Subscribe to `remote:poisoned` and `decode:error`                                                                  |
| Detect stale credential reuse                  | Subscribe to `credentials:meshMismatch`                                                                            |

## Out of scope

- Hiding write timing or device count from the remote.
- Hiding who compacts (snapshot file names embed the device id).
- Per-device revocation. Removing a device from a mesh requires rotating
  the mesh key material, which means creating a new mesh.
- Multi‑tenant isolation on a shared remote. The engine assumes one
  mesh per `remotePath`. Two meshes sharing a folder will mis‑decode
  each other's files and poison the remote.
