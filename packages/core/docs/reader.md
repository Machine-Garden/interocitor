# Read an existing mesh without joining it

Use `InterocitorReader` for a process or display that consumes current mesh
state but must never become a device. Typical examples are a one-shot Node.js
render, an export command, or a wall-mounted family dashboard with no editing
controls.

The reader uses the normal optimized receive path: local rows and exact
change-file receipts live in the supplied `LocalStore`, unseen change bodies
are prefetched and merged, and polling or adapter invalidations keep a
long-running view current. The difference is outbound capability. A reader
does not generate a device UUID, create mailbox folders or manifests, publish
device metadata or acknowledgements, flush changes, compact, or write durable
files. Its adapter is guarded at runtime so an accidental outbound call fails
before reaching storage.

## Read once from Node.js

With no `localStore`, the reader uses a volatile in-memory cache. Supply the
same schema and mesh key used by writers. This illustrative TypeScript omits
the surrounding process configuration and error reporting.

```ts
import { InterocitorReader, PortablePassphraseKeySource } from "@interocitor/core";
import { CloudflareAdapter } from "@interocitor/core/adapters/cloudflare";

const reader = new InterocitorReader(
  new CloudflareAdapter({
    baseUrl: process.env.INTEROCITOR_IO_URL!,
    token: process.env.INTEROCITOR_TOKEN!,
  }),
  {
    remotePath: process.env.INTEROCITOR_REMOTE_PATH!,
    keySource: new PortablePassphraseKeySource({
      portableKey: process.env.INTEROCITOR_PORTABLE_KEY!,
      generateIfMissing: false,
    }),
  },
);

await reader.connect();
try {
  const tasks = await reader.table("tasks").query();
  console.log(tasks);
} finally {
  await reader.disconnect();
}
```

The mesh must already exist. A missing manifest or missing encryption key is
an error rather than an invitation to bootstrap new state.

## Keep a browser display current

Use a durable browser `LocalStore` so reloads retain the row cache and exact
change-file ledger. This illustrative TypeScript assumes the application has
already created its adapter and obtained its portable mesh key:

```ts
import { InterocitorReader, PortablePassphraseKeySource } from "@interocitor/core";
import { IndexedDbLocalStore } from "@interocitor/web";

const reader = new InterocitorReader(adapter, {
  dbName: "taska-family-view",
  remotePath: "/TaskaFamily",
  localStore: new IndexedDbLocalStore("taska-family-view-reader"),
  keySource: new PortablePassphraseKeySource({ portableKey, generateIfMissing: false }),
});

await reader.connect();
```

Use a database name dedicated to the reader. If its local store contains a
pending batch or outbox entries from a read/write engine, connection fails
instead of publishing or silently discarding them.

`table()` returns `ReadonlyTable`: `row`, `query`, `where`, and `subscribe` are
available, while `add`, `put`, `patch`, `replace`, and `delete` do not exist.
The reader also exposes `getFile`, `openFile`, and `getFileMetadata`, but not
file upload or deletion.

For React, create the context with `{ mode: "reader" }`; the ordinary live
query, row, image, and connection-status hooks accept the resulting reader.

## Security and freshness boundary

Identityless means no Interocitor device record. The transport can still
identify the HTTP or storage principal, and any endpoint holding the mesh key
can decrypt the entire mesh. A reader may retain plaintext in its local cache.

Readers do not acknowledge compaction and never delay it. After a compaction,
the next pull restores the current snapshot and then merges every uncovered
change. A completed pull represents the objects the mailbox exposed during
that read; storage can still withhold or roll back data as described in the
[security model](security-model.md).
