<p align="center">
  <a href="https://github.com/TheUiTeam/interocitor">
    <img src="https://raw.githubusercontent.com/TheUiTeam/interocitor/main/docs/assets/hero.svg" alt="interocitor" width="560"/>
  </a>
</p>

<p align="center">
  <strong>The JavaScript mailbox that can't read your mail.</strong>
</p>

# @interocitor/core

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
import { Interocitor } from '@interocitor/core';
import { WebDAVAdapter } from '@interocitor/core/adapters/webdav';

const db = new Interocitor({
  remotePath: '/MyApp',
  dbName: 'my-app',
  appName: 'My App',
  // encrypted by default; set encrypted: false to opt out
});

// local-only usage works immediately
const id = await db.table('todos').add({
  text: 'Ship privacy-first sync',
  done: false,
}, { prefix: 'todo' });

// attach transport later, when app/backend is ready
await db.setRemoteStorage(new WebDAVAdapter({
  baseUrl: 'https://your-webdav-server.example.com',
  auth: { username: 'user', password: 'pass' },
}));
await db.connect();
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
const db = new Interocitor({ dbName: 'my-app', appName: 'My App', schema });

await db.table('tasks').add({ title: 'Ship it', done: false }, { prefix: 'task' });
await db.table('tasks').patch(taskId, { done: true });
await db.table('tasks').replace(taskId, fullTask);
await db.table('tasks').get(taskId);
await db.table('tasks').query();
await db.table('tasks').where('done').equals(false).orderBy('title');

await db.connect();
await db.secureWithBiometrics();
await db.restoreWithBiometrics();
```

No `await db.init()` — initialization is automatic.

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
        note: types.optional(types.string),
        dueAt: types.optional(types.index(types.date)),
      },
    },
  },
} satisfies DatabaseSchemaDefinition;

// inferred row type:
// { text: string; done: boolean; createdAt: Date; note?: string; dueAt?: Date }
```

`types.optional()` marks property presence, not `T | undefined` value type.
When present, `dueAt` is still `Date`, not `Date | undefined`.

Typed JSON also works:

```ts
items: types.typed<ReceiptItem[]>('json')
metadata: types.optional(types.typed<Record<string, unknown>>('json'))
```

## Row IDs

Use stable string IDs for synced rows. Do not use auto-increment IDs.

Usually app code should not import `createRowId()` directly. Prefer:

```ts
const id = await db.table('tasks').add({ title: 'Ship it' }, { prefix: 'task' });
```

If you need raw ID generation, `createRowId()` still exists and uses platform crypto.

## Offline guarantee

Every read and write hits the local store. No network required.
`connect()` and background sync are the only flows that touch the remote mailbox.

| Operation | Network? |
| --- | --- |
| `new Interocitor()` | No |
| `table.add()` | No |
| `table.patch()` / `table.replace()` | No |
| `table.delete()` | No |
| `table.get()` / `table.query()` | No |
| `connect()` | Yes, if adapter configured |

## Local-only mode

No adapter. No remote. Just IndexedDB.

```ts
const db = new Interocitor({
  dbName: 'meal-planner',
  appName: 'Meal Planner',
  encrypted: false,
  schema,
});

const rows = await db.table('weekPlans').query();
```

You can attach transport later with `setRemoteStorage()`.

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
yarn workspace @interocitor/core test
```

## Package context

This package is the main JavaScript/TypeScript runtime in the monorepo. See also:
- root `README.md` — monorepo overview
- `packages/interocitor-swift` — Swift client
- `examples/todo-webdav` — local demo app

## License

MIT
