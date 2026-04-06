# interocitor

> ☢️work in progress ☢️

Encrypted local-first CRDT database that syncs over cloud storage you already own. Google Drive is the default path; relay-server compaction is optional. No vendor lock-in.

Named after the alien communication device from *This Island Earth* (1955) — assembles itself from parts shipped separately, enables communication across any distance.

## What it does

Each device keeps a full local copy in IndexedDB. Changes sync through a shared folder on Google Drive, WebDAV (Nextcloud/ownCloud), or anything that implements the storage adapter interface.

A **mesh** is a group of devices that share data — a family's phones and laptops, a team's browsers, your own devices across platforms.

- **Offline-first** — reads and writes are instant, always local
- **Multi-device** — any number of devices in a mesh
- **Flexible deployment** — direct cloud sync by default (Google Drive); optional relay-server compaction mode
- **Encrypted** — AES-256-GCM, key never leaves devices, cloud provider sees ciphertext
- **Crash-proof** — any device can close/crash/die without corrupting shared state
- **Zero dependencies** — Web Crypto API, IndexedDB, fetch. That's it.

## Quick start

```ts
import { SyncEngine } from 'interocitor';
import { GoogleDriveAdapter } from 'interocitor/adapters/google-drive';
import { generateKey, keyToPassphrase } from 'interocitor/crypto/keys';

// 1. Pick a storage adapter
const adapter = new GoogleDriveAdapter({
  clientId: 'YOUR_GOOGLE_CLIENT_ID',
});

// 2. Create the engine
const engine = new SyncEngine(adapter, { rootPath: '/Interocitor' });

// 3. Encryption (optional but recommended)
const key = await generateKey();
const passphrase = await keyToPassphrase(key);
console.log('Share this with your mesh:', passphrase);
engine.setEncryptionKey(key);

// 4. Initialize and connect
await engine.init();    // opens local DB, loads cached state
await engine.connect(); // authenticates with cloud, syncs, starts polling

// 5. Write data
await engine.put('tasks', 'task_1', {
  title: 'Review PR #42',
  status: 'open',
  assignee: 'marina',
});

// 6. Read data
const tasks = engine.query('tasks');
const task = engine.get('tasks', 'task_1');

// 7. Listen for changes from other devices
const unsub = engine.on((event) => {
  if (event.type === 'change') {
    console.log(`Updated: ${event.table}/${event.rowId}`);
  }
});

// 8. Cleanup
await engine.disconnect();
```

## How it works

```
Device A                    Cloud Folder                   Device B
─────────                   ────────────                   ─────────
write to IDB ──┐
               ├─ flush ──► c1/clients/dev_a/2026-04-06/
               │              {hlc}-{id}.json
               │            c1/clients/dev_a/head.json
               │                                     poll ──► read head
               │                                            list date folders
               │                                            merge into IDB
               │            c1/clients/dev_b/...  ◄── flush ─┤
  poll ──► read                                              │
  merge into IDB                                             └── write to IDB
```

1. Each device writes one file per change entry under its own date-sharded folder. One device, one folder. No concurrent writes to the same file.
2. Each device polls for changes from other devices' folders, reads head files to detect new data, then downloads and merges using LWW-per-column CRDTs.
3. A Hybrid Logical Clock (HLC) provides total ordering without a time server.
4. If encryption is enabled, each change file is independently encrypted with AES-256-GCM before upload.
5. **Compaction mode is configurable**: direct-cloud meshes can compact from authorized clients, while relay-server mode centralizes compaction and garbage collection.

IndexedDB is a **cache**, not the source of truth. Browser clears it? The app rehydrates from the manifest-referenced snapshot on next open.

## Adapters

### WebDAV (Nextcloud, ownCloud, any WebDAV server)

```ts
import { WebDAVAdapter } from 'interocitor/adapters/webdav';

const adapter = new WebDAVAdapter({
  baseUrl: 'https://cloud.example.com/remote.php/dav/files/alice',
  auth: { username: 'alice', password: 'APP_PASSWORD' },
});
```

The "my own cloud" option. Runs on a $5 VPS, a Raspberry Pi, or a NAS.

### Google Drive

```ts
import { GoogleDriveAdapter } from 'interocitor/adapters/google-drive';

const adapter = new GoogleDriveAdapter({
  clientId: 'YOUR_CLIENT_ID', // from Google Cloud Console
});
```

Uses `drive.file` scope — the app can only see files it created. Mesh members share the folder via Google Drive's native sharing.

### Memory (testing)

```ts
import { MemoryAdapter } from 'interocitor/adapters/memory';

const adapter = new MemoryAdapter();
await adapter.authenticate();
```

### Full custom adapter

Plug in any backend that implements `StorageAdapter`:

```ts
import { SyncEngine, type StorageAdapter, type FileEntry } from 'interocitor';

class MyAdapter implements StorageAdapter {
  readonly name = 'my-adapter';
  // implement: authenticate, isAuthenticated, ensureFolder,
  //   listFiles, listFolders, readFile, writeFile, deleteFile, getFileMetadata
}
```

## Encryption

All encryption uses the Web Crypto API (AES-256-GCM). The key is generated on the first device and transferred to other devices via:

- **Passphrase** — ~43 character base58 string (copy-paste, read over phone, write on paper)
- **URL fragment** — `https://yourapp.com/join#key=...` (fragment never hits the server)
- **QR code** — encode either of the above

```ts
import { generateKey, keyToPassphrase, passphraseToKey } from 'interocitor/crypto/keys';

// First device generates
const key = await generateKey();
const passphrase = await keyToPassphrase(key);

// Other devices import
const sameKey = await passphraseToKey(passphrase);
engine.setEncryptionKey(sameKey);
```

The key never leaves devices. The cloud folder only contains ciphertext.

**Recovery:** If all devices lose the key, cloud data is unrecoverable. This is by design. Print the passphrase and store it somewhere safe.

## CRDT strategy

**Last-Writer-Wins per column** (LWW-Register). Each column in each row carries its own HLC timestamp. When merging, the highest HLC wins for that column independently.

```
Device A sets task.title = "Review PR" at T1
Device B sets task.status = "done" at T2

After merge: { title: "Review PR" (T1), status: "done" (T2) }
Both changes preserved — different columns.
```

Deletes are soft (tombstone). A delete with a lower HLC than a subsequent upsert loses — the row comes back. Tombstones are retained for 90 days (server GC policy).

Intentionally simple. No ordered list CRDTs, no rich text merging. For tabular data, LWW-per-column is sufficient and trivial to reason about.

## Events

```ts
engine.on((event) => {
  switch (event.type) {
    case 'change':            // row updated (local or remote)
    case 'delete':            // row deleted
    case 'sync:start':        // pull from cloud started
    case 'sync:complete':     // pull finished, N entries merged
    case 'sync:error':        // pull failed
    case 'flush:start':       // push to cloud started
    case 'flush:complete':
    case 'flush:error':
    case 'rehydrate:start':   // rebuilding from snapshot
    case 'rehydrate:complete':
    case 'auth:required':     // cloud auth needed
    case 'auth:complete':
    case 'schema:mismatch':   // remote schema is newer
  }
});
```

## Cloud folder structure

```
/Interocitor/
  manifest.json                              ← global pointer
  manifest-{generation}.json                 ← global manifest

  devices/
    dev_a1b2c3.json                          ← per-device metadata

  c1/                                        ← channel (opaque ID)
    channel.json                             ← channel pointer
    channel-manifest-{gen}-{writer}.json     ← channel manifest
    mainline/
      snapshot-{epoch}-{writer}.json         ← L2 snapshot (written by compactor)
      delta-{from}-to-{to}-{writer}.json     ← L1 delta (written by compactor)
    clients/
      dev_a1b2c3/
        head.json                            ← latest HLC, date, file count
        2026-04-05/
          {hlc}-{changeId}.json              ← L0 change file
        2026-04-06/
          {hlc}-{changeId}.json
      dev_d4e5f6/
        head.json
        2026-04-06/
          {hlc}-{changeId}.json
```

## What this is NOT

- Not a real-time collaboration tool (30-60s polling, not WebSocket)
- Not a general-purpose database (no indexes, no queries beyond full-table scan)
- Not for large binary data (designed for structured JSON records)
- Not multi-tenant (one mesh per folder, everyone sees everything)

## Browser tests (Playwright)

Playwright e2e tests run in a real browser and validate:

- manifest bootstrap and writer-authority enforcement
- Channelized file-per-change writes and cross-device sync
- Encrypted round-trip (cloud only has ciphertext)
- WebDAV adapter contract (`PROPFIND`, `MKCOL`, `GET`, `PUT`, `DELETE`)
- Multi-context WebDAV sync isolation

```bash
yarn test:e2e:install
yarn test:e2e
```

Useful variants:

```bash
yarn test:e2e:headed
yarn test:e2e:debug
```

## License

MIT
