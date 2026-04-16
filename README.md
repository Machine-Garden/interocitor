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

- `packages/interocitor` — the main JavaScript/TypeScript package
- `packages/interocitor-swift` — Swift client
- `packages/interocitor-webdav` — tiny local WebDAV server for demos/tests
- `packages/interocitor-workers` — Cloudflare transport pieces
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
import { SyncEngine, createRowId } from 'interocitor';
import { WebDAVAdapter } from 'interocitor/adapters/webdav';

const adapter = new WebDAVAdapter({
  baseUrl: 'https://your-webdav-server.example.com',
  auth: { username: 'user', password: 'pass' },
});

const engine = new SyncEngine(adapter, {
  remotePath: '/MyApp',
  dbName: 'my-app',
  appName: 'My App',
  // encrypted by default; set encrypted: false to opt out
});

await engine.init();
await engine.connect();

const id = createRowId({ prefix: 'todo' });
await engine.put('todos', id, {
  text: 'Ship privacy-first sync',
  done: false,
});
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

- `await engine.init()` — open local storage and load state; no network required
- `await engine.put(table, id, data)` — insert or update a row locally
- `await engine.delete(table, id)` — tombstone locally
- `await engine.query(table, options?)` — read from local indexes only
- `await engine.sync()` — exchange encrypted artifacts with the remote adapter
- `await engine.secureWithBiometrics()` — optional, explicit keychain enrollment
- `await engine.restoreWithBiometrics()` — explicit recovery flow

## Row IDs

Use stable string IDs for synced rows. Do not use auto-increment IDs.

Good default:

```ts
import { createRowId } from 'interocitor';

const id = createRowId({ prefix: 'todo' });
await engine.put('todos', id, { text: 'Ship it', done: false });
```

`createRowId()` uses platform crypto. No extra dependency needed.

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
import { SyncEngine, generateShareQR, handleScannedQR } from 'interocitor';

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

const joiner = new SyncEngine(adapter, {
  remotePath: credentials.remotePath,
  passphrase: credentials.passphrase,
  dbName: 'team-alpha',
  appName: 'My App',
});
await joiner.init();
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
yarn workspace interocitor test
```

## Package map

- [`packages/interocitor`](./packages/interocitor) — the main JavaScript/TypeScript engine with adapters and encryption helpers
- [`packages/interocitor-swift`](./packages/interocitor-swift) — Swift client
- [`packages/interocitor-webdav`](./packages/interocitor-webdav) — local WebDAV server for demos/tests
- [`packages/interocitor-workers`](./packages/interocitor-workers) — Cloudflare transport pieces

## License

MIT
