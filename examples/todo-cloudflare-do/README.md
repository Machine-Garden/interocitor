<p align="center">
  <a href="https://github.com/Machine-Garden/interocitor">
    <img src="https://raw.githubusercontent.com/Machine-Garden/interocitor/main/docs/assets/hero.svg" alt="Interocitor" width="560"/>
  </a>
</p>

# TODO over Cloudflare Workers, D1, and R2

Runnable public example of an app-owned Worker with Interocitor mounted
at `/todo-interocitor`.

The Worker uses D1 for row-sync objects and metadata, R2 for durable files, and
an optional Durable Object for low-latency invalidations. The browser remains
responsible for row queries, merge, and application-payload encryption.

## Route ownership

The host app owns:

- `/`
- `/api/ping`
- `/todo-interocitor/__interocitor/system/*`, protected by the example's
  system bearer before delegation

The Interocitor mount owns:

- `/todo-interocitor/health`
- `/todo-interocitor/io/*`
- `/todo-interocitor/notify/*`
- `/todo-interocitor/recovery/*`

## Example policy

The Worker demonstrates three independent values:

- `INTEROCITOR_MESH_SECRET` signs and validates checksummed mesh addresses;
- `TODO_MESH_BEARER_SECRET` derives the demo per-mesh bearer as
  `sha256(meshId + secret)`;
- `TODO_SYSTEM_BEARER_TOKEN` protects the host-routed system handler.

The committed strings are local-development placeholders, not production
secrets. The deterministic mesh bearer demonstrates composition but has no
subject identity, expiry, rotation, or revocation.

TypeScript/JavaScript snippets below are command helpers or partial
application fragments as labelled. They are not a general production
authorization design.

## Run locally

### 1. Install and build

From the repository root:

```bash
yarn install
yarn build:int
yarn build:web
yarn workspace @interocitor/workers build
```

The root has no `yarn build` script; use the commands above or `yarn build:all`.

### 2. Create the local D1 schema

Run the example migration for its maintenance tables, then apply the canonical
Workers schema for the current runtime, including `stored_files`:

```bash
yarn --cwd examples/todo-cloudflare-do db:migrate:local
yarn --cwd examples/todo-cloudflare-do exec wrangler d1 execute \
  INTEROCITOR_DB \
  --local \
  --file=../../packages/workers/schema.sql
```

Both schema steps are required. The example migration creates its maintenance
tables; the canonical Workers schema creates `stored_files` for R2-backed file
calls.

### 3. Start the Worker and page server

In one terminal:

```bash
yarn --cwd examples/todo-cloudflare-do dev
```

In another terminal from the repository root:

```bash
PORT=4174 node tools/webdav-server/server.mjs --mode=memory
```

The second command is only a loopback static-file server here; do not deploy or
expose it. Open:

<http://127.0.0.1:4174/examples/todo-cloudflare-do/index.html>

### 4. Provision a mesh address and bearer

The Worker requires a valid checksummed address. Ask the host-protected system
route to issue one:

```bash
curl --fail-with-body \
  --request POST \
  --header 'Authorization: Bearer replace-with-production-system-secret' \
  --header 'Content-Type: application/json' \
  --data '{"op":"issue-mesh-id"}' \
  http://127.0.0.1:8787/todo-interocitor/__interocitor/system/provision
```

Copy the returned `meshId`. Compute the demo mesh bearer with this runnable
helper, replacing the first argument:

```bash
node -e "const {createHash}=require('node:crypto'); console.log(createHash('sha256').update(process.argv[1] + process.argv[2]).digest('hex'))" \
  '<mesh-id>' \
  'replace-with-production-secret'
```

In the page, enter:

| Field        | Local value                              |
| ------------ | ---------------------------------------- |
| Worker URL   | `http://127.0.0.1:8787/todo-interocitor` |
| Namespace    | returned `meshId`                        |
| Remote path  | `/todo-app`                              |
| Access token | computed SHA-256 hex                     |

Choose **New session**, copy the resulting join token to another tab, connect
both, and add tasks. The pre-filled local Worker URL includes the required
mount prefix; replace the origin when using a deployed Worker.

## Credential modes and join-token custody

The `credentials` query parameter selects browser custody:

```text
?credentials=session          # default: plaintext credential record in sessionStorage
?credentials=memory           # JS memory only
?credentials=local            # plaintext credential record in localStorage
?credentials=passkey          # WebAuthn largeBlob, when supported
?credentials=memory-envelope  # encrypted envelope and unwrap key both in page memory
```

The join token contains the Worker URL, mesh address, remote path, application
bearer, and portable mesh key. Possession grants this demo's network access and
decryption capability. Treat it as a secret: do not log it, place it in normal
analytics, or use the clipboard-based flow as a production invitation system.

Cloudflare sees route/address, object names, sizes, timing, manifest/device
metadata, and the client-supplied durable-file metadata. With the configured
portable key source, row change/snapshot and file payloads are encrypted before
upload. A copied join token plus stored objects is sufficient to decrypt them.

## Durable-file pattern

The TODO UI is row-only, but the Worker mounts R2-backed file routes. This
partial fragment assumes `db`, `task`, `taskId`, and `file` exist:

```js
const path = `tasks/${taskId}/files/${Date.now()}_${file.name}`;
await db.putFile(path, new Uint8Array(await file.arrayBuffer()), file.type);
await db.table("tasks").patch(taskId, {
  file_paths: [...(task.file_paths ?? []), path],
});
```

The Wrangler `INTEROCITOR_MAX_STORED_FILE_BYTES` and
`INTEROCITOR_MAX_MESH_STORED_BYTES` values set the per-file and per-mesh
stored-file quotas. The checked-in configuration uses the package defaults of
32 MiB per file and 512 MiB per mesh.

## Relay and maintenance behavior

The exported `InterocitorRelayDurableObject` batches invalidations and improves
latency; clients still poll for correctness. Change objects and snapshots are
immutable. Heads, manifest pointers, and device heartbeats overwrite their
paths. Scheduled TTL cleanup affects D1 sync roots, not R2 durable files.

The opt-in Playwright suite is executable from the repository root:

```bash
yarn test:e2e:cloudflare:run
```

It provisions test mesh IDs/bearers and covers auth, relay, compaction,
maintenance, prefix integrity, and QR share/join cleanup and timeout behavior.
It requires Chromium and a working local Wrangler runtime.

## Deploy your own copy

This is an operator checklist, not a copy-paste deployment with shared IDs:

1. Create D1 and R2 resources with Wrangler and replace the placeholder D1 IDs
   and bucket names in `wrangler.toml`.
2. Remove the three placeholder secret values from `[vars]`, then set
   `INTEROCITOR_MESH_SECRET`, `TODO_MESH_BEARER_SECRET`, and
   `TODO_SYSTEM_BEARER_TOKEN` with `wrangler secret put`.
3. Apply both remote schema steps:

   ```bash
   yarn --cwd examples/todo-cloudflare-do db:migrate:remote
   yarn --cwd examples/todo-cloudflare-do exec wrangler d1 execute \
     INTEROCITOR_DB \
     --remote \
     --file=../../packages/workers/schema.sql
   ```

4. Review the cron TTL, request limits, CORS/origin exposure, audit sink,
   application identity policy, recovery-wrapper access, and R2 lifecycle.
5. Deploy:

   ```bash
   yarn --cwd examples/todo-cloudflare-do deploy
   ```

`wrangler.toml` points at the example entry
`examples/todo-cloudflare-do/todo-interocitor.js`, which imports the built
Workers workspace. Rebuild before every deployment.

## Related packages

- [Core engine](../../packages/core/README.md)
- [Browser helpers](../../packages/web/README.md)
- [Workers runtime](../../packages/workers/README.md)

## Other runnable examples

- [Live in-memory TodoMVC](../../docs/examples/todomvc/index.html)
- [Live encrypted chat](../../docs/examples/chat/index.html)
- [Live shared board](../../docs/examples/board/index.html)
- [Protected family locator](../../docs/examples/family-locator/index.html)
- [TODO over WebDAV](../todo-webdav/README.md)
- [Browser key custody](../biometric-keys/README.md)
