# Mesh addresses and access

Named addresses give one mesh a stable application meaning; checksummed IDs
let an application provision many meshes without admitting arbitrary storage
namespaces. Direct mode uses the requested address as the storage namespace.
Optional route resolution can instead map one opaque presented address to one
canonical namespace. Integrity gates decide which canonical addresses are
valid. `meshMiddleware` separately authenticates and authorizes requests.

The snippets are partial Worker policy fragments. Supply the surrounding
Worker, environment bindings, and application identity/policy services. The
complete runnable deployment is the
[Cloudflare TODO app example](../../../examples/todo-cloudflare-do/README.md).

## One stable shared database

Use a named address when one mesh has stable application meaning. A Worker
acting as the shared database for an application can expose that mesh as
`/sync/io/main`; every client is configured with `main`, with no ID issuance or
discovery step.

Define the allowed name with an integrity gate:

```ts
runtime: {
  meshIntegrityGates: [({ address }) => address === 'main'],
}
```

The gate admits the address as written. `main` remains the D1 namespace, R2
namespace, and relay-object name.

Named addresses are predictable. Apply mesh middleware when the shared
database is not public.

## Many application-provisioned meshes

Use checksummed IDs when the application creates many meshes and arbitrary
UUIDs must not create storage namespaces:

```ts
runtime: {
  meshIntegrityGates: [checksummedMeshIntegrityGate],
  meshSecret: (env) => env.INTEROCITOR_MESH_SECRET,
}
```

`checksummedMeshIntegrityGate` accepts `<UUIDv7>.<tag>` addresses issued with
the same `meshSecret`. Route `createInterocitorSystemHandler(...)` behind the
host application's administrative policy when the host needs the built-in ID
issue/validate operations.

Knowing a valid checksummed address proves that the address was issued. Mesh
middleware still decides whether the current request may use it.

## Resolve opaque per-subject routes

Set `resolveMeshRoute` when clients should receive individually replaceable
addresses without moving the canonical D1, file-body, or relay namespace:

```ts
runtime: {
  resolveMeshRoute: async ({ presentedAddress }, env) => {
    const binding = await env.control.findActiveRoute(presentedAddress);
    return binding ? { canonicalAddress: binding.canonicalAddress } : null;
  },
  meshIntegrityGates: [checksummedMeshIntegrityGate],
}
```

This snippet is a partial policy fragment; the host supplies and protects the
control store. When the resolver is present it is authoritative. `null`
returns `404`, and the runtime does not retry the presented address as a
canonical address. A thrown, rejected, or malformed result returns `503`.
Only omission or `undefined` disables the resolver; a configured non-function
value also returns `503` instead of enabling direct routing.
Resolution is exactly one hop; never return another public alias.
The internal `__interocitor_recovery__` namespace is not a valid public or
resolved mesh address: direct use returns `404`, and a resolver mapping returns
`503` without affecting the separate recovery route.

Integrity gates run after resolution. Their `address` and `canonicalAddress`
fields contain the resolved namespace, while `presentedAddress` retains the
decoded URL segment. The same fields reach mesh middleware, durable-file store
selection, and upload policy. D1, file-body keys, built-in audit events, and the
relay always use the canonical address.

The system handler remains canonical-addressed and never invokes the public
resolver. Recovery is also outside this pipeline. For per-subject grants,
delegation, revocation, and pairing, see
[Protected mesh control](mesh-control.md).

## Combining address rules

Gates use OR semantics in array order. This deployment supports a stable
`main` mesh and provisioned meshes:

```ts
meshIntegrityGates: [({ address }) => address === "main", checksummedMeshIntegrityGate];
```

If every gate returns literal `false`, the Worker returns `404` before
middleware or storage. A gate exception or non-boolean return value returns
`503`; only literal `true` admits the canonical address.

## Apply application authentication and authorization

The application decides how a request becomes a subject and what that subject
may do. The authorizer can call any bearer-token verifier, session service,
identity provider, or policy engine:

```ts
import { createInterocitorMount, createMeshAuthorizationMiddleware } from "@interocitor/workers";

const authorizeMesh = createMeshAuthorizationMiddleware(
  async ({ canonicalAddress, request }, env) => {
    const subject = await env.identity.verify(request);
    if (!subject) return "deny";

    const permission = await env.permissions.forMesh(subject, canonicalAddress);
    if (permission === "write") return "full";
    if (permission === "read") return "readonly";
    return "deny";
  },
);

const mount = createInterocitorMount({
  mountPrefix: "/sync",
  db: (env) => env.DB,
  runtime: {
    meshIntegrityGates: [({ address }) => address === "main"],
    meshMiddleware: [authorizeMesh],
  },
});
```

The four results are:

| Result     | Read  | Write | Meaning                                                                             |
| ---------- | ----- | ----- | ----------------------------------------------------------------------------------- |
| `none`     | allow | allow | This address requires no application authorization.                                 |
| `readonly` | allow | `403` | The subject may consume the mesh. Notify is also allowed because it is read access. |
| `full`     | allow | allow | The subject may consume and modify the mesh.                                        |
| `deny`     | `403` | `403` | The request has no mesh access.                                                     |

An authorizer exception or invalid result returns `503`.

### Conceal accepted addresses from denied callers

The default `403` denial tells a caller that the address passed the integrity
gate but they lack access. That can disclose issuance for checksummed IDs. A
deployment that needs invalid and unauthorized addresses to be indistinguishable
can opt into matching `404` responses:

```ts
const authorizeMesh = createMeshAuthorizationMiddleware(
  async ({ request }, env) => {
    const subject = await env.identity.verify(request);
    return subject ? "full" : "deny";
  },
  { concealDenied: true },
);
```

This applies to `deny` and readonly write rejections. It intentionally trades
the client's explicit authorization diagnostic for address-existence concealment;
authorization-service failures remain `503`.

## Compose other request policy

`meshMiddleware` wraps accepted IO and notify requests in array order. Each
layer can return a response or call `next()` once:

```ts
meshMiddleware: [
  async (context, env, next) => {
    const startedAt = Date.now();
    const response = await next();
    await env.audit.record({
      presentedAddress: context.presentedAddress,
      canonicalAddress: context.canonicalAddress,
      access: context.access,
      status: response.status,
      elapsedMs: Date.now() - startedAt,
    });
    return response;
  },
  authorizeMesh,
];
```

Place audit middleware before authorization when denied requests must be
recorded. Recovery, global health, preflight, and system routes have separate
host-owned policy boundaries.
