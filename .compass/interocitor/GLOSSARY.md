# Glossary — interocitor

The canonical source for this language is the project's own
[dictionary](../../docs/dictionary.md), written for humans before this chart
existed. Where code and product disagree, the product word is canonical here and
the code word is recorded as an alias.

## **Mesh**

### Meaning

One shared data space and the set of devices entitled to hold a complete copy of
it. Not an account, not a service, not a subscription.

### Bounded context

[**Mesh**](./DOMAIN.md#mesh)

### Product appearance

What an application creates, joins, pairs into, and recovers.

### Implementation aliases

`meshId`, `remotePath` — code names the mesh by its identity and its location,
never by the whole.

## **Device**

### Meaning

One participant holding a copy of the mesh and able to originate changes to it.
The dictionary also calls this a _client replica_.

### Bounded context

[**Mesh**](./DOMAIN.md#mesh)

### Product appearance

A browser tab, a phone, or a headless process that appears in a mesh's device
records.

### Implementation aliases

`deviceId`, `endpoint`

## **Mesh ID**

### Meaning

The identity of the shared mesh, agreed by every device in it and visible to the
remote as routing metadata. Not a secret.

### Bounded context

[**Artifact Exchange**](./DOMAIN.md#artifact-exchange)

### Product appearance

Recorded in the manifest; asked for when re-joining a mesh.

## **Device ID**

### Meaning

The identity of one client replica, used for ordering changes and for
diagnostics. Visible to the remote and not a decryption secret.

### Bounded context

[**Mesh**](./DOMAIN.md#mesh)

## **Row**

### Meaning

An addressable record in the mesh, made of independently changeable columns and
merged per column rather than whole.

### Bounded context

[**Row Convergence**](./DOMAIN.md#row-convergence)

### Product appearance

What an application adds, patches, and queries through a table.

## **Tombstone**

### Meaning

The persisting record that a row was deleted, kept so a late-arriving change
cannot resurrect it.

### Bounded context

[**Row Convergence**](./DOMAIN.md#row-convergence)

### Product appearance

A deleted row that stays deleted on every device, including ones that were
offline when it went.

## **CRDT**

### Meaning

The conflict-resolution model that lets replicas merge changes without a central
database deciding the result. Interocitor's variant is per-column
last-write-wins with tombstones.

### Bounded context

[**Row Convergence**](./DOMAIN.md#row-convergence)

## **HLC**

### Meaning

A hybrid logical clock: the monotonic, mergeable stamp carried by every column
change so devices can order changes without a shared clock.

### Bounded context

[**Row Convergence**](./DOMAIN.md#row-convergence)

## **Local store**

### Meaning

The device database holding rows, the sync outbox, and sync bookkeeping. Once it
initializes, row work does not need the remote. It sits inside the trusted
device boundary and may hold plaintext.

### Bounded context

[**Row Convergence**](./DOMAIN.md#row-convergence)

### Product appearance

Why an application keeps working with the network off.

## **Remote mailbox**

### Meaning

The storage backend a mesh exchanges artifacts through and stores durable files
in. It never merges, queries, or reads what it carries.

### Bounded context

[**Artifact Exchange**](./DOMAIN.md#artifact-exchange)

### Product appearance

"Bring your own storage" — a WebDAV server, a Drive account, a Worker
deployment.

### Implementation aliases

`remote`, `adapter target`

## **Storage adapter**

### Meaning

The connector that lets a mesh use one kind of remote mailbox. It implements
listing, reading, writing, and deleting objects, and is never a source of key
material.

### Bounded context

[**Artifact Exchange**](./DOMAIN.md#artifact-exchange)

### Implementation aliases

`StorageAdapter`

## **Change file**

### Meaning

One batch of a device's row operations, written whole to the mailbox for other
devices to collect. Identified by its exact name.

### Bounded context

[**Artifact Exchange**](./DOMAIN.md#artifact-exchange)

## **Snapshot**

### Meaning

A full representation of row state at a point in time, published so the change
files it covers need not be replayed.

### Bounded context

[**Artifact Exchange**](./DOMAIN.md#artifact-exchange)

## **Compaction**

### Meaning

Publishing a snapshot and retiring the change history it covers, once retiring
it is safe for every device that has not caught up.

### Bounded context

[**Artifact Exchange**](./DOMAIN.md#artifact-exchange)

## **Manifest**

### Meaning

The small, unencrypted control record naming the mesh, its generation and
schema, whether it is protected, and which snapshot is current. It never
contains the portable key or row and file content.

### Bounded context

[**Artifact Exchange**](./DOMAIN.md#artifact-exchange)

## **Generation**

### Meaning

Which era of a mesh's exchange history a device is working in. A device in an
older generation must reconcile before it resumes writing.

### Bounded context

[**Artifact Exchange**](./DOMAIN.md#artifact-exchange)

### Implementation aliases

`syncGeneration`

## **Durable file**

### Meaning

A path-addressed byte object in the mesh, written and read whole and never
CRDT-merged.

### Bounded context

[**Durable Files**](./DOMAIN.md#durable-files)

### Product appearance

Images and attachments an application puts, gets, opens, and deletes.

## **Sealed file**

### Meaning

A durable file encrypted with an explicit extra key instead of the mesh key, so
mesh membership alone does not open it. The seal is a human-readable label, not
a guard.

### Bounded context

[**Durable Files**](./DOMAIN.md#durable-files)

### Implementation aliases

`tainted` — the code word predates the product word and means the same thing.

## **Encryption boundary**

### Meaning

The point before data leaves the device. Change payloads, snapshots, and durable
file bytes are encrypted here. Object names, sizes, timestamps, device IDs, and
the manifest remain visible beyond it.

### Bounded context

[**Trust and Custody**](./DOMAIN.md#trust-and-custody)

## **Mesh key**

### Meaning

The single key that encrypts a mesh's change files, snapshots, and ordinary
durable files before upload.

### Bounded context

[**Trust and Custody**](./DOMAIN.md#trust-and-custody)

## **Portable key**

### Meaning

The high-entropy, copyable form of the mesh key. It is generated, not chosen,
and it is a capability rather than a password: whoever holds it and a copy of
the mesh data can read that mesh.

### Bounded context

[**Trust and Custody**](./DOMAIN.md#trust-and-custody)

### Product appearance

The base58 string transferred by pairing, a deliberate manual hand-off, or an
application's own secure flow. Never in source control, URLs, analytics, or
logs.

### Implementation aliases

`passphrase` — as in `PortablePassphraseKeySource`, where it means the generated
portable key and never a human password.

## **Key source**

### Meaning

The application-supplied object telling the engine how to obtain mesh-key
material and where to persist mesh credentials.

### Bounded context

[**Trust and Custody**](./DOMAIN.md#trust-and-custody)

### Implementation aliases

`KeySource`, `PortablePassphraseKeySource`, `BoundSharedKeySource`

## **Credential store**

### Meaning

Where a device's mesh credential record is held and loaded from — browser
storage, a passkey, an encrypted envelope, or memory for one process.

### Bounded context

[**Trust and Custody**](./DOMAIN.md#trust-and-custody)

## **Credential envelope**

### Meaning

An encrypted credential record whose ciphertext may be stored anywhere, unlocked
by a separate key provider. It protects credentials at rest and changes nothing
about how mesh data is encrypted.

### Bounded context

[**Trust and Custody**](./DOMAIN.md#trust-and-custody)

## **Pairing**

### Meaning

The deliberate, time-boxed act by which a device already in a mesh shares
connection details with another.

### Bounded context

[**Trust and Custody**](./DOMAIN.md#trust-and-custody)

### Product appearance

Scanning a QR code on a second device. The QR itself never carries the portable
key.

## **Handshake wrapping key**

### Meaning

The temporary key derived during a pairing that protects the connection details
in transit. Unrelated to the mesh key and discarded when the pairing ends.

### Bounded context

[**Trust and Custody**](./DOMAIN.md#trust-and-custody)

## **Recovery phrase**

### Meaning

A randomly generated, user-recorded secret — commonly twelve words — that can
later unlock a stored copy of the portable key. The application owns its word
list, generation, and validation.

### Bounded context

[**Trust and Custody**](./DOMAIN.md#trust-and-custody)

### Implementation aliases

`recovery words`

## **KEK**

### Meaning

The key-encryption key derived from a recovery phrase by a password-hardening
function. The phrase itself is never a key.

### Bounded context

[**Trust and Custody**](./DOMAIN.md#trust-and-custody)

## **Wrapper**

### Meaning

The encrypted record stored remotely that contains the portable key, mesh ID,
and remote path, and is opened by the KEK. The remote holds only its locator and
ciphertext.

### Bounded context

[**Trust and Custody**](./DOMAIN.md#trust-and-custody)

## **DEK**

### Meaning

The data-encryption key that actually protects mesh content. In the recovery
model the portable mesh key is the DEK, and the wrapper only protects its stored
copy.

### Bounded context

[**Trust and Custody**](./DOMAIN.md#trust-and-custody)

## **Mesh address**

### Meaning

The route segment by which a deployment's storage selects one mesh's namespace.
Deployment routing, deliberately allowed to differ from the mesh ID.

### Bounded context

[**Mesh Access**](./DOMAIN.md#mesh-access)

### Product appearance

The `<address>` in a Worker route such as `/io/<address>`. An **operator** admits a
stable name, a checksummed issued value, or another form through integrity
gates.

## **Mesh alias**

### Meaning

A presented **mesh address** that is not the canonical one: an opaque,
subject-specific route resolving in one hop to the mesh actually stored. Routing,
never authentication — holding an alias does not prove who you are.

### Bounded context

[**Mesh Access**](./DOMAIN.md#mesh-access)

### Product appearance

"Protected mesh control" and "virtual per-user mesh alias". Revoking one subject
deletes their binding; the canonical mesh, its rows, file bodies, and **mesh
key** are untouched, and no one else's address changes. Code says _presented
route alias_ against _canonical storage namespace_.

## **Operator**

### Meaning

The [application developer](./README.md#actors) in their deployment-running
role: the party that stands up a mailbox host, decides which **mesh addresses**
it admits, and owns the **access decision** it enforces. Not a separate actor —
the same person, wearing the hat that owns the storage bill and the
authorization.

### Bounded context

[**Mesh Access**](./DOMAIN.md#mesh-access)

## **Integrity gate**

### Meaning

The operator-supplied rule deciding which mesh addresses a deployment will
admit at all, applied before any access decision.

### Bounded context

[**Mesh Access**](./DOMAIN.md#mesh-access)

## **Invalidation**

### Meaning

A notice from a mailbox host that something changed, so devices need not keep
asking. An optimisation, never a correctness requirement.

### Bounded context

[**Mesh Access**](./DOMAIN.md#mesh-access)

### Implementation aliases

`relay`

## **Replica**

### Meaning

An additional remote mailbox a device writes to on a best-effort basis, never
reads from, and never blocks on.

### Bounded context

[**Artifact Exchange**](./DOMAIN.md#artifact-exchange)
