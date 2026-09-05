// compass: interocitor.rows.local-store

/**
 * Resilient local store wrapper.
 *
 * Antifragility contract: the application must never get stuck on IndexedDB.
 *
 * Rules:
 * - `open()` must settle in bounded time.
 * - If IndexedDB is blocked, suspended, closing, or otherwise non-progressing,
 *   the store degrades to in-memory mode and the engine continues.
 * - The local database is treated as a cache, never the source of truth.
 * - Recovery prefers continued app function over local durability.
 *
 * In practice this means two recovery paths:
 * 1. `open()` is protected by a no-progress deadline and falls back to memory.
 * 2. Post-open operations are retried once on memory when the underlying IDB
 *    handle starts closing or has already closed.
 *
 * Failure path: `console.error(...)` so monitoring (Sentry/etc.) records
 * the degradation, then silently continues. No public event, no mode
 * getter — the local cache is an implementation detail.
 */

/**
 * Whether an IndexedDB error means the handle is no longer trustworthy and the
 * application should abandon persistence in favour of progress.
 */
function isUnrecoverableIdbState(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.toLowerCase();
  return (
    normalized.includes("database connection is closing") ||
    normalized.includes("connection is closing") ||
    normalized.includes("invalidstateerror") ||
    normalized.includes("the database connection is closed") ||
    normalized.includes("transaction on idbdatabase") ||
    normalized.includes("connection closed")
  );
}

/**
 * Stable human-readable reason attached to console diagnostics so Sentry and
 * logs can distinguish open-time stalls from post-open handle death.
 */
function classifyFallbackReason(error: unknown): string {
  if (isUnrecoverableIdbState(error)) return "idb-handle-closing";
  return "idb-open-stalled-or-unavailable";
}

import type { DatabaseSchemaDefinition, LocalStore } from "@interocitor/core";
import { MemoryLocalStore } from "@interocitor/core";
import { IndexedDbLocalStore } from "./indexed-db-local-store.ts";

/** Default IDB open deadline. Anything longer is a wedged platform. */
export const DEFAULT_LOCAL_OPEN_TIMEOUT_MS = 300;

export type LocalStoreDegradationReason = "idb-handle-closing" | "idb-open-stalled-or-unavailable";

export interface LocalStoreDegradationInfo {
  reason: LocalStoreDegradationReason;
  error: unknown;
  dbName?: string;
}

export type LocalStoreDegradedHook = (info: LocalStoreDegradationInfo) => void;

export interface ResilientLocalStoreOptions {
  dbName?: string;
  dbVersion?: number;
  schema?: DatabaseSchemaDefinition;
  /** Hard deadline for IndexedDB open. Default 300 ms. */
  openTimeoutMs?: number;
  /** Override for tests. Defaults to () => new IndexedDbLocalStore(...). */
  primaryFactory?: () => LocalStore;
  /** Override for tests. Defaults to () => new MemoryLocalStore(). */
  fallbackFactory?: () => LocalStore;
  /**
   * Notified when the resilient store degrades to memory because
   * IndexedDB hung at open or its handle became unusable post-open.
   * Hook must be synchronous and never throw — failures are swallowed
   * to preserve the "never stuck" guarantee.
   */
  onDegraded?: LocalStoreDegradedHook;
}

/**
 * Open the primary with a *no-progress* deadline.
 *
 * The deadline only trips if the primary shows zero progress within
 * `ms`. Once any progress signal fires (e.g. IndexedDB's
 * `onupgradeneeded` — meaning the platform is processing the request,
 * not blocked), the deadline is permanently disarmed and we wait for
 * `open()` to resolve naturally.
 *
 * Rationale: a real upgrade on a slow device or with many indexes can
 * legitimately take seconds. We must not falsely degrade to memory in
 * that case. We *do* want to bail when the open is wedged (no callback
 * fires at all — blocked, suspended tab, dead worker).
 */
function openWithProgressDeadline(primary: LocalStore, ms: number, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let progressed = false;
  const onProgress = () => {
    progressed = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  // Pass onProgress as an extra argument. IndexedDbLocalStore.open accepts it;
  // adapters that strictly type `open(): Promise<void>` will simply
  // ignore it at runtime (JS does not enforce arity).
  const openPromise = (primary.open as (cb?: () => void) => Promise<void>)(onProgress);
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (progressed) return; // disarmed already; this branch is defensive
      reject(new Error(`${label} stalled with no progress for ${ms}ms`));
    }, ms);
  });
  return Promise.race([openPromise, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Returns a `LocalStore` whose `open()` is bounded and falls back to
 * an in-memory store on any failure (timeout, throw, blocked, missing IDB).
 *
 * After fallback, all subsequent reads/writes hit memory. The original
 * primary handle (if it ever became ready) is closed and discarded.
 */
export function createResilientLocalStore(opts: ResilientLocalStoreOptions = {}): LocalStore {
  const openTimeoutMs = opts.openTimeoutMs ?? DEFAULT_LOCAL_OPEN_TIMEOUT_MS;
  const primaryFactory =
    opts.primaryFactory ??
    (() => new IndexedDbLocalStore(opts.dbName, opts.dbVersion, opts.schema));
  const fallbackFactory = opts.fallbackFactory ?? (() => new MemoryLocalStore());

  let active: LocalStore | null = null;
  let degraded = false;

  const fallback = (reason: unknown, primary: LocalStore | null): LocalStore => {
    degraded = true;
    const classifiedReason = classifyFallbackReason(reason);
    // Sentry / monitoring hook. One line, easy to grep.
    // eslint-disable-next-line no-console
    console.error(`[interocitor] LocalStore degraded to memory (${classifiedReason}):`, reason);
    if (opts.onDegraded) {
      try {
        opts.onDegraded({
          reason: classifiedReason as LocalStoreDegradationReason,
          error: reason,
          dbName: opts.dbName,
        });
      } catch {
        // Never let a consumer hook stop the engine.
      }
    }
    if (primary) {
      try {
        primary.close();
      } catch {
        /* ignore */
      }
    }
    const mem = fallbackFactory();
    // MemoryLocalStore.open() is a noop, but call it for contract symmetry.
    void mem.open();
    return mem;
  };

  const runWithRecovery = async <T>(operation: (store: LocalStore) => Promise<T>): Promise<T> => {
    const current = requireActive(active);
    try {
      return await operation(current);
    } catch (error) {
      if (!isUnrecoverableIdbState(error) || degraded) throw error;
      active = fallback(error, current);
      return operation(requireActive(active));
    }
  };

  const adapter: LocalStore = {
    withLock: (name, operation) => runWithRecovery((store) => store.withLock(name, operation)),
    async open(): Promise<void> {
      if (active) return;
      // If the platform has no IDB at all (worker without IDB exposed,
      // private mode, SSR), don't even try — go straight to memory.
      if (typeof indexedDB === "undefined") {
        active = fallback(new Error("IndexedDB not available in this runtime"), null);
        return;
      }
      const primary = primaryFactory();
      try {
        await openWithProgressDeadline(
          primary,
          openTimeoutMs,
          `IndexedDbLocalStore.open(${opts.dbName ?? "interocitor"})`,
        );
        active = primary;
      } catch (err) {
        active = fallback(err, primary);
      }
    },

    close(): void {
      if (!active) return;
      try {
        active.close();
      } catch {
        /* ignore */
      }
      active = null;
      degraded = false;
    },

    getRow: (table, rowId) => runWithRecovery((store) => store.getRow(table, rowId)),
    putRow: (row) => runWithRecovery((store) => store.putRow(row)),
    putRows: (rows) => runWithRecovery((store) => store.putRows(rows)),
    getTable: (table) => runWithRecovery((store) => store.getTable(table)),
    queryWhere: (table, clause) => runWithRecovery((store) => store.queryWhere(table, clause)),
    getAllRows: () => runWithRecovery((store) => store.getAllRows()),
    clearRows: () => runWithRecovery((store) => store.clearRows()),
    getTableNames: () => runWithRecovery((store) => store.getTableNames()),

    commitLocalMutation: (row, pendingBatch) =>
      runWithRecovery((store) => store.commitLocalMutation(row, pendingBatch)),
    promotePendingBatch: () => runWithRecovery((store) => store.promotePendingBatch()),
    pushOutbox: (entry) => runWithRecovery((store) => store.pushOutbox(entry)),
    pushOutboxEntries: (entries) => runWithRecovery((store) => store.pushOutboxEntries(entries)),
    peekOutbox: () => runWithRecovery((store) => store.peekOutbox()),
    acknowledgeOutbox: (entryIds) => runWithRecovery((store) => store.acknowledgeOutbox(entryIds)),
    drainOutbox: () => runWithRecovery((store) => store.drainOutbox()),
    outboxSize: () => runWithRecovery((store) => store.outboxSize()),

    getCursor: (deviceId) => runWithRecovery((store) => store.getCursor(deviceId)),
    setCursor: (deviceId, offset) => runWithRecovery((store) => store.setCursor(deviceId, offset)),
    getAllCursors: () => runWithRecovery((store) => store.getAllCursors()),

    getMeta: (key) => runWithRecovery((store) => store.getMeta(key)),
    setMeta: (key, value) => runWithRecovery((store) => store.setMeta(key, value)),
    clearAll: () => runWithRecovery((store) => store.clearAll()),
  };

  // Diagnostic, not a public API. Tests and internal logging can read it.
  Object.defineProperty(adapter, "__degraded", {
    get: () => degraded,
    enumerable: false,
  });

  return adapter;
}

function requireActive(active: LocalStore | null): LocalStore {
  if (!active) throw new Error("LocalStore not opened");
  return active;
}
