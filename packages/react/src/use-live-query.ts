import { useMemo, useRef, useSyncExternalStore } from 'react';
import type { QueryResult } from '@interocitor/core';

export interface UseLiveQueryResult<R> {
  /** `undefined` until first fetch resolves. */
  data: R | undefined;
  loading: boolean;
  error: Error | null;
}

/**
 * React hook for live Interocitor queries.
 *
 * Backed by the engine's async query cache (core-owned). Multiple components
 * with the same query share one snapshot, one in-flight load, and one stable
 * cache entry — no duplicate fetches, no flash of absent data on remount or
 * sibling mount, and stale rows stay visible while a refresh is in-flight.
 *
 * Re-fetches when:
 *   - `deps` change (new descriptor → new cache entry)
 *   - the underlying table emits a change/delete event (engine invalidates,
 *     this hook re-reads the snapshot)
 *
 * @param factory — returns a `QueryResult<T>`. Re-invoked when `deps` change.
 * @param deps — dependency array (same semantics as `useMemo`).
 * @param selector — optional transform. Pure on `rows`. Memoized against
 *                   the cached rows reference, so unchanged rows skip re-runs.
 */
export function useLiveQuery<T extends Record<string, unknown>>(
  factory: () => QueryResult<T>,
  deps: readonly unknown[],
): UseLiveQueryResult<T[]>;
export function useLiveQuery<T extends Record<string, unknown>, R>(
  factory: () => QueryResult<T>,
  deps: readonly unknown[],
  selector: (rows: T[]) => R,
): UseLiveQueryResult<R>;
export function useLiveQuery<T extends Record<string, unknown>, R = T[]>(
  factory: () => QueryResult<T>,
  deps: readonly unknown[],
  selector?: (rows: T[]) => R,
): UseLiveQueryResult<R> {
  // Build the descriptor-bearing query handle from user deps.
  // Identity stays stable across renders that don't change deps, so the
  // useSyncExternalStore subscription below stays attached to one entry.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const query = useMemo(() => factory(), deps);

  // Kick a load on first mount per query (and per deps change). The engine
  // dedupes concurrent loads and serves cached rows synchronously to peers.
  const startedRef = useRef<QueryResult<T> | null>(null);
  if (startedRef.current !== query) {
    startedRef.current = query;
    void query.load();
  }

  const subscribe = useMemo(
    () => (notify: () => void) => {
      let active = true;
      const notifyWhenLoaded = () => {
        void query.load().finally(() => {
          if (active) notify();
        });
      };

      // `useSyncExternalStore` only re-reads snapshots after `notify()`.
      // The render-time `query.load()` above populates the async cache, but
      // promise completion itself is not an external-store event. Bridge that
      // first load, and every table invalidation, back into React.
      notifyWhenLoaded();
      const unsubscribe = query.subscribe(() => {
        notify(); // keep stale data visible immediately while refresh is pending
        notifyWhenLoaded();
      });

      return () => {
        active = false;
        unsubscribe();
      };
    },
    [query],
  );

  // Stable snapshot bookkeeping. `useSyncExternalStore` calls getSnapshot on
  // every render — it MUST return the same reference unless something
  // observable actually changed, otherwise React loops.
  //
  // We cache:
  //  - last raw rows reference seen from the engine cache
  //  - last selector input + output (for memoization across calls)
  //  - last returned snapshot object (returned as-is on no-op renders)
  const lastRowsRef = useRef<T[] | undefined>(undefined);
  const lastSelectorInputRef = useRef<T[] | undefined>(undefined);
  const lastSelectorFnRef = useRef<typeof selector>(undefined);
  const lastSelectorOutputRef = useRef<R | undefined>(undefined);
  const lastResultRef = useRef<UseLiveQueryResult<R> | null>(null);

  const getSnapshot = (): UseLiveQueryResult<R> => {
    const rows = query.peekCache();
    const status = query.peekStatus();
    const error = status.status === 'error' ? (status.error ?? null) : null;
    const loading = !rows && !error;

    let data: R | undefined;
    if (rows) {
      if (selector) {
        // Re-run selector ONLY when the rows reference changes. Selector
        // function identity is intentionally ignored — call sites pass an
        // inline arrow that changes every render, but the transform is
        // semantically stable. If we honored fn identity, the output would
        // change every render (e.g. `flatMap` returns a fresh array) and
        // useSyncExternalStore would loop.
        if (lastSelectorInputRef.current !== rows) {
          lastSelectorOutputRef.current = selector(rows);
          lastSelectorInputRef.current = rows;
        }
        // Always remember latest fn so callers wanting devtools/etc. can
        // introspect; not used for invalidation.
        lastSelectorFnRef.current = selector;
        data = lastSelectorOutputRef.current;
      } else {
        data = rows as unknown as R;
      }
    }

    const prev = lastResultRef.current;
    if (
      prev !== null
      && rows === lastRowsRef.current
      && data === prev.data
      && error === prev.error
      && loading === prev.loading
    ) {
      return prev;
    }

    const next: UseLiveQueryResult<R> = { data, loading, error };
    lastRowsRef.current = rows;
    lastResultRef.current = next;
    return next;
  };

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
