<p align="center">
  <a href="https://github.com/TheUiTeam/interocitor">
    <img src="https://raw.githubusercontent.com/TheUiTeam/interocitor/main/docs/assets/hero.svg" alt="Interocitor" width="560"/>
  </a>
</p>

# InterocitorSwift

Swift runtime for local-first row storage and optional encrypted
mailbox sync on Apple platforms.

The package keeps reads, writes, CRDT merge, and decryption on the device. A
configured WebDAV or Cloudflare adapter moves remote objects; it does not query
or merge application rows.

For row sync, InterocitorSwift exchanges the current Core manifest, encrypted
change, snapshot, device-metadata, and compaction artifacts with
[`@interocitor/core`](../core/README.md). That is row-protocol compatibility,
not full feature parity: InterocitorSwift does not expose Core's durable-file
API, pairing/enrollment workflow, or recovery feature set.

Before any payload is read, the runtime verifies the manifest version and
content hash, configured schema version, encryption mode, and managed-server
writer. It rejects an invalid manifest instead of rewriting it during
`connect()`.

> **Public release:** clone the public repository and add
> `packages/interocitor-swift` as a local Swift package.

## Requirements

- Swift tools 5.10 or later
- macOS 13 or later, or iOS 16 or later
- SQLite3, supplied by the Apple platform SDK

## Add the package from a checkout

1. Clone this repository.
2. In Xcode, choose **File → Add Package Dependencies → Add Local**.
3. Select the cloned `packages/interocitor-swift` directory.
4. Add the `InterocitorSwift` product to your app target.

For another local Swift package, use a relative path:

```swift
dependencies: [
    .package(path: "../interocitor/packages/interocitor-swift")
]
```

The repository URL cannot select a nested `Package.swift`, so a remote
`.package(url: ...)` dependency on the monorepo root is not a working install
path.

## Store rows locally

The following is a runnable fragment inside an asynchronous function. It uses
the persistent SQLite store and performs no network I/O.

```swift
import Foundation
import InterocitorSwift

let databaseDirectory = FileManager.default.urls(
    for: .applicationSupportDirectory,
    in: .userDomainMask
)[0].path

let localStore = IndexedSQLiteStore(
    configuration: IndexedSQLiteStoreConfiguration(
        databasePath: databaseDirectory,
        databaseName: "todos.sqlite"
    )
)

let db = Interocitor(
    config: SyncConfig(remotePath: "/todos", dbName: "todos"),
    localStore: localStore
)

try await db.initialize()

try await db.put(
    table: "todos",
    rowId: "todo-1",
    columns: [
        "text": .string("Ship encrypted sync"),
        "done": .bool(false),
        "createdAt": .double(Date().timeIntervalSince1970)
    ]
)

let rows = try await db.query(table: "todos")
```

`initialize()`, `put`, `delete`, `get`, `query`, and `queryWhere` are local
operations. `MemoryLocalStore` is the non-persistent alternative for tests and
short-lived processes.

## Connect encrypted remote storage

Remote encryption is opt-in. Set the same `MeshKey` on every peer **before**
calling `connect()`:

```swift
let adapter = WebDAVStorageAdapter(
    config: WebDAVConfig(
        baseURL: "https://dav.example.test/remote.php/dav/files/alice",
        auth: .basic(username: "alice", password: webDAVAppPassword)
    )
)

let db = Interocitor(
    adapter: adapter,
    config: SyncConfig(remotePath: "/Apps/Todos", dbName: "secure-todos"),
    localStore: localStore
)

let meshKey = try loadKeyFromKeychain() ?? generateMeshKey()
try storeKeyInKeychain(meshKey)

await db.setEncryptionKey(meshKey)
try await db.initialize()
try await db.connect()
```

This is a partial integration fragment: the application owns credential
collection, first-device key creation, peer pairing, lifecycle handling, and
error presentation.

Without `setEncryptionKey(_:)`, remote changes and snapshots are written
without Interocitor application-layer encryption. SQLite also stores local
rows as plaintext. With a key configured, change payloads and snapshots are
AES-GCM ciphertext before the adapter receives them. Routing paths, object
names, sizes, timing, device metadata, manifest metadata, and change-head
metadata remain visible to the remote service.

A database or object-store dump therefore reveals:

- plaintext application rows if encryption was not enabled;
- ciphertext for protected change and snapshot payloads if it was enabled;
- operational metadata in either mode.

Key custody stays with the app. A copied mesh key plus the remote objects is
sufficient to decrypt protected payloads, so use Keychain or an equivalent
application-owned secret store and never send the key to the storage service.
If the key cannot decrypt protected payloads, or its encryption mode conflicts
with the manifest, `connect()` fails instead of presenting an empty database.

## Query and mutate rows

These calls are runnable after `initialize()`:

```swift
let one = try await db.get(table: "todos", rowId: "todo-1")
let all = try await db.query(table: "todos")

let done = try await db.queryWhere(
    table: "todos",
    clause: WhereClause(
        field: "done",
        op: .equals,
        value: .bool(true)
    )
)

try await db.delete(table: "todos", rowId: "todo-1")
```

Column values use `AnyCodable`: `.string`, `.int`, `.double`, `.bool`, or
`.null`, plus recursive `.array` and `.object` values.

## Core-compatible schemas and merge policies

Use `SyncConfig(schema:)` when the mesh declares a logical schema version or a
merge policy. The version must equal the remote manifest version. Built-in
policy resolution matches Core: a field override wins over its table policy,
then the database policy; every schema defaults to `lww`.

This is an illustrative configuration to apply consistently in every runtime;
only the built-in policies are portable, and Swift does not implement Core
custom merge functions.

```swift
let schema = DatabaseSchema(
    version: 1,
    tables: [
        "tasks": TableSchema(
            merge: TableMergeConfig(
                strategy: .lww,
                fields: ["status": .lww]
            )
        )
    ]
)

let db = Interocitor(
    adapter: adapter,
    config: SyncConfig(remotePath: "/Apps/Todos", schema: schema),
    localStore: localStore
)
```

Local `put` operations always apply their supplied values. Merge policy resolves
conflicts while applying remote changes. A delete clears the row payload; a
later `put` creates a new row incarnation and publishes only its new fields.

## Sync lifecycle

| Call | Network behavior |
| --- | --- |
| `initialize()` | Opens and loads the local store; no network |
| `put`, `delete`, `get`, `query`, `queryWhere` | Local-only |
| `connect()` | Authenticates the adapter, creates or loads the remote manifest, catches up, flushes, and starts polling |
| `flush()` | Writes queued local changes to the primary adapter and configured replicas |
| `pull()` | Lists retained changes and merges filenames not recorded in the local exact-file receipt set |
| `rehydrate()` | Rebuilds local state from the current snapshot, then pulls newer changes |
| `compact()` | Pulls, publishes a new snapshot and manifest generation, and prunes changes through the watermark |
| `disconnect()` | Stops polling, flushes when the remote is healthy, and closes the local store |
| `setRemoteStorage(_:)` | Switches adapters or enters local-only mode |

`compact()` is an explicit maintenance operation. The runtime does not provide
a distributed compaction lease, idle-time policy, or automatic “20 changes”
threshold. If multiple peers may compact, the application must coordinate
that operation. Compaction retains tombstones until active devices have
acknowledged a watermark. A stale outbox entry at or before the published GC
floor is not uploaded; the client rehydrates from the canonical snapshot
instead.

## Adapters

| Type | Purpose | Important behavior |
| --- | --- | --- |
| `WebDAVStorageAdapter` | Basic- or bearer-authenticated WebDAV storage | `baseURL` is the WebDAV service root; the engine appends `remotePath` |
| `CloudflareStorageAdapter` | An `@interocitor/workers` IO route | `baseURL` includes `/io/<address>`; an optional bearer token is forwarded to host mesh middleware |
| `StorageAdapter` | Custom byte-oriented transport | Implement async authentication (`isAuthenticated() async -> Bool`), folder, list, read, write, delete, and metadata operations |

`CloudflareStorageAdapter.subscribeToInvalidations` exposes WebSocket
notifications, but `Interocitor` does not subscribe automatically. An app that
uses it must trigger `pull()` from the callback. Polling remains the correctness
path.

## Main public surface

| API | Role |
| --- | --- |
| `Interocitor` | Main actor for local rows and sync lifecycle |
| `SyncConfig`, `ReplicaConfig`, `DatabaseSchema`, `TableSchema`, `TableMergeConfig`, `MergeStrategy` | Remote lifecycle settings, logical schema version, and built-in merge policy |
| `IndexedSQLiteStore`, `IndexedSQLiteStoreConfiguration` | Persistent SQLite local store |
| `MemoryLocalStore` | In-memory local store |
| `WebDAVStorageAdapter`, `WebDAVConfig`, `WebDAVAuth` | WebDAV transport |
| `CloudflareStorageAdapter`, `CloudflareAdapterConfig` | Cloudflare Workers transport |
| `AnyCodable`, `WhereClause`, `WhereOperator`, `Row`, `SyncEvent` | Row values, local queries, row representation, and events |
| `generateMeshKey`, `storeKeyInKeychain`, `loadKeyFromKeychain`, `clearKeyFromKeychain` | Mesh-key creation and local custody helpers |
| `keyToPassphrase`, `passphraseToKey`, `keyToShareURL`, `keyFromFragment` | Portable key export/import helpers; treat their output as a secret |

The module also exports low-level protocol, CRDT, HLC, manifest, envelope, and
adapter-support types. They are implementation-facing APIs rather than the
supported application surface listed above.

`SyncConfig` defaults are `serverManaged: false`,
`serverId: "server_relay_1"`, `pollInterval: 30`, `flushDebounce: 2`,
`flushThreshold: 50`, `dbName: "interocitor"`, a seven-day
`offlineGraceMs`, and no replicas. `deviceName` and `deviceType` are written
to peer-visible device metadata. The `_owner` field assigned to a local write
is snapshot metadata, not a last-writer identity across peers.

## Remote object layout

```text
<remotePath>/
  manifest.json
  manifest-<generation>.json
  devices/
    <deviceId>.json
  mainline/
    snapshot-<epoch>-<writer>.json
  changes/
    head.json
    <hlc>-<changeId>.json
```

Manifest, device, and head files contain operational metadata. The application
payloads inside change and snapshot files are encrypted only when a mesh key
has been configured.

## Validate the package

From `packages/interocitor-swift`:

```bash
swift test
```

This runs the local, SQLite, CRDT, crypto, and adapter unit tests. Live WebDAV
tests are skipped unless `INTEROCITOR_WEBDAV_URL` is set.

The companion script starts the repository's loopback-only WebDAV test server:

```bash
bash Scripts/run-integration-tests.sh
```

To validate real Core ↔ Swift row compatibility, run:

```bash
bash Scripts/run-core-swift-interop.sh
```

It builds the repository's Core package and verifies both directions over
encrypted loopback WebDAV: Core bootstrap and snapshot rehydration in Swift,
then Swift bootstrap (including nested JSON) and Swift compaction read by fresh
Core processes.

## Source layout

```text
Sources/InterocitorSwift/
  SyncEngine.swift
  IndexedSQLiteStore.swift
  MemoryLocalStore.swift
  StorageAdapter.swift
  WebDAVStorageAdapter.swift
  CloudflareStorageAdapter.swift
  Crypto.swift
  CRDT.swift
  HLC.swift
  Types.swift
```

## Related documentation

- [Repository overview](../../README.md)
- [Core runtime](../core/README.md)
- [Cloudflare Workers runtime](../workers/README.md)
- [Loopback WebDAV test server](../webdav/README.md)

## License

MIT
