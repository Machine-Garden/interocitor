<p align="center">
  <a href="https://github.com/TheUiTeam/interocitor">
    <img src="https://raw.githubusercontent.com/TheUiTeam/interocitor/main/docs/assets/hero.svg" alt="interocitor" width="560"/>
  </a>
</p>

# interocitor-workers

Cloudflare Workers runtime for [Interocitor](https://github.com/TheUiTeam/interocitor). Handles storage, sync, and optional realtime relay — all behind a single URL prefix in your existing Worker.

## Quick start

```ts
import { InterocitorRelayDurableObject, withInterocitor } from 'interocitor-workers';

const appWorker = {
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === '/') return new Response('app root');
    if (url.pathname === '/api/ping') return Response.json({ ok: true });
    return new Response('not found', { status: 404 });
  },
};

export { InterocitorRelayDurableObject };

export default withInterocitor(appWorker, {
  mountPrefix: '/sync',
  db: (env) => env.MY_DB,
  relay: (env) => env.MY_RELAY,
});
```

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

## Custom routing

If you need manual routing instead of wrapping the whole worker:

```ts
import { createInterocitorMount } from 'interocitor-workers';

const mount = createInterocitorMount({
  mountPrefix: '/sync',
  db: (env) => env.MY_DB,
  relay: (env) => env.MY_RELAY,
});

export { InterocitorRelayDurableObject } from 'interocitor-workers';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (mount.matches(url.pathname)) return mount.fetch(request, env, ctx);
    return appWorker.fetch(request, env, ctx);
  },
};
```

## Environment

| Variable | Required | Default | Description |
|---|---|---|---|
| `INTEROCITOR_ACCESS_TOKEN` | no | open | Shared secret for per-prefix HMAC tokens |
| `INTEROCITOR_SYSTEM_TOKEN` | no | disabled | Bearer token for system ops |
| `INTEROCITOR_ENABLE_SCHEDULED_MAINTENANCE` | no | `''` | Set `'1'` to run TTL sweeps in `scheduled` |
| `INTEROCITOR_PATH_TTL_HOURS` | no | `0` | Hours before inactive paths are deleted |
| `INTEROCITOR_MAX_CONTROL_BYTES` | no | `262144` | Max bytes for manifest/head/heartbeat files |
| `INTEROCITOR_MAX_CHANGE_BYTES` | no | `8388608` | Max bytes for change files |
| `INTEROCITOR_MAX_MAINLINE_BYTES` | no | `16777216` | Max bytes for mainline snapshots |
| `INTEROCITOR_MAX_GENERIC_FILE_BYTES` | no | `8388608` | Max bytes for other files |

## License

MIT
