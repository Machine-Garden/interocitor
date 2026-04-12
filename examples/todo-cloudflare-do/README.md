<p align="center">
  <a href="https://github.com/TheUiTeam/interocitor">
    <img src="https://raw.githubusercontent.com/TheUiTeam/interocitor/main/docs/assets/hero.svg" alt="interocitor" width="560"/>
  </a>
</p>

# TODO over Cloudflare Worker + Durable Objects

GitHub example directory: <https://github.com/TheUiTeam/interocitor/tree/main/examples/todo-cloudflare-do>

This example shows the Cloudflare-hosted version of the same Interocitor promise: the server can coordinate transport, but it still should not be able to read your data.

## Why this example exists

The WebDAV example proves the model with a very dumb mailbox. This example proves the model can still hold when the transport gets smarter.

Here Cloudflare provides ordering, fanout, persistence, and maintenance behavior. But merge and decryption stay on the client. That is the line Interocitor is trying not to cross.

## What role do Durable Objects play here

Durable Objects provide per-prefix coordination for request ordering and server-sent event fanout. They are transport coordinators, not document interpreters.

## What is implemented

- Durable Object for per-prefix request ordering and SSE fanout
- D1-backed metadata and append-only mutation persistence
- Interocitor-native endpoints for sync flows
- maintenance and compaction-related cleanup hooks

## API shape

This example exposes Interocitor-native transport endpoints rather than generic WebDAV.

## Mutation policy (append-only + system endpoint)

Normal sync writes are append-only. Administrative cleanup happens through explicit system operations so transport maintenance does not become silent mutation of application state.

### System op: prune-compacted-changes

Used to prune changes that are no longer needed after compaction-related workflows.

### System op: maintenance

Used for retention cleanup and related housekeeping.

## Retention and size limits

See the Worker source and Wrangler configuration for the latest limits and operational settings.

## Persistence behavior

The worker persists transport-side metadata while leaving payload interpretation to clients.

## Run locally

```bash
yarn install
yarn build
yarn --cwd examples/todo-cloudflare-do db:migrate:local
yarn --cwd examples/todo-cloudflare-do dev
```

## Use with `CloudflareAdapter`

Point the browser client at the local Worker endpoint and use the same encrypted Interocitor session across multiple tabs or devices.

## SSE client hint

This example includes invalidation fanout. Clients can use SSE as a hint to trigger sync sooner, but the authoritative state still comes from local storage plus encrypted artifact exchange.

## Opt-in Playwright coverage

From the repo root:

```bash
yarn test:e2e:cloudflare
yarn test:e2e:cloudflare:run
```

## Deploy

```bash
yarn --cwd examples/todo-cloudflare-do deploy
```

## Related packages

- Core engine: `packages/interocitor`
- Worker runtime: `packages/interocitor-workers`
