# Core API reference

`@interocitor/core` exposes the runtime-neutral engine, row and file APIs,
cache handles, local-store contract, key sources, events, and typed errors.
This reference also defines the consequential configuration and lifecycle
boundaries for application callers.

Use the [package README](../README.md) for orientation and a first call. Use
the focused pages for [pairing](pairing.md), [recovery](recovery.md),
[identityless readers](reader.md), [adapters](adapter-contract.md),
[compaction](compaction.md), and the
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

### Construct an identityless reader

```ts
import { InterocitorReader } from "@interocitor/core";

const reader = new InterocitorReader(adapter, {
  keySource,
  remotePath: "/MyApp",
});
```

`InterocitorReaderConfig` requires `remotePath` and `keySource`. Its
`localStore` defaults to a volatile `MemoryLocalStore`; supply one explicitly
for a persistent read cache. It also accepts `dbName`, `schema`, polling and
relay intervals, logging, connect-stage timeout options, and the expected
`serverId` for a server-managed mesh. Writer identity, batching, replicas,
compaction, initialization mutations, and join-policy options are absent.

For a one-shot operation, `readOnce(callback)` creates an isolated in-memory
cache, completes a remote pull, invokes the callback, and disconnects. It
returns the callback value plus diagnostics with
`consistency: 'completed-remote-pull'` and `cache.coldReplay: true`. Persistent
cache failures cannot block this path, but the cold replay can increase remote
reads, bytes, and latency.

The long-running reader lifecycle is `init`, `connect`, `pull`, `disconnect`,
and optional `setRemoteStorage`. Reader `connect()` rejects with
`ReaderRemotePullIncompleteError` when a connect stage times out rather than
exposing an offline cache as a completed remote read. It reads only existing
meshes and exposes query, subscription, status, observation, and durable-file
read methods. Its `ReadonlyTable` exposes `row`, `query`, `where`, and
`subscribe`. See the [reader guide](reader.md) for caching, React use, and the
security boundary.

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
| `observeChanges(listener)`                        | Observe live local and remote change entries plus their net effect on this endpoint; returns an unsubscribe function.                                                                                                             |

The full connect pipeline applies `connectStageTimeoutMs` to its named stages.
This is not a deadline around every adapter request: the reload head probe and
normal sync/file calls still depend on adapter-level timeouts.

When a named stage times out, `connect()` resolves without throwing, emits
`connect:error`, calls `onConnectStalled`, and leaves the initialized engine
offline-ready. Treat the callback as telemetry and user messaging only; retry
the remote session explicitly rather than making correctness depend on it.

Connection status separates local readiness from remote activity:

| Status       | Meaning                                                      |
| ------------ | ------------------------------------------------------------ |
| `offline`    | Local work is available, but no remote session is connected. |
| `connecting` | `connect()` is establishing or resuming the remote session.  |
| `syncing`    | A connected engine is pulling or flushing.                   |
| `idle`       | The engine is connected and has no active sync work.         |

`getConnectionStatusDetails().solo` is a separate configuration flag: it is
true when no remote mesh path is configured. It is not a communication status
and should not be presented as a sync failure.

## Rows and tables

`table(name)` is the recommended typed entry point:

| `Table<T>` API                    | Result                                                                                                                  |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `add(data, { prefix? }, userId?)` | Insert under a generated row ID and return that ID.                                                                     |
| `patch(rowId, partial, userId?)`  | Update only supplied columns and return the merged row.                                                                 |
| `put(rowId, partial, userId?)`    | Alias of `patch` with the same partial-update behavior.                                                                 |
| `replace(rowId, value, userId?)`  | Write the full value and explicitly null existing fields omitted from it.                                               |
| `delete(rowId, userId?)`          | Write a tombstone.                                                                                                      |
| `row(rowId)`                      | Return a lazy, thenable `RowResult<T>`.                                                                                 |
| `query()`                         | Return a lazy, thenable `QueryResult<T>` that resolves to `T[]`.                                                        |
| `where(field)`                    | Build `equals`, `above`, `aboveOrEqual`, `below`, `belowOrEqual`, `between`, `startsWith`, or `anyOf` query conditions. |
| `subscribe(listener)`             | Subscribe to change/delete events for this table; returns an unsubscribe function.                                      |

The engine also exports lower-level `put`, `delete`, `query`, `queryWhere`, and
`tableNames` methods. `batch(fn)` groups nested writes into one
`ChangeEntry`; nested batches join the outer batch. That entry is not a
cross-device transaction: unrelated batches published by different peers
remain independent.

### Conflict resolution

Conflict resolution is per column. Configured and schema-less databases both
default to HLC-based `lww`. Custom merge functions must be deterministic,
commutative, associative, and idempotent to preserve convergence. See
[Sync completeness, convergence, and integrity](sync-completeness.md).

### Deletion semantics

`delete()` writes a tombstone rather than immediately unlinking a row. Public
reads hide tombstoned rows, while snapshots retain tombstones so an older
queued write cannot resurrect deleted data. Reusing the same row ID starts a
new row incarnation; fields from the deleted incarnation do not carry over.

### Observe changes

Use `observeChanges` when application code needs the attempted CRDT operations
and their effective field changes at the merge boundary:

```ts
const observations: ChangeObservation[] = [];
const unsubscribe = db.observeChanges((observation) => {
  observations.push(observation);
});
```

One observation represents one remotely decoded `ChangeEntry` or one promoted
local batch. Its `effects` contain one net transition per affected row. Each
field includes its before and/or after `ColumnEntry`; changing only the CRDT
timestamp is still an effect because it can influence a later merge. A remote
entry whose operations all lose is observable with an empty `effects` array.
`fileName` is present only for remote observations.

The feed is live and endpoint-relative. A subscription starts with the next
local batch; it does not join a batch that is already open or recover a pending
batch from an earlier session. Core does not persist or replay historical
observations, emit history while installing a snapshot, authenticate the
claimed `change.device` or `change.user`, prove that the remote disclosed every
change, or establish global chronology. TypeScript Core does not populate
`change.user` for local mutations. A remote file can be delivered again
if pull applied it but failed before persisting its receipt, so consumers that
persist observations should tolerate gaps and duplicates. `observedAt` is this
endpoint's callback time; the entry HLC remains conflict order rather than a
trusted wall clock. Errors thrown by a listener do not interrupt row writes or
synchronization, and each listener receives a detached copy it cannot use to
mutate engine state. Callbacks are not awaited; asynchronous work and rejected
promises remain the listener's responsibility.

Persisting observations copies plaintext current and historical values outside
the row store. The application owns storage security, redaction, retention,
failure handling, and any stronger audit or authorship guarantees.

### Schema typing

The `types` helpers describe inferred row fields and local indexes in a
`DatabaseSchemaDefinition`:

```ts
import { types, type DatabaseSchemaDefinition } from "@interocitor/core";

const schema = {
  tables: {
    todos: {
      fields: {
        text: types.string,
        done: types.boolean,
        createdAt: types.index(types.date),
        note: types.string.optional,
      },
    },
  },
} satisfies DatabaseSchemaDefinition;
```

`.optional` makes a field optional in the inferred row type.
`types.index(...)` adds a local index used by `where` and `orderBy`; indexed
and unique fields cannot be optional. `types.typed<T>("json")` describes a
caller-owned structured value without making its runtime shape part of the
manifest. `types.file` declares a `FileRef` column, the row-side pointer to a
[durable file](#durable-files); it cannot be indexed.

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

| API                                | Contract                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `flush()`                          | Move queued local changes to the primary adapter, then attempt configured write-only replicas.                                  |
| `pull()`                           | Read and merge remote changes from the primary adapter.                                                                         |
| `rehydrate()`                      | Publish durable local work, replace local state with the manifest snapshot, then catch up.                                      |
| `compact()`                        | Publish a snapshot/manifest generation, then best-effort remove exactly covered changes and every superseded mainline snapshot. |
| `getQuarantinedOfflineChanges()`   | Return local operations withheld after the device exceeded `retention.maxOfflineDurationMs`, or `null`.                         |
| `clearQuarantinedOfflineChanges()` | Remove the local quarantine after the application has exported, discarded, or deliberately reapplied it.                        |

Replica failures emit `replica:error` and do not fail a successful primary
flush. Pull and rehydrate never read replicas. See [Compaction](compaction.md)
for deletion guarantees and automatic scheduling.

## Durable files

File operations use the remote adapter directly. They are not cached in the
local row store, queued in its outbox, merged, or compacted.

| API                                        | Contract                                                                                                                         |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `putFile(path, data, contentType?, seal?)` | Encrypt and upload; a later write to the same path replaces the object. The returned metadata carries the plaintext `digest`.    |
| `toFileRef(path, metadata)`                | Build the `FileRef` for a `types.file` column from a `putFile` result: `{ path, digest, size, contentType?, taint? }`.           |
| `getFile(path \| ref)`                     | Download/decrypt an untainted file with the mesh key. Given a `FileRef`, verify the bytes against `ref.digest`.                  |
| `openFile(path \| ref)`                    | Download metadata/ciphertext and return a `SealedFile`; the caller supplies an extra key when required. `open()` verifies a ref. |
| `getFileMetadata(path \| ref)`             | Read metadata without downloading plaintext; returns `null` when missing.                                                        |
| `deleteFile(path \| ref, seal?)`           | Delete the object; a missing object is already deleted. A sealed file needs `{ key }` so the store accepts the delete.           |

A `FileRef` is immutable where a path is not: overwriting the path changes the
digest, so a stale reference is refused with `FileIntegrityError` instead of
served. That is what makes a digest-keyed cache correct at every layer, from a
memory map to IndexedDB or the Cache API, with no invalidation and no service
worker. Core does not ship the cache; it ships the reference that makes one
safe. Keep policy labels such as taints on the row as well. See
[Tainted files](tainted-files.md).

## `SyncConfig`

### Identity, storage, and schema

| Option                      | Default             | Contract                                                                                                                                                                                |
| --------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `localStore`                | Required            | Runtime-owned row, outbox, cursor, and metadata store. Core creates no default.                                                                                                         |
| `keySource`                 | Required            | `MeshKeySource`; `null` selects an unencrypted mesh. The mode must match the remote manifest.                                                                                           |
| `remotePath`                | None                | Mesh root inside the adapter. Required before remote operations.                                                                                                                        |
| `dbName`                    | `'interocitor'`     | Local diagnostic and credential-store namespace; it does not create a store.                                                                                                            |
| `schema`                    | None                | Table fields, local indexes, merge policy, and an optional manifest compatibility marker. A version set at bootstrap must match on later clients; it does not migrate an existing mesh. |
| `deviceId`                  | Generated           | Test/host override for the device identity.                                                                                                                                             |
| `deviceName` / `deviceType` | None                | Plaintext remote device metadata.                                                                                                                                                       |
| `joinExistingMeshPolicy`    | `'reset-to-remote'` | On a different existing mesh, either clear local state or intentionally merge it.                                                                                                       |

### Joining an existing mesh with local state

`reset-to-remote` clears rows, queued/pending writes, cursors, and stale mesh
metadata before pull. `merge-with-remote` retains and can publish local work.
The engine emits `join:existing-mesh` before applying the selected policy.

This policy does not authorize changing the key of an existing local store.
Pairing into another mesh must use a fresh isolated local store and credential
namespace, or an application-owned full erase completed before `init()`.

### Initialization and diagnostics

| Option                  | Default  | Contract                                                                                                                                                                                             |
| ----------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolveInitialState`   | None     | Runs during `init()` before persisted credentials; returned fields override constructor defaults and may be asynchronous.                                                                            |
| `onInit`                | None     | Runs once per initialization after local open, credential/encryption resolution, and local-state load, before `connect()`. It sees the current local cache and is not a synchronized migration hook. |
| `logLevel`              | `'info'` | Per-engine logging threshold.                                                                                                                                                                        |
| `connectStageTimeoutMs` | `15000`  | Deadline for each named full-pipeline connect stage, not every adapter call.                                                                                                                         |
| `onConnectStalled`      | None     | Notification for a timed-out connect stage; exceptions from the hook are swallowed.                                                                                                                  |

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
`compact()`; otherwise the manifest policy remains authoritative. Manifests
without retention fields resolve to the same finite defaults.

`pollInterval` is the active session's base rather than a fixed cadence. A pull
that merges no entries doubles the next interval up to 60 seconds; a pull that
merges at least one entry resets it to the configured base. While an adapter's
invalidation relay is healthy, `relayHealthyPollInterval` supplies the
safety-net polling base instead.

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

| Source                        | Use                                                                                                                                                                                                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PortablePassphraseKeySource` | Produce the mesh key from a high-entropy portable base58 value; optionally load/persist it through a `CredentialStore`.                                                                                                                                                |
| `BoundSharedKeySource`        | Combine the portable component with runtime- or account-bound derivation supplied by the application.                                                                                                                                                                  |
| Custom `MeshKeySource`        | Declare `credentialPersistence` as `"none"` or `"durable"`, and implement `load(context)`, `persist(context, credentials)`, and `clear()`. Durable sources must also implement `loadPersistedCredentials()` so the engine can inspect mesh anchors before replacement. |
| `null`                        | Select an unencrypted mesh.                                                                                                                                                                                                                                            |

Configure the key source before `init()`. Use a new engine to change mesh or
encryption mode. See [Shared key scenarios](shared-key-scenarios.md) and
[Credential store](credential-store.md).

## Connected stores

`db.connectedStores` persists application-defined credentials for related
meshes in the parent engine's local metadata. It does not create, connect, or
run child engines. The relationship is one-way: an application reads a record
and constructs a separate `Interocitor` instance itself.

This is the primitive for a product with many independent units of work, such
as projects, boards, or cases. Give each its own mesh, keep its credentials
here, and open only the meshes a session needs; the parent's own rows can carry
a summary per child as the index. Which meshes to open, when to close them,
moving a record between two, and search across them stay with the application.

`put(credentials)` upserts by `id`, preserves an existing `createdAt`, and sets
`updatedAt` to the current time. `list()` and `get(id)` read records, and
`remove(id)` deletes one. Anyone who can read the parent's local store inherits
access to credentials saved there, so use a separate trust boundary when that
inheritance is not intended.

## Important events

| Event family                                                                                                               | Meaning                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `connection:status`, `connect:state`, `connect:noop`, `connect:error`, `transport:teardown`                                | Remote-session state and transitions.                                                   |
| `join:existing-mesh`                                                                                                       | Different existing mesh detected; includes policy and local row/queue counts.           |
| `sync:start`, `sync:complete`, `sync:error`                                                                                | Pull lifecycle.                                                                         |
| `flush:start`, `flush:complete`, `flush:error`                                                                             | Primary outbox publication.                                                             |
| `change`, `delete`                                                                                                         | Applied row events.                                                                     |
| `rehydrate:start`, `rehydrate:complete`                                                                                    | Snapshot replacement.                                                                   |
| `auth:required`, `auth:complete`                                                                                           | Connect-time adapter authentication.                                                    |
| `remote:access`, `remote:access:restored`                                                                                  | The remote answered 401/403/404/429/503; see [Remote access decisions](#remote-access). |
| `relay:subscribe`, `relay:ready`, `relay:message`, `relay:error`, `relay:closed`, `relay:unavailable`                      | Optional invalidation transport.                                                        |
| `credentials:restored`, `credentials:persisted`, `credentials:conflict`, `credentials:meshMismatch`, `encryption:resolved` | Credential and encryption lifecycle.                                                    |
| `decode:error`, `remote:poisoned`                                                                                          | Remote bytes failed validation/decryption; stop normal sync and investigate.            |
| `replica:error`                                                                                                            | A replica write failed after the primary path continued.                                |
| `schema:mismatch`                                                                                                          | Local logical schema version differs from the manifest.                                 |

Compaction events are listed in [Compaction](compaction.md#events). High-volume
`trace:manifest` and `trace:head` events are diagnostics for tests/devtools,
not a stable application contract.

`compact:snapshot-cleanup` reports the active path plus attempted, deleted, and
failed superseded-snapshot deletions. A healthy remote has one mainline
snapshot; storage failures may temporarily leave more until a managed
retention check or later compaction retries cleanup.

## Remote access decisions {#remote-access}

Interocitor manages encrypted data. Deciding who may reach a mesh belongs to
the host and its identity provider. The engine's job is to understand that
decision when it arrives as an HTTP status and give the application a clear
moment to react. The built-in Cloudflare, WebDAV, S3, and Google Drive adapters
turn these statuses into a `RemoteAccessError` instead of a generic failure:

| Status | `kind`               | Effect on the engine                                                    |
| ------ | -------------------- | ----------------------------------------------------------------------- |
| 401    | `unauthenticated`    | Pauses the remote session. The provider wants a sign-in.                |
| 403    | `forbidden`          | Pauses the remote session. Identified, but this mesh/write is denied.   |
| 404    | `not-found`          | Pauses the remote session. Only on mesh-level routes (health, listing). |
| 429    | `rate-limited`       | Reported only. Polling backs off, honouring `Retry-After`.              |
| 503    | `policy-unavailable` | Reported only. The decision is unknown, not negative.                   |

A missing file (404 on `readFile`, `getFileMetadata`, or a WebDAV/Drive path)
is never an access decision; those keep their existing null/plain-error
behaviour.

When a request is denied (`error.denied` is true) the engine stops polling,
relay subscriptions, scheduled flushes, and compaction; sets `connected` to
false and the status to `offline`; and emits `remote:access` with
`paused: true`. It never retries the denied request on its own. Local reads and
writes continue and queue in the outbox. Temporary conditions emit the same
event with `paused: false` and leave the session connected.

```ts
db.on((event) => {
  if (event.type !== "remote:access" || !event.paused) return;
  switch (event.kind) {
    case "unauthenticated":
      return startSignIn(); // afterwards: adapter.setToken(token); await db.connect();
    case "forbidden":
      return showReadOnlyBanner(event.error);
    case "not-found":
      return leaveMesh(); // the alias was revoked or never existed for this subject
  }
});
```

The current decision is available synchronously through
`db.getRemoteAccessError()` and `db.getConnectionStatusDetails().remoteAccess`,
and in React through `useRemoteAccess(db)`. A successful `connect()` clears it
and emits `remote:access:restored`; `disconnect()` and `setRemoteStorage()`
clear it silently. `CloudflareAdapter.setToken()`, `WebDAVAdapter.setAuth()`,
`S3Adapter.setCredentials()`, and `GoogleDriveAdapter.setAccessToken()` accept the refreshed credential and mark
the adapter unauthenticated so the next `connect()` re-verifies.

## Typed errors

| Error                                | When                                                                              | Recovery                                                                                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `MeshCredentialMismatchError`        | Persisted credential `meshId` differs from the live manifest.                     | Confirm the intended mesh, disconnect, clear credentials, and construct a new engine with the correct key source and join policy. |
| `CredentialReplacementRequiredError` | A configured key differs from the durable credential under the same `dbName`.     | Use an isolated local and credential namespace, or complete a full application-owned reset before constructing a replacement.     |
| `CredentialPersistenceError`         | Required durable credential inspection or persistence failed.                     | Preserve the current local state and retry or repair credential custody; do not continue with an unverified key.                  |
| `MeshKeySourceContractError`         | A source declared durable persistence without an inspection hook.                 | Implement `loadPersistedCredentials()` or explicitly declare the source nonpersistent.                                            |
| `MeshEncryptionMismatchError`        | Configured encrypted/unencrypted mode differs from the manifest.                  | Construct a new engine with the expected mode and matching key material.                                                          |
| `ConnectStageTimeoutError`           | `withDeadline` expires; also supplied as the error for a timed-out connect stage. | Treat a handled connect-stage timeout as offline-ready and retry later; the underlying operation is not cancelled.                |
| `ReaderRemotePullIncompleteError`    | A Reader connect stage timed out before its remote receive pipeline completed.    | Do not consume the cache as a completed read; retry the single-shot operation or restore remote availability.                     |
| `RemoteAccessError`                  | The remote rejected a request with 401, 403, a mesh-level 404, 429, or 503.       | Inspect `kind`; sign in, show read-only state, or leave the mesh, then give the adapter the new credential and call `connect()`.  |
| `FileIntegrityError`                 | Bytes opened for a `FileRef` do not hash to `ref.digest`.                         | Treat the bytes as untrusted; re-read the row for a newer reference, or re-upload and store a fresh `toFileRef` result.           |

Other adapter, storage, crypto, and validation failures reject with ordinary
`Error` values; their message text is not a stable programmatic contract.
