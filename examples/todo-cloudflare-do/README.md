# TODO over Cloudflare Worker + Durable Objects

This example provides an Interocitor-native endpoint with:

- Durable Object for per-prefix request ordering + SSE fanout
- **D1 as the real persistence medium** for files/folders

- URL shape: `/io/<prefix>/...`
- `<prefix>` is the Durable Object name (session partition key)
- all files/folders under the same prefix are persisted in D1 rows

## What role DO play here

Durable Objects are **not strictly required for plain polling sync**, but they are **recommended** for this shape of push fanout.

- Without DO, a Worker can still serve the same Interocitor-native API over D1.
- With DO, each prefix gets single-writer ordering and consistent fanout for live invalidation.
- SSE/WebSocket push is much simpler from DO because connections and writes meet in one actor.
- If you only need eventual consistency + polling, D1/R2 + stateless Worker is viable.

## What is implemented

- Native IO endpoints over `/io/<prefix>` (`ensure-folder`, `list-files`, `list-folders`, `metadata`, `file`)
- folder/file metadata + basic ETag generation
- durable data persisted in D1 (`files` and `folders` tables)
- SSE invalidation endpoint: `/events/<prefix>`
- CORS enabled for browser demos

## API shape

- Adapter-facing base URL: `https://<host>/<optional-prefix>/io/<namespace>`
- SSE endpoint: `.../events/<namespace>` (derived from base URL)
- Execute endpoint: `POST .../io/<namespace>/__interocitor__/execute`

Deployment can be:

- sub-path (example: `https://mysite.com/interocitor/io/team-a`)
- dedicated subdomain (example: `https://interocitor.mysite.com/io/team-a`)
- shared worker behind gateway/reroute (preserve auth header, query string, SSE streaming)

## Mutation policy (append-only + execute)

- Default mode is append-only (`INTEROCITOR_APPEND_ONLY=1`).
- In append-only mode:
  - `DELETE` returns `405`
  - `PUT` to an existing file returns `409`
- Privileged operations are done via `POST /io/<prefix>/__interocitor__/execute`.
- Execute requires `x-interocitor-token` header matching Worker secret `INTEROCITOR_EXEC_TOKEN`.

Access-token model (for normal adapter traffic):

- Optional bearer token in adapter config is sent as `Authorization: Bearer <token>`.
- Worker validates token as `sha256(prefix + INTEROCITOR_ACCESS_TOKEN)` when secret is set.
- If `INTEROCITOR_ACCESS_TOKEN` is not set, the backend is public.
- This access token protects backend usage/cost, not data confidentiality.

### Execute compact

Compaction is implemented server-side as a privileged prune over `changes/*.json` up to a watermark HLC.

Request body:

```json
{
  "op": "compact",
  "remotePath": "/team-a/todo-app",
  "watermarkHlc": "2026-04-07T12:30:00.000Z:000001:dev_x"
}
```

Notes:

- It only prunes files named like `<hlc>-chg_*.json` and skips `head.json`.
- It writes an immutable command receipt to `/.interocitor/commands/` under the same remote path.

## Persistence behavior

- **Remote (deployed):** D1 persists data by design.
- **Local dev:** `yarn dev` uses `--persist-to .wrangler/state` so local state survives restarts.

## Run locally

```bash
cd /Users/akorzunov/dev/github/interocitor/examples/todo-cloudflare-do
yarn
yarn wrangler d1 create todo-cloudflare-do-db
## copy returned database_id + preview_database_id into wrangler.toml
yarn wrangler secret put INTEROCITOR_EXEC_TOKEN
yarn wrangler secret put INTEROCITOR_ACCESS_TOKEN
yarn db:migrate:local
yarn check
yarn dev
```

Worker starts on `http://127.0.0.1:8787`.

## Use with `CloudflareAdapter`

1. Build `interocitor` root once:

```bash
cd /Users/akorzunov/dev/github/interocitor
yarn build
```

2. Use adapter setup like this:

```ts
import { CloudflareAdapter } from 'interocitor/adapters/cloudflare';

const adapter = new CloudflareAdapter({
  baseUrl: 'http://127.0.0.1:8787/io/team-a',
});
```

3. Keep one prefix per mesh/workspace (`team-a` above).

### Prefix example

- `team-a` and `team-b` are isolated namespaces.

## SSE client hint

For near-real-time refresh, attach EventSource per prefix:

```js
const source = new EventSource('http://127.0.0.1:8787/events/team-a');
source.addEventListener('invalidate', () => {
  // trigger engine refresh or local UI refetch
});
```

## Deploy

```bash
cd /Users/akorzunov/dev/github/interocitor/examples/todo-cloudflare-do
yarn db:migrate:remote
yarn deploy
```

