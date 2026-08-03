# Adapter contract

A storage adapter is a thin wrapper over a remote byte store
(WebDAV, Google Drive, Cloudflare, in‑memory). The engine treats the
remote as **a mailbox**: it lists files, reads files, writes files,
deletes files. There is no compute on the remote side.

This document is what an adapter implementer must guarantee, and what
the engine guarantees in return.

## Interface

```ts
interface StorageAdapter {
  readonly name: string;

  authenticate(): Promise<void>;
  isAuthenticated(): boolean;

  ensureFolder(path: string): Promise<void>;
  listFiles(path: string): Promise<FileEntry[]>;
  listFolders(path: string): Promise<string[]>;

  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  deleteFile(path: string): Promise<void>;

  getFileMetadata(path: string): Promise<FileEntry | null>;

  // Optional durable app-file capability. Sync internals keep using the
  // primitives above; these methods are for user files/images that do not
  // compact or merge.
  putStoredFile?(path: string, data: Uint8Array | string, options?: StoredFileWriteOptions): Promise<StoredFileMetadata>;
  getStoredFile?(path: string): Promise<Uint8Array>;
  deleteStoredFile?(path: string): Promise<void>;
  getStoredFileMetadata?(path: string): Promise<StoredFileMetadata | null>;

  getHandshakeConfig?(): string;
  resetFolderCache?(): void;
}

interface FileEntry {
  name: string;
  path: string;
  size: number;
  modifiedTime: string;   // ISO 8601
  etag?: string;
  revision?: string;
}

interface StoredFileMetadata extends FileEntry {
  uploadedByDeviceId?: string;
  uploadedAt?: string;
  lastAccessedAt?: string;
  useCount?: number;
  plaintextSize?: number;
  storedSize?: number;
  contentType?: string;
  taint?: string;
}

interface StoredFileWriteOptions {
  uploadedByDeviceId?: string;
  plaintextSize?: number;
  contentType?: string;
  taint?: string;
}
```

`StorageAdapter` in `src/core/types.ts` is the type authority.
`MemoryAdapter` is a compact reference implementation of the generic object
semantics.

## Required semantics

### Paths

- Paths use `/` as the separator and start with the configured
  `remotePath` root, e.g. `/MyApp/changes/01HX...-chg_01HX....json`.
- Paths are case‑sensitive.
- Trailing slashes on folders are tolerated but never produced by the
  engine.
- An adapter is free to map paths to any backend‑native form (Google
  Drive uses file IDs internally) as long as the externally observed
  semantics below hold.

### `listFiles(folderPath)` — direct children only

- Returns the **direct file children** of `folderPath`. No recursion.
- Each `FileEntry.path` is the full path the engine can pass to
  `readFile` / `deleteFile` without further mangling.
- Empty folder → empty array (not throw).
- Missing folder → throwing is acceptable; the engine catches it and
  treats it as "no changes yet". Returning `[]` is also acceptable.
- Order is **not required** — the engine sorts by `name`.

### `listFolders(folderPath)` — direct subfolder names

- Returns folder names (not full paths), no recursion.
- Used rarely; safe to return `[]` if the backend has no folder concept.

### `readFile(path)`

- Returns the exact bytes that were last written.
- Missing file → throw. The engine inspects the error and treats most
  failures as transient.
- Adapters MUST NOT silently return stale data. Eventually consistent
  backends should at least provide read‑after‑write for the same key
  (see "Consistency" below).

### `writeFile(path, data)`

- Overwrites unconditionally if the path exists.
- Creates the file if it does not.
- Does not need to be atomic across paths, but a single `writeFile` call
  must either fully apply or fully fail. Partial writes are not
  acceptable (no half‑written change files).
- Bytes written = bytes read. No re‑encoding (e.g. don't strip BOMs,
  don't normalise line endings on text content).

> **No CAS / ETag.** The interface intentionally does **not** require
> conditional writes. If your backend supports If‑Match, you may use it
> internally for retry safety, but the engine never depends on it. See
> the compaction safety notes in [Compaction](compaction.md).

### `deleteFile(path)`

- Removes the file. Subsequent `readFile(path)` should fail.
- Deleting a missing file should be a no‑op (no throw). Core uses this for
  explicit durable app-file deletion; compaction retains sync change files.

### Durable app-file methods

`putStoredFile`, `getStoredFile`, `deleteStoredFile`, and `getStoredFileMetadata` are optional. Implement them when a backend has a better storage path for user files than the sync-object primitives.

Semantics:

- They store opaque bytes at a mesh file path chosen by the engine.
- They are not part of `changes/`, snapshots, or compaction.
- `putStoredFile` may overwrite the current object at that path.
- `deleteStoredFile` removes the object and any backend metadata used for quota/access tracking.
- `getStoredFile` should update `lastAccessedAt`/`useCount` when the backend tracks those fields.
- Returned `size` should be the stored byte size; `plaintextSize` is supplied by the engine when known.

If an adapter does not implement these methods, the engine falls back to `writeFile`/`readFile`/`deleteFile`/`getFileMetadata` under `<remotePath>/files/...`.

### `ensureFolder(path)`

- Idempotent. Creates parent folders as needed.
- For backends without folders (S3‑style), this can be a no‑op.
- Engine calls this before the first write into a folder. Adapters
  typically cache "ensured" paths in a `Set` to avoid repeated round
  trips; expose `resetFolderCache()` so the engine can invalidate on
  mesh swap or transport teardown.

### Bounded progress

Adapters should reject failed operations instead of leaving promises pending.
The full connect pipeline wraps its named stages with
`connectStageTimeoutMs`, but that is not a universal deadline around every
adapter call. The reload fast-path head read, normal `pull()`/`flush()` calls,
durable file methods, and adapter-owned authentication requests can still
depend on adapter progress. Make network operations abortable, impose an
adapter-level timeout, and return meaningful errors.

When a deadline-wrapped connect stage stalls, the engine emits
`connect:error`, calls `onConnectStalled`, returns from `connect()`, and keeps
initialized local row operations available for a later retry.

### `authenticate()` / `isAuthenticated()`

- At the start of `connect()`, the engine consults `isAuthenticated()`.
- When it returns false, the engine emits `auth:required`, calls
  `authenticate()` as a deadline-wrapped connect stage, then emits
  `auth:complete` on success.
- Core does not automatically retry a failed operation after a 401, and it
  does not re-check primary-adapter authentication before every pull or flush.
- Write-only replica adapters are checked and authenticated before their
  individual replica flush.
- Storing credentials is the adapter's problem. The engine does not
  persist tokens.

### `getFileMetadata(path)`

- Returns `null` if missing, otherwise size + modifiedTime (+ etag if
  the backend exposes one).
- Used by maintenance code to make eviction decisions; safe to be
  best‑effort.

### Optional: `getHandshakeConfig()`

- Returns an opaque adapter‑specific config string the scanner uses to
  configure their own adapter during pairing.
- MUST NOT include credentials. The handshake exchanges keys over an
  ECDH relay; the config identifies how to reach the same backend endpoint,
  not its password or the mesh `remotePath`. The `remotePath` travels inside
  the encrypted handshake credential envelope.

### Optional: recovery wrapper storage

Portable-key recovery can use the regular primitives under
`/.interocitor/recovery/`. An adapter that needs a separate, mesh-independent
endpoint can additionally implement `RecoveryStorageAdapter` with
`readRecoveryWrapper(locator)` and `writeRecoveryWrapper(locator, data)`.
Overwrite behavior belongs to the adapter. See the
[Recovery API reference](recovery-reference.md#storage-adapter-behavior).

## Consistency assumptions

The engine is designed to tolerate weak consistency, but it does require:

| Property | Required? | Notes |
| --- | --- | --- |
| Read‑after‑write for same path on same client | **Yes** | The engine reads back files it just wrote (e.g. in compaction). |
| Read‑your‑own‑writes globally | No | Other devices may see the new file with a delay. |
| Strong list consistency | No | The engine sorts and dedupes; missing entries are picked up on the next poll. |
| Atomic multi‑file write | No | Engine never assumes two files are written together. |
| Conditional writes (CAS / If‑Match) | No | Engine never sends one. Compaction safety notes spell out the trade‑off. |
| Monotonic file listing | No | An adapter may return a file in one `listFiles` and omit it from the next; the engine retries. |

If your backend can lose writes silently, the adapter should surface
that as a thrown error from `writeFile`, not a successful return. The
engine treats a thrown write as "stay in the outbox, retry later".

## What the engine guarantees in return

- **Single writer per `path`.** The engine never has two concurrent
  in‑flight writes to the same path from the same instance. (Other
  instances/devices can; see compaction.)
- **Bounded retries.** A failed `writeFile` keeps the entry in the
  outbox and retries on the next flush trigger. There is no infinite
  loop.
- **Exact sync-history deletes.** After snapshot and manifest publication,
  compaction calls `deleteFile()` only for filenames in the snapshot's
  `coveredChangeFiles`. HLC order is never treated as proof of coverage.
- **Folder cache invalidation.** Engine calls `resetFolderCache()` on
  mesh swap, transport teardown, and remote poison.
- **Authoritative format.** All payloads are UTF‑8 JSON or raw bytes.
  Never partial JSON, never streamed.

## Folder layout the engine writes

For a configured `remotePath = /MyApp` (mesh‑scoped — see "Scope" below):

```
/MyApp/
├── manifest.json                              # pointer { currentGeneration, file }
├── manifest-1.json                            # generation 1
├── manifest-2.json                            # generation 2 ...
├── changes/
│   ├── head.json                              # { latestHlc } — pull fast path
│   ├── <HLC>-chg_<id>.json                    # encrypted change entry
│   └── ...
├── devices/
│   └── <deviceId>.json                        # device metadata
├── files/
│   └── <app path>                             # durable encrypted app files
└── mainline/
    └── snapshot-<epoch>-<serverId>.json       # encrypted snapshot
```

`<HLC>` is a 26‑char sortable string; sorting change files lexically by
`name` yields HLC order.

## Scope of `remotePath`

`remotePath` is **mesh‑level**. One folder = one mesh = one logical
database. Specifically:

- App‑level: choose the parent folder (`/MyApp` vs `/OtherApp`).
- User‑level: typically the user's whole drive is one mesh; you don't
  multiplex.
- Mesh‑level: each mesh gets its own `remotePath`. Two meshes sharing
  the same `remotePath` will fight over the manifest and poison the
  remote.
- Device‑level: never. Devices share `remotePath`; that's the whole
  point.

When you re‑pair (new mesh, fresh key), pick a new `remotePath` or
delete the old folder first.

## Implementing a custom adapter

Minimum viable implementation: copy `MemoryAdapter` and replace the
`Map<string, …>` with calls to your backend. The repository currently has a
WebDAV-specific Playwright contract test:

```bash
yarn workspace @interocitor/core test:e2e \
  webdav.adapter.contract.spec.ts
```

Use that test as a behavior example, then add equivalent coverage for the new
adapter. Passing the WebDAV test is not proof that another backend satisfies
authentication, consistency, timeout, metadata, or recovery semantics.

## Things adapters routinely get wrong

- Returning recursive children from `listFiles`. Fix: filter out paths
  containing a `/` after the prefix.
- Re‑encoding JSON on write (pretty‑printing, sorting keys). Fix: write
  the bytes you were given.
- Caching `readFile` results indefinitely. Fix: don't cache reads at all,
  or cache only with a short TTL keyed on `etag`/`modifiedTime`.
- Throwing on `deleteFile` of a missing path. Fix: swallow the 404.
- Treating folders as files. Fix: the engine never reads a folder.
