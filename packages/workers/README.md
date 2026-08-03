<p align="center">
  <a href="https://github.com/TheUiTeam/interocitor">
    <img src="https://raw.githubusercontent.com/TheUiTeam/interocitor/main/docs/assets/hero.svg" alt="interocitor" width="560"/>
  </a>
</p>

# @interocitor/workers

Cloudflare Workers runtime for [Interocitor](https://github.com/TheUiTeam/interocitor). Handles both app-data surfaces — CRDT row sync and R2-backed durable file/image storage — plus optional realtime relay, all behind a single URL prefix in your existing Worker.

> **Public release:** build the `0.1.0` API from the matching monorepo
> workspaces.

From the repository root:

```bash
yarn install
yarn workspace @interocitor/workers build
```

TypeScript and Wrangler fragments in this README are illustrative unless a
section explicitly links a runnable command. They use the package's current
API but assume host Worker bindings, environment types, and application policy.
The [Cloudflare TODO app example](../../examples/todo-cloudflare-do/README.md) is
the complete runnable deployment.

## Quick start

This illustrative Worker entry serves one protected application database at
the stable mesh address `main`. It assumes Cloudflare binding types and
values supplied by the host; the complete runnable deployment is
[the Cloudflare TODO app example](../../examples/todo-cloudflare-do/README.md).

```ts
import {
  createMeshAuthorizationMiddleware,
  withInterocitor,
} from '@interocitor/workers';

interface Env {
  MY_DB: D1Database;
  MY_FILES: R2Bucket;
  MAIN_MESH_TOKEN: string;
}

const authorizeMain = createMeshAuthorizationMiddleware(({ request }, env: Env) =>
  request.headers.get('Authorization') === `Bearer ${env.MAIN_MESH_TOKEN}`
    ? 'full'
    : 'deny',
);

const appWorker = {
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === '/') return new Response('app root');
    if (url.pathname === '/api/ping') return Response.json({ ok: true });
    return new Response('not found', { status: 404 });
  },
};

export default withInterocitor<Env>(appWorker, {
  mountPrefix: '/sync',
  db: (env) => env.MY_DB,
  files: (env) => env.MY_FILES,
  runtime: {
    meshIntegrityGates: [({ address }) => address === 'main'],
    meshMiddleware: [authorizeMain],
  },
});
```

The exact bearer comparison is a small working application policy. Replace
the authorizer with the AuthN/AuthZ system used by your host application. See
[Mesh addresses and access](docs/mesh-access.md).

The Cloudflare adapter base URL is `/sync/io/main`. The QR handshake relay base
is a separate app-level logical path such as `/Taska`.

Interocitor claims `/<mountPrefix>/io/*`, `/<mountPrefix>/notify/*`,
`/<mountPrefix>/recovery/*`, and `/<mountPrefix>/health`. Everything else goes
to your app.

### Recovery wrappers

`/<mountPrefix>/recovery/<locator>` stores an opaque recovery wrapper outside
the mesh-specific `/io/<address>` namespace. This lets a client recover its
manifest mesh ID, portable key, and remote path from an
application-generated recovery phrase. It does not recover a separate Worker
route address or storage-provider login. The Worker receives only ciphertext and
the phrase-derived opaque locator, never the words or mesh key.

Recovery wrappers are capability-addressed by their opaque locator. See
[Recovery phrases](../core/docs/recovery.md) and the
[route reference](docs/runtime-options.md#recovery-wrapper-route).

## Public API

Documented entrypoints in this package:

| API | Use when |
| --- | --- |
| `withInterocitor` | You want Interocitor to wrap an existing Worker and own one URL prefix |
| `createInterocitorMount` | You want explicit route matching and manual delegation inside a larger Worker |
| `createInterocitorSystemHandler` | You choose to expose maintenance or mesh-ID operations from a host-owned route |
| `createMeshAuthorizationMiddleware` | You want a four-state `none` / `readonly` / `full` / `deny` application access decision |
| `checksummedMeshIntegrityGate` | You accept only addresses issued by your checksum authority |
| `InterocitorRelayDurableObject` | You want realtime invalidation over WebSockets in addition to polling |
| `broadcast` | You need to enqueue a custom relay invalidation outside the built-in write/delete paths |
| `applySchema`, `ensureSchema`, `SCHEMA_STATEMENTS` | You need programmatic D1 schema setup instead of the packaged SQL file |
| `InterocitorMountOptions`, `InterocitorRuntimeOptions`, `InterocitorSystemHandlerOptions` | Configuration contracts; see the [reference](docs/runtime-options.md) |
| `InterocitorMount`, `InterocitorSystemHandler`, `WithInterocitorOptions` | Returned handler and wrapper contracts |
| `MeshIntegrityGate`, `MeshMiddleware`, `MeshAuthorizer`, `MeshAuthorization`, `MeshRequestContext`, `MeshIntegrityContext`, `MeshAccess` | Mesh integrity and application-policy contracts |
| `FileUploadAuthorizationRequest`, `FileUploadAuthorizationResult` | You need app-owned policy before durable file uploads are accepted |
| `WorkerAuditEvent`, `WorkerAuditOutcome` | Completed storage-operation instrumentation contracts |
| `BroadcastDiagnostics` | Optional logging controls for `broadcast` |
| `D1Database`, `R2Bucket`, `R2ObjectBody`, `DurableObjectNamespace`, `ExecutionContextLike`, `WorkerLike` | Minimal Cloudflare-compatible structural types used by the package API |

## Runtime

### Required bindings

The conventional app wiring is:

```ts
const mount = createInterocitorMount({
  mountPrefix: '/sync',
  db: (env) => env.INTEROCITOR_DB,
  files: (env) => env.INTEROCITOR_FILES,
  relay: (env) => env.INTEROCITOR_RELAY,
  runtime: {
    meshIntegrityGates: [({ address }) => address === 'main'],
    meshMiddleware: [authorizeMain],
  },
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

Apply the canonical D1 schema from the public repository root:

```bash
yarn --cwd examples/todo-cloudflare-do exec wrangler d1 execute \
  <database-name> \
  --file=../../packages/workers/schema.sql
```

Add `--local` for Wrangler local state and omit it for the configured remote
database. Replace `<database-name>` and finish the Wrangler binding IDs first.

Programmatic hosts can call `ensureSchema(db)` once per D1 binding object; it
uses a `WeakSet` fast path and idempotent `CREATE ... IF NOT EXISTS`
statements. `applySchema(db)` executes the idempotent statements every time.
`SCHEMA_STATEMENTS` exposes the base statements for tooling; the functions
also apply the compatibility check for the `stored_files.taint` column.

### Realtime relay

The optional Durable Object relay sends invalidation signals after successful
writes and deletes. Notify requests pass the same integrity and middleware
pipeline as IO requests. Clients continue polling when the relay is absent.
See [Realtime invalidation relay](docs/relay.md) for wiring and verification.

## Custom routing

If you need manual routing instead of wrapping the whole worker:

```ts
import {
  createInterocitorMount,
} from '@interocitor/workers';

const mount = createInterocitorMount<Env>({
  mountPrefix: '/sync',
  db: (env) => env.MY_DB,
  files: (env) => env.MY_FILES,
  relay: (env) => env.MY_RELAY,
  runtime: {
    meshIntegrityGates: [({ address }) => address === 'main'],
    meshMiddleware: [authorizeMain],
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
- `authorizeFileUpload` can reject by mesh address, path, uploader device id, size, content type, current mesh usage, or app-specific request auth.

The following illustrative policy omits the host identity provider and
environment type. It shows where whole-mesh authorization and
durable-file-specific policy compose.

```ts
import {
  checksummedMeshIntegrityGate,
  createInterocitorMount,
  createMeshAuthorizationMiddleware,
} from '@interocitor/workers';

const authorizeMesh = createMeshAuthorizationMiddleware(async ({ address, access, request }, env) => {
  const subject = await verifyBearerWithYourIdentityProvider(request, env);
  if (!subject) return 'deny';
  const permission = await meshPermissionFor(subject, address, env);
  if (permission === 'write') return 'full';
  if (permission === 'read' && access === 'read') return 'readonly';
  return 'deny';
});

const mount = createInterocitorMount<Env>({
  mountPrefix: '/sync',
  db: env => env.INTEROCITOR_DB,
  files: env => env.INTEROCITOR_FILES,
  runtime: {
    maxStoredFileBytes: env => env.INTEROCITOR_MAX_STORED_FILE_BYTES,
    maxMeshStoredBytes: env => env.INTEROCITOR_MAX_MESH_STORED_BYTES,
    meshIntegrityGates: [checksummedMeshIntegrityGate],
    meshMiddleware: [authorizeMesh],
    meshSecret: env => env.INTEROCITOR_MESH_SECRET,
    authorizeFileUpload: async ({ address, path, size, contentType, taint, request }) => {
      if (contentType?.startsWith('image/') && size > 8 * 1024 * 1024) {
        return { allowed: false, status: 413, reason: 'image too large' };
      }
      return true;
    },
  },
});
```

## Runtime options

Start with the behavior your deployment needs:

| Need | Options |
| --- | --- |
| Define valid mesh addresses | `meshIntegrityGates` |
| Apply application access or request policy | `meshMiddleware` |
| Set D1/R2 request and quota limits | `maxControlBytes`, `maxChangeBytes`, `maxMainlineBytes`, `maxGenericFileBytes`, `maxStoredFileBytes`, `maxMeshStoredBytes` |
| Add durable-file-specific policy | `authorizeFileUpload` |
| Reclaim inactive D1 sync roots | `enableScheduledMaintenance`, `pathTtlHours` |
| Instrument completed storage operations | `storageOperationAudit` |
| Enable targeted diagnostics | `verbose` |

The [Worker configuration reference](docs/runtime-options.md) defines every
type, default, route surface, ordering rule, and failure behavior.

## Mesh addresses and access

Use a named address when one mesh has a stable meaning in your application.
For example, a Worker acting as the shared database for one application can
serve that database at `/sync/io/main`. Every client can be configured with
`main`; the application does not need to provision or discover a generated ID.

Use generated, checksummed IDs when the application provisions many meshes and
arbitrary UUIDs must not create storage namespaces.

For either model, integrity gates define which addresses exist. Mesh
middleware decides what the current request may do. Read [Mesh addresses and
access](docs/mesh-access.md) for the complete named/checksummed model,
four-state authorization, AuthN/AuthZ integration, and middleware composition.

## Maintenance and system operations

Scheduled TTL cleanup and the optional host-routed system handler are covered
in [Maintenance and system operations](docs/maintenance.md), including exactly
what TTL deletes and how the host applies its administrative policy.

## Storage operation instrumentation

`storageOperationAudit` is awaited instrumentation for completed storage
operations:

```ts
runtime: {
  // Simplest useful sink: structured log to `wrangler tail` / Logpush.
  storageOperationAudit: (event) => console.log(JSON.stringify(event)),
}
```

The Worker does not persist events. Callback failures do not fail the request,
while callback latency adds request latency. Each `WorkerAuditEvent` carries
`op` (write, read, delete, list, metadata, recovery, or stored-file variants), `address`,
`path`, `status`, `outcome`, optional `bytes`/`taint`, a `requestId`, and an
ISO `at` timestamp.

It covers completed sync-object operations, recovery-wrapper operations, and
stored-file upload/download/delete/metadata. Gate, middleware, validation,
quota, and system-operation denials require request middleware audit.
What it **cannot** see: CRDT row meaning (payloads are encrypted), the `taint`
→ key mapping, and client-side unlock/decrypt of sealed files. Full event
shape and boundaries: [Audit](docs/audit.md).

## Catch-up after absence

A device returning within the current remote epoch catches up incrementally:
`pull()` lists change files and merges exact filenames absent from its receipt
set. When compaction advances the remote epoch, the client rehydrates from the
current snapshot and then pulls the uncovered tail. Covered D1 change objects
are deleted after snapshot publication, and the handling colo evicts their
Worker Cache API entries.
See [Catch-up](docs/catch-up.md).

## Security guardrails

For the Cloudflare implementation's security boundary — D1, R2, application
encryption, metadata exposure, and the limits of server-side access control —
see [Security guardrails](docs/security-guardrails.md).

## License

MIT
