<p align="center">
  <a href="https://github.com/TheUiTeam/interocitor">
    <img src="https://raw.githubusercontent.com/TheUiTeam/interocitor/main/docs/assets/hero.svg" alt="interocitor" width="560"/>
  </a>
</p>

# TODO over Cloudflare Worker + Durable Objects

GitHub example directory: <https://github.com/TheUiTeam/interocitor/tree/main/examples/todo-cloudflare-do>

This example provides an Interocitor-native endpoint with:

- Durable Object for per-prefix request ordering + SSE fanout
- **D1 as the real persistence medium** for files/folders

- URL shape: `/io/<prefix>/...`
- `<prefix>` is the Durable Object name (session partition key)
- all files/folders under the same prefix are persisted in D1 rows

## What role do Durable Objects play here

Durable Objects are **not strictly required for plain polling sync**, but they are **recommended** for this shape of push fanout.

- Without DO, a Worker can still serve the same Interocitor-native API over D1.
- With DO, each prefix gets single-writer ordering and consistent fanout for live invalidation.
- SSE/WebSocket push is much simpler from DO because connections and writes meet in one actor.
- If you only need eventual consistency + polling, D1/R2 + stateless Worker is viable.

## What is implemented

- Native IO endpoints over `/io/<prefix>` (`ensure-folder`, `list-files`, `list-folders`, `metadata`, `file`)
- folder/file metadata + basic ETag generation
- durable data persisted in D1 (`files`, `folders`, `mesh_paths`, `maintenance_runs`, `maintenance_actions`)
- mesh-path activity metrics for retention and auditability
- configurable per-path write-size limits before D1 BLOB writes
- scheduled TTL cleanup for inactive mesh roots
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
- Automatic compaction is intentionally **not** enabled in this example yet.

### Execute maintenance

The same privileged execute endpoint also exposes product-ish maintenance/admin helpers:

```json
{ "op": "run-maintenance" }
```

Runs TTL cleanup immediately for the current prefix using the configured retention window.

```json
{ "op": "maintenance-status", "remotePath": "/todo-app" }
```

Returns tracked mesh-path activity and byte counters for the requested mesh root, or all tracked mesh roots for the prefix when `remotePath` is omitted.

## Retention and size limits

The worker tracks activity per `(prefix, remote_root)` mesh path.
A mesh path becomes TTL-eligible when `last_operation_at` is older than `INTEROCITOR_PATH_TTL_HOURS`.
Scheduled cleanup runs from the Worker `scheduled()` handler and the example ships with a default cron of every 4 hours.

Configurable guardrails:

- `INTEROCITOR_PATH_TTL_HOURS` — inactivity TTL before deletion
- `INTEROCITOR_MAINTENANCE_MAX_PATHS_PER_RUN` — throttle TTL sweep size per run
- `INTEROCITOR_MAX_CONTROL_BYTES` — manifests, head, device heartbeat files
- `INTEROCITOR_MAX_CHANGE_BYTES` — change-file ceiling
- `INTEROCITOR_MAX_MAINLINE_BYTES` — mainline snapshot ceiling
- `INTEROCITOR_MAX_PREFIX_BYTES` — total byte ceiling per prefix across all file categories
- `INTEROCITOR_MAX_GENERIC_FILE_BYTES` — catch-all file ceiling

This example keeps explicit application-level limits even though D1 stores file content in a `BLOB`, because operationally safe payload sizes matter more than the raw storage type alone.

## Persistence behavior

The example keeps D1 setup intentionally simple: the full schema lives in a single consolidated migration file, `migrations/0001_schema.sql`.

- **Remote (deployed):** D1 persists data by design.
- **Local dev:** `yarn dev` uses `--persist-to .wrangler/state` so local state survives restarts.

## Run locally

```bash
cd examples/todo-cloudflare-do
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
# from the monorepo root
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

## Opt-in Playwright coverage

There is a dedicated Playwright harness for this example that starts:

- the shared static demo server on port `4174`
- a separate Cloudflare Worker test harness on port `8788`
- local D1 migrations via `wrangler.playwright.toml`

This is intentionally **opt-in** so normal project test runs do not depend on Wrangler.

From the repo root:

```bash
yarn test:e2e:cloudflare        # starts harness, specs stay skipped by default
yarn test:e2e:cloudflare:run    # actually executes the Cloudflare example specs
```

Current example coverage includes:

- SSE sync landing before long polling can fire
- access-token protected mode
- compaction + fresh-tab rehydrate from mainline snapshot
- SSE reconnect after simulated Durable Object in-memory loss
- mesh-path activity tracking + TTL cleanup
- oversized writes rejected before D1 persistence

The reconnect spec simulates DO loss by dropping live SSE clients through the privileged execute endpoint in the **test-only** Wrangler config. This validates the behavior you actually care about: EventSource reconnects automatically and sync resumes without waiting for the long polling interval.

## Deploy

```bash
cd examples/todo-cloudflare-do
yarn db:migrate:remote
yarn deploy
```

