# Worker configuration reference

`createInterocitorMount(...)` and `withInterocitor(...)` use the same mount
options. `createInterocitorSystemHandler(...)` uses the smaller system-handler
options described below.

## Mount options

| Option | Type | Behavior |
| --- | --- | --- |
| `mountPrefix` | `string \| null` | URL prefix shared by the Interocitor routes. The default, `null`, and `/` place those routes at the Worker root. Root mounting claims only Interocitor health, IO, notify, and recovery paths. |
| `db` | `(env) => D1Database` | Required. Supplies D1 storage for sync objects, metadata, recovery wrappers, and maintenance. |
| `files` | `(env, { address }) => StoredFileBucket \| undefined` | Supplies R2 or AWS S3 storage for durable file bodies. The accepted mesh address permits stable per-mesh selection. Without a store, durable-file routes return `501`; row sync still works. |
| `relay` | `(env) => DurableObjectNamespace` | Supplies the optional invalidation relay. Without it, notify routes return `501`; clients continue by polling. |
| `runtime` | `InterocitorRuntimeOptions<Env>` | Address integrity, request policy, limits, maintenance, diagnostics, and instrumentation. |

`createInterocitorSystemHandler(...)` consumes only `mountPrefix`, `db`, and
`runtime`. Its `runtime` accepts `meshIntegrityGates`, `pathTtlHours`,
`meshSecret`, and `verbose`; mesh middleware, upload policy, limits, scheduled
maintenance, and storage instrumentation belong to the mesh mount. The system
route is separate from that mount. See
[Maintenance and system operations](maintenance.md).

Environment binding names belong to the host Worker. Getters are evaluated
against the `env` supplied to the current request or scheduled event.

## Recovery wrapper route

The mesh mount claims
`/<mountPrefix>/recovery/<locator>` so a client can retrieve an opaque
credential wrapper without first knowing a mesh address. Recovery uses D1 and
`maxControlBytes`; it does not require the durable-file `files` store.

| Request | Result |
| --- | --- |
| `GET` with an existing 43-character base64url locator | `200` with the serialized wrapper |
| `GET` with an absent locator | `404` |
| First `PUT` for a locator | `201` |
| Later `PUT` for the same locator | `409`; wrappers are immutable on this route |
| Invalid locator | `400` |
| Body larger than `maxControlBytes` | `413` |
| Method other than `GET`, `PUT`, or preflight `OPTIONS` | `405` |

The route is outside mesh-address IO, so it does not pass
`meshIntegrityGates` or `meshMiddleware`. Locator possession is the
default access rule. A host that also requires application authentication must
route `createInterocitorMount(...)` manually and apply that policy before
delegating recovery requests. Completed reads and immutable-write attempts
emit `recovery-read` and `recovery-write` events through
`storageOperationAudit`.

## Runtime options

### Mesh request pipeline

| Option | Type | Default | Behavior |
| --- | --- | --- | --- |
| `meshIntegrityGates` | `readonly MeshIntegrityGate<Env>[]` | `[]` | Ordered, OR-composed rules defining which mesh addresses exist. The first `true` accepts the original address unchanged. All `false` returns `404` before middleware or storage. A thrown or rejected gate returns `503`. |
| `meshMiddleware` | `readonly MeshMiddleware<Env>[]` | `[]` | Ordered layers around accepted `/io/<address>` and `/notify/<address>` requests. A layer may return a response or call `next()` once. Recovery, global health, preflight, and system routes do not use this chain. |

An empty integrity-gate list rejects every mesh address. Every working mesh
mount therefore supplies at least one gate. Gates also apply to system
operations that target an existing mesh; mesh-ID issue/validate operations do
not target an existing mesh.

IO operations are classified as `read` or `write` before middleware runs.
Notify connections and notify health are `read`. See [Mesh addresses and
access](mesh-access.md) for named meshes, checksummed IDs, and the four-state
authorization helper.

A second call to the same layer's `next()` returns `500`. Uncaught middleware
exceptions propagate to the Worker runtime. `createMeshAuthorizationMiddleware`
normalizes authorizer exceptions and invalid decisions to `503`.

### Scheduled maintenance

| Option | Type | Default | Behavior |
| --- | --- | --- | --- |
| `enableScheduledMaintenance` | `(env: Env) => string \| number \| boolean \| undefined` | `false` | `true`, `1`, or `'1'` makes `withInterocitor(...).scheduled()` run an all-mesh TTL sweep after the wrapped app's scheduled handler. It has no effect when using `createInterocitorMount(...)` alone. |
| `pathTtlHours` | `(env: Env) => string \| number \| undefined` | `0` (disabled) | Positive hours since `mesh_paths.last_operation_at` before a D1 sync root becomes eligible for deletion. Omitted, invalid, zero, or negative values disable TTL deletion. Fractional hours are accepted. |

TTL maintenance removes D1 sync objects for an inactive remote root and marks
its `mesh_paths` row deleted. It does not remove durable file bodies from R2 or
S3. Read the
destructive semantics and cron wiring in [Maintenance and system
operations](maintenance.md) before enabling it.

### Request body and storage limits

All values are bytes. Omitted, invalid, non-integer, zero, or negative values
use the documented default. An over-limit request returns `413`.

| Option | Type | Default | Applies to |
| --- | --- | ---: | --- |
| `maxControlBytes` | `(env: Env) => string \| number \| undefined` | 256 KiB | One manifest pointer, manifest snapshot, head, device heartbeat, or recovery-wrapper PUT body. |
| `maxChangeBytes` | `(env: Env) => string \| number \| undefined` | 8 MiB | One CRDT change object. |
| `maxMainlineBytes` | `(env: Env) => string \| number \| undefined` | 16 MiB | One mainline snapshot. |
| `maxGenericFileBytes` | `(env: Env) => string \| number \| undefined` | 8 MiB | One D1 sync object not covered by the control, change, or mainline limits. |
| `maxStoredFileBytes` | `(env: Env) => string \| number \| undefined` | 32 MiB | One object-store-backed durable-file PUT body. |
| `maxMeshStoredBytes` | `(env: Env) => string \| number \| undefined` | 512 MiB | Sum of D1-tracked durable-file sizes for one mesh address. An overwrite subtracts the previous stored size before adding the replacement. |

The D1 sync-object limits and durable-file object-store limits are independent.

### Durable-file object store

`StoredFileBucket` is the exact-key `get` / `put` / `delete` boundary used for
durable file bodies. An R2 binding satisfies it directly. `S3StoredFileBucket`
implements it with signed requests to the configured AWS regional endpoint.

The `files` resolver runs after mesh integrity and middleware have accepted the
address. Its `address` is the canonical storage address. Selection must be a
stable function of that address and deployment configuration: D1 records one
opaque object key, not a provider identifier, so changing a mesh from one store
to another does not migrate existing bodies.

See [AWS S3 durable-file storage](s3-file-storage.md) for the configuration
contract and security boundary.

### Durable-file upload policy

`authorizeFileUpload` is optional and unset by default. Without it, a
durable-file upload that passes the built-in size, device-header, and quota
checks proceeds. The callback has type
`(request: FileUploadAuthorizationRequest, env: Env) => FileUploadAuthorizationResult | Promise<FileUploadAuthorizationResult>`.
It adds application policy to durable-file
PUTs. It runs after the per-file limit, required
`X-Interocitor-Device-Id` header, and per-mesh quota checks, and before the
object-store write.

The request includes:

| Field | Meaning |
| --- | --- |
| `address` | Accepted mesh address. |
| `path` | Normalized durable-file path. |
| `size` | Stored request-body bytes. |
| `currentMeshStoredBytes` | Stored durable-file bytes before this write. |
| `maxMeshStoredBytes` | Resolved quota for this mesh. |
| `uploadedByDeviceId` | Client-supplied `X-Interocitor-Device-Id`. |
| `plaintextSize` | Optional client-supplied plaintext size. |
| `contentType` | Client-supplied content type, defaulting to `application/octet-stream`. |
| `taint` | Optional client-supplied opaque classification. |
| `request` | Incoming request after its body has been consumed; headers and cookies remain available. |

The device ID and other client-supplied metadata are policy inputs, not
authenticated identity. Return `true` to allow, `false` to reject with `403`,
or `{ allowed: false, status, reason }` to choose the rejection response. The
hook does not authorize sync-object writes or reads; use `meshMiddleware` for
whole-mesh request policy. A thrown or rejected hook propagates to the Worker
runtime.

### Checksum authority

`meshSecret` has type `(env: Env) => string | undefined`. It supplies the HMAC authority used by
`checksummedMeshIntegrityGate` and mesh-ID issue/validate system operations.
An omitted or empty value uses the development default `'interocitor'`. Supply
a deployment secret before using checksummed IDs in production. Changing the
secret invalidates IDs issued with the previous value.

The checksum establishes that an address was issued by the same authority. It
does not authenticate the requester.

### Instrumentation and diagnostics

| Option | Type | Default | Behavior |
| --- | --- | --- | --- |
| `storageOperationAudit` | `(event: WorkerAuditEvent, env: Env) => void \| Promise<void>` | unset | Awaited callback for completed sync-storage, durable-file, and recovery operations. Callback failures are swallowed; callback latency adds request latency. See [Worker audit](audit.md). |
| `verbose` | `(env: Env) => string \| number \| boolean \| undefined` | `false` | `true`, `1`, or `'1'` logs integrity-gate exceptions, audit-callback exceptions, missing relay bindings, and relay delivery results. Broadcast failures are warned regardless of this setting. |

`storageOperationAudit` observes terminal storage operations. To record gate
or authorization denials, put request audit middleware before authorization in
`meshMiddleware`.
