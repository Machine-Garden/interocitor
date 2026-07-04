<p align="center">
  <a href="https://github.com/TheUiTeam/interocitor">
    <img src="https://raw.githubusercontent.com/TheUiTeam/interocitor/main/docs/assets/hero.svg" alt="interocitor" width="560"/>
  </a>
</p>

# @interocitor/workers

Cloudflare Workers runtime for [Interocitor](https://github.com/TheUiTeam/interocitor). Handles both app-data surfaces — CRDT row sync and R2-backed durable file/image storage — plus optional realtime relay, all behind a single URL prefix in your existing Worker.

## Quick start

Use the Worker package for the concrete sync adapter base URL, for example `/sync/io/{meshId}`. This is separate from the handshake relay base used by QR pairing, which is an app-level logical path such as `/Taska`.

```ts
import { InterocitorRelayDurableObject, withInterocitor } from '@interocitor/workers';

interface Env {
  MY_DB: D1Database;
  MY_FILES: R2Bucket;
  MY_RELAY: DurableObjectNamespace;
  INTEROCITOR_ACCESS_TOKEN?: string;
  INTEROCITOR_SYSTEM_TOKEN?: string;
  INTEROCITOR_MESH_SECRET?: string;
  INTEROCITOR_ENABLE_SCHEDULED_MAINTENANCE?: string;
  INTEROCITOR_PATH_TTL_HOURS?: string;
}

const appWorker = {
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === '/') return new Response('app root');
    if (url.pathname === '/api/ping') return Response.json({ ok: true });
    return new Response('not found', { status: 404 });
  },
};

export { InterocitorRelayDurableObject };

export default withInterocitor<Env>(appWorker, {
  mountPrefix: '/sync',
  db: (env) => env.MY_DB,
  files: (env) => env.MY_FILES,
  relay: (env) => env.MY_RELAY,
  runtime: {
    accessToken: (env) => env.INTEROCITOR_ACCESS_TOKEN,
    systemToken: (env) => env.INTEROCITOR_SYSTEM_TOKEN,
    meshSecret: (env) => env.INTEROCITOR_MESH_SECRET,
    enableScheduledMaintenance: (env) => env.INTEROCITOR_ENABLE_SCHEDULED_MAINTENANCE,
    pathTtlHours: (env) => env.INTEROCITOR_PATH_TTL_HOURS,
  },
});
```

Interocitor does not constrain your `Env` type. You own your env shape. Pass only the bindings and settings it needs via getters.

Interocitor claims `/<prefix>/io/*`, `/<prefix>/notify/*`, `/<prefix>/__interocitor/*`, and `/<prefix>/health`. Everything else goes to your app.

## Runtime

### Required bindings

The conventional app wiring is:

```ts
const mount = createInterocitorMount({
  mountPrefix: '/sync',
  db: (env) => env.INTEROCITOR_DB,
  files: (env) => env.INTEROCITOR_FILES,
  relay: (env) => env.INTEROCITOR_RELAY,
});
```

```toml
[[d1_databases]]
binding = "INTEROCITOR_DB"
# other Wrangler fields...

[[r2_buckets]]
binding = "INTEROCITOR_FILES"
bucket_name = "interocitor-files"

[[durable_objects.bindings]]
name = "INTEROCITOR_RELAY"
class_name = "InterocitorRelayDurableObject"

[[migrations]]
tag = "v1"
new_classes = ["InterocitorRelayDurableObject"]
```

Binding names are ultimately yours. Pass them to `withInterocitor(...)` or `createInterocitorMount(...)` via getters. D1 is required for sync; R2 is required only if clients call durable file/image APIs; Durable Objects are required only for realtime relay.

Apply the D1 schema from the package root:

```bash
wrangler d1 execute <database-name> --file node_modules/@interocitor/workers/schema.sql
```

The published package includes `schema.sql` in its `files` list.

### Realtime relay: what `InterocitorRelayDurableObject` does

`InterocitorRelayDurableObject` is the optional Durable Object behind Interocitor's notify WebSocket route.

- `withInterocitor(..., { relay: (env) => env.MY_RELAY })` enables `/<mountPrefix>/notify/<prefix>`.
- The Worker authenticates that route with the same per-prefix access-token rule as `/<mountPrefix>/io/<prefix>`.
- The relay stores WebSockets using Cloudflare's hibernation API (`acceptWebSocket`) and fans out tiny invalidation messages after successful file writes/deletes. The package broadcasts internally after successful `PUT` and `DELETE` responses; apps should not wrap these routes just to notify peers.
- Check relay wiring with `GET /notify/<prefix>/health` using the same bearer/access token. It returns JSON such as `{ "ok": true, "connected": 0 }`; `501` means the relay binding was not configured.
- Set `runtime.verbose` (for example from `INTEROCITOR_VERBOSE=1`) to emit relay diagnostics to `wrangler tail`: unauthorized notify requests, missing binding, WebSocket forwarding, and broadcast delivery/failure counts.
- Correctness does not depend on the relay. Clients still poll/pull. The relay is the low-latency path for apps that want push invalidations.

Minimum Worker entry:

```ts
import { InterocitorRelayDurableObject, withInterocitor } from '@interocitor/workers';

export { InterocitorRelayDurableObject };

export default withInterocitor(appWorker, {
  mountPrefix: '/sync',
  db: (env) => env.MY_DB,
  relay: (env) => env.MY_RELAY,
});
```

Minimum Wrangler config:

```toml
[[durable_objects.bindings]]
name = "MY_RELAY"
class_name = "InterocitorRelayDurableObject"

[[migrations]]
tag = "v1"
new_classes = ["InterocitorRelayDurableObject"]
```

Proof that the relay is reachable:

```bash
# 1. Start the Cloudflare TODO example with RUN_CF_EXAMPLE_TESTS=1.
RUN_CF_EXAMPLE_TESTS=1 yarn test:e2e:cloudflare:run --grep "InterocitorRelayDurableObject"

# 2. Or open the notify endpoint manually from a browser/client:
# ws(s)://<worker>/sync/notify/<prefix>?access_token=<sha256(prefix + accessSecret)>
```

The repository includes this proof as `examples/todo-cloudflare-do/tests/e2e/cloudflare.relay.e2e.spec.ts`: it starts the example Worker, opens `/todo-interocitor/notify/<namespace>` with the valid token, and expects the WebSocket to reach `open`.

## Custom routing

If you need manual routing instead of wrapping the whole worker:

```ts
import { createInterocitorMount } from '@interocitor/workers';

const mount = createInterocitorMount<Env>({
  mountPrefix: '/sync',
  db: (env) => env.MY_DB,
  files: (env) => env.MY_FILES,
  relay: (env) => env.MY_RELAY,
  runtime: {
    accessToken: (env) => env.INTEROCITOR_ACCESS_TOKEN,
    systemToken: (env) => env.INTEROCITOR_SYSTEM_TOKEN,
    meshSecret: (env) => env.INTEROCITOR_MESH_SECRET,
  },
});

export { InterocitorRelayDurableObject } from '@interocitor/workers';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (mount.matches(url.pathname)) return mount.fetch(request, env, ctx);
    return appWorker.fetch(request, env, ctx);
  },
};
```

## File and image storage

Durable app files are stored in R2 and tracked in D1 metadata. This is separate from sync change files: files are uploaded, read, overwritten, and deleted directly; they are never compacted or merged.

Worker metadata tracks:

- uploader device id
- stored byte size and optional plaintext byte size
- content type
- upload/modified time
- last access time
- total read count
- `taint` — an opaque label set by the client for [sealed files](../core/docs/tainted-files.md). The worker stores and returns it but never interprets it; the bytes stay opaque to the server regardless.

Uploads are guarded before R2 write:

- `maxStoredFileBytes` limits one upload.
- `maxMeshStoredBytes` limits total stored file bytes for a mesh, accounting for overwrites and deletes.
- `authorizeFileUpload` can reject by mesh prefix, path, uploader device id, size, content type, current mesh usage, or app-specific request auth.

```ts
const mount = createInterocitorMount<Env>({
  mountPrefix: '/sync',
  db: env => env.INTEROCITOR_DB,
  files: env => env.INTEROCITOR_FILES,
  runtime: {
    maxStoredFileBytes: env => env.INTEROCITOR_MAX_STORED_FILE_BYTES,
    maxMeshStoredBytes: env => env.INTEROCITOR_MAX_MESH_STORED_BYTES,
    authorizeFileUpload: async ({ prefix, path, uploadedByDeviceId, size, contentType, taint, request }) => {
      if (!uploadedByDeviceId) return { allowed: false, status: 401, reason: 'missing device' };
      if (contentType?.startsWith('image/') && size > 8 * 1024 * 1024) {
        return { allowed: false, status: 413, reason: 'image too large' };
      }
      // Inspect request headers/cookies here if your app has user auth.
      return true;
    },
  },
});
```

## Runtime getters

Interocitor no longer reads magic env variable names by itself. You pass everything explicitly through getters.

```ts
runtime: {
  accessToken: (env) => env.INTEROCITOR_ACCESS_TOKEN,
  systemToken: (env) => env.INTEROCITOR_SYSTEM_TOKEN,
  meshSecret: (env) => env.INTEROCITOR_MESH_SECRET,
  enableScheduledMaintenance: (env) => env.INTEROCITOR_ENABLE_SCHEDULED_MAINTENANCE,
  pathTtlHours: (env) => env.INTEROCITOR_PATH_TTL_HOURS,
  maxControlBytes: (env) => env.INTEROCITOR_MAX_CONTROL_BYTES,
  maxChangeBytes: (env) => env.INTEROCITOR_MAX_CHANGE_BYTES,
  maxMainlineBytes: (env) => env.INTEROCITOR_MAX_MAINLINE_BYTES,
  maxGenericFileBytes: (env) => env.INTEROCITOR_MAX_GENERIC_FILE_BYTES,
  maxStoredFileBytes: (env) => env.INTEROCITOR_MAX_STORED_FILE_BYTES,
  maxMeshStoredBytes: (env) => env.INTEROCITOR_MAX_MESH_STORED_BYTES,
  authorizeFileUpload: async (upload, env) => true,
}
```

Only `db` is required for sync. `files` is required for durable file/image APIs. Everything else is optional.

## Observability (audit)

The worker is the **trusted boundary**: it observes every mesh operation it
serves, so an `audit` callback is the place to record "who did what" without
trusting the client. Provide it as a runtime getter; the worker invokes it
with a typed event after each operation.

```ts
runtime: {
  // Simplest useful sink: structured log to `wrangler tail` / Logpush.
  audit: (event) => console.log(JSON.stringify(event)),
}
```

`audit` is a **pure callback** — the worker does not persist events itself, and
callback failures never fail the request. Each `WorkerAuditEvent` carries
`op` (write, read, delete, list, metadata, stored-file-\*, system), `prefix`,
`path`, `status`, `outcome`, optional `bytes`/`taint`, a `requestId`, and an
ISO `at` timestamp.

What the worker **can** audit: change-file/manifest writes, compaction and
maintenance, reads, lists, and stored-file upload/download/delete/metadata.
What it **cannot** see: CRDT row meaning (payloads are encrypted), the `taint`
→ key mapping, and client-side unlock/decrypt of sealed files. Full event
shape and boundaries: [Audit](docs/audit.md).

## Catch-up after absence

A device returning after a long absence catches up incrementally: the cursor is
already in the data model. Change files are HLC-named, and `pull()` merges only
those newer than the device's cursor — no full re-download unless the needed
tail was already compacted away. See [Catch-up](docs/catch-up.md).

## Mesh IDs

Workers issue and validate mesh/team IDs. Each ID is a UUIDv7 with an embedded HMAC tag — only the worker with the secret can mint valid IDs.

### System ops

Issue a mesh ID (requires `INTEROCITOR_SYSTEM_TOKEN`):

```bash
curl -X POST https://your-worker/sync/__interocitor/my-prefix \
  -H "Authorization: Bearer $SYSTEM_TOKEN" \
  -d '{"op": "issue-mesh-id"}'
# → { "meshId": "0196745e-...-7abc-...AbCdEfGhIjK" }
```

Validate a mesh ID:

```bash
curl -X POST https://your-worker/sync/__interocitor/my-prefix \
  -H "Authorization: Bearer $SYSTEM_TOKEN" \
  -d '{"op": "validate-mesh-id", "meshId": "0196745e-...AbCdEfGhIjK"}'
# → { "valid": true }
```

### Secret management

Set `INTEROCITOR_MESH_SECRET` in your Worker environment (wrangler secret or `.dev.vars`).

Default value is `'interocitor'` — fine for development, **change it in production**.

⚠️ **Changing this secret invalidates ALL existing mesh IDs.** Peers with previously issued IDs will fail validation. Treat it as permanent.

## Security guardrails

For the current security boundary of the Cloudflare implementation — D1,
R2, application encryption, metadata exposure, and the limits of current
server-side access control — see [Security guardrails](docs/security-guardrails.md).

## License

MIT
