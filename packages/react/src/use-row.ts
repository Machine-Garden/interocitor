import { useState, useEffect } from 'react';
import type { Table } from '@interocitor/core';

export interface UseRowResult<T> {
  /** `undefined` until first fetch resolves, or if row doesn't exist. */
  data: T | undefined;
  loading: boolean;
  error: Error | null;
}

/**
 * Subscribe to a single row by ID. Re-fetches when the row changes.
 *
 * @example
 * const { data: plan } = useRow(db.table('weekPlans'), weekId);
 */
export function useRow<T extends Record<string, unknown>>(
  table: Table<T>,
  rowId: string | undefined,
): UseRowResult<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!rowId) {
      setData(undefined);
      setLoading(false);
      return;
    }

    let cancelled = false;

    const fetch = () => {
      table.get(rowId).then(row => {
        if (cancelled) return;
        setData(row);
        setError(null);
        setLoading(false);
      }).catch(err => {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      });
    };

    fetch();
    const unsub = table.subscribe(event => {
      if (event.rowId === rowId) fetch();
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [table, rowId]);

  return { data, loading, error };
}
