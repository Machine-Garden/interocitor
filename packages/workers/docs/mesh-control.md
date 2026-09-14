# Protected mesh control

Use protected mesh control when an application must issue and delegate its own
revocable grants, or give subjects replaceable routes, independently of an
existing identity provider's resource permissions. For ordinary multi-user
access, keep one stable address and authorize each request through the host
application instead; see
[Mesh addresses and access](mesh-access.md#authorize-people-through-the-host-application).

In the specialized grant model, several people share one encrypted mesh while
the Cloudflare Worker keeps a small, server-readable control plane. The
Interocitor data plane remains client encrypted.

This is a reference-monitor boundary, not another Interocitor mesh:

```text
presented route + authenticated subject
                 │
                 ▼
        route resolver (one hop)
                 │
                 ▼
       canonical storage address
                 │
                 ▼
       grant middleware ── deny
                 │ allow
                 ▼
          D1 / file store / relay
```

The Worker may read route bindings, subject identifiers, grants, expiry, and
revocation state. It does not need the mesh passphrase, data key, or plaintext
application records. Protect control-plane reads and mutations with the host
application's authentication and administrative policy.

## Separate the three identifiers

- The **authenticated subject ID** identifies a person or device account. It
  comes from a server-verifiable login, session, or device proof.
- The **presented address** is the opaque route in `/io/<address>` and
  `/notify/<address>`. A deployment can issue a different address to each
  subject.
- The **canonical address** is the stable D1, durable-file, cache, and relay
  namespace selected internally by the Worker.

Neither address is `manifest.meshId`. Core records that manifest identity to
detect accidental mesh mismatch; it is not requester authentication and the
Worker must not rewrite it.

## Enable one-hop route indirection

`resolveMeshRoute` is optional and disabled by default. With no resolver, the
presented and canonical addresses are identical, preserving direct mode.

When configured, the resolver is authoritative: `null` returns `404` and there
is no direct-address fallback. It returns one canonical address, which then
passes the normal integrity gates. Never store alias-to-alias chains.

This partial Worker policy assumes `env.control` is an application-owned,
strongly consistent plaintext policy service and `env.identity` verifies the
incoming request:

```ts
import {
  checksummedMeshIntegrityGate,
  createInterocitorMount,
  createMeshGrantAuthorizationMiddleware,
} from "@interocitor/workers";

const authorizeGrant = createMeshGrantAuthorizationMiddleware({
  authenticate: async ({ request }, env: Env) => env.identity.verify(request),
  loadGrantChain: async (subjectId, { canonicalAddress }, env: Env) =>
    env.control.loadCurrentGrantChain(subjectId, canonicalAddress),
  isTrustedRoot: async (root, { canonicalAddress }, env: Env) =>
    env.control.isPolicyRoot(root, canonicalAddress),
  concealDenied: true,
});

const mount = createInterocitorMount<Env>({
  mountPrefix: "/sync",
  db: (env) => env.DB,
  files: (env) => env.files,
  relay: (env) => env.RELAY,
  runtime: {
    resolveMeshRoute: async ({ presentedAddress }, env) => {
      const binding = await env.control.findActiveRoute(presentedAddress);
      return binding ? { canonicalAddress: binding.canonicalAddress } : null;
    },
    meshIntegrityGates: [checksummedMeshIntegrityGate],
    meshMiddleware: [authorizeGrant],
  },
});
```

The resolver runs for IO and new notify requests. Integrity gates,
`meshMiddleware`, file-store selection, durable-file upload policy, D1 keys,
and relay selection receive or use the canonical address. Gate and middleware
contexts also retain `presentedAddress`; the existing `address` field remains a
second name for the same `canonicalAddress` value.

The separately routed system handler remains canonical-addressed and does not
use `resolveMeshRoute`. Keep it behind host administrative policy. Recovery is
also a separate capability-addressed route and does not use mesh control.
The Worker reserves its internal `__interocitor_recovery__` D1 namespace: it
cannot be admitted directly as a public mesh or returned as a canonical route
target, even when a host integrity gate would otherwise allow it.

## Issue bounded grants

`MeshAccessGrant` is plaintext authorization metadata. A chain is ordered from
one trusted root to the authenticated leaf subject. Every child must:

- name its immediate parent;
- keep the same canonical address;
- be issued by the parent's subject;
- keep or reduce `full` to `readonly`, never widen `readonly` to `full`;
- use a strictly smaller delegation depth; and
- keep its validity window inside its parent's window.

`createMeshGrantAuthorizationMiddleware` loads and validates the current chain
on every admitted IO or notify request. A revoked, expired, not-yet-valid,
cyclic, malformed, or overlong chain fails closed. `readonly` permits Worker
read operations and new notify connections; `full` permits reads and writes.

Use `attenuateMeshGrant(parent, child)` when creating a delegated grant. It
constructs the parent link and rejects authority widening before persistence.
Use `markMeshGrantRevoked(grant)` to create the terminal revoked form, then
persist that state in the authoritative control store. Keep ancestors so a
revoked parent continues to invalidate every descendant.

The package intentionally does not add grant or route tables to the mailbox D1
schema and does not expose an administration endpoint. The host owns the
identity system, policy-root decision, durable control store, approval UI, and
the strongly protected route that issues or revokes access. An ordinary CRDT
mesh is not a safe live policy source: its protected rows are opaque to the
Worker and a mailbox can be stale or rolled back.

## Approve a new subject

Treat an approval inbox as another host-owned control endpoint, not as an
ordinary protected Interocitor mesh. It can store a request identifier,
server-verified subject, inviter, requested canonical mesh, and expiry in the
plaintext control store. It must not accept a client-supplied subject as proof
of identity or contain mesh keys.

Only the policy owner or a holder of a grant with remaining delegation depth
should be allowed to approve. Approval creates an attenuated child grant and a
new presented-route binding in the authoritative control store. The pairing
flow then carries the approved subject's final connection configuration; a
rejected or expired request receives no mesh credentials.

## Pair a protected route

Protected pairing uses the core pairing capability contract. Configure both
participants to support the grant and indirect-routing capability IDs, and
require the ones the deployment needs. A required capability is negotiated in
both directions before mesh credentials are accepted; unsupported peers fail
closed.

Use a public, separately authorized bootstrap adapter for the handshake relay.
After approval, put the recipient-specific final adapter configuration in
`connectionConfig`. That field travels only inside the ECDH-encrypted,
AES-GCM-protected credential envelope; public `adapterConfig` remains
credential-free bootstrap information.

Do not copy the inviter's route or bearer into the response. The application
must issue a route and request credential for the joining subject, then let the
recipient construct its final `CloudflareAdapter` from the returned
`connectionConfig`.

## Revoke access

For a subject-specific removal, do both operations in one authoritative policy
update when possible:

1. mark the subject's leaf grant, or an ancestor grant, revoked;
2. remove its presented-route binding.

Subsequent IO requests and new notify upgrades fail. Other subjects retain
their routes and grants, so neither the canonical address nor the shared mesh
passphrase needs to change for operational network revocation.

This guarantee has explicit limits:

- A client may keep plaintext and keys it already received. Mesh control cannot
  make those local copies unreadable.
- A previously opened relay socket is not closed by a later grant change. The
  socket carries invalidation metadata rather than mesh payloads; immediate
  per-subject socket closure needs a subject-aware relay extension.
- Core's normal `Interocitor` lifecycle writes device metadata and
  acknowledgements. Use `InterocitorReader` with a `readonly` grant when the
  client must consume the mesh without becoming a device or attempting writes.
- `full` authorizes Worker write operations, not an application's semantic
  action or claimed author. Review and tribunal services must derive the actor
  from server authentication and validate the application role instead of
  trusting an author field in a client payload.
- Recovery locators, alternate Worker deployments, and direct storage
  credentials are separate capabilities. Protect or revoke each independently.
- Do not cache positive route or grant decisions unless the deployment accepts
  and documents the resulting revocation delay.

For the underlying address and middleware contract, see
[Mesh addresses and access](mesh-access.md). For copied-key and metadata
boundaries, see [Cloudflare security guardrails](security-guardrails.md).
