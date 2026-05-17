<p align="center">
  <a href="https://github.com/TheUiTeam/interocitor">
    <img src="https://raw.githubusercontent.com/TheUiTeam/interocitor/main/docs/assets/hero.svg" alt="interocitor" width="560"/>
  </a>
</p>

# TODO over Cloudflare Worker + D1

GitHub example directory: <https://github.com/TheUiTeam/interocitor/tree/main/examples/todo-cloudflare-do>

This example shows Interocitor mounted into an app-owned Worker under a prefix, with D1-backed transport state and the optional `InterocitorRelayDurableObject` wired for notify WebSockets.

## What is implemented

- app-owned Worker entry at `todo-interocitor.js`
- Interocitor mounted under `/todo-interocitor`
- D1-backed metadata and append-only mutation persistence
- Interocitor-native endpoints for sync flows
- `InterocitorRelayDurableObject` exported and bound as `INTEROCITOR_RELAY`
- `/todo-interocitor/notify/<namespace>` WebSocket route enabled through `relay: (env) => env.INTEROCITOR_RELAY`
- maintenance and compaction-related cleanup hooks

## Route ownership

App owns:
- `/`
- `/api/ping`

Interocitor owns:
- `/todo-interocitor/health`
- `/todo-interocitor/io/*`
- `/todo-interocitor/notify/*`
- `/todo-interocitor/__interocitor/*`

## Relay proof of work

The repository includes an opt-in e2e proof that the Durable Object relay is reachable through the mounted Worker route:

```bash
RUN_CF_EXAMPLE_TESTS=1 yarn test:e2e:cloudflare:run --grep "InterocitorRelayDurableObject"
```

That test opens:

```text
ws://127.0.0.1:<worker-port>/todo-interocitor/notify/<namespace>?access_token=<sha256(namespace + accessSecret)>
```

and expects the WebSocket to reach `open`. This proves the example exports `InterocitorRelayDurableObject`, Wrangler binds it, and `withInterocitor(..., { relay })` routes `/notify/<namespace>` into the Durable Object.

## Durable files pattern

The TODO UI intentionally stays row-only, but the Cloudflare-backed transport
also supports durable file objects under the mesh `files/` namespace. Use
rows for references and metadata; store large or binary payloads separately.

```js
const path = `tasks/${taskId}/files/${Date.now()}_${file.name}`;
await db.putFile(path, new Uint8Array(await file.arrayBuffer()), file.type);
await db.table('tasks').patch(taskId, {
  file_paths: [...(task.file_paths ?? []), path],
});
```

For image UI in React apps, render a stored image with
`useImage(db, path)` from `@interocitor/react`. For non-image attachments,
read bytes directly with `db.getFile(path)` and build your own download UI.

## Mutation policy

Normal sync writes are append-only. Administrative cleanup happens through explicit system operations so transport maintenance does not become silent mutation of application state.

## Run locally

```bash
yarn install
yarn build
yarn --cwd examples/todo-cloudflare-do db:migrate:local
yarn --cwd examples/todo-cloudflare-do dev
```

## Deploy

`wrangler.toml` points at `./todo-interocitor.js`, not directly at the package source.

```bash
yarn --cwd examples/todo-cloudflare-do deploy
```

## Related packages

- Core engine: `packages/interocitor`
- Worker runtime: `packages/interocitor-workers`
