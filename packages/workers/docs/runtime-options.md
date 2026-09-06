# Worker configuration reference

`createInterocitorMount(...)` and `withInterocitor(...)` use the same mount
options. `createInterocitorSystemHandler(...)` uses the smaller system-handler
options described below.

## Mount options

| Option        | Type                                         | Behavior                                                                                                                                                                                                                   |
| ------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mountPrefix` | `string \| null`                             | URL prefix shared by the Interocitor routes. The default, `null`, and `/` place those routes at the Worker root. Root mounting claims only Interocitor health, IO, notify, and recovery paths.                             |
| `cors`        | `CorsOptions<Env>`                           | Optional exact-origin browser policy. Omit it to preserve `Access-Control-Allow-Origin: *`; when configured, only an exact listed request `Origin` receives the allow-origin header and every response varies by `Origin`. |
| `db`          | `(env) => D1Database`                        | Required. Supplies D1 storage for sync objects, metadata, recovery wrappers, and maintenance.                                                                                                                              |
| `files`       | `(env, route) => FileBodyStore \| undefined` | Supplies the configured destination for durable file bodies. `route.canonicalAddress` permits stable per-mesh selection; `route.address` has the same canonical value. Without a store, durable-file routes return `501`.  |
| `relay`       | `(env) => DurableObjectNamespace`            | Supplies the optional invalidation relay. Without it, notify routes return `501`; clients continue by polling.                                                                                                             |
| `runtime`     | `InterocitorRuntimeOptions<Env>`             | Address integrity, request policy, limits, maintenance, diagnostics, and instrumentation.                                                                                                                                  |

`createInterocitorSystemHandler(...)` consumes `mountPrefix`, `cors`, `db`, and
`runtime`. Its `runtime` accepts `meshIntegrityGates`, `pathTtlHours`,
`meshSecret`, and `verbose`; mesh middleware, upload policy, limits, scheduled
maintenance, and storage instrumentation belong to the mesh mount. The system
route is separate from that mount. See
[Maintenance and system operations](maintenance.md).

Environment binding names belong to the host Worker. Getters are evaluated
against the `env` supplied to the current request or scheduled event.

### CORS policy

`cors` has one required field: `allowedOrigins`, either a readonly array or an
`(env) => readonly string[]` resolver. Each entry is an exact browser origin;
an empty list allows no cross-origin browser reads. The package never reflects
an unlisted `Origin`, and configured responses include `Vary: Origin` so a
cache cannot reuse one origin's CORS decision for another. `cors` controls
browser response access only; use mesh middleware for request authentication
and authorization.

`createInterocitorSystemHandler(...)` also accepts `cors`, independently from
the mesh mount, because hosts route its system endpoints separately.

## Recovery wrapper route

The mesh mount claims
`/<mountPrefix>/recovery/<locator>` so a client can retrieve an opaque
credential wrapper without first knowing a mesh address. Recovery uses D1 and
`maxControlBytes`; it does not require the durable-file `files` store.

| Request                                                | Result                                      |
| ------------------------------------------------------ | ------------------------------------------- |
| `GET` with an existing 43-character base64url locator  | `200` with the serialized wrapper           |
| `GET` with an absent locator                           | `404`                                       |
| First `PUT` for a locator                              | `201`                                       |
| Later `PUT` for the same locator                       | `409`; wrappers are immutable on this route |
| Invalid locator                                        | `400`                                       |
| Body larger than `maxControlBytes`                     | `413`                                       |
| Method other than `GET`, `PUT`, or preflight `OPTIONS` | `405`                                       |

The route is outside mesh-address IO, so it does not pass
`meshIntegrityGates` or `meshMiddleware`. Locator possession is the
default access rule. A host that also requires application authentication must
route `createInterocitorMount(...)` manually and apply that policy before
delegating recovery requests. Completed reads and immutable-write attempts
emit `recovery-read` and `recovery-write` events through
`storageOperationAudit`.

## Runtime options

### Mesh request pipeline

| Option               | Type                                | Default | Behavior                                                                                                                                                                                                                                                                   |
| -------------------- | ----------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolveMeshRoute`   | `MeshRouteResolver<Env>`            | unset   | Authoritative one-hop mapping from the presented IO/notify address to a canonical address. `null` returns `404` with no identity fallback; a throw or malformed result returns `503`. When unset, both addresses are identical.                                            |
| `meshIntegrityGates` | `readonly MeshIntegrityGate<Env>[]` | `[]`    | Ordered, OR-composed rules defining which canonical mesh addresses exist. The first literal `true` accepts the address. All literal `false` returns `404` before middleware or storage. A malformed stack, thrown, rejected, or non-boolean result returns `503`.          |
| `meshMiddleware`     | `readonly MeshMiddleware<Env>[]`    | `[]`    | Ordered layers around accepted `/io/<address>` and `/notify/<address>` requests. A layer may return a response or call `next()` once. A malformed stack or non-Response result returns `503`. Recovery, global health, preflight, and system routes do not use this chain. |

An empty integrity-gate list rejects every mesh address. Every working mesh
mount therefore supplies at least one gate. Public IO/notify resolution occurs
before these gates. The separately routed system handler does not resolve
public aliases; its gates receive the canonical address supplied by the host.
Mesh-ID issue/validate operations do not target an existing mesh.

IO operations are classified as `read` or `write` before middleware runs.
Notify connections and notify health are `read`. See [Mesh addresses and
access](mesh-access.md) for named meshes, checksummed IDs, and the four-state
authorization helper. See [Protected mesh control](mesh-control.md) for opaque
per-subject routes and delegable grants.

A second call to the same layer's `next()` returns `500`. Uncaught middleware
exceptions propagate to the Worker runtime. `createMeshAuthorizationMiddleware`
normalizes authorizer exceptions and invalid decisions to `503`.

Its optional second argument, `{ concealDenied: true }`, maps `deny` and a
readonly write rejection to the same `404 Not found` response returned when no
integrity gate accepts the address. It protects deployments where revealing
that an issued or named mesh exists is not acceptable. The default is `false`,
which retains `403 Forbidden` for an accepted address whose caller lacks
access; this gives clients a clearer authorization failure.

#### Route-resolution context

`MeshRouteResolver` receives one `MeshRouteContext` before integrity gates or
mesh middleware run:

| Field              | Meaning                                                     |
| ------------------ | ----------------------------------------------------------- |
| `presentedAddress` | Decoded address from the public IO or notify URL.           |
| `request`          | Clone of the incoming request.                              |
| `surface`          | `io` or `notify`.                                           |
| `access`           | `read` or `write`, classified from the requested operation. |

Return `{ canonicalAddress }` to select the stable storage namespace, or
`null` when that presented address is not currently bound. The resolver is
called once; its result is never submitted for another round of resolution.
Only an omitted or `undefined` resolver disables indirection. A configured
non-function value fails closed with `503` instead of restoring direct routing.
The internal `__interocitor_recovery__` namespace is reserved: using it
directly as a public mesh returns `404`, and resolving a public route to it
returns `503`. Recovery requests continue to use the separate `/recovery`
surface.

#### Protected grant middleware

`createMeshGrantAuthorizationMiddleware(...)` converts a current plaintext
grant chain into the same four-state mesh authorization decision. The host
provides these callbacks and settings:

| Option           | Required | Default    | Meaning                                                               |
| ---------------- | -------- | ---------- | --------------------------------------------------------------------- |
| `authenticate`   | yes      | —          | Verify the request and return a stable `subjectId`, or `null`.        |
| `loadGrantChain` | yes      | —          | Load the authoritative root-to-subject chain for this request.        |
| `isTrustedRoot`  | yes      | —          | Confirm that the first grant is rooted in current application policy. |
| `now`            | no       | `Date.now` | Supply the Unix-millisecond clock used for validity checks.           |
| `concealDenied`  | no       | `true`     | Return `404` instead of `403` for absent or insufficient grants.      |
| `maxChainLength` | no       | `32`       | Reject a longer chain as malformed.                                   |

Creating the middleware throws when `maxChainLength` is not a positive safe
integer.

Every `MeshAccessGrant` names `grantId`, `parentGrantId`,
`canonicalAddress`, `issuerSubjectId`, `subjectId`, `authorization`,
`delegationDepth`, and `issuedAt`. `notBefore`, `expiresAt`, and `revokedAt`
are optional Unix-millisecond timestamps. `issuedAt` and `notBefore` are
inclusive activation bounds; `expiresAt` is exclusive; any `revokedAt` value
makes the grant inactive. String identifiers and addresses must be non-empty,
delegation depth must be a non-negative safe integer, and timestamps must be
finite and non-negative. Invalid principal data, clocks, or grant shapes and
unavailable policy callbacks return `503`. Missing, untrusted, inactive, or
insufficient grants use the configured denial response.

The middleware snapshots the authenticated subject and each primitive grant
field before validation, then supplies the frozen root snapshot to
`isTrustedRoot`.

`attenuateMeshGrant(parent, child)` inherits an omitted `notBefore` or
`expiresAt` bound from the parent, constructs the issuer and parent link, and
returns a frozen grant. `markMeshGrantRevoked(grant, revokedAt?)` returns a
frozen copy and preserves an existing first revocation timestamp; the optional
timestamp defaults to `Date.now()`.

The host persists grants and route bindings. The package provides no grant
table or management endpoint. See [Protected mesh control](mesh-control.md)
for delegation, approval, pairing, and revocation guidance.

### Scheduled maintenance

| Option                       | Type                                                     | Default        | Behavior                                                                                                                                                                                                 |
| ---------------------------- | -------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enableScheduledMaintenance` | `(env: Env) => string \| number \| boolean \| undefined` | `false`        | `true`, `1`, or `'1'` makes `withInterocitor(...).scheduled()` run an all-mesh TTL sweep after the wrapped app's scheduled handler. It has no effect when using `createInterocitorMount(...)` alone.     |
| `pathTtlHours`               | `(env: Env) => string \| number \| undefined`            | `0` (disabled) | Positive hours since `mesh_paths.last_operation_at` before a D1 sync root becomes eligible for deletion. Omitted, invalid, zero, or negative values disable TTL deletion. Fractional hours are accepted. |

TTL maintenance removes D1 sync objects for an inactive remote root and marks
its `mesh_paths` row deleted. It does not remove durable file bodies from the
configured store. Read the
destructive semantics and cron wiring in [Maintenance and system
operations](maintenance.md) before enabling it.

### Request body and storage limits

All values are bytes. Omitted, invalid, non-integer, zero, or negative values
use the documented default. An over-limit request returns `413`.

| Option                | Type                                          | Default | Applies to                                                                                                                                |
| --------------------- | --------------------------------------------- | ------: | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `maxControlBytes`     | `(env: Env) => string \| number \| undefined` | 256 KiB | One manifest pointer, manifest snapshot, head, device heartbeat, or recovery-wrapper PUT body.                                            |
| `maxChangeBytes`      | `(env: Env) => string \| number \| undefined` |   8 MiB | One CRDT change object.                                                                                                                   |
| `maxMainlineBytes`    | `(env: Env) => string \| number \| undefined` |  16 MiB | One mainline snapshot.                                                                                                                    |
| `maxGenericFileBytes` | `(env: Env) => string \| number \| undefined` |   8 MiB | One D1 sync object not covered by the control, change, or mainline limits.                                                                |
| `maxStoredFileBytes`  | `(env: Env) => string \| number \| undefined` |  32 MiB | One file-body-store PUT body.                                                                                                             |
| `maxMeshStoredBytes`  | `(env: Env) => string \| number \| undefined` | 512 MiB | Sum of D1-tracked durable-file sizes for one mesh address. An overwrite subtracts the previous stored size before adding the replacement. |

The D1 sync-object limits and durable file-body-store limits are independent.

### Durable file-body store

`FileBodyStore` is the provider-neutral exact-key `get` / `put` / `delete`
boundary used for durable file bodies. It does not own authorization, mesh
routing, quotas, or durable-file application and operational metadata; the
Worker and D1 retain those responsibilities. On reads, the store reports only
representation facts needed to serve the body: its stored `size` and optional
HTTP-formatted `etag`. `R2FileBodyStore` adapts a Cloudflare R2 binding, and
`S3FileBodyStore` signs requests to a configured S3-compatible endpoint and
defaults to the AWS regional endpoint when no endpoint is supplied.

| Method                             | Required behavior                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `get(key)`                         | Return the exact stored bytes, size, and optional HTTP-formatted ETag; return `null` when the key is absent. |
| `put(key, value, { contentType })` | Fully replace the bytes at the key or reject. Partial successful writes are not valid.                       |
| `delete(key)`                      | Remove the bytes. Deleting an absent key is a successful no-op.                                              |

Keys are opaque provider-independent strings. A store may map them to a bucket
key, remote path, or provider file identifier, but it must not reinterpret the
mesh or application path encoded by the Worker. Listing, authentication, and
provider account discovery are outside this interface.

The `files` resolver runs after mesh integrity and middleware have accepted the
route. Its `canonicalAddress` is the stable storage namespace, `address` has
the same value, and `presentedAddress` is the caller's decoded URL segment.
Selection must be a stable function of the canonical
address and deployment configuration: D1 records one opaque object key, not a
provider identifier, so changing a mesh from one store to another does not
migrate existing bodies.

Store construction, endpoint allowlisting, and provider credentials belong to
trusted deployment configuration. Request data and browser-controlled metadata
must not choose an arbitrary destination or supply a shared credential.

See [S3-compatible durable-file storage](s3-file-storage.md) for the
configuration contract and security boundary.

### Durable-file upload policy

`authorizeFileUpload` is optional and unset by default. Without it, a
durable-file upload that passes the built-in size, device-header, and quota
checks proceeds. The callback has type
`(request: FileUploadAuthorizationRequest, env: Env) => FileUploadAuthorizationResult | Promise<FileUploadAuthorizationResult>`.
It adds application policy to durable-file
PUTs. It runs after the per-file limit, required
`X-Interocitor-Device-Id` header, and per-mesh quota checks, and before the
file-body-store write.

The request includes:

| Field                    | Meaning                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `address`                | Canonical mesh address under the common request-context field.                           |
| `presentedAddress`       | Decoded public route address supplied by the caller.                                     |
| `canonicalAddress`       | Stable mesh namespace selected by route resolution.                                      |
| `path`                   | Normalized durable-file path.                                                            |
| `size`                   | Stored request-body bytes.                                                               |
| `currentMeshStoredBytes` | Stored durable-file bytes before this write.                                             |
| `maxMeshStoredBytes`     | Resolved quota for this mesh.                                                            |
| `uploadedByDeviceId`     | Client-supplied `X-Interocitor-Device-Id`.                                               |
| `sealed`                 | The write presents a seal guard, proving the client holds the file's extra key.          |
| `overwritesSealed`       | The object being replaced is sealed; the guard already matched before the hook ran.      |
| `request`                | Incoming request after its body has been consumed; headers and cookies remain available. |

The device ID and other client-supplied metadata are policy inputs, not
authenticated identity. Return `true` to allow, `false` to reject with `403`,
or `{ allowed: false, status, reason }` to choose a `400`–`599` rejection
response. Only omission or `undefined` disables the hook. A configured
non-function, thrown or rejected callback, malformed result, non-boolean
`allowed`, or invalid status returns `503`. The hook does not authorize
sync-object writes or reads; use `meshMiddleware` for whole-mesh request
policy.

### Checksum authority

`meshSecret` has type `(env: Env) => string | undefined`. It supplies the HMAC authority used by
`checksummedMeshIntegrityGate` and mesh-ID issue/validate system operations.
An omitted or empty value uses the development default `'interocitor'`. Supply
a deployment secret before using checksummed IDs in production. Changing the
secret invalidates IDs issued with the previous value.

The checksum establishes that an address was issued by the same authority. It
does not authenticate the requester.

### Instrumentation and diagnostics

| Option                  | Type                                                           | Default | Behavior                                                                                                                                                                                       |
| ----------------------- | -------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storageOperationAudit` | `(event: WorkerAuditEvent, env: Env) => void \| Promise<void>` | unset   | Awaited callback for completed sync-storage, durable-file, and recovery operations. Callback failures are swallowed; callback latency adds request latency. See [Worker audit](audit.md).      |
| `verbose`               | `(env: Env) => string \| number \| boolean \| undefined`       | `false` | `true`, `1`, or `'1'` logs integrity-gate exceptions, audit-callback exceptions, missing relay bindings, and relay delivery results. Broadcast failures are warned regardless of this setting. |

`storageOperationAudit` observes terminal storage operations. To record gate
or authorization denials, put request audit middleware before authorization in
`meshMiddleware`.
