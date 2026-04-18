<p align="center">
  <a href="https://github.com/TheUiTeam/interocitor">
    <img src="https://raw.githubusercontent.com/TheUiTeam/interocitor/main/docs/assets/hero.svg" alt="interocitor" width="560"/>
  </a>
</p>

# @interocitor/react

React bindings for Interocitor.

Low-level primitives:
- typed React context factory
- live query hook
- live row hook

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
  version: 1,
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
