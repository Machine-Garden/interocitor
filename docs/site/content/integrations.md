---
title: Which Interocitor packages does your app need?
description: The capability ladder from @interocitor/core through @interocitor/web to @interocitor/react, what each rung adds, and where to stop climbing.
kicker: Plan · Integrations
heading: A capability ladder: core, web, react.
lede: Three packages, one engine. Each rung adds a runtime concern on top of the one below it and never replaces the API underneath. Stop at the rung your runtime needs.
---

## Climb the ladder one rung at a time {#ladder}

Interocitor ships as a ladder rather than a bundle. The engine at the bottom is runtime-neutral. The rungs above it supply what a browser, and then a React tree, need in order to use that engine well.

| Rung | Package              | Adds                                                                                       | Stop here when                                                    |
| ---- | -------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| 1    | `@interocitor/core`  | Rows, sync, encryption, pairing, recovery, durable files, and the mailbox adapters         | The runtime supplies its own local store and key custody          |
| 2    | `@interocitor/web`   | IndexedDB local stores, browser credential custody, image helpers, and local reset helpers | The app is a browser app without React, or with another framework |
| 3    | `@interocitor/react` | Typed context, live queries and rows, image URLs, connection status, connected-store views | The app renders with React                                        |

The ladder only goes up. Every call you make on rung 3 is still a call into rung 1: hooks subscribe to the same engine, and the browser stores plug into the same `LocalStore` and credential contracts that a Node process or a test would implement itself. Nothing on a higher rung changes what the remote sees, which is described in [security](/security).

## Rung 1: core is the engine {#core}

Core owns everything that makes a mesh a mesh: the row CRDT, the sync protocol, client-side encryption, pairing, recovery phrases, path-addressed durable files, and the contracts for a local store and a remote adapter. Mailbox adapters for memory, WebDAV, Google Drive, and the Cloudflare worker are separate entry points of this package, so an app imports only the backend it uses.

Core asks for two things explicitly and refuses to guess either. A `localStore` says where plaintext rows live. A `keySource` says who holds the mesh key, and `null` is a deliberate answer that creates an unencrypted mesh. A remote adapter and `remotePath` are needed only for sync and files.

```ts
import { Interocitor, MemoryLocalStore, PortablePassphraseKeySource } from "@interocitor/core";
import { MemoryAdapter } from "@interocitor/core/adapters/memory";

const db = new Interocitor(new MemoryAdapter(), {
  dbName: "my-app",
  remotePath: "/MyApp",
  localStore: new MemoryLocalStore(),
  keySource: new PortablePassphraseKeySource(),
});

await db.init();
await db.table("todos").add({ text: "Ship privacy-first sync", done: false });
await db.connect();
```

Stay on this rung when the runtime is not a browser. A Node worker, a script, or an [agent](/automation) implements the public `LocalStore` contract or accepts the volatile memory store, keeps the portable key in its own credential store, and joins the mesh as one more trusted endpoint. Tests and Storybook stories also stay here: a memory store with a null key source exercises the real engine without a server.

What core does not do is choose for you. There is no IndexedDB, no browser credential storage, and no image handling, because each of those is a runtime decision with a custody consequence, and that is what the next rung is for.

## Rung 2: web is the browser {#web}

Web is where most browser applications start. It does not wrap the engine. It supplies the pieces a browser normally wires into it, each an implementation of a contract core already defines.

- **Local stores.** `IndexedDbLocalStore` persists rows, outbox, cursors, and metadata. A resilient variant keeps the app opening when IndexedDB is blocked or wedged, falling back to memory and reporting the degradation. A named variant rotates the physical database name for reset and recovery flows.
- **Credential custody.** `createWebCredentialStore` chooses where the mesh credential record lives: the tab session, memory only, plaintext `localStorage`, or a WebAuthn passkey `largeBlob`. An envelope mode lets the record come from a backend or native storage while unwrapping requires a passkey ceremony. These are the custody choices [trust and key custody](/trust#custody) asks you to make on purpose.
- **Additional app keys.** `createWebSecretStore` holds a separate secret per namespace, in browser storage or behind platform or cross-platform WebAuthn, for cases such as a record-seal key or an outbound signer.
- **Images and reset.** `putImage` and `getImageBlobUrl` move image files through the core file API and hand back revokable `blob:` URLs. Reset helpers delete the local database with a deadline and report whether another tab blocked it.

```ts
import { Interocitor, PortablePassphraseKeySource } from "@interocitor/core";
import { WebDAVAdapter } from "@interocitor/core/adapters/webdav";
import { IndexedDbLocalStore, createWebCredentialStore } from "@interocitor/web";

const dbName = "case-vault";

const db = new Interocitor(new WebDAVAdapter({ baseUrl: "/webdav", auth: { token } }), {
  dbName,
  remotePath: "/CaseVault",
  localStore: new IndexedDbLocalStore(dbName),
  keySource: new PortablePassphraseKeySource({
    portableKey,
    credentialStore: createWebCredentialStore(dbName, {
      storage: "sessionStorage",
    }),
  }),
});

await db.init();
await db.connect();
```

The engine API is unchanged. `db.table`, `db.putFile`, `db.subscribe`, and the lifecycle are the same calls as on rung 1, now backed by storage that survives a reload and a credential record whose custody boundary you named.

Stay on this rung when the app is a browser app that is not React, or when it uses another framework's reactivity. Core's `subscribe` and `observeChanges` are enough to drive any view layer.

## Rung 3: react is the bindings {#react}

React is bindings only. It does not construct, initialize, configure, or connect the engine. App code still builds the engine from the two rungs below, calls `init()` and `connect()`, and then hands the initialized engine to a provider.

```tsx
import { createInterocitorContext, useLiveQuery, useRow } from "@interocitor/react";

export const [InterocitorProvider, useDb] = createInterocitorContext<DB>();

function TaskList({ weekId }: { weekId: string }) {
  const db = useDb();
  const { data, loading } = useLiveQuery(
    () => db.table("tasks").where("weekId").equals(weekId),
    [db, weekId],
  );
  if (loading) return <span>Loading…</span>;
  return (
    <ul>
      {data?.map((task) => (
        <li key={task.id}>{task.title}</li>
      ))}
    </ul>
  );
}
```

What the rung adds is subscription, not capability:

- **Typed context.** One provider and hook pair captures the schema type so components need no generics.
- **Live data.** `useLiveQuery` and `useRow` subscribe to the core query cache. Cached rows stay visible during a refresh, and descriptors share one in-flight load across components.
- **Images.** `useImage` wraps the web package's blob URL helper and revokes URLs on unmount and path change.
- **Status.** `useConnectionStatus` reports offline, connecting, syncing, or idle. `useIsSolo` is the separate no-mesh gate for a setup screen.
- **Connected stores.** `useConnectedStores` and `useConnectedStore` read and manage the credentials of related meshes, the scaling pattern [data boundaries](/data-boundaries) describes.

Mutations have no React wrapper because they need none. `db.table("tasks").patch(id, { done: true })` writes locally first, syncs in the background, and every live query on that table updates from engine events.

Hooks work against local state as soon as `init()` has run, so a stalled `connect()` degrades to offline-ready rather than to a blank screen. The banner that explains that is the app's to render.

## Step off the ladder for other runtimes {#other-runtimes}

The ladder is the TypeScript path. Two other runtimes implement the same protocol at rung 1 and join the same meshes:

- **Python** is an async implementation for headless workers and automation. Its default local store is memory-only, so a short-lived worker treats the remote mesh as its durable state and flushes before it reports success.
- **Swift** keeps reads, writes, merge, and decryption on an Apple device, with WebDAV and Cloudflare adapters for the mailbox.

The Cloudflare worker is not a rung. It is a mailbox that a core adapter talks to, and it admits, meters, and audits without reading rows. [Mailbox operations](/mailbox) covers choosing and running it.

## Decision summary {#summary}

| Your runtime                  | Install                                                         | You supply                                                    |
| ----------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------- |
| Node worker, script, or agent | `@interocitor/core`                                             | A `LocalStore` or the memory store, key custody, an adapter   |
| Unit tests and Storybook      | `@interocitor/core`                                             | `MemoryLocalStore` and `keySource: null`                      |
| Browser app without React     | `@interocitor/core` + `@interocitor/web`                        | A credential custody choice and a view layer over `subscribe` |
| React app                     | `@interocitor/core` + `@interocitor/web` + `@interocitor/react` | An initialized engine handed to the provider                  |
| Python worker or Apple app    | The Python or Swift package                                     | The same key and mailbox as the TypeScript endpoints          |

Whatever rung you stop on, the engine is the same, and so is the boundary: the remote stores what it cannot read, and the endpoints that hold the key hold everything.
