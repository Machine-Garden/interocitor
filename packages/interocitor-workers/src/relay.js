export class InterocitorRelay {
  constructor(state, _env) {
    this.ctx = state;
  }

  async fetch(request) {
    const { pathname } = new URL(request.url);

    if (pathname === '/__connect') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }
      const pair = new WebSocketPair();
      // Hibernation API: the runtime manages the socket lifecycle.
      // The DO sleeps as soon as this fetch() returns and no other
      // event is pending.
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (pathname === '/__broadcast') {
      const payload = await request.text();
      const sockets = this.ctx.getWebSockets();
      for (const ws of sockets) {
        try {
          ws.send(payload);
        } catch {
          // Dead socket — runtime will fire webSocketClose/webSocketError
          // and clean it up.  Don't close manually here; let hibernation
          // handle the lifecycle.
        }
      }
      return new Response('ok');
    }

    if (pathname === '/__reset') {
      const sockets = this.ctx.getWebSockets();
      for (const ws of sockets) {
        try { ws.close(1000, 'reset'); } catch {}
      }
      return new Response(JSON.stringify({ cleared: sockets.length }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('not found', { status: 404 });
  }

  // Required for hibernation.  Clients don't send meaningful messages.
  async webSocketMessage(_ws, _msg) {}

  // Cleanup hook.  With hibernation, this fires even after the DO
  // has been evicted and reloaded — the runtime replays the event.
  async webSocketClose(_ws, _code, _reason) {}

  async webSocketError(ws, _error) {
    try { ws.close(1011, 'error'); } catch {}
  }
}

// ─── Worker-side broadcast helper ────────────────────────────────────────────
//
// Fire-and-forget from the Worker after a D1 write.
// If the DO binding is absent, this is a no-op — clients poll instead.

export function broadcast(env, ctx, prefix, payload) {
  const binding = env?.INTEROCITOR_RELAY;
  if (!binding) return;

  const stub = binding.get(binding.idFromName(prefix));
  const p = stub.fetch(new Request('https://internal/__broadcast', {
    method: 'POST',
    body: JSON.stringify(payload),
  })).catch(() => {});

  ctx?.waitUntil?.(p);
}

export function createRelayMount(relayBase, relayWorker) {
  const mountPrefix = `/${String(relayBase || '').trim().replace(/^\/+|\/+$/g, '')}`;

  function matches(pathname) {
    return Boolean(mountPrefix) && (pathname === mountPrefix || pathname.startsWith(`${mountPrefix}/`));
  }

  async function fetch(request, env, ctx) {
    if (!relayWorker || typeof relayWorker.fetch !== 'function') {
      return new Response('Relay not configured', { status: 501 });
    }
    const url = new URL(request.url);
    if (!matches(url.pathname)) return new Response('Not found', { status: 404 });
    url.pathname = url.pathname.slice(mountPrefix.length) || '/';
    return relayWorker.fetch(new Request(url.toString(), request), env, ctx);
  }

  return Object.freeze({ mountPrefix, matches, fetch });
}

export function withInterocitorRelay(relayBase, worker = {}, relayWorker) {
  const relay = createRelayMount(relayBase, relayWorker);
  const baseWorker = worker ?? {};
  return {
    ...baseWorker,
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (relay.matches(url.pathname)) return relay.fetch(request, env, ctx);
      if (typeof baseWorker.fetch === 'function') return baseWorker.fetch(request, env, ctx);
      return new Response('Not found', { status: 404 });
    },
    async scheduled(event, env, ctx) {
      if (typeof baseWorker.scheduled === 'function') return baseWorker.scheduled(event, env, ctx);
    },
  };
}
