import { MemoryLocalStore } from '@interocitor/core';
import { IndexedDbLocalStore } from './indexed-db-local-store.ts';
import { createResilientLocalStore } from './resilient-store.ts';
import type {
  LocalStore,
  DatabaseSchemaDefinition,
} from '@interocitor/core';
import type {
  LocalStoreDegradationInfo,
  LocalStoreDegradedHook,
} from './resilient-store.ts';

/**
 * Versioned IndexedDB rotation primitive.
 *
 * Invariant ("will never stuck"): the application must keep working no matter
 * what state IndexedDB is in. To guarantee this, the local store name is
 * treated as a nuance — when a disaster occurs (handle keeps closing, repeated
 * blocked open, irrecoverable corruption) we rotate to the next versioned
 * name (`baseName`, `baseName-v2`, `baseName-v3`, …), remember the new pointer
 * in a small persistent slot, and reopen.
 *
 * Storage of the rotation pointer:
 *   - Default uses globalThis.localStorage when available.
 *   - SSR / private mode without localStorage fall back to an in-memory map,
 *     which still survives within the page but not across reloads.
 *
 * Cleanup of old versions (Option B, opportunistic):
 *   - When `indexedDB.databases()` exists (Chromium/WebKit modern), older
 *     versioned names are deleted in the background after a successful open
 *     on the current name. Firefox keeps them; the browser eventually evicts.
 *
 * This module deliberately depends on `createResilientLocalStore` so it gets
 * the open-deadline and post-open closing-handle recovery for free.
 */

export interface NamedLocalStoreOptions {
  baseName: string;
  schema?: DatabaseSchemaDefinition;
  /** Defaults to localStorage. Pass a custom store for tests or SSR. */
  pointerStore?: PointerStore;
  /** Bounded open deadline. Defaults to 300 ms. */
  openTimeoutMs?: number;
  /** Forwarded into the inner resilient store's onDegraded. */
  onLocalDegraded?: LocalStoreDegradedHook;
  /** Notified when the active DB name rotates. */
  onRotated?: (info: { from: string; to: string; reason: string }) => void;
}

export interface PointerStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

const memoryPointerSlots = new Map<string, string>();

function defaultPointerStore(): PointerStore {
  const ls = (typeof globalThis !== 'undefined' && (globalThis as any).localStorage) || null;
  if (ls && typeof ls.getItem === 'function' && typeof ls.setItem === 'function') {
    return {
      get: (key) => {
        try { return ls.getItem(key); } catch { return null; }
      },
      set: (key, value) => {
        try { ls.setItem(key, value); } catch { /* ignore */ }
      },
    };
  }
  return {
    get: (key) => memoryPointerSlots.get(key) ?? null,
    set: (key, value) => { memoryPointerSlots.set(key, value); },
  };
}

const POINTER_PREFIX = 'interocitor:dbName:';
const VERSION_SUFFIX = /-v(\d+)$/;

function parseVersion(name: string, baseName: string): number {
  if (name === baseName) return 1;
  const tail = name.slice(baseName.length);
  const match = VERSION_SUFFIX.exec(tail);
  return match ? Number(match[1]) : 1;
}

function buildName(baseName: string, version: number): string {
  return version <= 1 ? baseName : `${baseName}-v${version}`;
}

function pointerKey(baseName: string): string {
  return `${POINTER_PREFIX}${baseName}`;
}

/**
 * Best-effort cleanup of older versioned IndexedDB databases. Only runs when
 * the platform exposes `indexedDB.databases()` (modern Chromium/WebKit). Any
 * failure is silently swallowed — cleanup is a luxury, not a requirement.
 */
async function cleanupOlderVersions(baseName: string, currentVersion: number): Promise<void> {
  const idb = (typeof indexedDB !== 'undefined' ? indexedDB : null) as IDBFactory | null;
  if (!idb || typeof (idb as IDBFactory & { databases?: () => Promise<{ name?: string }[]> }).databases !== 'function') return;
  try {
    const dbs = await (idb as IDBFactory & { databases: () => Promise<{ name?: string }[]> }).databases();
    for (const entry of dbs) {
      const name = entry?.name;
      if (!name) continue;
      if (name !== baseName && !name.startsWith(`${baseName}-v`)) continue;
      const version = parseVersion(name, baseName);
      if (version >= currentVersion) continue;
      try {
        await new Promise<void>((resolve) => {
          const req = idb.deleteDatabase(name);
          req.onsuccess = () => resolve();
          req.onerror = () => resolve();
          req.onblocked = () => resolve();
        });
      } catch {
        // Swallow; never block on cleanup.
      }
    }
  } catch {
    // Swallow; never block on enumeration.
  }
}

/**
 * Create a `LocalStore` that automatically rotates to a new versioned
 * IndexedDB name when the active DB handle becomes unusable. The first
 * `onDegraded` event observed with reason `idb-handle-closing` schedules a
 * rotation: the persisted pointer advances to the next version, so the next
 * `open()` call (or page reload) starts on a fresh DB.
 *
 * The returned store is itself wrapped by `createResilientLocalStore`, so
 * the never-stuck contract still holds for the freshly named DB.
 */
export function createNamedLocalStore(options: NamedLocalStoreOptions): LocalStore {
  const pointer = options.pointerStore ?? defaultPointerStore();
  const slot = pointerKey(options.baseName);

  const persistedName = pointer.get(slot);
  let activeVersion = persistedName ? parseVersion(persistedName, options.baseName) : 1;
  let activeName = persistedName ?? buildName(options.baseName, activeVersion);
  pointer.set(slot, activeName);

  const rotate = (reason: string): void => {
    activeVersion += 1;
    const nextName = buildName(options.baseName, activeVersion);
    const previousName = activeName;
    activeName = nextName;
    pointer.set(slot, nextName);
    if (options.onRotated) {
      try { options.onRotated({ from: previousName, to: nextName, reason }); } catch { /* never stuck */ }
    }
  };

  const wrappedOnDegraded: LocalStoreDegradedHook = (info: LocalStoreDegradationInfo) => {
    if (options.onLocalDegraded) {
      try { options.onLocalDegraded(info); } catch { /* never stuck */ }
    }
    // Only rotate on irrecoverable handle states. Open-stalls fall back to
    // memory in-process; rotation only helps on the *next* open and we keep
    // it for those.
    if (info.reason === 'idb-handle-closing' || info.reason === 'idb-open-stalled-or-unavailable') {
      rotate(info.reason);
    }
  };

  const inner = createResilientLocalStore({
    dbName: activeName,
    schema: options.schema,
    openTimeoutMs: options.openTimeoutMs,
    onDegraded: wrappedOnDegraded,
    primaryFactory: () => new IndexedDbLocalStore(activeName, undefined, options.schema),
    fallbackFactory: () => new MemoryLocalStore(),
  });

  // Best-effort background cleanup once the active store has had a chance to
  // open. Failures are swallowed.
  const scheduleCleanup = (): void => {
    Promise.resolve().then(() => cleanupOlderVersions(options.baseName, activeVersion)).catch(() => {});
  };

  return {
    async open() {
      await inner.open();
      scheduleCleanup();
    },
    close: () => inner.close(),
    getRow: (table, rowId) => inner.getRow(table, rowId),
    putRow: (row) => inner.putRow(row),
    putRows: (rows) => inner.putRows(rows),
    getTable: (table) => inner.getTable(table),
    queryWhere: (table, clause) => inner.queryWhere(table, clause),
    getAllRows: () => inner.getAllRows(),
    clearRows: () => inner.clearRows(),
    getTableNames: () => inner.getTableNames(),
    pushOutbox: (entry) => inner.pushOutbox(entry),
    pushOutboxEntries: (entries) => inner.pushOutboxEntries(entries),
    drainOutbox: () => inner.drainOutbox(),
    outboxSize: () => inner.outboxSize(),
    getCursor: (deviceId) => inner.getCursor(deviceId),
    setCursor: (deviceId, offset) => inner.setCursor(deviceId, offset),
    getAllCursors: () => inner.getAllCursors(),
    getMeta: (key) => inner.getMeta(key),
    setMeta: (key, value) => inner.setMeta(key, value),
    clearAll: () => inner.clearAll(),
  };
}

/**
 * Read the current active DB name for a base name, without opening anything.
 * Useful for diagnostics, banners, or "reset database" UIs.
 */
export function getActiveLocalDatabaseName(baseName: string, pointer: PointerStore = defaultPointerStore()): string {
  return pointer.get(pointerKey(baseName)) ?? baseName;
}
