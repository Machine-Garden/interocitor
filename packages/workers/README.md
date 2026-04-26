<p align="center">
  <a href="https://github.com/TheUiTeam/interocitor">
    <img src="https://raw.githubusercontent.com/TheUiTeam/interocitor/main/docs/assets/hero.svg" alt="interocitor" width="560"/>
  </a>
</p>

# @interocitor/workers

Cloudflare Workers runtime for [Interocitor](https://github.com/TheUiTeam/interocitor). Handles storage, sync, and optional realtime relay — all behind a single URL prefix in your existing Worker.

## Quick start

```ts
import { InterocitorRelayDurableObject, withInterocitor } from '@interocitor/workers';

interface Env {
  MY_DB: D1Database;
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

```toml
[[d1_databases]]
binding = "MY_DB"
# other Wrangler fields...

[[durable_objects.bindings]]
name = "MY_RELAY"
class_name = "InterocitorRelayDurableObject"

[[migrations]]
tag = "v1"
new_classes = ["InterocitorRelayDurableObject"]
```

Binding names are yours. Pass them to `withInterocitor(...)` via getters.

### Realtime relay: what `InterocitorRelayDurableObject` does

`InterocitorRelayDurableObject` is the optional Durable Object behind Interocitor's notify WebSocket route.

- `withInterocitor(..., { relay: (env) => env.MY_RELAY })` enables `/<mountPrefix>/notify/<prefix>`.
- The Worker authenticates that route with the same per-prefix access-token rule as `/<mountPrefix>/io/<prefix>`.
- The relay stores WebSockets using Cloudflare's hibernation API (`acceptWebSocket`) and can fan out tiny invalidation messages with `broadcast(...)`.
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
}
```

Only `db` is required. Everything else is optional.

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

## License

MIT
