// compass: interocitor.rows.local-store

import { MemoryLocalStore } from "@interocitor/core";
import { IndexedDbLocalStore } from "./indexed-db-local-store.ts";
import {
  isGeneratedLocalDatabaseName,
  UnstableCredentialNamespaceError,
} from "./local-database-name.ts";
import { createResilientLocalStore } from "./resilient-store.ts";
import type { LocalStore, DatabaseSchemaDefinition } from "@interocitor/core";
import type { LocalStoreDegradationInfo, LocalStoreDegradedHook } from "./resilient-store.ts";

/**
 * Versioned IndexedDB rotation primitive.
 *
 * Invariant ("will never stuck"): the application must keep working no matter
 * what state IndexedDB is in. To guarantee this, the local store name is
 * treated as a nuance — when a disaster occurs (handle keeps closing, repeated
 * blocked open, irrecoverable corruption) we rotate to the next versioned
 * name (`baseName`, then names such as `baseName-v2-4f3a…`), remember the new
 * pointer in a small persistent slot, and reopen.
 *
 * Storage of the rotation pointer:
 *   - Default uses globalThis.localStorage when available.
 *   - SSR / private mode without localStorage fall back to an in-memory map,
 *     which still survives within the page but not across reloads.
 *
 * Old generations are deliberately retained. IndexedDB open/delete requests
 * cannot be cancelled after a blocked timeout, and another tab may still be
 * using an older generation. Destructive cleanup therefore belongs to an
 * explicit application reset flow, not this availability wrapper.
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

/**
 * A rotatable local cache with a stable encryption-domain identity.
 *
 * `credentialNamespace` is safe to pass to the engine and credential stores.
 * `activeDatabaseName` is the current physical IndexedDB generation and is
 * exposed for diagnostics and exact maintenance only.
 */
export interface NamedLocalStore extends LocalStore {
  readonly credentialNamespace: string;
  readonly activeDatabaseName: string;
}

export interface PointerStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

const memoryPointerSlots = new Map<string, string>();

function defaultPointerStore(): PointerStore {
  const ls = (typeof globalThis !== "undefined" && (globalThis as any).localStorage) || null;
  if (ls && typeof ls.getItem === "function" && typeof ls.setItem === "function") {
    return {
      get: (key) => {
        try {
          return ls.getItem(key) ?? memoryPointerSlots.get(key) ?? null;
        } catch {
          return memoryPointerSlots.get(key) ?? null;
        }
      },
      set: (key, value) => {
        memoryPointerSlots.set(key, value);
        try {
          ls.setItem(key, value);
        } catch {
          /* ignore */
        }
      },
    };
  }
  return {
    get: (key) => memoryPointerSlots.get(key) ?? null,
    set: (key, value) => {
      memoryPointerSlots.set(key, value);
    },
  };
}

const POINTER_PREFIX = "interocitor:dbName:";
const VERSION_SUFFIX = /^-v(\d+)(?:-([0-9a-f]+))?$/;

export { isGeneratedLocalDatabaseName } from "./local-database-name.ts";

function parseVersion(name: string, baseName: string): number {
  if (name === baseName) return 1;
  const tail = name.slice(baseName.length);
  const match = VERSION_SUFFIX.exec(tail);
  return match ? Number(match[1]) : 1;
}

function buildName(baseName: string, version: number): string {
  return version <= 1 ? baseName : `${baseName}-v${version}`;
}

function freshGenerationName(baseName: string, version: number): string {
  const random = new Uint8Array(8);
  crypto.getRandomValues(random);
  const token = Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${buildName(baseName, version)}-${token}`;
}

function pointerKey(baseName: string): string {
  return `${POINTER_PREFIX}${baseName}`;
}

/**
 * Advance a logical store to a fresh physical IndexedDB generation.
 *
 * Call only after disconnecting the current engine. This does not delete the
 * previous database or change the encryption domain. Credentials remain
 * anchored to the stable `baseName`, never to the returned physical name.
 */
export function rotateLocalDatabaseName(
  baseName: string,
  pointer: PointerStore = defaultPointerStore(),
): { from: string; to: string } {
  const slot = pointerKey(baseName);
  const from = pointer.get(slot) ?? baseName;
  // The counter is diagnostic only. The random suffix makes physical names
  // distinct even when two tabs race the pointer's read-modify-write cycle.
  const to = freshGenerationName(baseName, parseVersion(from, baseName) + 1);
  pointer.set(slot, to);
  return { from, to };
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
export function createNamedLocalStore(options: NamedLocalStoreOptions): NamedLocalStore {
  if (isGeneratedLocalDatabaseName(options.baseName)) {
    throw new UnstableCredentialNamespaceError(options.baseName);
  }

  const pointer = options.pointerStore ?? defaultPointerStore();
  const slot = pointerKey(options.baseName);

  const persistedName = pointer.get(slot);
  const initialVersion = persistedName ? parseVersion(persistedName, options.baseName) : 1;
  let activeName = persistedName ?? buildName(options.baseName, initialVersion);
  pointer.set(slot, activeName);

  const rotate = (reason: string): void => {
    const { from: previousName, to: nextName } = rotateLocalDatabaseName(options.baseName, pointer);
    activeName = nextName;
    if (options.onRotated) {
      try {
        options.onRotated({ from: previousName, to: nextName, reason });
      } catch {
        /* never stuck */
      }
    }
  };

  const wrappedOnDegraded: LocalStoreDegradedHook = (info: LocalStoreDegradationInfo) => {
    if (options.onLocalDegraded) {
      try {
        options.onLocalDegraded(info);
      } catch {
        /* never stuck */
      }
    }
    // Only rotate on irrecoverable handle states. Open-stalls fall back to
    // memory in-process; rotation only helps on the *next* open and we keep
    // it for those.
    if (info.reason === "idb-handle-closing" || info.reason === "idb-open-stalled-or-unavailable") {
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

  return {
    credentialNamespace: options.baseName,
    get activeDatabaseName() {
      return activeName;
    },
    withLock: (name, operation) => inner.withLock(name, operation),
    async open() {
      await inner.open();
    },
    close: () => inner.close(),
    getRow: (table, rowId) => inner.getRow(table, rowId),
    getRows: (refs) => inner.getRows(refs),
    putRow: (row) => inner.putRow(row),
    putRows: (rows) => inner.putRows(rows),
    getTable: (table) => inner.getTable(table),
    queryWhere: (table, clause) => inner.queryWhere(table, clause),
    getAllRows: () => inner.getAllRows(),
    clearRows: () => inner.clearRows(),
    getTableNames: () => inner.getTableNames(),
    commitLocalMutation: (row, change) => inner.commitLocalMutation(row, change),
    peekPendingBatch: () => inner.peekPendingBatch(),
    promotePendingBatch: () => inner.promotePendingBatch(),
    pushOutbox: (entry) => inner.pushOutbox(entry),
    pushOutboxEntries: (entries) => inner.pushOutboxEntries(entries),
    peekOutbox: () => inner.peekOutbox(),
    acknowledgeOutbox: (entryIds) => inner.acknowledgeOutbox(entryIds),
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
 * Useful for diagnostics, banners, or exact reset UIs. This physical name is
 * not a credential namespace; use `NamedLocalStore.credentialNamespace` for
 * credential stores and the engine's logical `dbName`.
 */
export function getActiveLocalDatabaseName(
  baseName: string,
  pointer: PointerStore = defaultPointerStore(),
): string {
  return pointer.get(pointerKey(baseName)) ?? baseName;
}
