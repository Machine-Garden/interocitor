import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConnectedStoreCredentials, Interocitor } from "@interocitor/core";

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Result of `useConnectedStores`.
 *
 * `credentials` is the latest snapshot of all sub-store credentials stored
 * in the parent Interocitor. `refresh` re-reads from the vault. `put`,
 * `remove`, and `get` proxy the engine's `connectedStores` API and refresh
 * the local snapshot on success.
 */
export interface UseConnectedStoresResult {
  credentials: ConnectedStoreCredentials[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  get: (id: string) => Promise<ConnectedStoreCredentials | null>;
  put: (credentials: ConnectedStoreCredentials) => Promise<ConnectedStoreCredentials>;
  remove: (id: string) => Promise<boolean>;
}

/**
 * Read and mutate the parent Interocitor's connected-store credential
 * vault. Returns the current credentials list and stable proxy methods
 * that refresh the snapshot after each mutation.
 *
 * @example
 * const { credentials, put, remove } = useConnectedStores(db);
 * await put({ id: 'reviews', remotePath: '/family/reviews', passphrase: null, encrypted: false, dbName: 'reviews-db' });
 */
export function useConnectedStores(db: Interocitor<any>): UseConnectedStoresResult {
  const [credentials, setCredentials] = useState<ConnectedStoreCredentials[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const aliveRef = useRef(true);
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    if (aliveRef.current) setLoading(true);
    try {
      const next = await db.connectedStores.list();
      if (aliveRef.current && request === requestRef.current) {
        setCredentials(next);
        setError(null);
      }
    } catch (err) {
      if (aliveRef.current && request === requestRef.current) setError(toError(err));
    } finally {
      if (aliveRef.current && request === requestRef.current) setLoading(false);
    }
  }, [db]);

  useEffect(() => {
    aliveRef.current = true;
    void refresh();
    return () => {
      aliveRef.current = false;
      requestRef.current += 1;
    };
  }, [refresh]);

  const get = useCallback((id: string) => db.connectedStores.get(id), [db]);

  const put = useCallback(
    async (creds: ConnectedStoreCredentials) => {
      const stored = await db.connectedStores.put(creds);
      await refresh();
      return stored;
    },
    [db, refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      const ok = await db.connectedStores.remove(id);
      if (ok) await refresh();
      return ok;
    },
    [db, refresh],
  );

  return useMemo(
    () => ({ credentials, loading, error, refresh, get, put, remove }),
    [credentials, loading, error, refresh, get, put, remove],
  );
}

/** Result of `useConnectedStore`. */
export interface UseConnectedStoreResult {
  credentials: ConnectedStoreCredentials | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

/**
 * Read a single sub-store's credentials by id. Refreshes when `id`
 * changes; mutations performed elsewhere are not auto-observed (the
 * vault has no change notification yet — call `refresh()` after a write
 * if needed).
 */
export function useConnectedStore(db: Interocitor<any>, id: string): UseConnectedStoreResult {
  const [credentials, setCredentials] = useState<ConnectedStoreCredentials | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const aliveRef = useRef(true);
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    if (aliveRef.current) setLoading(true);
    try {
      const next = await db.connectedStores.get(id);
      if (aliveRef.current && request === requestRef.current) {
        setCredentials(next);
        setError(null);
      }
    } catch (err) {
      if (aliveRef.current && request === requestRef.current) setError(toError(err));
    } finally {
      if (aliveRef.current && request === requestRef.current) setLoading(false);
    }
  }, [db, id]);

  useEffect(() => {
    aliveRef.current = true;
    void refresh();
    return () => {
      aliveRef.current = false;
      requestRef.current += 1;
    };
  }, [refresh]);

  return useMemo(
    () => ({ credentials, loading, error, refresh }),
    [credentials, loading, error, refresh],
  );
}
