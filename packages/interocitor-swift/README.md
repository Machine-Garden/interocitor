<p align="center">
  <a href="https://github.com/TheUiTeam/interocitor">
    <img src="https://raw.githubusercontent.com/TheUiTeam/interocitor/main/docs/assets/hero.svg" alt="interocitor" width="560"/>
  </a>
</p>

# interocitor-swift

Swift-native Interocitor runtime for macOS and iOS.

Same idea, same trade-off: a mailbox that can't read your mail.

## Why this package exists

`interocitor-swift` brings the Interocitor model to Apple platforms.

The goal is not to compete with CloudKit, Firebase, or collaborative CRDT platforms on features. The goal is to preserve the same architectural property as the JavaScript package: all meaningful data work stays on the client.

That means:

- local state lives in SQLite
- merge happens on the device
- decryption happens on the device
- the remote transport only moves opaque bytes

If your app needs true end-to-end encrypted sync across your own Apple devices, this package is the native runtime for that model.

## Platforms

- iOS
- macOS

## Installation

### Swift Package Manager

```swift
dependencies: [
  .package(url: "https://github.com/TheUiTeam/interocitor.git", branch: "main")
]
```

Then depend on the `InterocitorSwift` product.

## Quick start

```swift
import InterocitorSwift

let engine = try SyncEngine(
  dbName: "todos.sqlite",
  schema: [
    "todos": TableSchema(indexes: ["done", "createdAt"])
  ],
  localStore: IndexedSQLiteStore(path: "todos.sqlite"),
  adapter: nil,
  passphrase: "correct horse battery staple"
)

try engine.initEngine()
try engine.put("todos", row: [
  "id": "todo-1",
  "text": "Ship encrypted sync",
  "done": false,
  "createdAt": Date().timeIntervalSince1970
])

let rows = try engine.query("todos")
```

## Adapters

### WebDAV

Use `WebDAVStorageAdapter` when you want self-hosted sync or an inspectable remote mailbox.

### Cloudflare Workers (`interocitor-workers`)

Use `CloudflareStorageAdapter` when you want an Interocitor-native endpoint with push-style invalidation while preserving client-side merge and decryption.

### Custom adapter

Implement the `StorageAdapter` protocol to target any byte-oriented transport that can list, read, write, and delete remote objects.

## Local store

### SQLite (persistent)

This package maps the Interocitor local-first model onto SQLite for Apple platforms.

### Memory (tests)

Use `MemoryLocalStore` for tests and in-process validation.

## Core API

```swift
try engine.initEngine()
try engine.put("todos", row: row)
try engine.delete("todos", id: "todo-1")
let one = try engine.get("todos", id: "todo-1")
let many = try engine.query("todos")
try engine.sync()
```

## Where clauses

```swift
let doneRows = try engine.query(
  "todos",
  where: .eq("done", true)
)
```

## Encryption

Interocitor only works for its intended purpose if the transport never needs plaintext.

```swift
let engine = try SyncEngine(
  dbName: "secure.sqlite",
  schema: schema,
  localStore: IndexedSQLiteStore(path: "secure.sqlite"),
  adapter: adapter,
  passphrase: "correct horse battery staple"
)
```

### Client-side fingerprint verification

As with the JavaScript package, you can expose a key fingerprint in your UI so users can verify device pairing intentionally.

## CRDT strategy

This runtime keeps the same core architecture as the JS package: client-side CRDT merge with hybrid logical clocks, remote mailbox only for exchange.

## How sync works

```text
App
  -> SyncEngine
  -> local SQLite
  -> encrypt locally
  -> remote byte transport
  -> download ciphertext
  -> decrypt locally
  -> merge locally
```

## Offline guarantee

| Operation | Network? |
| --- | --- |
| init | No |
| put / delete | No |
| get / query | No |
| sync | Yes, if adapter configured |

## Cloud folder layout

```text
<remotePath>/
  snapshot.meta
  changes/
  blobs/
```

## Tests

Current coverage includes:

- SQLite local store behavior
- HLC behavior and ordering
- CRDT merge logic
- WebDAV integration flows

Run the Swift package tests from the package directory with standard Swift tooling.

## Source layout

```text
Sources/InterocitorSwift/
  SyncEngine.swift
  IndexedSQLiteStore.swift
  MemoryLocalStore.swift
  Crypto.swift
  CRDT.swift
  HLC.swift
  ...
```

## Package context

- Monorepo root: <https://github.com/TheUiTeam/interocitor>
- Package home: <https://github.com/TheUiTeam/interocitor/tree/main/packages/interocitor-swift>
- JS runtime sibling: <https://github.com/TheUiTeam/interocitor/tree/main/packages/interocitor>
- Workers runtime sibling: <https://github.com/TheUiTeam/interocitor/tree/main/packages/interocitor-workers>

## License

MIT
