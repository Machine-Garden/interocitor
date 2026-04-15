<p align="center">
  <a href="https://github.com/TheUiTeam/interocitor">
    <img src="https://raw.githubusercontent.com/TheUiTeam/interocitor/main/docs/assets/hero.svg" alt="interocitor" width="560"/>
  </a>
</p>

# TODO over Cloudflare Worker + D1

GitHub example directory: <https://github.com/TheUiTeam/interocitor/tree/main/examples/todo-cloudflare-do>

This example shows Interocitor mounted into an app-owned Worker under a prefix, with D1-backed transport state and no Durable Objects.

## What is implemented

- app-owned Worker entry at `todo-interocitor.js`
- Interocitor mounted under `/todo-interocitor`
- D1-backed metadata and append-only mutation persistence
- Interocitor-native endpoints for sync flows
- maintenance and compaction-related cleanup hooks

## Route ownership

App owns:
- `/`
- `/api/ping`

Interocitor owns:
- `/todo-interocitor/health`
- `/todo-interocitor/io/*`
- `/todo-interocitor/__interocitor/*`

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
