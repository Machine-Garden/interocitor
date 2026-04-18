import { useState, useEffect, useMemo, useRef } from 'react';
import type { QueryResult } from '@interocitor/core';

export interface UseLiveQueryResult<R> {
  /** `undefined` until first fetch resolves. */
  data: R | undefined;
  loading: boolean;
  error: Error | null;
}

/**
 * React hook for live Interocitor queries. Re-fetches when deps change
 * or when the underlying table emits a change/delete event.
 *
 * @param factory — returns a `QueryResult<T>`. Re-invoked when `deps` change.
 * @param deps — dependency array (same semantics as `useMemo`).
 * @param selector — optional transform. Return the same reference to skip re-render.
 *
 * @example
 * const { data } = useLiveQuery(
 *   () => db.table('receipts').where('weekId').equals(wId),
 *   [wId],
 * );
 *
 * const { data: ids } = useLiveQuery(
 *   () => db.table('weekPlans').query(),
 *   [],
 *   plans => plans.map(p => p.weekId),
 * );
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
  const [data, setData] = useState<R | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const selectorRef = useRef(selector);
  selectorRef.current = selector;

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const query = useMemo(() => factory(), deps);

  useEffect(() => {
    let cancelled = false;

    const fetch = () => {
      Promise.resolve(query).then(rows => {
        if (cancelled) return;
        const sel = selectorRef.current;
        const next = (sel ? sel(rows) : rows) as R;
        setData(prev => prev === next ? prev : next);
        setError(null);
        setLoading(false);
      }).catch(err => {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      });
    };

    fetch();
    const unsub = query.subscribe(() => fetch());

    return () => {
      cancelled = true;
      unsub();
    };
  }, [query]);

  return { data, loading, error };
}
