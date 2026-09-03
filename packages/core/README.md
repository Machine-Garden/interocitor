<p align="center">
  <a href="https://github.com/Machine-Garden/interocitor">
    <img src="https://raw.githubusercontent.com/Machine-Garden/interocitor/main/docs/assets/hero.svg" alt="Interocitor" width="560" />
  </a>
</p>

<p align="center">
  <em>Runtime-neutral local-first CRDT rows and durable remote files.</em>
</p>

# @interocitor/core

`@interocitor/core` is the runtime-neutral Interocitor engine. It owns the row
CRDT, sync protocol, local-store and remote-adapter contracts, client-side
encryption, pairing, recovery, and path-addressed durable file APIs.

Most browser applications should start with
[`@interocitor/web`](../web/README.md). It supplies IndexedDB local stores,
browser credential custody, image helpers, and reset/recovery helpers around
the core engine. React applications add
[`@interocitor/react`](../react/README.md) for context and reactive hooks.

Choose core directly when a runtime can supply its own `LocalStore`, key
custody, and mailbox adapter, or when implementing a non-browser integration.

## Install

```bash
yarn add @interocitor/core
```

Adapters are exported as separate package entry points, so applications import
only the backend they use.

## Start with protected local-first rows

This illustrative shape uses volatile memory stores for a test or short-lived
process. Production runtimes should select a durable local store and persistent
key custody before connecting.

```ts
import { Interocitor, MemoryLocalStore, PortablePassphraseKeySource } from "@interocitor/core";
import { MemoryAdapter } from "@interocitor/core/adapters/memory";

const keySource = new PortablePassphraseKeySource();
const db = new Interocitor(new MemoryAdapter(), {
  dbName: "my-app",
  remotePath: "/MyApp",
  localStore: new MemoryLocalStore(),
  keySource,
});

await db.init();

const todoId = await db
  .table("todos")
  .add({ text: "Ship privacy-first sync", done: false }, { prefix: "todo" });

await db.connect();
await db.table("todos").patch(todoId, { done: true });
```

`init()` opens the local store, so row reads and writes do not wait for a
remote session. `connect()` creates or resumes the mailbox, pulls remote
changes, flushes local work, and starts the configured sync cadence.

Keep the portable key returned by `keySource.getPortableKey()` in an
application-owned credential store or establish a recovery path. Losing the
only copy makes a protected mesh unreadable.

## Keep rows and files distinct

| Surface       | Use it for                                                  | Availability and lifecycle                                                                                    |
| ------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| CRDT rows     | Structured, queryable state that must remain useful offline | Reads and writes use `LocalStore`; encrypted changes and snapshots synchronize when transport is available.   |
| Durable files | Exact byte payloads such as documents, images, and exports  | File calls use the remote adapter directly; there is no core file cache, offline queue, merge, or compaction. |

Store file metadata and paths in rows when the reference must be available
offline. Store the bytes with `putFile`, then retry transfer failures in
application code.

```ts
await db.putFile("tasks/task-1/report.pdf", bytes, "application/pdf");
const copy = await db.getFile("tasks/task-1/report.pdf");
await db.deleteFile("tasks/task-1/report.pdf");
```

Deleting a row does not delete its referenced files. Writing the same file
path replaces the remote object according to adapter semantics.

## Compose the runtime

Every engine needs an explicit local store and key source. A remote adapter and
`remotePath` are required only for sync and durable files.

### Local row storage

- `MemoryLocalStore` is volatile and intended for tests and short-lived
  processes. It clears on close.
- Browser applications normally use the durable and resilient IndexedDB stores
  from `@interocitor/web`.
- Node and other runtimes implement the public `LocalStore` contract, including
  atomic row/outbox commits, exact acknowledgements, locks, cursors, and
  metadata.

The local store contains plaintext. Protect it with the host platform's
storage and device security controls.

### Mesh key custody

- `PortablePassphraseKeySource` generates or restores portable mesh key
  material.
- `BoundSharedKeySource` combines the portable component with
  application-bound derivation.
- A custom `MeshKeySource` can connect host-specific custody.
- `keySource: null` explicitly creates or joins an unencrypted mesh.

A non-null key source encrypts row payloads, snapshots, and durable file bodies
before the adapter receives them. It does not hide object paths, sizes, timing,
request identity, device metadata, or the manifest.

### Mailbox adapter

| Entry point                               | Choose it when                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| `@interocitor/core/adapters/memory`       | Tests need an in-process, non-persistent mailbox.                       |
| `@interocitor/core/adapters/webdav`       | A NAS, Nextcloud, ownCloud, or another WebDAV service owns the mailbox. |
| `@interocitor/core/adapters/google-drive` | A user-owned Google Drive should carry the artifacts.                   |
| `@interocitor/core/adapters/cloudflare`   | A deployed Interocitor Worker supplies D1/R2 storage and invalidations. |
| Custom implementation of `StorageAdapter` | Existing storage should implement the mailbox contract.                 |

The remote is storage, not a merge authority or query server. One
`remotePath` identifies one mesh; sharing the same folder between unrelated
meshes corrupts that boundary.

## Lifecycle and failure boundary

Use the lifecycle in this order:

```text
new Interocitor(adapter?, config)
        │
        ├─ configureMesh(...)      optional, before initialization
        ▼
      init()                       local readiness
        │
        ├─ setRemoteStorage(...)   if no adapter was supplied
        ▼
    connect()                      remote session and sync
        │
        ▼
  disconnect()                    flush attempt, teardown, store close
```

`connect()` auto-initializes, but an explicit `init()` makes the local-ready
boundary visible. If a deadline-wrapped connect stage stalls, core leaves an
opened local store usable and queued row writes available for a later retry.
Adapter calls outside that staged pipeline still need adapter-level timeouts.

When an existing remote mesh has a different identity from local state,
`joinExistingMeshPolicy` controls the consequence:

- `reset-to-remote` is the default and clears local rows, pending/queued work,
  cursors, and stale mesh metadata before pulling.
- `merge-with-remote` retains local work and may publish it into the joined
  mesh.

Select that policy before connecting and back up meaningful local work before
allowing a reset.

## Public entry points

| API or entry point                                                                                                                                           | Use it for                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `Interocitor`                                                                                                                                                | Runtime-neutral engine lifecycle, rows, sync, and durable files.                  |
| `db.table(name)`                                                                                                                                             | Typed row CRUD, queries, row handles, and subscriptions.                          |
| `db.putFile`, `db.getFile`, `db.openFile`, `db.deleteFile`, `db.getFileMetadata`                                                                             | Direct durable file storage, including application-keyed sealed files.            |
| `db.flush`, `db.pull`, `db.rehydrate`, `db.compact`                                                                                                          | Explicit sync and maintenance operations.                                         |
| `db.observeChanges`                                                                                                                                          | Optional live observation of attempted changes and this endpoint's merge effects. |
| `db.connectedStores`                                                                                                                                         | Application-owned credentials for related meshes.                                 |
| `PortablePassphraseKeySource`, `BoundSharedKeySource`                                                                                                        | Portable or application-bound key recovery.                                       |
| `createRecoveryWrapper`, `publishRecoveryWrapper`, `recoverMeshCredentials`                                                                                  | Client-provided recovery phrases for portable-key meshes.                         |
| `generateShareQR`, `generateJoinQR`, `handleScannedQR`                                                                                                       | Recommended QR pairing flows.                                                     |
| `createGeneratorSession`, `runScannerHandshake`                                                                                                              | Lower-level pairing handshake control.                                            |
| `@interocitor/core/adapters/memory`, `@interocitor/core/adapters/webdav`, `@interocitor/core/adapters/google-drive`, `@interocitor/core/adapters/cloudflare` | Mailbox transports.                                                               |
| `@interocitor/core/crypto/signing`                                                                                                                           | ECDSA authorship and capability-token helpers.                                    |

For exact signatures, configuration defaults, lifecycle effects, events, and
typed errors, use the [Core API reference](docs/api-reference.md).

## Guarantees and limits

- Row writes are committed to the configured local store before remote
  publication. Durability across crashes depends on that store's contract.
- Peers that observe the same immutable changes converge under last-write-wins
  or a deterministic, commutative, associative, and idempotent custom merge.
- Row conflict resolution is per column. Deletion writes a tombstone so an
  older queued change cannot resurrect the deleted incarnation.
- Remote delivery is eventual, not real-time. Optional invalidations accelerate
  pulls; polling remains the correctness path.
- The remote can withhold, replay, or roll back artifacts. Encryption detects
  modified ciphertext but cannot force availability or freshness.
- Every endpoint with the mesh key can read the whole row database. Isolate
  smaller trust domains into separate meshes and keys.
- Rows are not an exactly-once job queue. Side effects need an
  application-owned claim, lease, or idempotency rule.
- Compaction has no cross-device CAS. Use one authorized managed writer or
  otherwise serialize compaction.

## Build common capabilities

- [Pair a device](docs/pairing.md)
- [Create and use recovery phrases](docs/recovery.md)
- [Choose portable or bound shared keys](docs/shared-key-scenarios.md)
- [Seal files for an additional application-held key](docs/tainted-files.md)
- [Sign records and capability tokens](docs/signing.md)
- [Migrate application data](docs/data-migrations.md)
- [Test an Interocitor product](docs/testing.md)

## Protocol, security, and operations

- [Core API reference](docs/api-reference.md)
- [Security and threat model](docs/security-model.md)
- [Remote adapter contract and mailbox layout](docs/adapter-contract.md)
- [Sync completeness, convergence, and integrity](docs/sync-completeness.md)
- [Compaction protocol and tuning](docs/compaction.md)
- [Credential-store contract](docs/credential-store.md)
- [Recovery API reference](docs/recovery-reference.md)

## Validate the package

From the repository root after installing dependencies and Chromium:

```bash
yarn workspace @interocitor/core test:unit
yarn workspace @interocitor/core test:e2e
```

The unit suite includes the local-store contract. The browser suite exercises
the public package entry point, memory and WebDAV adapters, sync, encryption,
pairing, recovery, compaction, and failure handling.

Use the repository-level [`yarn preflight`](../../README.md#validate-a-release)
before publishing any package.

## License

MIT
