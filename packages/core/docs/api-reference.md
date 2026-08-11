# Core API reference

`@interocitor/core` exposes the runtime-neutral engine, row and file APIs,
cache handles, local-store contract, key sources, events, and typed errors.
This reference also defines the consequential configuration and lifecycle
boundaries for application callers.

Use the [package README](../README.md) for orientation and a first call. Use
the focused pages for [pairing](pairing.md), [recovery](recovery.md),
[adapters](adapter-contract.md), [compaction](compaction.md), and the
[security model](security-model.md).

TypeScript snippets on this page are partial API fragments. Application schema,
adapter authentication, runtime objects, and error UI are intentionally
omitted.

## Construct an engine

```ts
import { Interocitor } from "@interocitor/core";

const db = new Interocitor(adapter, {
  localStore,
  keySource,
  remotePath: "/MyApp",
});
```

The supported constructors are:

```ts
new Interocitor(config);
new Interocitor(adapter, config);
```

The config-only form starts without a remote adapter. Attach one later with
`setRemoteStorage(adapter)`. `localStore` and `keySource` are required config
fields; use `keySource: null` for an unencrypted mesh.

## Engine lifecycle

| API                                               | Contract                                                                                                                                                                                                                          |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `configureMesh(state)`                            | Apply `remotePath`, passphrase/encryption input, or device ID before initialization. Throws after `init()` or while connected; construct a new engine instead.                                                                    |
| `init()`                                          | Open the local store, resolve initial state and credentials, resolve encryption, load local metadata, then call `onInit`. Rejects if those operations fail.                                                                       |
| `connect()`                                       | Auto-initializes, authenticates, loads or creates the manifest, applies the existing-mesh join policy, pulls, flushes, and starts polling/invalidation. Requires an adapter and `remotePath`. Concurrent calls share one attempt. |
| `disconnect()`                                    | Stop timers/invalidation, flush the pending batch, attempt a final outbox flush, close the local store, and return the engine to uninitialized/offline state. A failed final flush is logged and does not reject disconnect.      |
| `setRemoteStorage(adapter \| null)`               | Attach, replace, or detach the remote adapter. A live switch tears down the old transport and reconnects the replacement; attaching the same adapter object is a no-op.                                                           |
| `setLocalStore(store)`                            | Initialize if needed, flush when connected, close the old store, open/load the replacement, then pull and flush if the engine was connected.                                                                                      |
| `clearCredentials()`                              | Clear the key source, persisted credential record, and resolved encryption state. It does not clear rows, install a new key, or choose a mesh. Disconnect and construct a new configured engine before reconnecting.              |
| `isReady()`                                       | Whether local initialization completed.                                                                                                                                                                                           |
| `getConnectionStatus()`                           | `'offline'`, `'connecting'`, `'syncing'`, or `'idle'`.                                                                                                                                                                            |
| `getConnectionStatusDetails()`                    | Status plus `solo`, `ready`, `connected`, `remotePath`, `meshId`, and `deviceId`.                                                                                                                                                 |
| `getManifest()`                                   | Current in-memory manifest or `null`.                                                                                                                                                                                             |
| `getMeshId()` / `getDeviceId()` / `isEncrypted()` | Current identity and encryption state.                                                                                                                                                                                            |
| `on(listener)`                                    | Subscribe to `SyncEvent`; returns an unsubscribe function.                                                                                                                                                                        |

The full connect pipeline applies `connectStageTimeoutMs` to its named stages.
This is not a deadline around every adapter request: the reload head probe and
normal sync/file calls still depend on adapter-level timeouts.

## Rows and tables

`table(name)` is the recommended typed entry point:

| `Table<T>` API                    | Result                                                                                                                  |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `add(data, { prefix? }, userId?)` | Insert under a generated row ID and return that ID.                                                                     |
| `patch(rowId, partial, userId?)`  | Update only supplied columns and return the merged row.                                                                 |
| `put(rowId, partial, userId?)`    | Backward-compatible alias of `patch`.                                                                                   |
| `replace(rowId, value, userId?)`  | Write the full value and explicitly null existing fields omitted from it.                                               |
| `delete(rowId, userId?)`          | Write a tombstone.                                                                                                      |
| `row(rowId)`                      | Return a lazy, thenable `RowResult<T>`.                                                                                 |
| `query()`                         | Return a lazy, thenable `QueryResult<T>` that resolves to `T[]`.                                                        |
| `where(field)`                    | Build `equals`, `above`, `aboveOrEqual`, `below`, `belowOrEqual`, `between`, `startsWith`, or `anyOf` query conditions. |
| `subscribe(listener)`             | Subscribe to change/delete events for this table; returns an unsubscribe function.                                      |

The engine also exports lower-level `put`, `delete`, `query`, `queryWhere`, and
`tableNames` methods. `batch(fn)` groups nested writes into one
`ChangeEntry`; nested batches join the outer batch.

Conflict resolution is per column. Configured and schema-less databases both
default to HLC-based `lww`. Custom merge functions must be deterministic,
commutative, associative, and idempotent to preserve convergence. See
[Conflict resolution](../README.md#conflict-resolution).

## Query and row caches

`QueryResult` and `RowResult` are promise-like: `await` triggers `load()`.
They also expose synchronous cache probes for UI bindings.

| API                                  | Contract                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `load({ bypassCache? })`             | Load through the engine cache; bypassing forces a fresh local-store read.                                    |
| `peekCache()`                        | Return cached rows/row synchronously without starting a load. Pending or error states may retain stale data. |
| `peekStatus()`                       | Return `empty`, `pending`, `ready`, or `error` plus an optional error.                                       |
| `readForRender(policy?)`             | Return cached data synchronously when permitted, otherwise a promise.                                        |
| `subscribe(listener)`                | Subscribe to relevant table or row changes.                                                                  |
| `descriptor`, `cacheKey`, `metadata` | Stable cache identity owned by core.                                                                         |

`QueryResult` additionally supports `orderBy(field, direction)` as part of
cache identity and `sort(compareFn)` as a post-load derivation that does not
change the cache key. Engine-level `getQueryCacheKey`, `readQueryCache`,
`loadQueryRows`, `getRowCacheKey`, `readRowCache`, and `loadRow` support
framework integrations; most applications should use the result handles.

## Sync and maintenance

| API                                | Contract                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `flush()`                          | Move queued local changes to the primary adapter, then attempt configured write-only replicas.                |
| `pull()`                           | Read and merge remote changes from the primary adapter.                                                       |
| `rehydrate()`                      | Publish durable local work, replace local state with the manifest snapshot, then catch up.                    |
| `compact()`                        | Publish a snapshot/manifest generation, then best-effort remove exactly covered changes and every superseded mainline snapshot. |
| `getQuarantinedOfflineChanges()`   | Return local operations withheld after the device exceeded `retention.maxOfflineDurationMs`, or `null`.       |
| `clearQuarantinedOfflineChanges()` | Remove the local quarantine after the application has exported, discarded, or deliberately reapplied it.      |

Replica failures emit `replica:error` and do not fail a successful primary
flush. Pull and rehydrate never read replicas. See [Compaction](compaction.md)
for deletion guarantees and automatic scheduling.

## Durable files

File operations use the remote adapter directly. They are not cached in the
local row store, queued in its outbox, merged, or compacted.

| API                                        | Contract                                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `putFile(path, data, contentType?, seal?)` | Encrypt and upload; a later write to the same path replaces the object.                                 |
| `getFile(path)`                            | Download/decrypt an untainted file with the mesh key.                                                   |
| `openFile(path)`                           | Download metadata/ciphertext and return a `SealedFile`; the caller supplies an extra key when required. |
| `getFileMetadata(path)`                    | Read metadata without downloading plaintext; returns `null` when missing.                               |
| `deleteFile(path)`                         | Delete the object; a missing object is already deleted.                                                 |

Use a row for offline-readable file references and policy labels. See
[Tainted files](tainted-files.md).

## `SyncConfig`

### Identity, storage, and schema

| Option                      | Default             | Contract                                                                                      |
| --------------------------- | ------------------- | --------------------------------------------------------------------------------------------- |
| `localStore`                | Required            | Runtime-owned row, outbox, cursor, and metadata store. Core creates no default.               |
| `keySource`                 | Required            | `MeshKeySource`; `null` selects an unencrypted mesh. The mode must match the remote manifest. |
| `remotePath`                | None                | Mesh root inside the adapter. Required before remote operations.                              |
| `dbName`                    | `'interocitor'`     | Local diagnostic and credential-store namespace; it does not create a store.                  |
| `schema`                    | None                | Table fields, local indexes, merge policy, and an optional manifest compatibility marker. A version set at bootstrap must match on later clients; it does not migrate an existing mesh. |
| `deviceId`                  | Generated           | Test/host override for the device identity.                                                   |
| `deviceName` / `deviceType` | None                | Plaintext remote device metadata.                                                             |
| `joinExistingMeshPolicy`    | `'reset-to-remote'` | On a different existing mesh, either clear local state or intentionally merge it.             |

`reset-to-remote` clears rows, queued/pending writes, cursors, and stale mesh
metadata before pull. `merge-with-remote` retains and can publish local work.
The engine emits `join:existing-mesh` before applying the selected policy.

### Initialization and diagnostics

| Option                  | Default  | Contract                                                                                                                  |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| `resolveInitialState`   | None     | Runs during `init()` before persisted credentials; returned fields override constructor defaults and may be asynchronous. |
| `onInit`                | None     | Runs once per initialization after local open, credential/encryption resolution, and local-state load, before `connect()`. It sees the current local cache and is not a synchronized migration hook. |
| `logLevel`              | `'info'` | Per-engine logging threshold.                                                                                             |
| `connectStageTimeoutMs` | `15000`  | Deadline for each named full-pipeline connect stage, not every adapter call.                                              |
| `onConnectStalled`      | None     | Notification for a timed-out connect stage; exceptions from the hook are swallowed.                                       |

### Transport, batching, and replicas

| Option                           | Default                     | Contract                                                                                                                       |
| -------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `pollInterval`                   | `30000`                     | Base polling interval in milliseconds.                                                                                         |
| `relayEnabled`                   | `true`                      | Subscribe to adapter invalidations when supported.                                                                             |
| `relayHealthyPollInterval`       | `max(pollInterval, 300000)` | Safety-net polling interval while relay is healthy.                                                                            |
| `flushDebounce`                  | `2000`                      | Delay before an automatic outbox flush.                                                                                        |
| `flushThreshold`                 | `50`                        | Pending operation count that forces a flush.                                                                                   |
| `batchWindowMs`                  | `1000`                      | Implicit period whose local writes share one change entry.                                                                     |
| `replicas`                       | `[]`                        | Write-only backup adapters with optional per-replica `remotePath`.                                                             |
| `serverManaged`                  | `false`                     | Restrict manifest publication/compaction to `serverId` when the mesh is bootstrapped in managed mode.                          |
| `serverId`                       | `'server_relay_1'`          | Authorized managed writer identity.                                                                                            |
| `retention.compactAfterMs`       | `604800000` (7 days)        | Maximum desired age of an uploaded change before the connected managed writer compacts it. Must be positive and finite.        |
| `retention.maxOfflineDurationMs` | `2592000000` (30 days)      | Maximum absence before a reconnecting device quarantines queued writes and restores remote state. Must be positive and finite. |

Automatic compaction options and their two independent thresholds are defined
in the [Compaction reference](compaction.md#auto-compaction-defaults).

The retention policy is written into a new mesh manifest. On an existing mesh,
an explicitly configured policy is published by the authorized writer's next
`compact()`; otherwise the manifest policy remains authoritative. Legacy
manifests resolve to the same finite defaults.

## Local store contract

`LocalStore` is public from `@interocitor/core` and
`@interocitor/core/storage/local-store`.

| Method family        | Required behavior                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `open()` / `close()` | Acquire and release the store. `init()` awaits open; disconnect closes.                                                          |
| Row methods          | Read/write individual rows, tables, all rows, table names, and `WhereClause` queries; support `clearRows()`.                     |
| Local commit methods | Atomically commit a row with its pending batch, then atomically promote the completed pending batch to the outbox.               |
| Outbox methods       | Append one/many `ChangeEntry` values, peek without deletion, acknowledge exact published IDs atomically, and report queue size.  |
| Locking              | `withLock(name, operation)` serializes correctness-critical store operations, including sync-state cuts and observation commits. |
| Cursor methods       | Read/write per-device numeric cursors and enumerate all cursors.                                                                 |
| Metadata methods     | Read/write engine-owned keys and support `clearAll()` across rows, outbox, cursors, and metadata.                                |

The local store holds plaintext. Its implementation decides durability and
query performance. `MemoryLocalStore` is volatile, performs linear scans, and
clears all state on `close()`. Browser applications normally use the
implementations in `@interocitor/web`.

`clearAll()` is consequential: rehydrate and the default existing-mesh join
policy use it. Implementations must clear every store family consistently.
Run the package unit tests, including `local-store-contract.test.mjs`, against
new implementations.

## Key sources

| Source                        | Use                                                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `PortablePassphraseKeySource` | Produce the mesh key from a high-entropy portable base58 value; optionally load/persist it through a `CredentialStore`. |
| `BoundSharedKeySource`        | Combine the portable component with runtime- or account-bound derivation supplied by the application.                   |
| Custom `MeshKeySource`        | Implement `load(context)`, `persist(context, credentials)`, and `clear()`.                                              |
| `null`                        | Select an unencrypted mesh.                                                                                             |

Configure the key source before `init()`. Use a new engine to change mesh or
encryption mode. See [Shared key scenarios](shared-key-scenarios.md) and
[Credential store](credential-store.md).

## Important events

| Event family                                                                                                               | Meaning                                                                       |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `connection:status`, `connect:state`, `connect:noop`, `connect:error`, `transport:teardown`                                | Remote-session state and transitions.                                         |
| `join:existing-mesh`                                                                                                       | Different existing mesh detected; includes policy and local row/queue counts. |
| `sync:start`, `sync:complete`, `sync:error`                                                                                | Pull lifecycle.                                                               |
| `flush:start`, `flush:complete`, `flush:error`                                                                             | Primary outbox publication.                                                   |
| `change`, `delete`                                                                                                         | Applied row events.                                                           |
| `rehydrate:start`, `rehydrate:complete`                                                                                    | Snapshot replacement.                                                         |
| `auth:required`, `auth:complete`                                                                                           | Connect-time adapter authentication.                                          |
| `relay:subscribe`, `relay:ready`, `relay:message`, `relay:error`, `relay:closed`, `relay:unavailable`                      | Optional invalidation transport.                                              |
| `credentials:restored`, `credentials:persisted`, `credentials:conflict`, `credentials:meshMismatch`, `encryption:resolved` | Credential and encryption lifecycle.                                          |
| `decode:error`, `remote:poisoned`                                                                                          | Remote bytes failed validation/decryption; stop normal sync and investigate.  |
| `replica:error`                                                                                                            | A replica write failed after the primary path continued.                      |
| `schema:mismatch`                                                                                                          | Local logical schema version differs from the manifest.                       |

Compaction events are listed in [Compaction](compaction.md#events). High-volume
`trace:manifest` and `trace:head` events are diagnostics for tests/devtools,
not a stable application contract.

`compact:snapshot-cleanup` reports the active path plus attempted, deleted, and
failed superseded-snapshot deletions. A healthy remote has one mainline
snapshot; storage failures may temporarily leave more until a managed
retention check or later compaction retries cleanup.

## Typed errors

| Error                         | When                                                                              | Recovery                                                                                                                          |
| ----------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `MeshCredentialMismatchError` | Persisted credential `meshId` differs from the live manifest.                     | Confirm the intended mesh, disconnect, clear credentials, and construct a new engine with the correct key source and join policy. |
| `MeshEncryptionMismatchError` | Configured encrypted/unencrypted mode differs from the manifest.                  | Construct a new engine with the expected mode and matching key material.                                                          |
| `ConnectStageTimeoutError`    | `withDeadline` expires; also supplied as the error for a timed-out connect stage. | Treat a handled connect-stage timeout as offline-ready and retry later; the underlying operation is not cancelled.                |

Other adapter, storage, crypto, and validation failures reject with ordinary
`Error` values; their message text is not a stable programmatic contract.
