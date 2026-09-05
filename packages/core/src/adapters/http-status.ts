/**
 * Shared HTTP status classification for storage adapters.
 *
 * Adapters call these helpers at every fetch site so that an access decision
 * from the remote (401, 403, mesh-level 404, 429, 503) becomes a typed
 * {@link RemoteAccessError} instead of an opaque `Error` whose only signal is
 * a status number buried in the message text.
 */

import { RemoteAccessError } from "../core/errors.ts";

export interface HttpFailureContext {
  adapter: string;
  operation: string;
  path?: string;
  /**
   * Treat 404 as an access outcome. Set this for mesh-level routes (health,
   * folder listing, ensure-folder) where a missing address means "no such
   * mesh for you"; leave it unset for file-level routes where 404 is an
   * ordinary missing file.
   */
  notFoundIsAccess?: boolean;
}

interface StatusLike {
  status: number;
  headers?: { get(name: string): string | null };
}

/** Parse a `Retry-After` header (seconds or HTTP date) into milliseconds. */
export function retryAfterMs(res: StatusLike): number | undefined {
  const raw = res.headers?.get("Retry-After");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(raw);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return undefined;
}

/**
 * Return a {@link RemoteAccessError} when the response status expresses an
 * access decision, otherwise `null`.
 */
export function remoteAccessError(
  res: StatusLike,
  ctx: HttpFailureContext,
): RemoteAccessError | null {
  const kind = RemoteAccessError.kindForStatus(res.status, ctx.notFoundIsAccess);
  if (!kind) return null;
  return new RemoteAccessError({
    status: res.status,
    kind,
    adapter: ctx.adapter,
    operation: ctx.operation,
    path: ctx.path,
    retryAfterMs: retryAfterMs(res),
  });
}

/**
 * Build the error to throw for a failed response: a typed
 * {@link RemoteAccessError} for access statuses, otherwise an ordinary
 * `Error` carrying `fallbackMessage` and the status.
 */
export function httpFailure(
  res: StatusLike,
  ctx: HttpFailureContext,
  fallbackMessage: string,
): Error {
  return remoteAccessError(res, ctx) ?? new Error(`${fallbackMessage}: HTTP ${res.status}`);
}

/**
 * Throw when the response expresses an access decision; return silently for
 * every other status so the caller keeps its existing handling.
 */
export function throwIfAccessDenied(res: StatusLike, ctx: HttpFailureContext): void {
  const err = remoteAccessError(res, ctx);
  if (err) throw err;
}
