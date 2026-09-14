// compass: interocitor.rows.local-store

/**
 * Delete an Interocitor IndexedDB database after callers have disconnected
 * and cleared credentials.
 *
 * This is intentionally low-level: it only deletes the local IndexedDB
 * database named by `dbName`. Apps should call it as the final destructive
 * local reset step, then reload before creating or joining a new mesh.
 */
export function resetLocalDatabase(dbName = "interocitor"): Promise<void> {
  return new Promise((resolve, reject) => {
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
    req.onsuccess = () => finish();
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

export type ResetLocalDatabaseOutcome = "deleted" | "blocked" | "timed-out" | "errored";

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
 */
export function resetLocalDatabaseWithDeadline(
  dbName: string,
  timeoutMs = 1_500,
): Promise<ResetLocalDatabaseOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: ResetLocalDatabaseOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    try {
      const req = indexedDB.deleteDatabase(dbName);
      req.onsuccess = () => finish("deleted");
      req.onerror = () => finish("errored");
      req.onblocked = () => finish("blocked");
    } catch {
      finish("errored");
      return;
    }
    setTimeout(() => finish("timed-out"), timeoutMs);
  });
}
