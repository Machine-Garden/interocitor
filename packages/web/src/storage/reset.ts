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
    const req = indexedDB.deleteDatabase(dbName);
    req.onsuccess = () => resolve();
    req.onerror = () =>
      reject(req.error ?? new Error(`Failed to delete IndexedDB database "${dbName}"`));
    req.onblocked = () => {
      reject(
        new Error(`Cannot delete IndexedDB database "${dbName}" while another connection is open`),
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
 * - `'blocked'` — another connection prevented deletion; safe to rotate name.
 * - `'timed-out'` — neither success nor block fired within the deadline.
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
