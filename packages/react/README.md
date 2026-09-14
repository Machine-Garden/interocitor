<p align="center">
  <a href="https://github.com/Machine-Garden/interocitor">
    <img src="https://raw.githubusercontent.com/Machine-Garden/interocitor/main/docs/assets/hero.svg" alt="Interocitor" width="560"/>
  </a>
</p>

# @interocitor/react

React bindings for Interocitor.

Bindings only. The React package does not create, initialize, configure, or
connect the engine. App code owns the normal order:

- construct the engine with its local store, key source, and optional remote
  adapter and path
- call `init()`
- call `connect()` when remote sync is configured
- provide the initialized engine to React

When pairing or backend discovery supplies mesh state after construction, call
`configureMesh(...)` before `init()` and attach the adapter with
`setRemoteStorage(...)` before connecting. A constructor
`resolveInitialState` callback can supply the same initialization-time mesh
state.

`connect()` is opportunistic: if cloud setup stalls, core may return in
offline-ready mode. React hooks still work against local state after
`init()`; app bootstrap/UI owns any `onLocalDegraded` or
`onConnectStalled` banner.

The package covers typed context, live queries and rows, image blob URLs,
connection status, and connected-store credential views. It does not wrap
mutations or own engine lifecycle.

## Build the public release

```bash
yarn install
yarn workspace @interocitor/core build
yarn workspace @interocitor/web build
yarn workspace @interocitor/react build
```

The `0.1.0` React package depends on matching monorepo
workspaces. Build the public repository release with the commands above.

The shell commands above are runnable from the repository root. TypeScript and
TSX blocks below are partial component fragments; they assume the
application's schema, initialized engine, provider, component props, and
surrounding error handling.

## Public API

Documented entrypoints in this package:

| API                                       | Use when                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| `createInterocitorContext`                | You want one typed provider/hook pair for the engine                           |
| `useLiveQuery`                            | A component should subscribe to a live query cache entry                       |
| `useRow`                                  | A component should subscribe to one live row                                   |
| `useImage`                                | A component should render an Interocitor image file as a revokable `blob:` URL |
| `useConnectionStatus`, `useIsSolo`        | UI should reflect transport state vs local-only mode                           |
| `useConnectedStores`, `useConnectedStore` | UI should read or manage connected-store credentials                           |

The package root also exports `UseLiveQueryResult`, `UseRowResult`,
`UseImageResult`, `UseConnectedStoresResult`, `UseConnectedStoreResult`,
`ConnectionStatus`, and `ConnectionStatusDetails`.

## Typed context

Capture DB types once. No generics in components.

```ts
import { createInterocitorContext } from "@interocitor/react";
import type { InferSchemaType } from "@interocitor/core";

const schema = {
  tables: {
    tasks: {
      fields: {
        title: types.string,
        done: types.boolean,
      },
    },
  },
} satisfies DatabaseSchemaDefinition;

type DB = InferSchemaType<typeof schema>;

export const [InterocitorProvider, useDb] = createInterocitorContext<DB>();
```

The generated hook throws if it is called outside its matching provider. Create
the pair once at app level and provide an initialized engine.

For a display-only application, select the reader capability when creating the
context. The provider then accepts `InterocitorReader`, and the generated hook
returns reader tables without mutation methods:

```tsx
import type { InterocitorReader } from "@interocitor/core";

export const [FamilyViewProvider, useFamilyView] = createInterocitorContext<DB>({ mode: "reader" });

declare const reader: InterocitorReader<DB>;

<FamilyViewProvider value={reader}>
  <App />
</FamilyViewProvider>;
```

`useLiveQuery`, `useRow`, `useImage`, `useConnectionStatus`, `useIsSolo`, and
`useRemoteAccess` accept the reader. Connected-store credential hooks remain a
read/write-engine surface. The application still constructs, initializes, and
connects the reader outside React.

```ts
import { Interocitor, PortablePassphraseKeySource } from "@interocitor/core";
import { IndexedDbLocalStore, createWebCredentialStore } from "@interocitor/web";

const dbName = "my-app";
const portableKey = "...high-entropy-base58...";

const db = new Interocitor<DB>(adapter, {
  dbName,
  remotePath: "/MyApp",
  localStore: new IndexedDbLocalStore(dbName),
  keySource: new PortablePassphraseKeySource({
    portableKey,
    credentialStore: createWebCredentialStore(dbName, { storage: "sessionStorage" }),
  }),
});
await db.init();
await db.connect(); // starts remote sync; may return offline-ready on stalled cloud setup
```

```tsx
<InterocitorProvider value={db}>
  <App />
</InterocitorProvider>
```

## useConnectionStatus

Expose a small user-facing connection model from the engine.

```tsx
const solo = useIsSolo(db);
const status = useConnectionStatus(db);

if (solo) return <SetupMeshButton />;
if (status === "connecting") return <span>Connecting…</span>;
if (status === "syncing") return <span>Syncing…</span>;
if (status === "offline") return <span>Offline — changes will sync later</span>;
return <span>Up to date</span>;
```

`useConnectionStatus` returns only communication state: `offline`,
`connecting`, `syncing`, or `idle`. `useIsSolo` is the separate no-mesh
boolean gate. If a component needs nuance, read it imperatively from core
with `db.getConnectionStatusDetails()`.

## useLiveQuery

Factory + deps. React-first. No render loop.

```tsx
const { data, loading, error } = useLiveQuery(() => db.table("tasks").query(), [db]);
```

Filtered query:

```tsx
const { data } = useLiveQuery(
  () => db.table("receipts").where("weekId").equals(weekId).orderBy("uploadedAt", "desc"),
  [db, weekId],
);
```

Selector:

```tsx
const { data: weekIds } = useLiveQuery(
  () => db.table("weekPlans").query(),
  [db],
  (plans) => plans.map((plan) => plan.weekId),
);
```

Dependencies have the same semantics as `useMemo`: include every reactive
value captured by the factory. Query descriptors share the core cache and
in-flight load across components. During refresh, cached rows remain visible;
`loading` is true only when there is no cached value yet. `data` is `undefined`
until the first fetch resolves.

## useRow

```tsx
const { data: task } = useRow(db.table("tasks"), taskId);
```

Advanced factory form and selector:

```tsx
const { data: title } = useRow(
  () => db.table("tasks").row(taskId),
  [db, taskId],
  (task) => task?.title ?? "",
);
```

`data` is `undefined` until the first fetch resolves, or if the row does not
exist. Passing `undefined` as the table-form row ID skips the read and returns
`{ data: undefined, loading: false, error: null }`. Rows use the same
core-owned cache and stale-while-revalidate behavior as live queries.

## useImage

Display image files stored with `@interocitor/web`'s `putImage(...)` or
`db.putFile(..., 'image/*')`.

`useImage` is image-oriented UI sugar over `@interocitor/web`'s
`getImageBlobUrl(db, path)`. It is not a generic attachment downloader: use
`db.getFile(path)` for non-image files or custom download flows.

```tsx
function Avatar({ userId }: { userId: string }) {
  const db = useDb();
  const user = useRow(db.table("users"), userId);
  const image = useImage(db, user.data?.avatar_path);

  if (user.loading || image.loading) return <span>Loading…</span>;
  if (image.error) return <span>Image unavailable</span>;
  if (!image.url) return null;

  return <img src={image.url} alt="" />;
}
```

Upload pattern:

```tsx
import { putImage } from "@interocitor/web";

const path = `users/${userId}/avatar`;
await putImage(db, path, file);
await db.table("users").patch(userId, { avatar_path: path });
```

`useImage` returns `{ url, blob, loading, error, metadata, contentType, revoke }`.
It automatically revokes the previous `blob:` URL on unmount and path changes. Call `image.revoke()` if you want to clear the current URL earlier. If loading is cancelled after the blob URL is created, the hook revokes it immediately.

Image bytes are encrypted before remote storage only when the supplied engine
uses an encrypted key source. `useImage` does not add encryption.

## Connected stores

```tsx
const { credentials, loading, error, refresh, get, put, remove } = useConnectedStores(db);
```

`useConnectedStores` performs an initial list. Successful `put` and `remove`
calls refresh the list; `get` reads one entry without refreshing it.

```tsx
const store = useConnectedStore(db, storeId);
```

`useConnectedStore` fetches on mount and when `db` or `storeId` changes.
Connected-store credentials have no change-notification stream, so mutations
elsewhere are not observed automatically; call `store.refresh()`.

## Testing

For React unit tests, component tests, and Storybook stories, use
an initialized `Interocitor` with `MemoryLocalStore` and `keySource: null` in
the provider. That exercises the real hooks without an Interocitor server.
Use browser storage or remote-sync integration only when the behavior under
test needs it. See [Test an Interocitor product](../core/docs/testing.md).

## Mutations

No React wrapper needed.

```tsx
await db.table("tasks").add({ title: "Ship it", done: false });
await db.table("tasks").patch(taskId, { done: true });
await db.table("tasks").replace(taskId, fullTask);
await db.table("tasks").delete(taskId);
```

Interocitor writes locally first, then syncs in background. Live queries update automatically from engine events.

## Validate the package

These commands are runnable from the repository root after `yarn install`:

```bash
yarn workspace @interocitor/react check
yarn workspace @interocitor/react build
yarn workspace @interocitor/react test:e2e
```

The runtime suite builds the matching core, web, and React workspaces before
exercising the package through its public entry point.

## License

MIT
