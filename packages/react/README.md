<p align="center">
  <a href="https://github.com/TheUiTeam/interocitor">
    <img src="https://raw.githubusercontent.com/TheUiTeam/interocitor/main/docs/assets/hero.svg" alt="interocitor" width="560"/>
  </a>
</p>

# @interocitor/react

React bindings for Interocitor.

Bindings only. React package does not create, init, configure, or connect the engine for you.
App code owns order:
- create engine
- `configureMesh(...)` or `resolveInitialState(...)`
- `setRemoteStorage(...)`
- `init()`
- optionally call `connect()` to start remote sync
- provide the initialized engine to React

`connect()` is opportunistic: if cloud setup stalls, core may return in
offline-ready mode. React hooks still work against local state after
`init()`; app bootstrap/UI owns any `onLocalDegraded` or
`onConnectStalled` banner.

Low-level primitives:
- typed React context factory
- live query hook
- live row hook
- image blob URL hook

## Install

```bash
yarn add @interocitor/react @interocitor/core @interocitor/web react
```

## Typed context

Capture DB types once. No generics in components.

```ts
import { createInterocitorContext } from '@interocitor/react';
import type { InferSchemaType } from '@interocitor/core';

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

```ts
import { Interocitor } from '@interocitor/core';
import { IndexedDbLocalStore } from '@interocitor/web';

const db = new Interocitor<DB>({
  dbName: 'my-app',
  localStore: new IndexedDbLocalStore('my-app'),
});

db.configureMesh({
  remotePath: '/MyApp',
  passphrase,
  encrypted: true,
});

await db.setRemoteStorage(adapter);
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
if (status === 'connecting') return <span>Connecting…</span>;
if (status === 'syncing') return <span>Syncing…</span>;
if (status === 'offline') return <span>Offline — changes will sync later</span>;
return <span>Up to date</span>;
```

`useConnectionStatus` returns only communication state: `offline`,
`connecting`, `syncing`, or `idle`. `useIsSolo` is the separate no-mesh
boolean gate. If a component needs nuance, read it imperatively from core
with `db.getConnectionStatusDetails()`.

## useLiveQuery

Factory + deps. React-first. No render loop.

```tsx
const { data, loading, error } = useLiveQuery(
  () => db.table('tasks').query(),
  [],
);
```

Filtered query:

```tsx
const { data } = useLiveQuery(
  () => db.table('receipts').where('weekId').equals(weekId).orderBy('uploadedAt', 'desc'),
  [weekId],
);
```

Selector:

```tsx
const { data: weekIds } = useLiveQuery(
  () => db.table('weekPlans').query(),
  [],
  plans => plans.map(plan => plan.weekId),
);
```

`data` is `undefined` until the first fetch resolves.

## useRow

```tsx
const { data: task } = useRow(db.table('tasks'), taskId);
```

`data` is `undefined` until the first fetch resolves, or if the row does not exist.

## useImage

Display image files stored with `@interocitor/web`'s `putImage(...)` or
`db.putFile(..., 'image/*')`.

`useImage` is image-oriented UI sugar over `@interocitor/web`'s
`getImageBlobUrl(db, path)`. It is not a generic attachment downloader: use
`db.getFile(path)` for non-image files or custom download flows.

```tsx
function Avatar({ userId }: { userId: string }) {
  const db = useDb();
  const user = useRow(db.table('users'), userId);
  const image = useImage(db, user.data?.avatar_path);

  if (user.loading || image.loading) return <span>Loading…</span>;
  if (image.error) return <span>Image unavailable</span>;
  if (!image.url) return null;

  return <img src={image.url} alt="" />;
}
```

Upload pattern:

```tsx
import { putImage } from '@interocitor/web';

const path = `users/${userId}/avatar`;
await putImage(db, path, file);
await db.table('users').patch(userId, { avatar_path: path });
```

`useImage` returns `{ url, blob, loading, error, metadata, contentType, revoke }`.
It automatically revokes the previous `blob:` URL on unmount and path changes. Call `image.revoke()` if you want to clear the current URL earlier. If loading is cancelled after the blob URL is created, the hook revokes it immediately.

## Mutations

No React wrapper needed.

```tsx
await db.table('tasks').add({ title: 'Ship it', done: false });
await db.table('tasks').patch(taskId, { done: true });
await db.table('tasks').replace(taskId, fullTask);
await db.table('tasks').delete(taskId);
```

Interocitor writes locally first, then syncs in background. Live queries update automatically from engine events.

## License

MIT
