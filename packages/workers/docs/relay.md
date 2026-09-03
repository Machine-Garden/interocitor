# Realtime invalidation relay

Use the relay when connected clients should learn about successful writes and
deletes without waiting for the next poll. Sync correctness remains based on
polling and pull; the relay carries invalidation signals only.

The TypeScript and TOML snippets are partial additions to an existing protected
mesh mount. The complete runnable Worker and opt-in browser test live in the
[Cloudflare TODO app example](../../../examples/todo-cloudflare-do/README.md).

## Configure the Durable Object

Starting from the protected named-mesh policy in [Mesh addresses and
access](mesh-access.md), add the relay binding and exported Durable Object:

```ts
import { InterocitorRelayDurableObject, withInterocitor } from "@interocitor/workers";

export { InterocitorRelayDurableObject };

export default withInterocitor(appWorker, {
  mountPrefix: "/sync",
  db: (env) => env.DB,
  relay: (env) => env.RELAY,
  runtime: {
    meshIntegrityGates: [({ address }) => address === "main"],
    meshMiddleware: [authorizeMesh],
  },
});
```

```toml
[[durable_objects.bindings]]
name = "RELAY"
class_name = "InterocitorRelayDurableObject"

[[migrations]]
tag = "v1"
new_classes = ["InterocitorRelayDurableObject"]
```

The mount claims `/sync/notify/<address>`. Notify requests pass the same
integrity gates and mesh middleware as IO requests, with `surface: 'notify'`
and `access: 'read'`. Without a relay binding, the route returns `501` and
clients continue polling.

`CloudflareAdapter.token` is sent as an `Authorization` bearer for IO and as
the `access_token` query parameter for browser WebSocket connections. An
application authorizer may inspect either representation, use cookies, or use
another host-owned credential mechanism. Query-string credentials can appear
in infrastructure logs; prefer a cookie or a one-purpose relay credential when
that exposure matters.

`GET /sync/notify/<address>/health` passes that same request pipeline and then
returns relay status including the connected-socket count.

Route removal or grant revocation blocks the next notify upgrade, but does not
close a socket that was already accepted. The current relay does not retain a
subject or grant identifier on each connection. Its messages are invalidation
signals rather than mesh payloads; deployments that require immediate
per-subject socket closure need a subject-aware relay extension. Polling and
subsequent IO requests still pass current authorization.

`runtime.verbose` logs missing relay bindings and successful delivery. Failed
broadcasts produce warnings regardless of verbose mode.

`broadcast(...)` is fire-and-forget. When an execution context is supplied it
passes the internal request to `ctx.waitUntil(...)`; delivery status is
available only through diagnostics. The Durable Object batches for one second
and keeps the latest pending payload for that mesh address, so several writes
inside the window can produce one invalidation. Clients must treat every
payload as “pull current state,” not as a complete mutation log.

The runnable Cloudflare example and its opt-in browser test are under
[`examples/todo-cloudflare-do`](../../../examples/todo-cloudflare-do/README.md).
