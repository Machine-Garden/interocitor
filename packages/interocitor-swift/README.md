<p align="center">
  <a href="https://github.com/TheUiTeam/interocitor">
    <img src="https://raw.githubusercontent.com/TheUiTeam/interocitor/main/docs/assets/hero.svg" alt="interocitor" width="560"/>
  </a>
</p>

<p align="center">
  <em>☢️ work in progress — 0.0.0-beta.2 ☢️</em>
</p>

---

# interocitor-swift

Swift-native Interocitor runtime for macOS and iOS. Same local-first CRDT model as the TypeScript package — no custom sync server, no third-party dependencies, encryption as a first principle.

Reads and writes always hit local SQLite. The cloud folder is a mailbox, not a runtime dependency.

## Platforms

- macOS 13+
- iOS 16+

## Installation

### Swift Package Manager

```swift
// Package.swift
.package(url: "https://github.com/TheUiTeam/interocitor", branch: "main"),
```

```swift
.target(
    name: "YourTarget",
    dependencies: [
        .product(name: "InterocitorSwift", package: "interocitor")
    ]
)
```

## Quick start

```swift
import InterocitorSwift

// 1. Configure
let config = SyncConfig(
    remotePath: "/MyApp",
    dbName: "myapp"
)

// 2. Create engine — local-only by default
let engine = SyncEngine(config: config)

// 3. Set encryption key (first principle — do this before connect)
let key = generateMeshKey()
await engine.setEncryptionKey(key)

// Share the key to other devices as a passphrase:
let passphrase = keyToPassphrase(key)   // ~43-char base58, e.g. "3vQB7b3..."
// On another device:
// let key = try passphraseToKey(passphrase)

// 4. Open local store — no network required
try await engine.initialize()

// 5. Write locally — works offline
try await engine.put(
    table: "tasks",
    rowId: "task_1",
    columns: ["title": .string("Review PR #42"), "status": .string("open")]
)

// 6. Attach a remote adapter and start syncing
let adapter = WebDAVStorageAdapter(config: WebDAVConfig(
    baseURL: "https://cloud.example.com/remote.php/dav/files/alice/Interocitor",
    auth: .basic(username: "alice", password: "APP_PASSWORD")
))
let syncEngine = SyncEngine(adapter: adapter, config: config)
await syncEngine.setEncryptionKey(key)
try await syncEngine.initialize()
try await syncEngine.connect()  // authenticate, pull, start polling
```

## Adapters

### WebDAV

Works with Nextcloud, ownCloud, the bundled `interocitor-webdav` Node server, and any standard WebDAV endpoint.

```swift
let adapter = WebDAVStorageAdapter(config: WebDAVConfig(
    baseURL: "https://cloud.example.com/remote.php/dav/files/alice/Interocitor",
    auth: .basic(username: "alice", password: "APP_PASSWORD")
))

// Or with a bearer token:
let adapter = WebDAVStorageAdapter(config: WebDAVConfig(
    baseURL: "https://dav.example.com",
    auth: .bearer(token: "mytoken")
))
```

### Cloudflare Workers (`interocitor-workers`)

Purpose-fit JSON protocol over Worker + D1 with SSE-driven invalidation. Mirrors `interocitor/adapters/cloudflare`.

```swift
let adapter = CloudflareStorageAdapter(config: CloudflareAdapterConfig(
    baseURL: "https://your-worker.example.com/io/my-namespace",
    token: "sha256(prefix + INTEROCITOR_ACCESS_TOKEN)"   // optional
))

// Real-time invalidation via SSE — call pull() when the server signals new data
let cancel = adapter.subscribeToInvalidations(
    onInvalidate: { payload in
        Task { try? await engine.pull() }
    },
    onReady: { print("SSE connected") },
    onError: { print("SSE disconnected") }
)
// Later: cancel() to stop
```

The SSE endpoint is derived automatically from the base URL (`/io/` → `/events/`). Token is passed as a bearer header on the SSE connection.

### Memory (tests)

```swift
let adapter = MemoryStorageAdapter()
let store   = MemoryLocalStore()
let engine  = SyncEngine(adapter: adapter, config: config, localStore: store)
```

### Custom adapter

Conform to `StorageAdapter`:

```swift
public protocol StorageAdapter: Sendable {
    var name: String { get }
    func authenticate() async throws
    func isAuthenticated() -> Bool
    func ensureFolder(path: String) async throws
    func listFiles(path: String) async throws -> [FileEntry]
    func listFolders(path: String) async throws -> [String]
    func readFile(path: String) async throws -> Data
    func writeFile(path: String, data: Data) async throws
    func deleteFile(path: String) async throws
    func getFileMetadata(path: String) async throws -> FileEntry?
}
```

## Local store

### SQLite (persistent)

```swift
let store = IndexedSQLiteStore(configuration: IndexedSQLiteStoreConfiguration(
    databasePath: FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].path,
    databaseName: "myapp.db"
))
let engine = SyncEngine(adapter: adapter, config: config, localStore: store)
```

Uses the system `sqlite3` library — zero external dependencies. WAL journal mode enabled by default. Tables: `rows`, `outbox`, `cursors`, `meta`.

### Memory (default / tests)

If no `localStore` is passed to `SyncEngine`, a `MemoryLocalStore` is used automatically.

## Core API

```swift
// Lifecycle
try await engine.initialize()             // open local store; no network
try await engine.connect()                // auth, pull, start polling
try await engine.disconnect()             // stop polling, close store
await engine.setRemoteStorage(adapter)    // attach / switch adapter at runtime
await engine.setRemoteStorage(nil)        // go local-only

// Writes (always local-first, queued for sync)
try await engine.put(table:rowId:columns:)
try await engine.delete(table:rowId:)

// Reads (always local, never network)
try await engine.get(table:rowId:)        // → Row?
try await engine.query(table:)            // → [Row]
try await engine.queryWhere(table:clause:)// → [Row]
engine.tableNames()                       // → [String]

// Sync
try await engine.flush()                  // push outbox to cloud now
try await engine.pull()                   // merge remote changes now
try await engine.compact()                // write snapshot, prune old changes

// Encryption
await engine.setEncryptionKey(key)
await engine.clearEncryptionKey()
await engine.isEncrypted()                // → Bool

// Device / mesh info
engine.getDeviceId()                      // → String
engine.getMeshId()                        // → String?

// Events
let unsubscribe = await engine.on { event in
    switch event {
    case .change(let table, let rowId, let row): ...
    case .delete(let table, let rowId):          ...
    case .syncComplete(let count):               ...
    case .flushComplete:                         ...
    case .rehydrateComplete(let rowCount):       ...
    case .syncError(let error):                  ...
    default: break
    }
}
// unsubscribe() to stop
```

## Where clauses

```swift
// Equality
let clause = WhereClause(field: "status", op: .equals, value: .string("open"))

// Comparison
WhereClause(field: "priority", op: .aboveOrEqual, value: .int(3))
WhereClause(field: "priority", op: .below, value: .int(5))

// Range
WhereClause(field: "score", op: .between, lower: .int(10), upper: .int(50))

// Prefix
WhereClause(field: "name", op: .startsWith, value: .string("Alg"))

// Set membership
WhereClause(field: "tag", op: .anyOf, values: [.string("swift"), .string("ios")])

let results = try await engine.queryWhere(table: "tasks", clause: clause)
```

## Encryption

Encryption is a first principle — every byte written to the cloud passes through AES-256-GCM before leaving the device.

```swift
import InterocitorSwift

// Generate a new key (do this once on the first device)
let key = generateMeshKey()

// Export as a human-readable passphrase (~43 chars, base58)
let passphrase = keyToPassphrase(key)

// Share as a URL fragment (never hits the server)
let shareURL = keyToShareURL(key, baseURL: "https://yourapp.com/join")

// Import on another device
let restoredKey = try passphraseToKey(passphrase)

// Persist in Keychain
try storeKeyInKeychain(key)
let loaded = try loadKeyFromKeychain()

// Verify a key against a known ciphertext (sanity-check on join)
let ok = verifyKey(key, sampleEncrypted: sampleFromCloud)
```

The wire format is an [EncryptedEnvelope](Sources/InterocitorSwift/Crypto.swift) JSON object:

```json
{ "v": 1, "iv": "<base64-12-byte-nonce>", "ct": "<base64-ciphertext+tag>" }
```

Each entry gets a freshly generated nonce. CryptoKit does the AES-GCM heavy lifting — no custom crypto primitives.

**Key loss = data loss.** Cloud folder contains only ciphertext. Print the passphrase.

### Client-side fingerprint verification

For encrypted remotes, every encrypted change and snapshot payload carries the mesh fingerprint (`meshId`) inside the encrypted envelope together with its payload kind (`change` or `snapshot`).

After decryption, the client verifies that fingerprint against the manifest/local mesh it already trusts.

- matching fingerprint → accept and merge
- wrong fingerprint → treat the remote as poisoned
- poisoned remote → cut off sync and emit `remotePoisoned`

This protects against cross-mesh ciphertext injection and storage mix-ups. It does **not** protect against someone who already has the real mesh key.

## CRDT strategy

Last-Writer-Wins per column, ordered by Hybrid Logical Clock (HLC). Each column carries its own HLC — merges are always field-level, never row-level.

```
Device A: task.title  = "Review PR"  at T1
Device B: task.status = "done"       at T2

→ { title: "Review PR" (T1), status: "done" (T2) }
```

Different fields: both preserved. Same field: latest HLC wins. Deletes are tombstones (soft delete with HLC). An upsert with a newer HLC revives a tombstoned row.

## How sync works

```
Device A                    Cloud (changes/)              Device B
   │                              │                            │
   ├─ put() → SQLite ─────────────┤                            │
   ├─ flush() ──────► {hlc}-{id}.json                         │
   │                 head.json ◄──┤                            │
   │                              ├──── poll head.json ────────┤
   │                              │     skip if cursor=head    │
   │                              ├──── download new files ────┤
   │                              │     CRDT merge → SQLite    │
```

Writes land in local SQLite immediately. The cloud folder (`changes/`) is a mailbox: one JSON file per flush entry. `head.json` carries the latest HLC — readers skip listing the folder entirely when nothing is new. Each reader advances its own cursor.

No coordination. No locks. Each device writes only its own files.

## Offline guarantee

| Operation | Network? |
|---|---|
| `initialize()` | No |
| `put()` / `delete()` | No |
| `get()` / `query()` / `queryWhere()` | No |
| `connect()` | Yes |
| `flush()` | Yes |
| `pull()` | Yes |
| `compact()` | Yes |

After `connect()`, losing network is fine — reads/writes continue locally, outbox accumulates, and the next `flush()` pushes everything when connectivity returns.

## Cloud folder layout

```
{remotePath}/
  manifest.json                        ← pointer: { currentGeneration, file }
  manifest-{generation}.json           ← immutable; epoch, watermarkHlc, snapshotPath
  devices/
    {deviceId}.json                    ← heartbeat: registeredAt, lastSeenAt
  mainline/
    snapshot-{epoch}-{writer}.json     ← full SQLite snapshot at watermarkHlc
  changes/
    head.json                          ← { latestHlc } — fast poll-skip hint
    {hlc}-{changeId}.json              ← one file per flush entry
```

Change files ≤ `watermarkHlc` are pruned automatically by `compact()`. Wire format is identical to the TypeScript package — a Swift device and a browser device sharing the same cloud folder will interoperate transparently, including encrypted meshes.

## Tests

```bash
cd packages/interocitor-swift
swift test
```

53 tests, 0 failures. Covers:

- HLC (init, tick, receive, serialization, ordering, skew clamping)
- CRDT (upsert, LWW, stale-write rejection, delete, revive-after-delete)
- MemoryLocalStore (rows, outbox, cursors, meta, clearAll)
- SyncEngine / memory adapter (basic sync, delete sync, offline-write, queryWhere, compaction + rehydration)
- Crypto (key generation, raw export/import, base58 encode/decode, passphrase, share URL, encrypt/decrypt, wrong-key rejection, envelope structure, Keychain-free fast path)
- Encrypted SyncEngine (round-trip, wrong-key isolation, encrypted compaction + rehydration)
- WebDAV adapter (config, auth headers, errors)
- Cloudflare adapter (config, token, errors)

## Source layout

```
Sources/InterocitorSwift/
  HLC.swift                  ← Hybrid Logical Clock
  Types.swift                ← AnyCodable, Row, ChangeEntry, Op, Manifest, WhereClause, SyncEvent …
  CRDT.swift                 ← applyOp, applyChangeEntry, rowToPlain
  Crypto.swift               ← AES-256-GCM, base58, passphrase, share URL, Keychain
  StorageAdapter.swift       ← StorageAdapter protocol, LocalStoreAdapter protocol,
                               MemoryStorageAdapter, InterocitorError
  MemoryLocalStore.swift     ← In-memory LocalStoreAdapter
  IndexedSQLiteStore.swift   ← SQLite-backed LocalStoreAdapter (system sqlite3, no deps)
  WebDAVStorageAdapter.swift ← WebDAV StorageAdapter (PROPFIND/PUT/DELETE/MKCOL)
  CloudflareStorageAdapter.swift ← Cloudflare Workers StorageAdapter + SSE invalidation
  SyncEngine.swift           ← Orchestrator: put/delete/get/query/flush/pull/rehydrate/compact
```

## Package context

- Monorepo: <https://github.com/TheUiTeam/interocitor>
- This package: <https://github.com/TheUiTeam/interocitor/tree/main/packages/interocitor-swift>
- TypeScript runtime: <https://github.com/TheUiTeam/interocitor/tree/main/packages/interocitor>
- WebDAV server: <https://github.com/TheUiTeam/interocitor/tree/main/packages/interocitor-webdav>
- Cloudflare Worker: <https://github.com/TheUiTeam/interocitor/tree/main/packages/interocitor-workers>

## License

MIT
