// compass: interocitor.rows.table-api

import { useMemo, useRef, useSyncExternalStore } from "react";
import type { ReadonlyTable, RowResult, Table } from "@interocitor/core";

export interface UseRowResult<R> {
  /** `undefined` until first fetch resolves, or if row doesn't exist. */
  data: R | undefined;
  loading: boolean;
  error: Error | null;
}

/**
 * React hook for a single live Interocitor row.
 *
 * Mirrors `useLiveQuery` in shape and behavior:
 *   - backed by the engine's row cache (core-owned, dedup, stale-while-revalidate)
 *   - `useSyncExternalStore` for concurrent-safe subscription
 *   - no flash of absent data on remount or sibling mount
 *   - subscribes only to events that touch this `rowId`
 *   - optional `selector` runs on the cached row, memoized against row identity
 *
 * @param tableOrFactory — a `Table<T>` (auto-builds the row handle from `rowId`)
 *                        or a factory `() => RowResult<T>` for advanced cases.
 * @param rowIdOrDeps   — when first arg is a `Table`, the rowId string (or
 *                        `undefined` to skip). When first arg is a factory,
 *                        the dependency array.
 * @param selector      — optional pure transform on the row.
 *
 * @example
 * const { data: plan } = useRow(db.table('weekPlans'), weekId);
 *
 * @example
 * const { data: title } = useRow(
 *   db.table('weekPlans'),
 *   weekId,
 *   plan => plan?.title ?? '',
 * );
 *
 * @example
 * const { data } = useRow(
 *   () => db.table('users').row(userId),
 *   [userId],
 * );
 */
export function useRow<T extends Record<string, unknown>>(
  table: Table<T> | ReadonlyTable<T>,
  rowId: string | undefined,
): UseRowResult<T>;
export function useRow<T extends Record<string, unknown>, R>(
  table: Table<T> | ReadonlyTable<T>,
  rowId: string | undefined,
  selector: (row: T | undefined) => R,
): UseRowResult<R>;
export function useRow<T extends Record<string, unknown>>(
  factory: () => RowResult<T>,
  deps: readonly unknown[],
): UseRowResult<T>;
export function useRow<T extends Record<string, unknown>, R>(
  factory: () => RowResult<T>,
  deps: readonly unknown[],
  selector: (row: T | undefined) => R,
): UseRowResult<R>;
export function useRow<T extends Record<string, unknown>, R = T>(
  tableOrFactory: Table<T> | ReadonlyTable<T> | (() => RowResult<T>),
  rowIdOrDeps: string | undefined | readonly unknown[],
  selector?: (row: T | undefined) => R,
): UseRowResult<R> {
  // Normalize both forms into one `RowResult | null`. `null` means "skip" —
  // matches the previous `useRow(table, undefined)` no-op behavior.
  const isFactoryForm = typeof tableOrFactory === "function";

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const query = useMemo<RowResult<T> | null>(
    () => {
      if (isFactoryForm) {
        return (tableOrFactory as () => RowResult<T>)();
      }
      const rowId = rowIdOrDeps as string | undefined;
      if (!rowId) return null;
      return (tableOrFactory as Table<T> | ReadonlyTable<T>).row(rowId);
      // Factory form: deps array drives invalidation.
      // Table form: table + rowId drive invalidation.
    },
    isFactoryForm ? (rowIdOrDeps as readonly unknown[]) : [tableOrFactory, rowIdOrDeps],
  );

  // Kick a load on first sight of this query. Engine dedupes peers.
  const startedRef = useRef<RowResult<T> | null>(null);
  if (query && startedRef.current !== query) {
    startedRef.current = query;
    void query.load().catch(() => {
      // Error state is read from the row cache after the subscription bridge
      // below notifies React.
    });
  }

  const subscribe = useMemo(
    () => (notify: () => void) => {
      if (!query) return () => {};
      let active = true;
      const notifyWhenLoaded = () => {
        void query.load().then(
          () => {
            if (active) notify();
          },
          () => {
            if (active) notify();
          },
        );
      };

      // Loading is asynchronous, while useSyncExternalStore only re-reads
      // after a notification. Bridge both the initial load and later row
      // invalidations back into React, keeping any stale row visible while a
      // refresh is pending.
      notifyWhenLoaded();
      const unsubscribe = query.subscribe(() => {
        notify();
        notifyWhenLoaded();
      });

      return () => {
        active = false;
        unsubscribe();
      };
    },
    [query],
  );

  // Stable snapshot bookkeeping. See useLiveQuery for full rationale —
  // useSyncExternalStore's getSnapshot must return a stable reference when
  // nothing observable changed.
  const lastRowRef = useRef<T | undefined>(void 0);
  const lastSelectorInputRef = useRef<T | undefined>(void 0);
  const lastSelectorHadInputRef = useRef<boolean>(false);
  const lastSelectorQueryRef = useRef<RowResult<T> | null>(null);
  const lastSelectorFnRef = useRef<typeof selector>(void 0);
  const lastSelectorOutputRef = useRef<R | undefined>(void 0);
  const lastResultRef = useRef<UseRowResult<R> | null>(null);

  const getSnapshot = (): UseRowResult<R> => {
    if (!query) {
      // Skipped read. Stable empty result.
      const prev = lastResultRef.current;
      if (
        prev !== null &&
        prev.data === undefined &&
        prev.loading === false &&
        prev.error === null
      ) {
        return prev;
      }
      const next: UseRowResult<R> = { data: undefined, loading: false, error: null };
      lastResultRef.current = next;
      lastRowRef.current = undefined;
      return next;
    }

    const row = query.peekCache();
    const status = query.peekStatus();
    const error = status.status === "error" ? (status.error ?? null) : null;
    // 'ready' with row=null means loaded-and-absent — that is NOT loading.
    const loaded = status.status === "ready";
    const loading = !loaded && !error;

    let data: R | undefined;
    if (selector) {
      // Re-run selector ONLY when the row identity changes (or transitions
      // between defined/undefined input), and once for each new row query so
      // selectors can map a loaded missing row to an application fallback.
      // Selector function identity is intentionally ignored — see
      // useLiveQuery for full rationale.
      const hadInput = row !== undefined;
      if (
        lastSelectorQueryRef.current !== query ||
        lastSelectorInputRef.current !== row ||
        lastSelectorHadInputRef.current !== hadInput
      ) {
        lastSelectorOutputRef.current = selector(row);
        lastSelectorInputRef.current = row;
        lastSelectorHadInputRef.current = hadInput;
        lastSelectorQueryRef.current = query;
      }
      lastSelectorFnRef.current = selector;
      data = lastSelectorOutputRef.current;
    } else {
      data = row as unknown as R | undefined;
    }

    const prev = lastResultRef.current;
    if (
      prev !== null &&
      row === lastRowRef.current &&
      data === prev.data &&
      error === prev.error &&
      loading === prev.loading
    ) {
      return prev;
    }

    const next: UseRowResult<R> = { data, loading, error };
    lastRowRef.current = row;
    lastResultRef.current = next;
    return next;
  };

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
