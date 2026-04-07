# interocitor

> ☢️ work in progress — 0.0.0-beta.2 ☢️

Sync structured data across devices using a cloud folder you already own. CRDT merge, E2E encryption, no purpose-built sync backend.

Start fully local in IndexedDB, attach sync later, switch adapters at runtime, or drop back to offline-only mode without losing local state.

## Why

You want local-first sync. You look at the options.

[Dexie Cloud](https://dexie.org/cloud/) — great IndexedDB wrapper, mature CRDT sync. But sync goes through their servers. Per-seat pricing. If they shut down, your sync is gone. [Firebase](https://firebase.google.com/), [Supabase](https://supabase.com/), [Convex](https://www.convex.dev/) — same dependency, different logo.

Those are real-time collaborative sync platforms. They move your bytes through their servers, under their Terms of Service.

Interocitor is **privacy-first**. It gives you total data ownership by syncing over storage you already control. The zero-infrastructure baseline uses background polling, but this isn't a hard limit — sync can be configured to run faster, or even become push-based with an optional relay.

The strongest use case: syncing your own stuff across your own devices — laptop, phone, tablet — without anyone else touching your data. For this, you don't need a heavy sync service. You just need a *transport* — a place where one device writes and another reads.

You already have one. Google Drive gives you 15 GB for free. A Nextcloud on a $5 VPS gives you whatever your disk holds. These aren't databases, they're dumb file stores. That's exactly what a CRDT log needs.

**Interocitor uses a shared cloud folder as the sync transport.** Each device writes changes as JSON files. Other devices poll the folder, download new files, merge via LWW-per-column CRDTs. All reads hit local IndexedDB — never the cloud. The cloud folder is a mailbox, not a runtime dependency.

What falls out of this design:

- No purpose-built sync backend. No WebSocket. No vendor lock-in.
- Swap Google Drive for WebDAV mid-session. Data survives.
- Optional AES-256-GCM encryption — cloud provider sees ciphertext.
- Browser clears IndexedDB? App rehydrates from cloud on next open.
- Zero runtime dependencies — Web Crypto API, IndexedDB, `fetch`.
- Network is never required for reads or writes — they hit local IDB immediately.

To be precise: Google Drive is still an API with auth, rate limits, quotas, and ToS. WebDAV on a VPS is a server you maintain. The claim is **no custom sync server** in your architecture — not "no servers involved."

## Quick start

```ts
import { SyncEngine } from 'interocitor';
import { GoogleDriveAdapter } from 'interocitor/adapters/google-drive';
import { generateKey, keyToPassphrase } from 'interocitor/crypto/keys';

interface AppSchema {
  tasks: { title: string; status: 'open' | 'in-progress' | 'done'; assignee: string };
  notes: { content: string };
}

const adapter = new GoogleDriveAdapter({ clientId: 'YOUR_GOOGLE_CLIENT_ID' });
const engine = new SyncEngine<AppSchema>(adapter, {
  remotePath: '/MyApp',
  dbName: 'myapp',
});

// encryption is optional — skip these three lines if you don't need it
const key = await generateKey();
const passphrase = await keyToPassphrase(key); // ~43 char base58, share it
engine.setEncryptionKey(key);

await engine.init();    // open local IndexedDB — no network
await engine.connect(); // authenticate, pull, start polling

const tasks = engine.table('tasks');

await tasks.put('task_1', {
  title: 'Review PR #42',
  status: 'open',
  assignee: 'marina',
});

const task = await tasks.get('task_1');
const all  = await tasks.query();

const unsub = engine.on((event) => {
  if (event.type === 'change') {
    console.log(`Updated: ${event.table}/${event.rowId}`);
  }
});

await engine.disconnect();
```

The schema generic is optional. Without it, pass a type param per table or go fully untyped:

```ts
const engine = new SyncEngine(adapter, { remotePath: '/App', dbName: 'app' });
const tasks  = engine.table<{ title: string; status: string }>('tasks');
const notes  = engine.table('notes'); // untyped, anything goes
```

You can also start local-only with IndexedDB and attach sync later:

```ts
import { WebDAVAdapter } from 'interocitor/adapters/webdav';

const engine = new SyncEngine<{ tasks: { title: string } }>({
  remotePath: '/App',
  dbName: 'app',
});

await engine.init();
await engine.table('tasks').put('task_1', { title: 'created before sync' });

await engine.setRemoteStorage(new WebDAVAdapter({
  baseUrl: 'https://cloud.example.com/remote.php/dav/files/alice',
  auth: { username: 'alice', password: 'APP_PASSWORD' },
}));
await engine.connect();
```

Indexed querying uses Dexie-like where clauses on `Table`:

```ts
const openTasks = await engine.table('tasks').where('status').equals('open');
const mine      = await engine.table('tasks').where('assignee').anyOf(['marina', 'anton']);
const high      = await engine.table('tasks').where('priority').aboveOrEqual(3);
const recent    = await engine.table('tasks').where('priority').between(2, 5);
```

Queries against un-indexed fields fall back to a full-table scan automatically. For schema definition (`types.index`, `types.enum`, migrations), see [interocitor-architecture.md](interocitor-architecture.md).

Backends are swappable at runtime. You can attach one later, switch to another, or go fully offline again:

```ts
await engine.setRemoteStorage(new WebDAVAdapter({ baseUrl: 'https://main.example.com/dav', auth: { ... } }));
await engine.connect();

await engine.setRemoteStorage(new WebDAVAdapter({ baseUrl: 'https://backup.example.com/dav', auth: { ... } }));
await engine.setRemoteStorage(null); // keep working locally in IndexedDB only
```

`setRemoteStorage(...)` re-seeds the selected backend from current local IndexedDB state. That means these flows are supported:

- start with no adapter, write locally, then enable sync later
- switch from adapter A to adapter B at runtime
- detach from sync completely with `setRemoteStorage(null)`
- reconnect to an old adapter later and merge remote changes made while this client was offline

## How sync works

```mermaid
flowchart LR
    subgraph A [Device A]
        PUT["put / delete"] -->|immediate| IDBA[(IDB)]
    end

    IDBA -->|async flush| CLOUD

    subgraph Cloud [changes/]
        CLOUD["change files\nhead.json"]
    end

    CLOUD -->|poll + merge| IDBB

    subgraph B [Device B]
        IDBB[(IDB)] --> QUERY["query / get"]
    end
```

Writes land in local IDB immediately — reads never touch the cloud. Flushing uploads one JSON file per change entry to the shared `changes/` folder. A single `head.json` carries the latest HLC so readers can skip listing the folder entirely when nothing is new. On pull, each reader downloads files above its local cursor, merges with HLC-ordered LWW-per-column CRDTs, and advances the cursor.

No locks, no coordination. Each device writes only its own files.

For detailed protocol sequence diagrams (pull, connect, compaction, bootstrap, rehydration, replica flush), see **[docs/flows.md](docs/flows.md)**.

## Core API at a glance

- `await engine.init()` — open IndexedDB and load local state; no network required
- `await engine.connect()` — authenticate, bootstrap/pull remote state, and start background sync
- `await engine.setRemoteStorage(adapterOrNull)` — attach, switch, or remove the remote backend at runtime
- `await engine.table('tasks').put(id, data)` — write locally first, queue sync for later
- `await engine.flush()` — push queued local changes to the active remote immediately
- `await engine.pull()` — merge remote changes into local IndexedDB immediately
- `await engine.disconnect()` — stop polling and close the local store

## Offline guarantee

Network is never required for data operations:

| Operation | Network? | Backing store |
|---|---|---|
| `init()` | No | IndexedDB open |
| `put()` / `delete()` | No | IDB write + outbox queue |
| `get()` / `query()` / `queryWhere()` | No | IDB read |
| `table()` / `tableNames()` | No | In-memory |
| `connect()` | **Yes** | Authenticates, pulls, starts poll |
| `flush()` | **Yes** | Uploads outbox to cloud |
| `pull()` | **Yes** | Downloads new change files |
| `compact()` | **Yes** | Snapshot + manifest write |

If the app loses network after `connect()`, local reads/writes continue. The outbox accumulates. Next `flush()` (automatic or manual) pushes everything.

## Replica adapters (backup)

Write to multiple cloud backends simultaneously. Pull reads from the primary adapter only; flush writes to primary + all replicas. Replica failures are best-effort — they emit a `replica:error` event but never fail the primary flush.

```ts
import { WebDAVAdapter } from 'interocitor/adapters/webdav';

const primary = new WebDAVAdapter({ baseUrl: 'https://main.example.com/dav', auth: { ... } });
const backup  = new WebDAVAdapter({ baseUrl: 'https://backup.example.com/dav', auth: { ... } });

const engine = new SyncEngine(primary, {
  remotePath: '/MyApp',
  replicas: [{ adapter: backup }],
});
```

## Adapters

### Google Drive

Easiest zero-infra start. Uses `drive.file` scope (app sees only files it created/opened). Mesh members can join via Drive native sharing.

```ts
import { GoogleDriveAdapter } from 'interocitor/adapters/google-drive';
const adapter = new GoogleDriveAdapter({ clientId: 'YOUR_CLIENT_ID' });
```

### WebDAV

The self-hosted / bring-your-own-cloud path. Works with Nextcloud, ownCloud, and any provider exposing a WebDAV endpoint + app password/basic auth.

```ts
import { WebDAVAdapter } from 'interocitor/adapters/webdav';
const adapter = new WebDAVAdapter({
  baseUrl: 'https://cloud.example.com/remote.php/dav/files/alice',
  auth: { username: 'alice', password: 'APP_PASSWORD' },
});
```

What WebDAV gives you in practice:

- You control where the sync mailbox lives (your VPS / NAS / managed WebDAV host).
- No vendor-specific sync runtime in your app architecture.
- Straightforward backups/migration because everything is files.

### Cloudflare (Interocitor-native, experimental)

Purpose-fit JSON/binary protocol over Worker + D1, plus SSE push (no DAV layer).

```ts
import { CloudflareAdapter } from 'interocitor/adapters/cloudflare';
const adapter = new CloudflareAdapter({
  baseUrl: 'https://<your-worker>/io/<prefix>',
  token: 'sha256(<prefix> + INTEROCITOR_ACCESS_TOKEN)',
});
```

#### Cloudflare API design

- Adapter endpoint contract: `https://<host>/<optional-prefix>/io/<namespace>`
- SSE endpoint is derived automatically as `.../events/<namespace>`
- Namespace isolates one mesh/workspace in the backend
- Prefix can be worker-owned (resolved from auth/session) or explicit in URL

#### Cloudflare deployment patterns

- **Sub-path deployment**
  - Example base URL: `https://mysite.com/interocitor/io/team-a`
- **Dedicated subdomain**
  - Example base URL: `https://interocitor.mysite.com/io/team-a`
- **Shared worker via gateway/reroute**
  - Public URL can stay the same shape (`.../io/team-a`), routed internally to Worker
  - Gateway must preserve `Authorization`, query string (`/file?path=...`), and SSE streaming

#### Cloudflare token model

- `token` in `CloudflareAdapter` is optional bearer auth for backend cost/abuse protection.
- Worker validates token as `sha256(prefix + INTEROCITOR_ACCESS_TOKEN)`.
- This makes tokens prefix-scoped (different namespace/prefix => different token).
- If the worker secret is unset, backend is public (token not required).
- This token is **not** your data encryption key; payload confidentiality still comes from Interocitor E2E encryption.

This is under active verification before being finalized as a stable drop-in backend.

### Memory

For tests.

```ts
import { MemoryAdapter } from 'interocitor/adapters/memory';
const adapter = new MemoryAdapter();
```

### Custom

Implement `StorageAdapter` (`authenticate`, `ensureFolder`, `listFiles`, `listFolders`, `readFile`, `writeFile`, `deleteFile`, `getFileMetadata`).

## Encryption

AES-256-GCM via Web Crypto API. Key is generated on the first device, shared to others as a base58 passphrase (~43 chars), a URL fragment (`#key=…`, never hits the server), or a QR code.

```ts
import { generateKey, keyToPassphrase, passphraseToKey } from 'interocitor/crypto/keys';

const key = await generateKey();
const passphrase = await keyToPassphrase(key);

// on another device
const sameKey = await passphraseToKey(passphrase);
engine.setEncryptionKey(sameKey);
```

Key never leaves devices. Cloud folder only contains ciphertext. All devices lose the key → data is unrecoverable. That's the point. Print it.

## CRDT strategy

LWW-per-column. Each field carries its own HLC timestamp. On merge, highest HLC wins per field independently.

```
Device A: task.title  = "Review PR"  at T1
Device B: task.status = "done"       at T2

→ { title: "Review PR" (T1), status: "done" (T2) }
```

Different fields → both preserved. Same field → latest wins. Deletes are tombstones with a bounded retention window (default 90 days).

Tombstone cleanup happens during compaction. Any device can trigger `engine.compact()` in the default mode; in server-managed mode (`serverManaged: true`), only the configured `serverId` may compact. If two devices compact concurrently, manifest generations determine which snapshot wins.

No ordered-list CRDTs, no rich-text merge. For tabular data this is enough, and you can reason about it on a napkin.

## Events

```ts
engine.on((event) => {
  switch (event.type) {
    case 'change':             // row upserted
    case 'delete':             // row tombstoned
    case 'sync:start':         // pull cycle begins
    case 'sync:complete':      // pull done, N entries merged
    case 'sync:error':
    case 'flush:start':        // push cycle begins
    case 'flush:complete':
    case 'flush:error':
    case 'rehydrate:start':    // rebuilding from snapshot
    case 'rehydrate:complete':
    case 'auth:required':      // cloud token expired
    case 'auth:complete':
    case 'schema:mismatch':    // remote schema newer
    case 'replica:error':      // backup adapter write failed
  }
});
```

## Cloud folder layout

```
{remotePath}/                                    e.g. /Interocitor/MyApp
  manifest.json                                  ← pointer: { currentGeneration, file }
  manifest-{generation}.json                     ← immutable; epoch, watermark, snapshotPath
  devices/
    {deviceId}.json                              ← heartbeat: lastSeenAt, userId
  mainline/
    snapshot-{epoch}-{writer}.json               ← full IDB snapshot at watermarkHlc
  changes/
    head.json                                    ← { latestHlc } — fast poll-skip hint
    {hlc}-{changeId}.json                        ← one file per flush entry (all devices)
```

**Write ordering in `compact()`:** snapshot → manifest file → manifest pointer.
Readers loading `manifest.json` always see a consistent pair; the snapshot file exists before any reader is directed to it.

**Retention policy:** only the current generation is needed at runtime.
Old `manifest-*` and old `snapshot-*` files are safe to delete after the pointer moves.
Change files `≤ watermarkHlc` are pruned automatically by `compact()`.

## Local TODO demo (WebDAV)

A user-facing demo app is available at `examples/todo-webdav/index.html`.

Run locally:

```bash
yarn demo:todo
```

Then open `http://127.0.0.1:4173/examples/todo-webdav/index.html`. Create a session in one tab, copy the join token, paste in another tab — both converge.

Related examples:

- Local custom WebDAV path (self-hosted style): `examples/todo-webdav/`
- Cloud custom Worker + D1 path: `examples/todo-cloudflare-do/`

## What this is not

A sync layer for structured JSON across a small device mesh. Not:

- **A multiplayer gaming backend** — it synchronizes durable state through files, not optimized for ephemeral push updates (e.g. mouse pointers).
- **A query engine** — supports simple secondary indexes + where clauses, not SQL joins/aggregations.
- **A blob store** — small JSON records, not images.
- **Multi-tenant** — one mesh, one folder, everyone sees everything.

## Tests

Playwright e2e in a real browser. Covers manifest bootstrap, writer-authority, file-per-change writes, cross-device sync, encrypted round-trips, WebDAV contract, multi-context isolation.

```bash
yarn test:e2e:install   # Chromium
yarn test:e2e           # run
yarn test:e2e:headed    # watch
yarn test:e2e:debug     # Playwright UI
```

## Planned: extraction to stable drop-ins

Two custom backend tracks are in active verification and will be extracted into polished drop-in solutions after full validation:

- WebDAV local/self-hosted workflow (`examples/todo-webdav/`)
- Cloudflare Worker + D1 (+ optional DO for SSE fanout) workflow (`examples/todo-cloudflare-do/`)

Google Drive and standard WebDAV remain the baseline production paths today.

## License

MIT
