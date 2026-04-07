# TODO over Cloudflare Worker + Durable Objects

This example provides a WebDAV-compatible endpoint with:

- Durable Object for per-prefix request ordering + SSE fanout
- **D1 as the real persistence medium** for files/folders

- URL shape: `/dav/<prefix>/<remote-path...>`
- `<prefix>` is the Durable Object name (session partition key)
- all WebDAV files/folders under the same prefix are persisted in D1 rows

## Do we need Durable Objects here?

Short answer: **not strictly required for plain polling sync**, but **recommended** for this shape of WebDAV emulation.

- Without DO, a Worker can still proxy to D1/R2/KV and serve WebDAV methods.
- With DO, each prefix gets single-writer ordering and consistent fanout for live invalidation.
- SSE/WebSocket push is much simpler from DO because connections and writes meet in one actor.
- If you only need eventual consistency + polling, D1/R2 + stateless Worker is viable.

## What is implemented

- `PROPFIND`, `MKCOL`, `PUT`, `GET`, `DELETE`, `OPTIONS`
- folder/file metadata + basic ETag generation
- durable data persisted in D1 (`files` and `folders` tables)
- SSE invalidation endpoint: `/events/<prefix>`
- CORS enabled for browser demos

## Mutation policy (append-only + execute)

- Default mode is append-only (`INTEROCITOR_APPEND_ONLY=1`).
- In append-only mode:
  - `DELETE` returns `405`
  - `PUT` to an existing file returns `409`
- Privileged operations are done via `POST /dav/<prefix>/__interocitor__/execute`.
- Execute requires `x-interocitor-token` header matching Worker secret `INTEROCITOR_EXEC_TOKEN`.

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
yarn db:migrate:local
yarn check
yarn dev
```

Worker starts on `http://127.0.0.1:8787`.

## Use with existing TODO demo UI

1. Build `interocitor` root once:

```bash
cd /Users/akorzunov/dev/github/interocitor
yarn build
```

2. Open the existing UI (`examples/todo-webdav/index.html`) from any static host.
3. In the UI set WebDAV URL to:
   - `http://127.0.0.1:8787/dav`
4. Keep remote path format as `/prefix/whatever`:
   - first segment (`prefix`) selects the DO instance.

### Token example

```json
{"v":1,"baseUrl":"http://127.0.0.1:8787/dav","remotePath":"/team-a/todo-app","key":"<passphrase>"}
```

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

