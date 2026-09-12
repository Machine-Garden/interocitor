// compass: interocitor.mailbox-host.relay

import type {
  DurableObjectNamespace,
  DurableObjectStateLike,
  ExecutionContextLike,
} from "./types.ts";

const RELAY_BROADCAST_BATCH_DELAY_MS = 1_000;

/**
 * Durable Object implementation for optional mesh invalidation signals.
 *
 * Export this class from the Worker entry, bind it under any environment name,
 * and pass that binding through the mount's `relay` getter. Sync correctness
 * remains polling-based when the relay is absent or unavailable.
 *
 * @see {@link ../docs/relay.md | Realtime invalidation relay}
 *   — the wrangler binding, what the relay carries, and what it deliberately
 *   does not make authoritative.
 */
export class InterocitorRelayDurableObject {
  private readonly ctx: DurableObjectStateLike;
  private pendingBroadcastPayload: string | null = null;
  private pendingBroadcastTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(state: DurableObjectStateLike, _env: unknown) {
    this.ctx = state;
  }

  private flushPendingBroadcast(): { connected: number; sent: number; failed: number } {
    const payload = this.pendingBroadcastPayload;
    this.pendingBroadcastPayload = null;
    if (this.pendingBroadcastTimer) {
      clearTimeout(this.pendingBroadcastTimer);
      this.pendingBroadcastTimer = null;
    }
    const sockets = this.ctx.getWebSockets();
    if (!payload) return { connected: sockets.length, sent: 0, failed: 0 };
    let sent = 0;
    let failed = 0;
    for (const ws of sockets) {
      try {
        ws.send(payload);
        sent++;
      } catch {
        failed++;
      }
    }
    return { connected: sockets.length, sent, failed };
  }

  private scheduleBroadcastFlush(): void {
    if (this.pendingBroadcastTimer) return;
    this.pendingBroadcastTimer = setTimeout(() => {
      this.flushPendingBroadcast();
    }, RELAY_BROADCAST_BATCH_DELAY_MS);
  }

  /** Handle relay control endpoints inside the Durable Object. */
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/__connect") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (pathname === "/__broadcast") {
      this.pendingBroadcastPayload = await request.text();
      this.scheduleBroadcastFlush();
      return new Response(
        JSON.stringify({ ok: true, queued: true, delayMs: RELAY_BROADCAST_BATCH_DELAY_MS }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (pathname === "/__status") {
      return new Response(
        JSON.stringify({
          ok: true,
          connected: this.ctx.getWebSockets().length,
          pendingBroadcast: this.pendingBroadcastPayload !== null,
          batchDelayMs: RELAY_BROADCAST_BATCH_DELAY_MS,
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (pathname === "/__reset") {
      const sockets = this.ctx.getWebSockets();
      for (const ws of sockets) {
        try {
          ws.close(1000, "reset");
        } catch {
          // Ignore close failure.
        }
      }
      this.pendingBroadcastPayload = null;
      if (this.pendingBroadcastTimer) {
        clearTimeout(this.pendingBroadcastTimer);
        this.pendingBroadcastTimer = null;
      }
      return new Response(JSON.stringify({ cleared: sockets.length }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("not found", { status: 404 });
  }

  /** Called by the runtime when a hibernated socket sends a message. */
  async webSocketMessage(_ws: WebSocket, _msg: ArrayBuffer | string): Promise<void> {}

  /** Called by the runtime when a hibernated socket closes. */
  async webSocketClose(_ws: WebSocket, _code: number, _reason: string): Promise<void> {}

  /** Called by the runtime when a hibernated socket errors. */
  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    try {
      ws.close(1011, "error");
    } catch {
      // Ignore close failure.
    }
  }
}

/** Optional logging controls for {@link broadcast}. */
export interface BroadcastDiagnostics {
  /** Log successful delivery and a missing relay binding. Default: `false`. */
  verbose?: boolean;
  /** Logging sink for relay diagnostics. Default: `console`. */
  logger?: Pick<Console, "debug" | "warn">;
}

/**
 * Queue a relay broadcast for one mesh address.
 *
 * This is intentionally fire-and-forget. Delivery success or failure is
 * reported only through the optional diagnostics logger and `waitUntil`.
 *
 * @see {@link ../docs/relay.md | Realtime invalidation relay}
 *   — why a dropped broadcast costs a poll interval rather than correctness.
 */
export function broadcast(
  relay: DurableObjectNamespace | undefined,
  ctx: ExecutionContextLike | undefined,
  address: string,
  payload: unknown,
  diagnostics: BroadcastDiagnostics = {},
): void {
  const logger = diagnostics.logger ?? console;
  if (!relay) {
    if (diagnostics.verbose)
      logger.warn("[interocitor:relay] broadcast skipped: relay binding not configured", {
        address,
      });
    return;
  }

  const stub = relay.get(relay.idFromName(address));
  const broadcastPromise = stub
    .fetch(
      new Request("https://internal/__broadcast", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    )
    .then(async (response) => {
      const result = await response.json().catch(() => ({ ok: response.ok }));
      if (
        !response.ok ||
        (typeof result === "object" &&
          result !== null &&
          "failed" in result &&
          Number(result.failed) > 0)
      ) {
        logger.warn("[interocitor:relay] broadcast incomplete", {
          address,
          status: response.status,
          result,
        });
        return;
      }
      if (diagnostics.verbose)
        logger.debug("[interocitor:relay] broadcast delivered", { address, result });
    })
    .catch((error) => {
      logger.warn("[interocitor:relay] broadcast failed", {
        address,
        error: error instanceof Error ? error.message : String(error),
      });
    });

  ctx?.waitUntil?.(broadcastPromise);
}
