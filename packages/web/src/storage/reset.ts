// compass: interocitor.rows.local-store

import {
  hasUnpushedLocalWrites,
  setUnpushedLocalWrites,
  UnpushedLocalWritesError,
} from "./resilient-store.ts";
import type { KeyValueSlots } from "./resilient-store.ts";

export interface ResetLocalDatabaseOptions {
  /** Delete even when the database holds writes the remote has never seen. */
  force?: boolean;
  /** Override the unpushed-marker slots (tests, SSR). */
  unpushedSlots?: KeyValueSlots;
}

/**
 * Delete an Interocitor IndexedDB database after callers have disconnected
 * and cleared credentials.
 *
 * This is intentionally low-level: it only deletes the local IndexedDB
 * database named by `dbName`. Apps should call it as the final destructive
 * local reset step, then reload before creating or joining a new mesh.
 *
 * Refuses with {@link UnpushedLocalWritesError} when the database is marked as
 * holding change history the remote has never seen. Pass `{ force: true }` to
 * delete anyway — that is the explicit "discard my unsynced work" gesture, and
 * it must come from the user, not from a recovery heuristic.
 *
 * Caveat that outlives this function: deletion unlinks the *logical* database.
 * IndexedDB is backed by LevelDB (Chromium) or SQLite (WebKit), and neither
 * promises that the underlying blocks are overwritten. Treat this as "the app
 * can no longer read it", never as "the bytes are gone".
 */
export function resetLocalDatabase(
  dbName = "interocitor",
  options: ResetLocalDatabaseOptions = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!options.force && hasUnpushedLocalWrites(dbName, options.unpushedSlots)) {
      reject(new UnpushedLocalWritesError(dbName, "reset"));
      return;
    }
    let blockedTimer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (blockedTimer) clearTimeout(blockedTimer);
      if (error) reject(error);
      else resolve();
    };
    const req = indexedDB.deleteDatabase(dbName);
    req.onsuccess = () => {
      // The database is gone; its unpushed-writes marker must not outlive it
      // and block an unrelated future database that reuses the name.
      setUnpushedLocalWrites(dbName, false, options.unpushedSlots);
      finish();
    };
    req.onerror = () =>
      finish(req.error ?? new Error(`Failed to delete IndexedDB database "${dbName}"`));
    req.onblocked = () => {
      // WebKit can briefly retain a handle after close(). Allow it to drain.
      // IndexedDB deletion requests cannot be cancelled: after this promise
      // rejects, the request remains queued and may delete the database later.
      if (blockedTimer) return;
      blockedTimer = setTimeout(
        () =>
          finish(
            new Error(
              `Deletion of IndexedDB database "${dbName}" is still blocked by an open connection. ` +
                `The browser request remains queued and may complete later; do not reuse this physical name.`,
            ),
          ),
        1_000,
      );
    };
  });
}

export type ResetLocalDatabaseOutcome =
  | "deleted"
  | "blocked"
  | "timed-out"
  | "errored"
  | "refused-unpushed-writes";

/**
 * Same as `resetLocalDatabase`, but never hangs and never throws.
 *
 * The default `resetLocalDatabase` call can stay pending forever if another
 * tab keeps the DB open (the IndexedDB spec keeps deleteDatabase blocked
 * until all connections close). For the "will never stuck" contract, this
 * variant returns a deterministic outcome within `timeoutMs`.
 *
 * - `'deleted'` — the database was successfully deleted.
 * - `'blocked'` — another connection delayed deletion. The request remains
 *   queued and may still complete, so rotate rather than reusing this name.
 * - `'timed-out'` — neither success nor block fired within the deadline. The
 *   request may still complete later; rotate rather than reusing this name.
 * - `'errored'` — the request emitted an explicit error.
 * - `'refused-unpushed-writes'` — the database holds change history the remote
 *   has never seen and `force` was not set. Nothing was requested or deleted.
 */
export function resetLocalDatabaseWithDeadline(
  dbName: string,
  timeoutMs = 1_500,
  options: ResetLocalDatabaseOptions = {},
): Promise<ResetLocalDatabaseOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: ResetLocalDatabaseOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    if (!options.force && hasUnpushedLocalWrites(dbName, options.unpushedSlots)) {
      finish("refused-unpushed-writes");
      return;
    }
    try {
      const req = indexedDB.deleteDatabase(dbName);
      req.onsuccess = () => {
        setUnpushedLocalWrites(dbName, false, options.unpushedSlots);
        finish("deleted");
      };
      req.onerror = () => finish("errored");
      req.onblocked = () => finish("blocked");
    } catch {
      finish("errored");
      return;
    }
    setTimeout(() => finish("timed-out"), timeoutMs);
  });
}
