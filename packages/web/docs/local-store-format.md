# Local store format and browser exposure

This is the browser-specific companion to the core
[security model](../../core/docs/security-model.md). That document describes
what the **remote** can observe. This one describes what a **copy of the local
browser profile** reveals, and specifies the store-format seam that lets the
local representation change later without breaking installs that already exist
in the field.

Everything in the exposure section below was read off the code in
`packages/web/src/storage/` and `packages/core/src/` rather than inferred from
design intent. Where the code contradicted the expected story, that is called
out explicitly.

---

## Part 1 — What a copy of the local profile reveals today

The web local store is an IndexedDB database (default name `interocitor`, see
`DEFAULT_DB_NAME` in `indexed-db-local-store.ts`) with five object stores:
`rows`, `pendingOps`, `outbox`, `cursors`, `meta`.

### Rows are plaintext structured clones

`putRow` / `putRows` call `store.put(this.withKey(row))`. `withKey` only adds a
derived `_meta.key`; it does not transform, wrap, or encode the payload. The
`Row` object — including every `payload.<field>.value` and its per-field HLC —
is handed to IndexedDB as-is and stored by the structured clone algorithm.

**A profile copy yields every row value in the clear.** Mesh encryption is for
the cloud; it has never applied to the device.

### The outbox and pendingOps hold change history that has no remote analogue

- `outbox` holds `ChangeEntry` objects that have been committed locally but not
  yet uploaded (`pushOutbox`, `pushOutboxEntries`, `drainOutbox`).
- `pendingOps` plus the `meta["pendingBatch"]` header hold the _open_ implicit
  batch (`commitLocalMutation`, `peekPendingBatch`, `promotePendingBatch`).

A `ChangeEntry` is `{ id, ts, device, user?, hlc, ops }`, and each `UpsertOp`
carries `table`, `rowId`, and `columns: Record<string, ColumnEntry>` where
`ColumnEntry` is `{ value, hlc }` (`packages/core/src/core/types.ts`).

This is the sharpest local-only exposure in the system. The remote receives
change entries **encrypted** — `encodeChangePayload` in
`packages/core/src/core/codec.ts` serializes `{meshId, kind, entry}` and hands
the whole JSON string to `encryptEntry` (AES-256-GCM, random 96-bit IV, envelope
`{v:1, iv, ct}`) — so ops, tables, row ids and values are all inside the
ciphertext. Locally they are plain objects. The local profile therefore holds a
_per-field-timestamped edit history_, including intermediate states and the
authoring device, that the remote never sees in readable form.

It also holds it for writes the remote will never see at all until they are
pushed, which is why the durability guard in Part 3 exists.

### Table names and row ids are keys, not values

- `rowKey(table, rowId)` returns `` `${table}/${rowId}` ``.
- The `rows` store is created with `{ keyPath: "_meta.key" }`.
- It carries `rows.createIndex("by_table", "_meta.table", { unique: false })`.

So table names and row ids are IndexedDB **key material**. They are ordered,
enumerable and range-queryable independently of whatever happens to a row's
value, and a `by_table` cursor enumerates a table without reading any row body.

The contrast with the remote is real and it holds: nothing in the remote naming
scheme derives from `op.table` or `op.rowId`. Change objects are named
`${entry.hlc}-${entry.id}.json` (`core/change-observation.ts`), snapshots
`mainline/snapshot-${epoch}-${serverId}.json` (`core/compaction.ts`), device
records `devices/<deviceId>.json`. **On an encrypted mesh the remote never
learns table names at all.**

One correction to that claim as originally stated: encryption is conditional.
`encodeForCloud` (`core/codec.ts`) returns the plaintext JSON unchanged when the
mesh has no key source (`this.encrypted = this.keySource !== null` in
`core/sync-engine.ts`). On an **unencrypted** mesh the remote does see table
names, row ids and values — in the change file _body_, still never in an object
name. The "remote never learns table names" statement is true of encrypted
meshes, which is the configuration the security model is written for.

### Every indexed or unique field stays plaintext, sorted, and range-queryable

This is the single most important constraint on any future encrypted local
format, and the code confirms it.

`schemaIndexKeyPath(field)` returns:

```ts
["_meta.table", `payload.${field}.value`];
```

An index with this key path is created for **every** field a schema marks
`index` or `unique`, plus every entry in `def.indexes`
(`collectExpectedIndexes`, `indexed-db-local-store.ts`).

IndexedDB stores index keys in the clear, in a separate sorted structure, so
that it can answer range queries without deserializing records. Encrypting the
row _value_ does nothing to those keys. Concretely: if an app marks `email`
unique, a copy of the profile yields the sorted set of all email addresses, and
supports "everything between `a` and `b`" queries over them, no matter what the
row bodies look like.

**A future encrypted format cannot keep native IndexedDB indexes over plaintext
field values.** It has to choose: drop schema indexes and scan (correct,
slower), or index over a deterministic transform of the value — and any
deterministic transform is, at minimum, an equality oracle and usually an
order-revealing one. There is no configuration of the current index machinery
that both preserves query capability and hides the indexed values.

### Tombstones persist after a delete

The delete branch of the CRDT merge in `packages/core/src/core/crdt.ts` sets
`_meta.deleted = true`, records `_meta.deletedHlc`, and assigns
`payload = {}`. The payload is cleared; **the row is not removed**. The key
`${table}/${rowId}` and the deletion timestamp survive.

A deleted row therefore still discloses that the row existed, under which table,
with which id, and when it was deleted. Deletion is a CRDT operation, not an
erasure.

### An in-place rewrite can never retroactively protect an existing install

IndexedDB is not a file the app controls. It sits on LevelDB in Chromium and
SQLite in WebKit. Both are append-oriented: a `put` writes a new record and
supersedes the old one, it does not overwrite the old bytes. Compaction and
vacuum are background processes with no application-visible guarantee, no API to
force, and no completion signal.

`resetLocalDatabase` (`reset.ts`) issues `indexedDB.deleteDatabase`, which
unlinks the _logical_ database. It guarantees that the app can no longer read
it. It guarantees nothing about the underlying blocks. (It additionally cannot
be cancelled once queued, which is why a name that saw a blocked or timed-out
delete must never be reused.)

The conclusion is structural, not a matter of implementation care:

> If a database has ever held plaintext rows, rewriting those rows in place
> cannot make the plaintext unrecoverable from that database's files.

Therefore a format change that exists to _stop storing plaintext_ is only
meaningful in a **new physical database**, freshly created, that never held the
plaintext. The old generation's remaining bytes are a separate problem to be
handled by an explicit user-facing reset — not something a migration can quietly
claim to have solved.

This is why the seam in Part 2 defaults `requiresFreshGeneration` to `true`.

---

## Part 2 — The store format seam

Two independent identities are now distinguished:

| Identity                | Where it lives                                    | What it means              |
| ----------------------- | ------------------------------------------------- | -------------------------- |
| **Physical generation** | the IndexedDB database _name_                     | which set of bytes on disk |
| **Store format**        | `meta["interocitor:store:format"]` inside that DB | what those bytes _mean_    |

Rotation (`rotateLocalDatabaseName` in `named-local-store.ts`, plus
`local-database-name.ts` for the generated-name predicate) changes the first.
The seam described here changes the second, and because of the conclusion above,
a format change normally forces a change of the first as well.

### API

From `@interocitor/web/storage/named-local-store`:

```ts
export const STORE_FORMAT_META_KEY = "interocitor:store:format";
export const LEGACY_PLAINTEXT_ROWS_FORMAT = "plaintext-rows-v1";

export interface StoreFormatDescriptor {
  readonly id: string;
  readonly migrateFrom?: Readonly<Record<string, StoreFormatMigration>>;
  /** Default true: migrate into a brand-new physical database. */
  readonly requiresFreshGeneration?: boolean;
}

export type StoreFormatMigration = (ctx: StoreFormatMigrationContext) => Promise<void>;

export interface StoreFormatMigrationContext {
  readonly from: string;
  readonly to: string;
  readonly source: LocalStore & LocalStoreMigrationExtensions;
  readonly target: LocalStore & LocalStoreMigrationExtensions;
  readonly inPlace: boolean;
  readonly sourceDatabaseName: string;
  readonly targetDatabaseName: string;
}

export function registerStoreFormat(d: StoreFormatDescriptor): void;
export function unregisterStoreFormat(id: string): void;
export function getStoreFormat(id: string): StoreFormatDescriptor | undefined;
export function listStoreFormats(): string[];

export function copyLocalStoreState(
  source: LocalStore & LocalStoreMigrationExtensions,
  target: LocalStore & LocalStoreMigrationExtensions,
): Promise<void>;
```

`createNamedLocalStore` accepts `storeFormat` (the desired format id, default
`plaintext-rows-v1`), `formats` (descriptors scoped to this store, in addition
to the global registry) and `onFormatMigrated`. The returned store exposes
`readonly storeFormat: string`.

### Decision procedure at open time

After the underlying database opens, the store reads
`meta["interocitor:store:format"]` and resolves exactly one of four outcomes.
None of them is an unhandled exception, and none of them destroys data.

1. **Unstamped and non-empty** → inferred as `plaintext-rows-v1`. Existing
   installs in the field predate the stamp; they must not be mistaken for a new
   database.
2. **Unstamped and empty** → adopts the desired format directly and stamps it.
3. **Recorded == desired** → identity. The stamp is written only if absent. No
   row, outbox entry or cursor is touched.
4. **Recorded != desired** → look up the desired format's
   `migrateFrom[recorded]`.

Failures are typed, all extending `StoreFormatError` (which carries a `.code`
string discriminant, following the existing `UnstableCredentialNamespaceError`
convention), so a host can branch on them and show a real message:

| Error                                | `.code`                            | Meaning                                                            |
| ------------------------------------ | ---------------------------------- | ------------------------------------------------------------------ |
| `UnknownStoreFormatError`            | `UNKNOWN_STORE_FORMAT`             | The DB records a format this build has never heard of (downgrade). |
| `UnsupportedStoreFormatUpgradeError` | `UNSUPPORTED_STORE_FORMAT_UPGRADE` | The desired format declares no path from the recorded one.         |
| `StoreFormatMigrationFailedError`    | `STORE_FORMAT_MIGRATION_FAILED`    | The migration threw. `cause` carries the original error.           |

In every failure case the source database, its pointer, and its contents are
left exactly as they were. Refusing to open is always preferable to opening onto
data the build cannot interpret.

### Fresh-generation migration, and its crash ordering

For `requiresFreshGeneration` (the default), the sequence is:

1. Mint a successor name **without** advancing the rotation pointer.
2. Open the successor as a raw `IndexedDbLocalStore`.
3. Run the migration (typically `copyLocalStoreState` plus format-specific work).
4. Stamp the successor's format.
5. Mark the successor as holding unpushed writes if the source did.
6. Close the successor, close the source.
7. **Only now** advance the pointer, and reopen through it.

A crash at any point before step 7 simply reopens the untouched source on the
next run. Half-built successors are abandoned rather than deleted — a delete
request cannot be cancelled and could land on a name a later attempt has
reused. The source generation is retained, never deleted; the only thing that
deletes a generation is an explicit, forced `resetLocalDatabase`.

`copyLocalStoreState` copies, in this order: rows (tombstones included),
cursors, all non-internal meta, the outbox, then the open pending batch. The
order is chosen so that a crash leaves the target strictly _behind_ the source
rather than ahead of it.

Two pieces of machinery exist only to make that copy honest, and both are
required of any store implementation participating in a migration
(`LocalStoreMigrationExtensions`):

- `getAllMeta()` — the `LocalStore` interface only offers `getMeta(key)`.
  Copying meta by allowlist would eventually drop `meshId` or the HLC and
  **silently fork the mesh**, so `copyLocalStoreState` throws rather than guess
  when enumeration is unavailable.
- `adoptPendingBatch(entry)` — carries the _open_ implicit batch across
  generations. Promoting it into the outbox instead would publish a batch the
  engine still considers open.

### What a future encrypted format must implement

1. A `StoreFormatDescriptor` with a new `id`, and
   `migrateFrom["plaintext-rows-v1"]`.
2. Leave `requiresFreshGeneration` at its default `true`. Per Part 1, an
   in-place rewrite cannot make the old plaintext unrecoverable, so an in-place
   encrypted format would be security theatre.
3. Re-encode rows, the outbox **and** the open pending batch. The outbox and
   pendingOps are the highest-value plaintext in the database; a format that
   encrypts rows and leaves the change history readable has protected the less
   sensitive half.
4. Carry `meta` across in full (via `getAllMeta`), including `meshId` and HLC
   state. Losing them forks the mesh.
5. Decide explicitly about schema indexes. The current
   `["_meta.table", "payload.<field>.value"]` key paths cannot survive
   unchanged: either drop them and scan, or accept a documented equality/order
   oracle. This is a product decision, not an implementation detail, and it
   belongs in the security model.
6. Decide explicitly about keys. `${table}/${rowId}` as the primary key and
   `_meta.table` as an index key are both cleartext today. Hiding them means a
   keyed transform of the key material and gives up `by_table` enumeration as
   it currently works.
7. Tell the host what to do about the retained source generation. The seam
   deliberately does not delete it; a forced `resetLocalDatabase` after the user
   confirms is the only honest disposal, and even then the caveats in Part 1
   apply.

---

## Part 3 — Unpushed writes are not disposable

The resilience machinery in this package predates the outbox. Two behaviours
were safe when IndexedDB held a re-fetchable row cache and became data loss once
it held local-only change history:

- `resilient-store.ts` degraded the whole store to `MemoryLocalStore` after a
  short no-progress open deadline.
- `named-local-store.ts` rotates to a new database name after repeated trouble.

Both now consult a durable marker before discarding anything.

### The marker

```ts
hasUnpushedLocalWrites(dbName, slots?): boolean
setUnpushedLocalWrites(dbName, value, slots?): void
```

It lives in `localStorage` under `interocitor:unpushed:<physicalDbName>` (with
an in-memory fallback), keyed by **physical generation**. It has to be outside
IndexedDB: the case that matters most is the one where IndexedDB will not open,
and you cannot read `outboxSize()` from a database that is wedged.

It is:

- **seeded from durable truth** at every successful open, from real
  `outboxSize()` and `peekPendingBatch()` results — so installs that predate the
  marker are protected from their very first open;
- **set** by `commitLocalMutation`, `pushOutbox`, `pushOutboxEntries` and a
  promoting `promotePendingBatch`;
- **re-derived** by `acknowledgeOutbox`, `drainOutbox` and `clearAll`;
- **never cleared on a read failure.** A clean marker is a licence to discard,
  so it is only ever written clean from a successful read that proved the store
  empty.

### The refusal

```ts
class UnpushedLocalWritesError extends Error {
  readonly code = "UNPUSHED_LOCAL_WRITES";
  readonly dbName: string;
  readonly operation: "degrade-to-memory" | "rotate" | "reset";
}
```

It is thrown by the single `fallback()` chokepoint in `resilient-store.ts`
(every degrade path funnels through it), by `rotateLocalDatabaseName`, and by
`resetLocalDatabase`. `resetLocalDatabaseWithDeadline` reports it as the
outcome `"refused-unpushed-writes"` without issuing any request.

Resilience is preserved where it was actually resilience: a store with a clean
marker still degrades to memory on a stalled open exactly as before, because
that database genuinely is a disposable cache. What changed is that the code no
longer _assumes_ it is one.

Each refusal has an explicit opt-out, because "discard my unsynced work" is a
legitimate user action — it just has to be a user action, never a recovery
heuristic:

- `createResilientLocalStore({ allowDegradeWithUnpushedWrites: true })`
- `rotateLocalDatabaseName(base, pointer, { force: true })`
- `resetLocalDatabase(name, { force: true })`

Hosts can observe refusals without failing hard via `onDegradeRefused` and
`onRotationRefused`.
