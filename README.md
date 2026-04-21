<p align="center">
  <a href="https://github.com/TheUiTeam/interocitor">
    <img src="https://raw.githubusercontent.com/TheUiTeam/interocitor/main/docs/assets/hero.svg" alt="interocitor" width="560"/>
  </a>
</p>

<p align="center">
  <strong>A mailbox that can't read your mail.</strong>
</p>

<p align="center">
  Privacy-first, local-second sync for apps that should stay readable only on the client.
</p>

## Monorepo umbrella

- `packages/core` — `@interocitor/core`, the main JavaScript/TypeScript package
- `packages/react` — `@interocitor/react`, React bindings
- `packages/interocitor-swift` — Swift client
- `packages/webdav` — `@interocitor/webdav`, tiny local WebDAV server for demos/tests
- `packages/workers` — `@interocitor/workers`, Cloudflare transport pieces
- `examples/` — runnable demos

## Why

Interocitor is your app's personal keychain.
Your devices hold the key. The cloud is only a mailbox. It carries encrypted sync artifacts and cannot read your mail.

What this means:
- encryption on by default
- reads and writes are local-first
- sync uses a remote mailbox, not a trusted database
- restore is explicit app UI, not automatic magic

## Quick start

```ts
import { Interocitor } from '@interocitor/core';
import { WebDAVAdapter } from '@interocitor/core/adapters/webdav';

const db = new Interocitor({
  dbName: 'my-app',
  appName: 'My App',
  // encrypted by default; set encrypted: false to opt out
});
await db.init();

const id = await db.table('todos').add({
  text: 'Ship privacy-first sync',
  done: false,
}, { prefix: 'todo' });

db.configureMesh({ remotePath: '/MyApp', encrypted: true });
await db.setRemoteStorage(new WebDAVAdapter({
  baseUrl: 'https://your-webdav-server.example.com',
  auth: { username: 'user', password: 'pass' },
}));
await db.connect();
```

## How sync works

Interocitor keeps the full working dataset local. Cloud storage only carries encrypted sync artifacts.

```mermaid
flowchart LR
  A[App UI] --> B[Interocitor]
  B --> C[Local store]
  B --> D[Encrypt + serialize changes]
  D --> E[Transport adapter
Google Drive / WebDAV / Cloudflare / custom]
  E --> F[Remote mailbox
(ciphertext only)]
  F --> E
  E --> G[Download encrypted files]
  G --> H[Decrypt on client]
  H --> B
```

## Core API at a glance

- `new Interocitor(config)` — create engine only; no hidden init side effects
- `await db.init()` — explicit local init
- `db.configureMesh(...)` — apply remotePath/passphrase/device config before connect
- `await db.table(name).add(data, { prefix? })` — insert with generated row ID
- `await db.table(name).patch(id, partial)` — patch touched fields only
- `await db.table(name).replace(id, row)` — full replace
- `await db.table(name).delete(id)` — tombstone locally
- `await db.table(name).query()` — read from local indexes only
- `await db.table(name).where(field).equals(value).orderBy(field, dir)` — filtered local query with explicit ordering
- `await db.connect()` — authenticate + sync when remote adapter is configured
- `await db.secureWithBiometrics()` — optional, explicit keychain enrollment
- `await db.restoreWithBiometrics()` — explicit recovery flow

## Local-only mode

No adapter needed. IndexedDB only.

```ts
import { Interocitor } from '@interocitor/core';

const db = new Interocitor({
  dbName: 'meal-planner',
  appName: 'Meal Planner',
  encrypted: false,
  schema,
});
await db.init();

const id = await db.table('tasks').add({ title: 'Buy milk', done: false });
const rows = await db.table('tasks').query();
```

Transport can be attached later with `setRemoteStorage()`.

## Schema typing

```ts
const schema = {
  version: 1,
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

// inferred row type:
// { text: string; done: boolean; createdAt: Date; note?: string }
```

`.optional` makes the property optional in the inferred row type. Indexed/unique fields cannot be optional.

## Device identity

Devices self-identify with UUIDv7 IDs — sortable, globally unique. Optional naming:

```ts
const db = new Interocitor({
  schema,
  dbName: 'my-app',
  appName: 'My App',
  deviceName: "Anton's laptop",
  deviceType: 'web',
});
```

## Row ownership

Every write stamps `_owner` with the current device ID. Automatic. Survives compaction.

```ts
const row = await db.table('tasks').get(taskId);
row._owner; // device ID of last writer
```

## Mesh IDs

Worker-issued with HMAC tag. See `@interocitor/core` README for details.

```ts
import { createMeshSecret, issueMeshId, isValidMeshId } from '@interocitor/core';
const secret = await createMeshSecret();
const meshId = await issueMeshId(secret);
await isValidMeshId(meshId, secret); // true
```

## Row IDs

Use stable string IDs for synced rows. Do not use auto-increment IDs.

Usually app code should not import `createRowId()` directly. Prefer:

```ts
const id = await db.table('todos').add({ text: 'Ship it', done: false }, { prefix: 'todo' });
```

If you need raw ID generation, `createRowId()` still exists and uses platform crypto.

## Offline guarantee

Every read and write hits the local store. No network required.
`sync()` is the only call that touches the remote mailbox.

| Operation | Network? |
| --- | --- |
| `init()` | No |
| `put()` | No |
| `delete()` | No |
| `query()` | No |
| `sync()` | Yes, when adapter exists |

## Adapters

### Google Drive
Use Google Drive as the remote mailbox when you want zero new backend infrastructure and are comfortable with full-dataset replication.

### WebDAV
Use WebDAV when you want a self-hosted or locally inspectable byte pipe. Good for demos, debugging, and private infrastructure.

### Cloudflare (Interocitor-native, experimental)
Use the Cloudflare adapter when you want Interocitor-aware transport features like invalidation fanout while keeping merge and decryption on the client.

### Memory
Use the memory adapter for tests, local demos, and contract validation.

## Pairing & multi-device

No pairing server. No accounts. No copy-pasting keys.

Devices pair by scanning a QR code. The exchange runs over the same cloud backend used for sync.

```ts
import { Interocitor, generateShareQR, handleScannedQR } from '@interocitor/core';

const passphrase = engine.getPassphrase();
const { qrPayload, complete } = await generateShareQR({
  adapter,
  relayBase: '/TeamAlpha',
  remotePath: '/TeamAlpha',
  passphrase,
});
await complete();

const credentials = await handleScannedQR({
  adapter,
  relayBase: '/TeamAlpha',
  payload: scannedQrPayload,
});

const joiner = new Interocitor({
  dbName: 'team-alpha',
  appName: 'My App',
});
joiner.configureMesh({
  remotePath: credentials.remotePath,
  passphrase: credentials.passphrase,
  encrypted: true,
});
await joiner.setRemoteStorage(adapter);
await joiner.connect();
```

## Local store

Interocitor is a sync engine, not a database. The local store is a pluggable abstraction (`LocalStoreAdapter`). The browser default uses IndexedDB. The Swift package uses SQLite. You don't need to care which — all reads, writes, and queries go through the engine API.

## CRDT strategy

Interocitor uses per-column CRDTs with hybrid logical clocks (HLC). All merge happens on the client. Remote storage is just a byte pipe — it never interprets your data.

Conflict default: `'remote-wins'`.
Override at database, table, or field level.

## Events

```ts
engine.on('change', (event) => {
  console.log(event.type, event.table, event.id);
});
```

## Demos

### Local TODO demo (WebDAV)

```bash
yarn demo:todo
```

### Cloudflare TODO demo

```bash
yarn demo:todo:cloudflare
```

## What this is not

- not Firebase
- not Fireproof
- not PowerSync
- not Replicache
- not a hosted backend
- not a query engine over the cloud
- not a server-trusted merge layer

## Tests

```bash
yarn workspace @interocitor/core test
```

## Package map

- [`packages/core`](./packages/core) — `@interocitor/core`, the main JavaScript/TypeScript engine with adapters and encryption helpers
- [`packages/react`](./packages/react) — `@interocitor/react`, React bindings
- [`packages/interocitor-swift`](./packages/interocitor-swift) — Swift client
- [`packages/webdav`](./packages/webdav) — `@interocitor/webdav`, local WebDAV server for demos/tests
- [`packages/workers`](./packages/workers) — `@interocitor/workers`, Cloudflare transport pieces

## License

MIT
