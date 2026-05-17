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
yarn add @interocitor/react @interocitor/core react
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

const db = new Interocitor<DB>({
  appName: 'My App',
  dbName: 'my-app',
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

Display encrypted images stored with `db.putImage(...)` or `db.putFile(..., 'image/*')`.

```tsx
function Avatar({ path }: { path?: string }) {
  const db = useDb();
  const image = useImage(db, path);

  if (image.loading) return <span>Loading…</span>;
  if (image.error) return <span>Image unavailable</span>;
  if (!image.url) return null;

  return <img src={image.url} alt="" />;
}
```

`useImage` returns `{ url, blob, loading, error, metadata, contentType, revoke }`.
It automatically revokes the previous `blob:` URL on unmount and path changes. Call `image.revoke()` if you want to clear the current URL earlier.

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
