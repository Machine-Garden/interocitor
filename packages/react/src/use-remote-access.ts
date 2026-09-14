import { useDebugValue, useMemo, useSyncExternalStore } from "react";
import type { Interocitor, InterocitorReader, RemoteAccessError } from "@interocitor/core";

export type { RemoteAccessError, RemoteAccessKind } from "@interocitor/core";

function subscribeToRemoteAccess<S extends Record<string, Record<string, unknown>>>(
  db: Interocitor<S> | InterocitorReader<S>,
  notify: () => void,
): () => void {
  return db.on((event) => {
    if (
      event.type === "remote:access" ||
      event.type === "remote:access:restored" ||
      event.type === "connection:status" ||
      event.type === "transport:teardown"
    )
      notify();
  });
}

/**
 * The negative access decision that paused remote sync, or `null`.
 *
 * Non-null after the remote answered 401 (`unauthenticated`), 403
 * (`forbidden`), or a mesh-level 404 (`not-found`). The engine has stopped
 * polling and publishing for the mesh; local reads and writes still work.
 * React to it: open the provider's sign-in, show a read-only banner, or leave
 * the mesh, then give the adapter the new credential and call `db.connect()`.
 *
 * Temporary conditions (429, 503) never set this value; observe them through
 * `db.on` and the `remote:access` event when needed.
 */
export function useRemoteAccess<S extends Record<string, Record<string, unknown>>>(
  db: Interocitor<S> | InterocitorReader<S>,
): RemoteAccessError | null {
  const getSnapshot = (): RemoteAccessError | null => db.getRemoteAccessError();

  const subscribe = useMemo(
    () => (notify: () => void) => subscribeToRemoteAccess(db, notify),
    [db],
  );

  const error = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useDebugValue(error ? `${error.kind} (${error.status})` : "ok");
  return error;
}
