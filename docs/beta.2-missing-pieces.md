# beta.2 missing pieces

## WebSocket-based invalidation

> Historical planning note. WebSocket invalidation now exists in the Workers package as an optional Durable Object relay. Treat the current Workers README as the source of truth for setup.

### Why SSE is removed

The original Cloudflare Worker implementation used Server-Sent Events (SSE) backed by a Durable Object for real-time invalidation. That model was removed because:

- Durable Object wall-clock billing is expensive for persistent connections
- SSE is not needed for correctness — Interocitor pull sync is already correct without it
- SSE was the only reason a Durable Object was required at all

### Current model

Pull-based sync remains sufficient for correctness: clients pull after local changes and on a configurable interval. Current Workers builds can also opt into WebSocket-based invalidation via `InterocitorRelayDurableObject`; that relay is an optimization that wakes clients to pull sooner, not a correctness requirement.

This is sufficient for most use cases and keeps realtime push optional.

### Future: WebSocket-based invalidation (Paid plan)

When realtime push is needed, the plan is to use the Cloudflare Workers [Hibernation API](https://developers.cloudflare.com/durable-objects/reference/websockets/#websocket-hibernation) rather than persistent SSE connections.

#### How it will work

Client opens a WebSocket to the Worker:

```
GET /todo-interocitor/ws/:prefix
Upgrade: websocket
Authorization: Bearer <access_token>
```

Worker accepts the WebSocket using `acceptWebSocket()` and stores it in the Durable Object (`InterocitorRelay`) using the hibernation API.

```js
// inside InterocitorRelay
async fetch(request, env, ctx) {
  const upgradeHeader = request.headers.get('Upgrade');
  if (upgradeHeader === 'websocket') {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
}
```

When a write happens, the Worker calls `broadcast()` to the relay:

```js
await broadcast(env, ctx, prefix, { type: 'file', path });
```

The relay sends a small invalidation message to all hibernated sockets for that prefix:

```js
webSocketMessage(ws, message) {
  // clients echo back to confirm liveness
}

// on broadcast
for (const ws of this.ctx.getWebSockets()) {
  ws.send(JSON.stringify({ type: 'invalidation', path, ts: Date.now() }));
}
```

Client receives message and calls `pull()` immediately instead of waiting for next poll interval.

#### Why hibernation not persistent connection

- Hibernated WebSockets cost nothing while idle
- Runtime wakes DO only on message
- No wall-clock billing while waiting
- Correct for mobile/battery-sensitive clients

#### What needs to change in adapters

Both `CloudflareAdapter` (JS/TS) and `CloudflareStorageAdapter` (Swift) need:

1. Remove SSE subscriber logic (`subscribeToInvalidations` SSE path)
2. Replace with optional WebSocket connection
3. WebSocket message handler calls existing `invalidate()` / `onInvalidation` callback
4. Reconnect logic on close/error (exponential backoff)
5. Fall back to poll interval if WebSocket unavailable

#### JS adapter change (`packages/interocitor/src/adapters/cloudflare.ts`)

Current SSE path:
```ts
subscribeToInvalidations(onInvalidation: ...) {
  const source = new EventSource(this.eventsUrl);
  source.onmessage = (e) => onInvalidation(JSON.parse(e.data));
  // ...
}
```

Replace with:
```ts
subscribeToInvalidations(onInvalidation: ...) {
  const ws = new WebSocket(`${this.config.workerBaseUrl}/ws/${this.config.namespace}`);
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'invalidation') onInvalidation(msg);
  };
  ws.onclose = () => /* reconnect with backoff */;
  // ...
}
```

#### Swift adapter change (`packages/interocitor-swift/Sources/InterocitorSwift/CloudflareStorageAdapter.swift`)

Current SSE path: `SSETask` class and `SSEDelegate`.

Replace with:
- `URLSessionWebSocketTask`
- message receive loop
- reconnect on cancel/error
- call existing `onInvalidation` handler on message

#### Wrangler binding

App that wants relay enables it:

```toml
[[durable_objects.bindings]]
name = "INTEROCITOR_RELAY"
class_name = "InterocitorRelay"

[[migrations]]
tag = "v1"
new_classes = ["InterocitorRelay"]
```

App that does not want relay pays nothing extra.

#### Integration model

Relay is opt-in and installed separately by the end user:

```js
import { withInterocitor, withInterocitorRelay, InterocitorRelay } from 'interocitor-workers';

const appWorker = { ... };

export default withInterocitorRelay(
  '/todo-interocitor-relay',
  withInterocitor('/todo-interocitor', appWorker),
  { fetch: relayFetch }
);

export { InterocitorRelay };
```

Or deployed as a completely separate Worker if app team prefers full isolation.

### Not in scope now

- Long polling (adds Worker CPU cost per idle request)
- SSE (DO wall-clock cost)
- Server-side merge (breaks encryption guarantee)
