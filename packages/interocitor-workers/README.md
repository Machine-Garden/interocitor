<p align="center">
  <a href="https://github.com/TheUiTeam/interocitor">
    <img src="https://raw.githubusercontent.com/TheUiTeam/interocitor/main/docs/assets/hero.svg" alt="interocitor" width="560"/>
  </a>
</p>

# interocitor-workers

Cloudflare Workers runtime for Interocitor-native transport flows.

## Shape

This package is split by responsibility:

- `src/worker.js` — thin Worker wiring, mount composition, auth, HTTP routes
- `src/ops.js` — semantic storage ops, re-exported from the spike implementation
- `src/relay.js` — separate relay wiring and compose helper for future paid-plan realtime paths
- `src/db-adapter.js` — database adapter seam
- `src/index.js` — stitch file only

## Clear separation

Your app stays the app.

Interocitor is one wrapped subsystem inside it.

App owns:
- app routes
- auth policy
- business logic
- non-Interocitor endpoints

Interocitor owns only the prefix you give it:
- `/<prefix>/health`
- `/<prefix>/io/*`
- `/<prefix>/__interocitor/*`

## Main API

```js
import { withInterocitor } from 'interocitor-workers';

const appWorker = {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/') {
      return new Response('app root');
    }

    if (url.pathname === '/api/ping') {
      return Response.json({ ok: true, source: 'app' });
    }

    return new Response('App route not found', { status: 404 });
  },
};

export default withInterocitor('/todo-interocitor', appWorker);
```

## Relay API

Relay is separate. End user installs and composes it only when wanted.

```js
import { InterocitorRelay, withInterocitorRelay } from 'interocitor-workers';

const appWorker = {
  async fetch() {
    return new Response('app route');
  },
};

const relayWorker = {
  async fetch(request, env, ctx) {
    const relay = new InterocitorRelay({}, env);
    return relay.fetch(request, env, ctx);
  },
};

export default withInterocitorRelay('/todo-interocitor-relay', appWorker, relayWorker);
```

## Notes

- cache is part of the semantic ops layer
- relay is optional
- database seam exists for future Hyperdrive / PlanetScale backends

## License

MIT
