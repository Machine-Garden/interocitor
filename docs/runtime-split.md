# Runtime Split

## Core

`@interocitor/core` is runtime-neutral. It owns the CRDT engine, sync protocol,
encryption, row APIs, byte-oriented file APIs, mailbox adapters, storage
contracts, and in-memory test/dev implementations.

Core does not create a browser local store. `SyncConfig.localStore` is required,
and runtimes must pass an implementation of the `LocalStore` contract.

Core exports:

- `Interocitor`
- `LocalStore`
- `MemoryLocalStore`
- `MemoryAdapter`
- `WebDAVAdapter`
- `GoogleDriveAdapter`
- `CloudflareAdapter`
- `CredentialStore` and `StoredCredentials` interfaces
- remote `StorageAdapter` contract and protocol types

## Web

`@interocitor/web` owns browser behavior:

- `IndexedDbLocalStore`
- resilient and named IndexedDB wrappers
- IndexedDB reset helpers
- `LocalStorageCredentialStore`
- `WebAuthnCredentialStore`
- `createWebCredentialStore`
- browser image helpers: `putImage`, `getImage`, `getImageBlobUrl`
- React image hook at `@interocitor/web/react`

Browser apps compose core explicitly:

```ts
import { Interocitor, WebDAVAdapter } from '@interocitor/core';
import {
  IndexedDbLocalStore,
  createWebCredentialStore,
} from '@interocitor/web';

const db = new Interocitor(new WebDAVAdapter({ baseUrl, auth }), {
  remotePath: '/Interocitor',
  localStore: new IndexedDbLocalStore('my-app'),
  credentialStore: createWebCredentialStore('my-app', 'My App'),
});
```

## Planned Node Package

`@interocitor/node` should be a local runtime package, not a backend package.
It should expose explicit Node building blocks first:

- `NodeSqliteLocalStore`, using `node:sqlite` and requiring Node 24 LTS+
- file credential stores for passphrase/device/mesh anchors
- optional composition helpers only after patterns are proven

Do not add a one-line `createNodeInterocitor` default yet.

SQLite is the durable local cache/outbox/meta backend. It should satisfy the
same `LocalStore` contract tests as `MemoryLocalStore` and `IndexedDbLocalStore`,
including rows, tombstones, queries, outbox FIFO/drain, cursors, meta,
`clearAll`, and reopen persistence.

## Markdown Knowledge Folder

Markdown support should live above core rows/files as a Node-side domain
adapter, e.g. `MarkdownKnowledgeFolder`.

The bridge maps human-authored notes to Interocitor data:

- notes become rows in a reserved schema such as `notes`
- stable note identity lives in frontmatter, not only file path
- body, title, frontmatter, links, path, mtime/hash, and deletion state become
  row fields
- attachments/assets use core file APIs

The bridge owns filesystem concerns:

- initial scan imports notes inside `db.batch(...)`
- watcher detects local edits and writes row updates
- Interocitor change events materialize remote edits back to `.md`
- echo suppression uses stored file hashes/mtimes in bridge metadata

For v1 conflicts, if both local file and remote row changed since the last
bridge checkpoint, write a conflict sibling file and keep both versions. Core
must not know about Markdown-specific conflicts.
