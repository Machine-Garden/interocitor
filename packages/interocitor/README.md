<p align="center">
  <a href="https://github.com/TheUiTeam/interocitor">
    <img src="https://raw.githubusercontent.com/TheUiTeam/interocitor/main/docs/assets/hero.svg" alt="interocitor" width="560"/>
  </a>
</p>

<p align="center">
  <strong>The JavaScript mailbox that can't read your mail.</strong>
</p>

# interocitor

Encrypted local-first CRDT sync for browser apps.

## Why

Interocitor is your app's __personal keychain__.
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

```mermaid
flowchart LR
  A[Browser app] --> B[Interocitor engine]
  B --> C[Local store]
  B --> D[Encrypt changes locally]
  D --> E[Adapter]
  E --> F[Remote mailbox\n(ciphertext only)]
  F --> E
  E --> G[Download ciphertext]
  G --> H[Decrypt locally]
  H --> B
```

## Core API at a glance

```ts
await engine.init();
await engine.connect();
await engine.put(table, id, data);
await engine.get(table, id);
await engine.query(table);
await engine.sync();

await engine.secureWithBiometrics();   // optional, explicit keychain enrollment
await engine.restoreWithBiometrics();  // explicit recovery flow
```

## Row IDs

Use stable string IDs for synced rows. Do not use auto-increment IDs.

Good default:

```ts
import { createRowId } from 'interocitor';

const id = createRowId({ prefix: 'task' });
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
| `get()` / `query()` | No |
| `sync()` | Yes, if adapter configured |

## Adapters

### Google Drive
For zero new backend infrastructure where Google Drive is acceptable as the encrypted mailbox.

### WebDAV
For self-hosted sync, local demos, and inspectable remote artifacts.

### Cloudflare (experimental)
For Interocitor-native transport flows with invalidation fanout and maintenance endpoints while keeping decryption client-side.

### Memory
For tests and adapter-contract validation.

## Local store

Interocitor is a sync engine, not a database. The local store is a pluggable abstraction (`LocalStoreAdapter`). The browser default uses IndexedDB. The Swift package uses SQLite. You don't need to care which — reads, writes, and queries go through the engine API.

## CRDT strategy

Interocitor uses per-column CRDTs with hybrid logical clocks (HLC). All merge happens on the client. Remote storage is just a byte pipe.

Conflict default: `'remote-wins'`.
Override at database, table, or field level.

## Events

```ts
engine.on('change', (event) => {
  console.log(event.type, event.table, event.id);
});
```

## Local TODO demo (WebDAV)

From the monorepo root:

```bash
yarn demo:todo
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

From the monorepo root:

```bash
yarn workspace interocitor test
```

## Package context

This package is the main JavaScript/TypeScript runtime in the monorepo. See also:
- root `README.md` — monorepo overview
- `packages/interocitor-swift` — Swift client
- `examples/todo-webdav` — local demo app

## License

MIT
