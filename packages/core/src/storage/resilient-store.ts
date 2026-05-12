/**
 * Resilient local store wrapper.
 *
 * Antifragility contract: `open()` must never hang. Either it succeeds with
 * the configured persistent store (IndexedDB), or it falls through to a
 * volatile in-memory store and continues. The engine never blocks on a
 * dead/blocked IDB request.
 *
 * The local store is a cache — cloud is the source of truth — so falling
 * back to memory degrades durability across reloads but does not lose
 * data already synced to the cloud, and does not break the engine.
 *
 * Failure path: `console.error(...)` so monitoring (Sentry/etc.) records
 * the degradation, then silently continues. No public event, no mode
 * getter — the local cache is an implementation detail.
 */

import type { DatabaseSchemaDefinition, LocalStoreAdapter } from '../core/types.ts';
import { LocalStore } from './local-store.ts';
import { MemoryLocalStore } from './memory-store.ts';

/** Default IDB open deadline. Anything longer is a wedged platform. */
export const DEFAULT_LOCAL_OPEN_TIMEOUT_MS = 300;

export interface ResilientLocalStoreOptions {
  dbName?: string;
  dbVersion?: number;
  schema?: DatabaseSchemaDefinition;
  /** Hard deadline for IndexedDB open. Default 300 ms. */
  openTimeoutMs?: number;
  /** Override for tests. Defaults to () => new LocalStore(...). */
  primaryFactory?: () => LocalStoreAdapter;
  /** Override for tests. Defaults to () => new MemoryLocalStore(). */
  fallbackFactory?: () => LocalStoreAdapter;
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
function openWithProgressDeadline(
  primary: LocalStoreAdapter,
  ms: number,
  label: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let progressed = false;
  const onProgress = () => {
    progressed = true;
    if (timer) { clearTimeout(timer); timer = null; }
  };
  // Pass onProgress as an extra argument. LocalStore.open accepts it;
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
 * Returns a `LocalStoreAdapter` whose `open()` is bounded and falls back to
 * an in-memory store on any failure (timeout, throw, blocked, missing IDB).
 *
 * After fallback, all subsequent reads/writes hit memory. The original
 * primary handle (if it ever became ready) is closed and discarded.
 */
export function createResilientLocalStore(opts: ResilientLocalStoreOptions = {}): LocalStoreAdapter {
  const openTimeoutMs = opts.openTimeoutMs ?? DEFAULT_LOCAL_OPEN_TIMEOUT_MS;
  const primaryFactory = opts.primaryFactory ?? (() => new LocalStore(opts.dbName, opts.dbVersion, opts.schema));
  const fallbackFactory = opts.fallbackFactory ?? (() => new MemoryLocalStore());

  let active: LocalStoreAdapter | null = null;
  let degraded = false;

  const fallback = (reason: unknown, primary: LocalStoreAdapter | null): LocalStoreAdapter => {
    degraded = true;
    // Sentry / monitoring hook. One line, easy to grep.
    // eslint-disable-next-line no-console
    console.error('[interocitor] LocalStore degraded to memory:', reason);
    if (primary) {
      try { primary.close(); } catch { /* ignore */ }
    }
    const mem = fallbackFactory();
    // MemoryLocalStore.open() is a noop, but call it for contract symmetry.
    void mem.open();
    return mem;
  };

  const adapter: LocalStoreAdapter = {
    async open(): Promise<void> {
      if (active) return;
      // If the platform has no IDB at all (worker without IDB exposed,
      // private mode, SSR), don't even try — go straight to memory.
      if (typeof indexedDB === 'undefined') {
        active = fallback(new Error('IndexedDB not available in this runtime'), null);
        return;
      }
      const primary = primaryFactory();
      try {
        await openWithProgressDeadline(primary, openTimeoutMs, `LocalStore.open(${opts.dbName ?? 'interocitor'})`);
        active = primary;
      } catch (err) {
        active = fallback(err, primary);
      }
    },

    close(): void {
      if (!active) return;
      try { active.close(); } catch { /* ignore */ }
      active = null;
      degraded = false;
    },

    // Every other method is a thin pass-through. We do NOT add per-call
    // timeouts here — once IDB is open, individual transactions either
    // complete or surface real errors. Adding more deadlines just hides
    // bugs; the only point we cannot recover from is the initial open.

    getRow: (table, rowId) => requireActive(active).getRow(table, rowId),
    putRow: (row) => requireActive(active).putRow(row),
    putRows: (rows) => requireActive(active).putRows(rows),
    getTable: (table) => requireActive(active).getTable(table),
    queryWhere: (table, clause) => requireActive(active).queryWhere(table, clause),
    getAllRows: () => requireActive(active).getAllRows(),
    clearRows: () => requireActive(active).clearRows(),
    getTableNames: () => requireActive(active).getTableNames(),

    pushOutbox: (entry) => requireActive(active).pushOutbox(entry),
    pushOutboxEntries: (entries) => requireActive(active).pushOutboxEntries(entries),
    drainOutbox: () => requireActive(active).drainOutbox(),
    outboxSize: () => requireActive(active).outboxSize(),

    getCursor: (deviceId) => requireActive(active).getCursor(deviceId),
    setCursor: (deviceId, offset) => requireActive(active).setCursor(deviceId, offset),
    getAllCursors: () => requireActive(active).getAllCursors(),

    getMeta: (key) => requireActive(active).getMeta(key),
    setMeta: (key, value) => requireActive(active).setMeta(key, value),
    clearAll: () => requireActive(active).clearAll(),
  };

  // Diagnostic, not a public API. Tests and internal logging can read it.
  Object.defineProperty(adapter, '__degraded', {
    get: () => degraded,
    enumerable: false,
  });

  return adapter;
}

function requireActive(active: LocalStoreAdapter | null): LocalStoreAdapter {
  if (!active) throw new Error('LocalStore not opened');
  return active;
}
