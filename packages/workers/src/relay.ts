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
      let sent = 0;
      let failed = 0;
      for (const ws of sockets) {
        try {
          ws.send(payload);
          sent++;
        } catch {
          failed++;
          // Dead socket — runtime cleanup handles it.
        }
      }
      return new Response(JSON.stringify({ ok: failed === 0, connected: sockets.length, sent, failed }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (pathname === '/__status') {
      return new Response(JSON.stringify({ ok: true, connected: this.ctx.getWebSockets().length }), {
        headers: { 'Content-Type': 'application/json' },
      });
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
export interface BroadcastDiagnostics {
  verbose?: boolean;
  logger?: Pick<Console, 'debug' | 'warn'>;
}

export function broadcast(
  relay: DurableObjectNamespace | undefined,
  ctx: ExecutionContextLike | undefined,
  prefix: string,
  payload: unknown,
  diagnostics: BroadcastDiagnostics = {},
): void {
  const logger = diagnostics.logger ?? console;
  if (!relay) {
    if (diagnostics.verbose) logger.warn('[interocitor:relay] broadcast skipped: relay binding not configured', { prefix });
    return;
  }

  const stub = relay.get(relay.idFromName(prefix));
  const broadcastPromise = stub
    .fetch(
      new Request('https://internal/__broadcast', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    )
    .then(async (response) => {
      const result = await response.json().catch(() => ({ ok: response.ok }));
      if (!response.ok || (typeof result === 'object' && result !== null && 'failed' in result && Number(result.failed) > 0)) {
        logger.warn('[interocitor:relay] broadcast incomplete', { prefix, status: response.status, result });
        return;
      }
      if (diagnostics.verbose) logger.debug('[interocitor:relay] broadcast delivered', { prefix, result });
    })
    .catch((error) => {
      logger.warn('[interocitor:relay] broadcast failed', {
        prefix,
        error: error instanceof Error ? error.message : String(error),
      });
    });

  ctx?.waitUntil?.(broadcastPromise);
}
