import { useDebugValue, useMemo, useSyncExternalStore } from 'react';
import type { ConnectionStatus, Interocitor } from '@interocitor/core';

export type { ConnectionStatus, ConnectionStatusDetails } from '@interocitor/core';

function subscribeToStatus<S extends Record<string, Record<string, unknown>>>(
  db: Interocitor<S>,
  notify: () => void,
): () => void {
  return db.on((event) => {
    if (event.type === 'connection:status' || event.type === 'mesh:configured' || event.type === 'transport:teardown') notify();
  });
}

/**
 * Subscribe to Interocitor's primitive communication status.
 *
 * This is intentionally only the sync/transport phase:
 * `offline`, `connecting`, `syncing`, or `idle`.
 * Solo/local-only mode is a separate boolean gate; use `useIsSolo(db)`.
 */
export function useConnectionStatus<S extends Record<string, Record<string, unknown>>>(
  db: Interocitor<S>,
): ConnectionStatus {
  const getSnapshot = (): ConnectionStatus => db.getConnectionStatus();

  const subscribe = useMemo(
    () => (notify: () => void) => subscribeToStatus(db, notify),
    [db],
  );

  const status = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useDebugValue(status);
  return status;
}

/** Boolean gate for local-only / no-mesh mode. Not a communication status. */
export function useIsSolo<S extends Record<string, Record<string, unknown>>>(
  db: Interocitor<S>,
): boolean {
  const getSnapshot = (): boolean => db.getConnectionStatusDetails().solo;

  const subscribe = useMemo(
    () => (notify: () => void) => subscribeToStatus(db, notify),
    [db],
  );

  const solo = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useDebugValue(solo ? 'solo' : 'mesh');
  return solo;
}
