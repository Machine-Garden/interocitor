<p align="center">
  <a href="https://github.com/TheUiTeam/interocitor">
    <img src="https://raw.githubusercontent.com/TheUiTeam/interocitor/main/docs/assets/hero.svg" alt="interocitor" width="700"/>
  </a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/TheUiTeam/interocitor/main/docs/assets/badges.svg" alt="zero servers · e2e encrypted · crdt merge · offline-first · zero deps · mit" width="700"/>
</p>

<p align="center">
  <em>☢️ work in progress — 0.0.0-beta.2 ☢️</em>
</p>

---

Start fully local in IndexedDB, attach sync later, switch adapters at runtime, or drop back to offline-only mode without losing local state.

## Monorepo umbrella

This repository is now the umbrella for the whole Interocitor family:

- `packages/interocitor` — the main JavaScript/TypeScript package
- `packages/interocitor-webdav` — local WebDAV server for Interocitor
- `packages/interocitor-workers` — Cloudflare Workers runtime for Interocitor-native sync flows
- `packages/interocitor-swift` — future Swift runtime that maps IndexedDB-like concepts onto SQLite
- `examples/todo-webdav` — file-backed WebDAV demo
- `examples/todo-cloudflare-do` — Cloudflare demo using the generic workers runtime

Package and example entry points:

- JS package: [`packages/interocitor`](https://github.com/TheUiTeam/interocitor/tree/main/packages/interocitor)
- WebDAV server package: [`packages/interocitor-webdav`](https://github.com/TheUiTeam/interocitor/tree/main/packages/interocitor-webdav)
- Workers runtime package: [`packages/interocitor-workers`](https://github.com/TheUiTeam/interocitor/tree/main/packages/interocitor-workers)
- Swift workspace: [`packages/interocitor-swift`](https://github.com/TheUiTeam/interocitor/tree/main/packages/interocitor-swift)
- WebDAV example: [`examples/todo-webdav`](https://github.com/TheUiTeam/interocitor/tree/main/examples/todo-webdav)
- Cloudflare example: [`examples/todo-cloudflare-do`](https://github.com/TheUiTeam/interocitor/tree/main/examples/todo-cloudflare-do)

If you only care about the JavaScript package, most of the API documentation below still applies directly to `interocitor`.

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

<p align="center">
  <img src="https://raw.githubusercontent.com/TheUiTeam/interocitor/main/docs/assets/sync-flow.svg" alt="sync architecture" width="750"/>
</p>

<details>
<summary>Mermaid version</summary>

```mermaid
flowchart LR
    subgraph A [Device A]
        PUT["put / delete"] -->|immediate| IDBA[(IDB)]
    end

    IDBA -->|async flush| CLOUD

    subgraph CLOUD [Cloud folder]
        CLOUD["manifest / changes / mainline"]
    end

    CLOUD -->|poll + merge| IDBB

    subgraph B [Device B]
        IDBB[(IDB)] --> QUERY["query / get"]
    end
```

</details>

Writes land in local IDB immediately — reads never touch the cloud. Flushing uploads one JSON file per change entry to the shared `changes/` folder. A single `head.json` carries the latest HLC so readers can skip listing the folder entirely when nothing is new. On pull, each reader downloads files above its local cursor, merges with HLC-ordered LWW-per-column CRDTs, and advances the cursor.

No locks, no coordination. Each device writes only its own files.

## Core API at a glance

- `await engine.init()` — open IndexedDB and load local state; no network required
- `await engine.connect()` — authenticate, bootstrap/pull remote state, and start background sync
- `await engine.setRemoteStorage(adapterOrNull)` — attach, switch, or remove the remote backend at runtime
- `await engine.table('tasks').put(id, data)` — write locally first, queue sync for later
- `await engine.flush()` — push queued local changes to the active remote immediately
- `await engine.pull()` — merge remote changes into local IndexedDB immediately
- `await engine.disconnect()` — stop polling and close the local store

## Offline guarantee

| Operation | Network? | Backing store |
| --- | --- | --- |
| `init()` | no | IndexedDB |
| `table.put()` | no | IndexedDB |
| `table.get()/query()` | no | IndexedDB |
| `connect()` | yes | cloud + IndexedDB |
| `flush()` | yes | cloud |
| `pull()` | yes | cloud + IndexedDB |

## Replica adapters (backup)

A write can be mirrored to one or more secondary destinations:

```ts
await engine.setReplicas([
  new WebDAVAdapter({ baseUrl: 'https://backup.example.com/dav', auth: { ... } }),
]);
```

Replicas receive the same encrypted payloads after the primary write completes. Reads still come from the primary adapter only.

## Adapters

### Google Drive

Uses the browser OAuth flow and a shared Drive folder.

```ts
import { GoogleDriveAdapter } from 'interocitor/adapters/google-drive';
```

### WebDAV

Generic filesystem-like cloud target for Nextcloud, ownCloud, etc.

```ts
import { WebDAVAdapter } from 'interocitor/adapters/webdav';
```

### Cloudflare (Interocitor-native, experimental)

Purpose-built HTTP API for Interocitor flows.

```ts
import { CloudflareAdapter } from 'interocitor/adapters/cloudflare';
```

#### Cloudflare deployment patterns

- **Sub-path deployment**
    - Example base URL: `https://mysite.com/interocitor/io/team-a`
- **Dedicated subdomain**
    - Example base URL: `https://interocitor.mysite.com/io/team-a`
- **Shared worker via gateway/reroute**
    - Public URL can stay the same shape (`.../io/team-a`), routed internally to Worker
    - Gateway must preserve `Authorization`, query string (`/file?path=...`), and SSE streaming

#### Cloudflare token model

Interocitor-native endpoints can be protected with a bearer token:

```ts
const adapter = new CloudflareAdapter({
  baseUrl: 'https://interocitor.mysite.com/io/team-a',
  accessToken: 'YOUR_SHARED_BEARER_TOKEN',
});
```

### Memory

Useful for tests and same-tab demos.

```ts
import { MemoryAdapter } from 'interocitor/adapters/memory';
```

## Encryption

AES-256-GCM via Web Crypto API. Key is generated on the first device, shared to others as a base58 passphrase (~43 chars), a URL fragment (`#key=…`, never hits the server), or a QR code.

Key never leaves devices. Cloud folder only contains ciphertext.

### Client-side fingerprint verification

For encrypted remotes, every encrypted change and snapshot payload carries the mesh fingerprint (`meshId`) inside the encrypted envelope. Clients verify that fingerprint after decrypting remote payloads.

- matching fingerprint → accept and merge
- wrong fingerprint → treat remote as poisoned and cut off sync
- poisoned remote → emit `remote:poisoned`

This protects against cross-mesh ciphertext injection and storage mix-ups. It does **not** protect against someone who already has the real mesh key.

Optional end-to-end encryption uses AES-256-GCM via Web Crypto.

```ts
import { generateKey, keyToPassphrase, passphraseToKey } from 'interocitor/crypto/keys';
```

Share the passphrase out-of-band. The cloud store only sees ciphertext.

## CRDT strategy

Per-column Last-Writer-Wins using Hybrid Logical Clocks (HLC).

```text
row = { columns: { field -> { value, hlc, tombstone? } } }
```

Deletes are tombstones. Merge is deterministic and commutative.

## Events

```ts
const unsub = engine.on((event) => {
  switch (event.type) {
    case 'change':
    case 'delete':
    case 'sync:start':
    case 'sync:complete':
    case 'sync:error':
    case 'remote:poisoned':
    case 'flush:start':
    case 'flush:complete':
    case 'flush:error':
    case 'rehydrate:start':
    case 'rehydrate:complete':
    case 'auth:required':
    case 'auth:complete':
    case 'schema:mismatch':
    case 'replica:error':
  }
});
```

## Cloud folder layout

```text
{remotePath}/                                    e.g. /Interocitor/MyApp
  manifest.json
  manifest-{generation}.json
  devices/
    {deviceId}.json
  mainline/
    snapshot-{epoch}-{writer}.json
  changes/
    head.json
    {hlc}-{changeId}.json
```

**Write ordering in `compact()`:** snapshot → manifest file → manifest pointer.
Readers loading `manifest.json` always see a consistent pair; the snapshot file exists before any reader is directed to it.

**Retention policy:** only the current generation is needed at runtime.
Old `manifest-*` and old `snapshot-*` files are safe to delete after the pointer moves.
Change files `≤ watermarkHlc` are pruned automatically by `compact()`.

## Local TODO demo (WebDAV)

A user-facing demo app is available at [`examples/todo-webdav/index.html`](https://github.com/TheUiTeam/interocitor/tree/main/examples/todo-webdav).

Run locally:

```bash
yarn demo:todo
```

Then open `http://127.0.0.1:4173/examples/todo-webdav/index.html`. Create a session in one tab, copy the join token, paste in another tab — both converge.

Related examples:

- Local custom WebDAV path (self-hosted style): [`examples/todo-webdav`](https://github.com/TheUiTeam/interocitor/tree/main/examples/todo-webdav)
- Cloud custom Worker + D1 path: [`examples/todo-cloudflare-do`](https://github.com/TheUiTeam/interocitor/tree/main/examples/todo-cloudflare-do)

## What this is not

Interocitor is a sync layer for structured JSON across a small device mesh. It is not:

- **A multiplayer gaming backend** — it synchronizes durable state through files, not optimized for ephemeral push updates (e.g. mouse pointers).
- **A query engine** — supports simple secondary indexes + where clauses, not SQL joins/aggregations.
- **A blob store** — small JSON records, not images.
- **Multi-tenant** — one mesh, one folder, everyone sees everything.

## Tests

Playwright e2e in a real browser. Covers manifest bootstrap, writer-authority, file-per-change writes, cross-device sync, encrypted round-trips, WebDAV contract, multi-context isolation.

The JavaScript/browser e2e suite now lives with the package in `packages/interocitor/tests/e2e`, but you can still run the common entry points from the repo root:

```bash
yarn test:e2e:install   # Chromium
yarn test:e2e           # JS package e2e suite
yarn test:e2e:todo      # package-owned TODO/WebDAV flow
yarn test:e2e:cloudflare
```

## Package map

Interocitor is now split into focused packages inside this monorepo:

- `packages/interocitor/` — main library
- `packages/interocitor-webdav/` — local WebDAV server for Interocitor
- `packages/interocitor-workers/` — reusable Cloudflare Workers runtime
- `packages/interocitor-swift/` — Swift workspace for a native implementation over SQLite

Examples stay under `examples/`, and example-owned workflows stay with those examples.

## License

MIT
