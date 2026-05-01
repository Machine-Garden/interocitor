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

`sync()` reconciles local state with the remote mailbox in two steps:

1. `pull()` — download remote change files and merge them into local state.
2. `flush()` — push queued local outbox entries to the remote mailbox.

`sync()` does **not** perform storage cleanup. Cleanup of old change files happens during **compaction**, a separate maintenance flow.

## Compaction & batching

Compaction, automatic compact scheduling, and batched writes exist in the shipped runtime APIs. The detailed policy, configuration, events, and `db.batch(fn)` API live in the package docs:

- JS/TS — see `packages/core/README.md` (manual `compact()`, immediate sampled auto-compact, delayed two-phase auto-compact, implicit `batchWindowMs`, explicit `db.batch(fn)`)
- Swift — see `packages/interocitor-swift/README.md` (manual `compact()` and coordination policy)

This root README stays umbrella-only.

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

For compact and maintenance guidance, see the package README that ships with your runtime.

## Local-only mode

```ts
const db = new Interocitor({ dbName: 'solo-app' });
await db.init();
await db.table('notes').add({ text: 'offline first' }, { prefix: 'note' });
```

Local CRUD works without any adapter.

## Schema typing

```ts
import { schema } from '@interocitor/core';

const appSchema = schema({
  todos: {
    text: schema.string(),
    done: schema.boolean().index(),
    createdAt: schema.date(),
    note: schema.string().optional(),
  },
});

const db = new Interocitor({ dbName: 'typed-app', schema: appSchema });

// inferred row type:
// { text: string; done: boolean; createdAt: Date; note?: string }
```

`.optional` makes the property optional in the inferred row type. Indexed/unique fields cannot be optional.

## Device identity

Devices self-identify with UUIDv7 IDs — sortable, globally unique. Optional naming:

```ts
const db = new Interocitor({
  dbName: 'my-app',
  deviceName: 'Anton’s iPhone',
  deviceType: 'ios',
});
```

These appear in pairing metadata and sync manifests.

## Row ownership

Every row written through the engine automatically gets `_owner` set to the writing device ID.

```ts
const row = await db.table('todos').row(id);
row?._owner; // device ID of last writer
```

## Mesh IDs

Mesh/team IDs should be worker-issued with an embedded HMAC tag:

```ts
import { createMeshSecret, issueMeshId, isValidMeshId } from '@interocitor/core';

const secret = await createMeshSecret();
const meshId = await issueMeshId(secret);
const ok = await isValidMeshId(meshId, secret);
```

Format: `<uuidv7>.<base64url HMAC tag>`.

## Row IDs

```ts
import { createRowId, normalizeRowId } from '@interocitor/core';

const id = await createRowId('todo');
const safe = normalizeRowId(id);
```

Row IDs are opaque, sortable, and safe for sync artifacts.

## Offline guarantee

| Operation | Network? |
| --- | --- |
| init | No |
| add / patch / replace / delete | No |
| query / row | No |
| connect / sync | Yes, if adapter configured |

## Adapters

Use one of the built-in adapters or provide your own:

- WebDAV
- Google Drive
- Cloudflare
- Memory adapter for tests

## Pairing & multi-device

Use three app-side modules for production integrations:

```text
lib/interocitor-db.ts      engine, schema, local repository, credential primitives
lib/interocitor-sync.ts    mesh id lifecycle, adapter, connect/disconnect, recovery
lib/interocitor-pairing.ts QR handshake only
```

Mesh IDs are not optional. Do not hardcode one Cloudflare prefix such as `/io/app-name`; use one namespace per household/workspace/device group, for example a Cloudflare adapter base URL `/sync/io/{meshId}`. Store the active mesh id locally and expose create/connect/disconnect/recover UI.

Pairing has two intents:

- **Join QR**: the unpaired device mints a fresh mesh id, creates a Cloudflare adapter with base URL `/sync/io/{meshId}`, calls `generateJoinQR()`, then receives credentials from the result's `credentials` promise after an existing device scans and pushes them.
- **Share QR**: an already-paired device calls `generateShareQR({ remotePath, passphrase })`; the new device scans and must use the credentials returned by `handleScannedQR()`.

```ts
import { decodeQRPayload, handleScannedQR, parseQRFromUrl } from '@interocitor/core';
// Or from the stable subpath:
// import { decodeQRPayload } from '@interocitor/core/handshake/qr';

const payload = parseQRFromUrl(location.hash) ?? decodeQRPayload(rawPastedPayload);
const received = await handleScannedQR({ adapter, relayBase: '/Taska', payload });

if (received) {
  if (received.passphrase) db.setPassphrase(received.passphrase);
  await connectFromPayload(received.remotePath);
}
```

`handleScannedQR()` returns `null` for join intent because the scanner pushed its own credentials. It returns credentials for share intent because the scanner received them.

## Local store

Browser runtime defaults to IndexedDB. For unrecoverable local encrypted mesh state, disconnect, detach remote storage, clear credentials, forget the local mesh id, call `resetLocalDatabase(dbName)`, then reload before creating or joining a new mesh.

## CRDT strategy

Interocitor uses per-column CRDT merge with hybrid logical clocks.

## Events

For simple snapshot UIs, refresh on `change`, `delete`, `rehydrate:complete`, and `sync:complete`. The engine also emits lifecycle and error events for reconnects, credential issues, and remote poison states.

## Demos

### Local TODO demo (WebDAV)

See `examples/todo-webdav`.

## What this is not

- not Firebase
- not a server-trusted merge layer
- not plaintext cloud sync

## Tests

Run workspace tests from the monorepo root.

## Package map

- `packages/core` — JS/TS runtime
- `packages/react` — React hooks
- `packages/interocitor-swift` — Swift runtime
- `packages/workers` — Worker-side helpers
- `packages/webdav` — WebDAV helper server

## License

MIT

