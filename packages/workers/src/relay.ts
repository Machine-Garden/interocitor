import type {
  DurableObjectNamespace,
  DurableObjectStateLike,
  ExecutionContextLike,
  InterocitorEnv,
} from './types.ts';

/**
 * Durable Object implementation for the Interocitor WebSocket relay.
 *
 * Export this class from your Worker entry and bind it in `wrangler.toml`
 * using any binding name you want. Pass that binding to `withInterocitor(...)`
 * via the `relay` getter.
 */
export class InterocitorRelayDurableObject {
  private readonly ctx: DurableObjectStateLike;

  constructor(state: DurableObjectStateLike, _env: InterocitorEnv) {
    this.ctx = state;
  }

  /** Handle relay control endpoints inside the Durable Object. */
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === '/__connect') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }
      const pair = new WebSocketPair();
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
          // Dead socket — runtime cleanup handles it.
        }
      }
      return new Response('ok');
    }

    if (pathname === '/__reset') {
      const sockets = this.ctx.getWebSockets();
      for (const ws of sockets) {
        try {
          ws.close(1000, 'reset');
        } catch {
          // Ignore close failure.
        }
      }
      return new Response(JSON.stringify({ cleared: sockets.length }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('not found', { status: 404 });
  }

  /** Called by the runtime when a hibernated socket sends a message. */
  async webSocketMessage(_ws: WebSocket, _msg: ArrayBuffer | string): Promise<void> {}

  /** Called by the runtime when a hibernated socket closes. */
  async webSocketClose(_ws: WebSocket, _code: number, _reason: string): Promise<void> {}

  /** Called by the runtime when a hibernated socket errors. */
  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    try {
      ws.close(1011, 'error');
    } catch {
      // Ignore close failure.
    }
  }
}

/**
 * Fan out a JSON payload to all clients connected to the relay instance for
 * the given prefix. Fire-and-forget.
 */
export function broadcast(
  relay: DurableObjectNamespace | undefined,
  ctx: ExecutionContextLike | undefined,
  prefix: string,
  payload: unknown,
): void {
  if (!relay) return;

  const stub = relay.get(relay.idFromName(prefix));
  const broadcastPromise = stub
    .fetch(
      new Request('https://internal/__broadcast', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    )
    .catch(() => undefined);

  ctx?.waitUntil?.(broadcastPromise);
}
