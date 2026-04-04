# interocitor

> ☢️work in progress ☢️

Encrypted local-first CRDT database that syncs over cloud storage you already own. No server. No vendor cloud. No subscription.

Named after the alien communication device from *This Island Earth* (1955) — assembles itself from parts shipped separately, enables communication across any distance.

## What it does

Each device keeps a full local copy in IndexedDB. Changes sync through a shared folder on Google Drive, Dropbox, WebDAV (Nextcloud/ownCloud), or anything that implements the storage adapter interface.

A **mesh** is a group of devices that share data — a family's phones and laptops, a team's browsers, your own devices across platforms.

- **Offline-first** — reads and writes are instant, always local
- **Multi-device** — any number of devices in a mesh
- **No server** — cloud storage is a dumb file transport, not a runtime dependency
- **Encrypted** — AES-256-GCM, key never leaves devices, cloud provider sees ciphertext
- **Crash-proof** — any device can close/crash/die without corrupting shared state
- **Zero dependencies** — Web Crypto API, IndexedDB, fetch. That's it.

## Quick start

```ts
import { SyncEngine, GoogleDriveAdapter, generateKey, keyToPassphrase } from 'interocitor';

// 1. Pick a storage adapter
const adapter = new GoogleDriveAdapter({ clientId: 'YOUR_GOOGLE_CLIENT_ID' });

// 2. Create the engine
const engine = new SyncEngine(adapter, { rootPath: '/Interocitor' });

// 3. Encryption (optional but recommended)
const key = await generateKey();
const passphrase = await keyToPassphrase(key);
console.log('Share this with your mesh:', passphrase);
// → something like "5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ"
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
               ├─ flush ──► changes/dev_a.ndjson
               │                                    poll ──► read
               │                                           merge into IDB
               │            changes/dev_b.ndjson ◄── flush ─┤
  poll ──► read                                             │
  merge into IDB                                            └── write to IDB
```

1. Each device writes to its own NDJSON file in the cloud folder. One device, one file. No concurrent writes to the same file.
2. Each device polls for changes from other devices' files, downloads new entries, and merges them using LWW-per-column CRDTs.
3. A Hybrid Logical Clock (HLC) provides total ordering without a time server.
4. If encryption is enabled, each NDJSON line is independently encrypted with AES-256-GCM before upload.

IndexedDB is a **cache**, not the source of truth. Browser clears it? The app rehydrates from cloud on next open.

## Adapters

### Google Drive

```ts
import { GoogleDriveAdapter } from 'interocitor';

const adapter = new GoogleDriveAdapter({
  clientId: 'YOUR_CLIENT_ID', // from Google Cloud Console
});
```

Uses `drive.file` scope — the app can only see files it created. Mesh members share the folder via Google Drive's native sharing.

### WebDAV (Nextcloud, ownCloud, any WebDAV server)

```ts
import { WebDAVAdapter } from 'interocitor';

const adapter = new WebDAVAdapter({
  baseUrl: 'https://cloud.example.com/remote.php/dav/files/username',
  auth: { username: 'user', password: 'pass' },
});
```

The "my own cloud" option. Runs on a $5 VPS, a Raspberry Pi, or a NAS.

### Memory (testing)

```ts
import { MemoryAdapter } from 'interocitor';

const adapter = new MemoryAdapter();
await adapter.authenticate();
```

### Write your own

Implement the `StorageAdapter` interface:

```ts
interface StorageAdapter {
  readonly name: string;
  authenticate(): Promise<void>;
  isAuthenticated(): boolean;
  ensureFolder(path: string): Promise<void>;
  listFiles(path: string): Promise<FileEntry[]>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  getFileMetadata(path: string): Promise<FileEntry | null>;
}
```

Dropbox, OneDrive, S3-compatible, or a REST API on your own server — anything that can read/write files.

## Encryption

All encryption uses the Web Crypto API (AES-256-GCM). The key is generated on the first device and transferred to other devices via:

- **Passphrase** — ~43 character base58 string (copy-paste, read over phone, write on paper)
- **URL fragment** — `https://yourapp.com/join#key=...` (fragment never hits the server)
- **QR code** — encode either of the above

```ts
import { generateKey, keyToPassphrase, passphraseToKey } from 'interocitor';

// First device generates
const key = await generateKey();
const passphrase = await keyToPassphrase(key);

// Other devices import
const sameKey = await passphraseToKey('5HueCGU8rMjxEXxi...');
engine.setEncryptionKey(sameKey);
```

The key never leaves devices. The cloud folder only contains ciphertext. Google/Dropbox/your WebDAV server cannot read your data.

**Recovery:** If all devices lose the key, cloud data is unrecoverable. This is by design. Print the passphrase and store it somewhere safe.

## Compaction & Migration

Change logs grow forever. Compaction writes a snapshot and deletes old logs. Migration is compaction with a transform function — same code path:

```ts
// Simple compaction
await engine.compact();

// Migration: rename a column
await engine.compact((table, row) => {
  if (table === 'tasks' && row['status_code']) {
    row['status'] = row['status_code'];
    delete row['status_code'];
  }
  return row;
});
```

Compaction bumps the epoch. Migration also bumps the schema version. Devices on old app versions see the version mismatch and prompt to update.

## CRDT strategy

**Last-Writer-Wins per column** (LWW-Register). Each column in each row carries its own HLC timestamp. When merging, the highest HLC wins for that column independently.

```
Device A sets task.title = "Review PR" at T1
Device B sets task.status = "done" at T2

After merge: { title: "Review PR" (T1), status: "done" (T2) }
Both changes preserved — different columns.
```

Deletes are soft (tombstone). A delete with a lower HLC than a subsequent upsert loses — the row comes back. Tombstones are cleaned up during compaction after 30 days.

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
    case 'compact:start':
    case 'compact:complete':
    case 'auth:required':     // cloud auth needed
    case 'auth:complete':
    case 'schema:mismatch':   // remote schema is newer
  }
});
```

## Cloud folder structure

```
/Interocitor/
  manifest.json              ← cleartext (schema version, mesh ID, encrypted flag)
  changes/
    dev_a1b2c3.ndjson        ← device A's change log (encrypted if enabled)
    dev_d4e5f6.ndjson        ← device B's change log
  snapshots/
    latest.json              ← compacted state (encrypted if enabled)
```

## What this is NOT

- Not a real-time collaboration tool (30-60s polling, not WebSocket)
- Not a general-purpose database (no indexes, no queries beyond full-table scan)
- Not for large binary data (designed for structured JSON records)
- Not multi-tenant (one mesh per folder, everyone sees everything)

## Browser tests (Playwright)

Playwright e2e tests run in a real browser and validate:

- IndexedDB-backed `SyncEngine` behavior
- `WebDAVAdapter` network flow (`PROPFIND`, `MKCOL`, `GET`, `PUT`, `DELETE`)

Google Drive is intentionally excluded from e2e tests in this phase.

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
