# Interocitor dictionary

This is a reference for the terms used across Interocitor’s APIs and
documentation. It describes current behaviour. Where a term names a planned
key-management design, it says so explicitly.

## Portable key

A **portable key** is the high-entropy, copyable secret that currently unlocks
an encrypted mesh. It is represented as a base58 string, but it is **not a
password**: do not choose one yourself, shorten it, or expect it to be
rememberable.

Think of it as a capability. Anyone who has both the portable key and a copy
of the remote mesh data can decrypt that mesh’s rows and ordinary files. A
portable key is normally delivered by pairing, a secure application flow, or
an intentional manual transfer; it must not be put in source control, URLs
that reach a server, analytics, or logs.

The current `PortablePassphraseKeySource` uses the portable key directly as
the mesh encryption key. The name `passphrase` is retained in some APIs for
compatibility; it does not mean a human password or a password-derived key.
Losing every copy of the portable key loses access to the encrypted mesh.

## Mesh

A **mesh** is the group of devices sharing one encrypted data space. It
includes the row database, durable files, device records, encryption
configuration, and a remote mailbox path. A mesh is not an account and does
not require an Interocitor-operated service.

## Mesh key

The **mesh key** is the AES-GCM key that encrypts change files, snapshots, and
ordinary durable files before upload. In today’s portable-key mode, the
portable key is the mesh key encoded as base58.

## Key source

A **key source** is the application-supplied object that tells the engine how
to obtain mesh-key material and where to persist mesh credentials. Core ships
`PortablePassphraseKeySource` for the copyable-key model and
`BoundSharedKeySource` for applications that derive the final mesh key from
their own inputs.

## Credential store

A **credential store** persists the local mesh credential record between
sessions. Depending on the runtime and configuration, this may be browser
storage, memory, WebAuthn/passkey storage, or an encrypted credential
envelope. It is local to the device; it is not the remote mesh mailbox.

## Credential envelope

A **credential envelope** is an AES-GCM-encrypted local record containing
mesh credentials. A browser may store that ciphertext in local storage or a
backend while a separate local or external key provider unlocks it. This
protects credentials at rest; it does not change how mesh data is encrypted.

## Pairing and handshake wrapping key

**Pairing** lets one device share mesh connection details with another. The
QR protocol uses ephemeral ECDH to derive a temporary **handshake wrapping
key**, which encrypts those details while they pass through a short-lived
relay. The QR itself does not contain the portable key. This temporary key is
not the mesh key and is discarded after the handshake.

## Recovery words, KEK, wrapper, and DEK

This is the intended recovery-key hierarchy; it is not a current public
protocol.

A **recovery phrase** is a randomly generated, user-recorded set of 12 words. It must be converted
with a password-hardening KDF into a **KEK** (key-encryption key); the words
themselves are not an AES key. The recovery phrase can support either of two
recovery modes:

- **Direct recovery:** the recovered material is the real mesh **DEK**
  (data-encryption key), so the words restore direct access to the mesh.
- **Wrapped recovery:** the real DEK is random and the server stores a
  **wrapper** (an encrypted copy of that DEK). The KEK derived from the 12
  words unlocks the wrapper and restores the real DEK. The server never needs
  the words or the unwrapped DEK.

The DEK encrypts mesh data. A wrapper is only an encrypted key record; it
does not encrypt rows or files itself. A product may additionally use a
device-local wrapper key, protected by a passkey, OS keychain, or KMS, to keep
the recovered DEK out of ordinary browser storage.

Today Interocitor has no recovery phrase or server-side DEK wrapper. The
portable key directly represents the mesh key and is persisted through the
configured credential store—usually browser local storage, optionally
WebAuthn/passkey storage or a caller-supplied encrypted envelope. These names
must not be confused with the existing temporary QR handshake wrapping key.
See the [shared-key scenarios](../packages/core/docs/shared-key-scenarios.md)
for the current portable-key model and intended bound-key direction.

## Remote mailbox

The **remote mailbox** is the storage backend used to exchange encrypted
artifacts. It can be WebDAV, Google Drive, Cloudflare, or a custom adapter.
It stores ciphertext and routing metadata; it does not merge CRDT rows or
need access to plaintext.

## Adapter

A **storage adapter** connects Interocitor to a remote mailbox. It implements
file-like operations such as listing, reading, writing, and deleting remote
objects. An adapter is transport/storage plumbing, not the source of mesh
encryption keys.

## Local store

A **local store** is the device’s local database. It makes reads and writes
available offline and keeps the sync outbox. Interocitor encrypts data before
remote upload; the local store is within the trusted-device boundary and may
contain plaintext.

## Manifest

A **manifest** is the small, plaintext remote control record for a mesh. It
identifies the mesh and describes the current sync generation, schema,
encryption-on/off state, and snapshot state. It does not contain the portable
key or plaintext row/file contents.

## Device ID and mesh ID

A **device ID** identifies one client replica for ordering and diagnostics. A
**mesh ID** identifies the shared mesh. Both are visible to the remote as part
of normal routing metadata; neither is a decryption secret.

## Change file, snapshot, and compaction

A **change file** contains one encrypted batch of CRDT operations. A
**snapshot** is an encrypted full representation of the row state at a point
in time. **Compaction** publishes a snapshot and allows old change history to
be retired once it is safe.

## CRDT and HLC

A **CRDT** is the conflict-resolution model that lets replicas merge changes
without a central database deciding the result. An **HLC** (hybrid logical
clock) gives changes a monotonic, mergeable timestamp used by that model.

## Durable file and sealed (tainted) file

A **durable file** is a path-addressed byte object in the mesh. It is uploaded,
read, overwritten, and deleted directly; unlike rows, it is not CRDT-merged.

A **sealed** or **tainted** file is a durable file encrypted with an explicit
extra key instead of the mesh key. The taint is only a human-readable label;
the caller must supply the matching key to open the bytes.

## Encryption boundary

The **encryption boundary** is the point before data leaves the device. Change
payloads, snapshots, and durable file bytes are encrypted on the client.
Object names, sizes, timestamps, the manifest, and device identifiers remain
visible to the remote. See the [security model](../packages/core/docs/security-model.md)
for the complete threat model.
