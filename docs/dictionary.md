# Interocitor dictionary

Interocitor uses these terms to distinguish encryption capabilities, mesh
identity, local persistence, and remote storage roles. Use the same meanings
when reading its APIs, package guides, and security boundaries.

## Portable key

A **portable key** is the high-entropy, copyable secret that unlocks
an encrypted mesh. It is represented as a base58 string, but it is **not a
password**: do not choose one yourself, shorten it, or expect it to be
rememberable.

Think of it as a capability. Anyone who has both the portable key and a copy
of the remote mesh data can decrypt that mesh’s rows and ordinary files. A
portable key is normally delivered by pairing, a secure application flow, or
an intentional manual transfer; it must not be put in source control, URLs
that reach a server, analytics, or logs.

`PortablePassphraseKeySource` uses the portable key directly as the mesh
encryption key. In this API, `passphrase` means the generated base58 portable
key, not a human password or password-derived key.
Losing every copy of the portable key loses access to the encrypted mesh.

## Mesh

A **mesh** is the group of devices sharing one data space. It includes the row
database, durable files, device records, encryption configuration, and a
remote mailbox path. A mesh is protected remotely when it uses a non-null key
source. A mesh is not an account and does not require an
Interocitor-operated service.

## Mesh key

The **mesh key** is the AES-GCM key that encrypts change files, snapshots, and
ordinary durable files before upload. With `PortablePassphraseKeySource`, the
portable key is the mesh key encoded as base58.

## Key source

A **key source** is the application-supplied object that tells the engine how
to obtain mesh-key material and where to persist mesh credentials. Core ships
`PortablePassphraseKeySource` for the copyable-key model and
`BoundSharedKeySource` for applications that derive the final mesh key from
their own inputs.

## Credential store

A **credential store** holds and loads the device’s mesh credential record.
Depending on the runtime and configuration, it may persist in browser
storage, WebAuthn/passkey storage, or an encrypted credential envelope, or it
may exist only in memory for the current process. It is separate from the
remote mesh mailbox.

## Credential envelope

A **credential envelope** is an AES-GCM-encrypted credential record. A browser
may store that ciphertext in local storage or a backend while a separate local
or external key provider unlocks it. This protects credentials at rest; it
does not change how mesh data is encrypted.

## Pairing and handshake wrapping key

**Pairing** lets one device share mesh connection details with another. The QR
protocol uses ephemeral ECDH to derive a temporary **handshake wrapping key**,
which encrypts those details while they pass through handshake-scoped relay
objects. The QR itself does not contain the portable key. This temporary key
is not the mesh key and is discarded after the handshake. See the
[pairing protocol](../packages/core/docs/pairing.md) for timing, cleanup, and
failure behavior.

## Recovery words, KEK, wrapper, and DEK

A **recovery phrase** is a randomly generated, user-recorded secret, commonly
a set of 12 words. The application owns its word-list format, generation, and
validation. Interocitor converts the supplied phrase with a password-hardening
KDF into a **KEK** (key-encryption key); the words themselves are not an AES
key.

The server stores a **wrapper**: an AES-GCM-encrypted record containing the
portable mesh key, mesh ID, and remote path. The KEK unlocks that wrapper. The
portable mesh key is the mesh **DEK** (data-encryption key) in this mode; the
wrapper only protects its stored copy and does not encrypt rows or files
itself. The remote receives the opaque wrapper locator and ciphertext, never
the phrase, KEK, or unwrapped portable key.

The wrapper can be recovered without remembering the manifest mesh ID. It
does not recover a storage-provider login or a separate Worker route address.
The portable key is also persisted through the configured credential store—browser
storage, WebAuthn/passkey storage, memory, or a caller-supplied encrypted
envelope. The recovery KEK is separate from the temporary QR handshake
wrapping key. See [Recovery phrases](../packages/core/docs/recovery.md) and the
[shared-key scenarios](../packages/core/docs/shared-key-scenarios.md).

## Remote mailbox

The **remote mailbox** is the storage backend used to exchange row-sync
artifacts and hold durable files. It can be WebDAV, S3, Google Drive, Cloudflare,
or a custom adapter. With a non-null key source it stores ciphertext plus
routing metadata; with a null key source payload artifacts are not encrypted.
The mailbox does not merge CRDT rows.

## Adapter

A **storage adapter** connects Interocitor to a remote mailbox. It implements
file-like operations such as listing, reading, writing, and deleting remote
objects. An adapter is transport/storage plumbing, not the source of mesh
encryption keys.

## Local store

A **local store** is the device database used for row reads, writes, and the
sync outbox. After that store initializes successfully, row work does not need
the remote. A raw store can still fail; an application that configures the
resilient wrapper can fall back to memory for the current session. The local
store is within the trusted-device boundary and may contain plaintext.

## Manifest

A **manifest** is the small, plaintext remote control record for a mesh. It
identifies the mesh and describes the current sync generation, schema,
encryption-on/off state, and snapshot state. It does not contain the portable
key or plaintext row/file contents.

## Device ID and mesh ID

A **device ID** identifies one client replica for ordering and diagnostics. A
**mesh ID** identifies the shared mesh. Both are visible to the remote as part
of normal routing metadata; neither is a decryption secret.

A Cloudflare **mesh address** is the route segment in `/io/<address>` that
selects the D1, R2, and relay namespace. The host can admit a stable name such
as `main`, a checksummed issued value, or another address form through
integrity gates. The address is deployment routing and can differ from the
manifest mesh ID.

## Change file, snapshot, and compaction

A **change file** contains one batch of CRDT operations. A **snapshot** is a
full representation of row state at a point in time. For a mesh with a
non-null key source, both are encrypted before upload. **Compaction** publishes
a snapshot and allows old change history to be retired once it is safe.

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
payloads, snapshots, and durable file bytes are encrypted on the client when
the mesh uses a non-null key source. Object names, sizes, timestamps, the
manifest, and device identifiers remain visible to the remote. With a null key
source, remote payloads are not confidential. See the
[security model](../packages/core/docs/security-model.md) for the complete
threat model.
