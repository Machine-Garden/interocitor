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
 * - The local database is a cache *of rows*, never the source of truth.
 * - Recovery prefers continued app function over local durability, **except**
 *   where the database holds state the remote has never seen.
 *
 * In practice this means two recovery paths:
 * 1. `open()` is protected by a no-progress deadline and falls back to memory.
 * 2. Post-open operations are retried once on memory when the underlying IDB
 *    handle starts closing or has already closed.
 *
 * ## The cache premise has a hole, and this wrapper plugs it
 *
 * Degrading to memory is only safe while the database holds a re-fetchable
 * row cache. It is data loss the moment it holds writes the remote has never
 * seen — and it already does: the outbox and the `pendingOps` batch are
 * local-only change history. Abandoning them silently loses user writes and
 * lets the device rejoin the mesh missing its own history.
 *
 * Therefore the wrapper keeps a durable, IndexedDB-independent marker (a
 * localStorage slot keyed by physical database name) recording whether the
 * database currently holds unpushed writes. It is readable even when
 * IndexedDB is wedged. Before *any* degrade-to-memory the marker is checked:
 *
 * - marker clean  → degrade as before (a row cache is genuinely disposable);
 * - marker dirty  → refuse, and reject with {@link UnpushedLocalWritesError}
 *   so a host can retry, prompt, or park the tab. Never a silent discard.
 *
 * Failure path for the clean case is unchanged: `console.error(...)` so
 * monitoring (Sentry/etc.) records the degradation, then continue.
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
import { sharedGlobalState } from "../shared-global-state.ts";

/** Default IDB open deadline. Anything longer is a wedged platform. */
export const DEFAULT_LOCAL_OPEN_TIMEOUT_MS = 300;

// ── Unpushed-write marker ──────────────────────────────────────────
//
// A tiny key/value slot that must remain readable when IndexedDB is not.
// localStorage is synchronous and independent of the IDB backing store, so
// it can be consulted on the failure path itself.

/** Minimal synchronous string slot store (localStorage-shaped). */
export interface KeyValueSlots {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/**
 * The memory tier behind {@link createDefaultSlotStore}, realm-wide rather than
 * module-wide.
 *
 * Where it is the *only* tier — SSR, private mode, a partitioned worker — it is
 * the whole slot store, and a second copy of this package carrying its own map
 * would make a marker written through one copy unreadable through the other.
 * The unpushed-writes marker is exactly the state a wrong answer silently
 * discards user writes over.
 */
const memorySlots = sharedGlobalState("web.memory-slots.v1", () => new Map<string, string>());

/**
 * localStorage when available, an in-process map otherwise (SSR, private
 * mode, storage-partitioned workers). The memory tier is a degradation, not a
 * guarantee: it survives the page, not a reload.
 */
export function createDefaultSlotStore(): KeyValueSlots {
  const ls = (typeof globalThis !== "undefined" && (globalThis as any).localStorage) || null;
  if (ls && typeof ls.getItem === "function" && typeof ls.setItem === "function") {
    return {
      get: (key) => {
        try {
          return ls.getItem(key) ?? memorySlots.get(key) ?? null;
        } catch {
          return memorySlots.get(key) ?? null;
        }
      },
      set: (key, value) => {
        memorySlots.set(key, value);
        try {
          ls.setItem(key, value);
        } catch {
          /* ignore */
        }
      },
    };
  }
  return {
    get: (key) => memorySlots.get(key) ?? null,
    set: (key, value) => {
      memorySlots.set(key, value);
    },
  };
}

const UNPUSHED_MARKER_PREFIX = "interocitor:unpushed:";

function unpushedMarkerKey(dbName: string): string {
  return `${UNPUSHED_MARKER_PREFIX}${dbName}`;
}

/**
 * Whether the physical database `dbName` is believed to hold writes the
 * remote has never seen (a non-empty outbox, or an open `pendingOps` batch).
 *
 * Deliberately conservative: an unknown/unreadable marker reads as clean so a
 * never-written database stays disposable, while any observed local write
 * flips it dirty before the next failure path can run.
 */
export function hasUnpushedLocalWrites(
  dbName: string,
  slots: KeyValueSlots = createDefaultSlotStore(),
): boolean {
  try {
    return slots.get(unpushedMarkerKey(dbName)) === "1";
  } catch {
    return false;
  }
}

/** Record (or clear) the unpushed-writes marker for a physical database. */
export function setUnpushedLocalWrites(
  dbName: string,
  value: boolean,
  slots: KeyValueSlots = createDefaultSlotStore(),
): void {
  try {
    slots.set(unpushedMarkerKey(dbName), value ? "1" : "0");
  } catch {
    /* marker is best-effort; never block a write on it */
  }
}

/** What a caller was about to do when unpushed local writes stopped it. */
export type UnpushedLocalWritesOperation = "degrade-to-memory" | "rotate" | "reset";

/**
 * A destructive-or-abandoning recovery step was refused because the local
 * database holds change history the remote has never seen.
 *
 * This is the typed error a host acts on: retry later, surface "you have
 * unsynced changes", force a publish, or explicitly opt into the loss
 * (`allowDegradeWithUnpushedWrites` / `force`). It is never thrown as a
 * side effect of a normal read or write.
 */
export class UnpushedLocalWritesError extends Error {
  readonly code = "UNPUSHED_LOCAL_WRITES" as const;

  readonly dbName: string;
  readonly operation: UnpushedLocalWritesOperation;

  constructor(dbName: string, operation: UnpushedLocalWritesOperation, cause?: unknown) {
    super(
      `Refusing to ${operation} local database ${JSON.stringify(dbName)}: it holds writes that ` +
        `have never reached the remote (outbox and/or an open pending batch). Publish or drain ` +
        `them first, or opt into the loss explicitly.`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "UnpushedLocalWritesError";
    this.dbName = dbName;
    this.operation = operation;
  }
}

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
  /**
   * Opt out of the unpushed-write guard and degrade to memory even when the
   * database holds change history the remote has never seen. Off by default:
   * the default is to refuse with {@link UnpushedLocalWritesError}.
   */
  allowDegradeWithUnpushedWrites?: boolean;
  /** Override the marker slot store (tests, SSR). Defaults to localStorage. */
  unpushedSlots?: KeyValueSlots;
  /**
   * Marker identity. Defaults to `dbName`. The marker must be keyed by the
   * *physical* database name so a rotation cannot inherit a clean marker from
   * a dirty predecessor.
   */
  markerName?: string;
  /**
   * Called instead of degrading when unpushed writes block the fallback. The
   * wrapper still rejects with {@link UnpushedLocalWritesError}; this hook is
   * for telemetry and host UI only. Must not throw.
   */
  onDegradeRefused?: (info: LocalStoreDegradationInfo) => void;
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
  const slots = opts.unpushedSlots ?? createDefaultSlotStore();
  const markerName = opts.markerName ?? opts.dbName ?? "interocitor";

  let active: LocalStore | null = null;
  let degraded = false;

  /** Flip the durable marker dirty. Synchronous, so it survives the next crash. */
  const markUnpushed = (): void => setUnpushedLocalWrites(markerName, true, slots);

  /**
   * Re-derive the marker from the store itself. Called after operations that
   * can *clear* unpushed state, and once after a successful open so a legacy
   * database with a pre-existing outbox is marked before anything can degrade.
   */
  const refreshUnpushedMarker = async (store: LocalStore | null): Promise<void> => {
    if (!store) return;
    try {
      const [outboxSize, pending] = await Promise.all([
        store.outboxSize(),
        store.peekPendingBatch(),
      ]);
      setUnpushedLocalWrites(markerName, outboxSize > 0 || pending !== null, slots);
    } catch {
      // Unreadable store: leave the marker as-is. Never clear it on failure —
      // a clean marker is a licence to discard the database.
    }
  };

  const fallback = (reason: unknown, primary: LocalStore | null): LocalStore => {
    const classifiedReason = classifyFallbackReason(reason);
    // The single chokepoint every degrade path funnels through. An IndexedDB
    // database holding unpushed change history is not a disposable cache, so
    // refuse rather than swap it out for an empty MemoryLocalStore.
    if (!opts.allowDegradeWithUnpushedWrites && hasUnpushedLocalWrites(markerName, slots)) {
      if (opts.onDegradeRefused) {
        try {
          opts.onDegradeRefused({
            reason: classifiedReason as LocalStoreDegradationReason,
            error: reason,
            dbName: opts.dbName,
          });
        } catch {
          /* telemetry hook must never mask the typed error */
        }
      }
      throw new UnpushedLocalWritesError(markerName, "degrade-to-memory", reason);
    }
    degraded = true;
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
      // fallback() throws UnpushedLocalWritesError instead of degrading when
      // the database holds un-uploaded change history. That typed error is the
      // caller's signal; it deliberately replaces the raw IDB error (which is
      // carried as `cause`).
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
        // Seed the marker from the durable truth before anything can degrade.
        // Installs that predate the marker (or that wrote through a different
        // adapter) are protected from their very first open.
        await refreshUnpushedMarker(primary);
      } catch (err) {
        if (err instanceof UnpushedLocalWritesError) throw err;
        try {
          active = fallback(err, primary);
        } catch (refusal) {
          // The primary never became usable and we are not allowed to pretend
          // memory is a substitute. Leave `active` null so a later open() can
          // retry the real database once the platform recovers.
          try {
            primary.close();
          } catch {
            /* ignore */
          }
          throw refusal;
        }
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
    getRows: (refs) => runWithRecovery((store) => store.getRows(refs)),
    putRow: (row) => runWithRecovery((store) => store.putRow(row)),
    putRows: (rows) => runWithRecovery((store) => store.putRows(rows)),
    getTable: (table) => runWithRecovery((store) => store.getTable(table)),
    queryWhere: (table, clause) => runWithRecovery((store) => store.queryWhere(table, clause)),
    getAllRows: () => runWithRecovery((store) => store.getAllRows()),
    clearRows: () => runWithRecovery((store) => store.clearRows()),
    getTableNames: () => runWithRecovery((store) => store.getTableNames()),

    // Every call below that can *create* unpushed state marks the database
    // dirty as soon as the write is durable; every call that can *clear* it
    // re-derives the marker from the store. Marking is cheap and synchronous;
    // re-derivation costs one count plus one meta read and only runs on the
    // rare drain/ack/clear paths.
    async commitLocalMutation(row, change) {
      await runWithRecovery((store) => store.commitLocalMutation(row, change));
      markUnpushed();
    },
    peekPendingBatch: () => runWithRecovery((store) => store.peekPendingBatch()),
    async promotePendingBatch() {
      const promoted = await runWithRecovery((store) => store.promotePendingBatch());
      // Pending batch -> outbox: still unpushed either way, so the marker only
      // needs re-deriving, not clearing.
      if (promoted) markUnpushed();
      return promoted;
    },
    async pushOutbox(entry) {
      await runWithRecovery((store) => store.pushOutbox(entry));
      markUnpushed();
    },
    async pushOutboxEntries(entries) {
      await runWithRecovery((store) => store.pushOutboxEntries(entries));
      if (entries.length > 0) markUnpushed();
    },
    peekOutbox: () => runWithRecovery((store) => store.peekOutbox()),
    async acknowledgeOutbox(entryIds) {
      await runWithRecovery((store) => store.acknowledgeOutbox(entryIds));
      await refreshUnpushedMarker(active);
    },
    async drainOutbox() {
      const drained = await runWithRecovery((store) => store.drainOutbox());
      // Drained entries are in the caller's hands, not the remote's. The
      // marker follows the *store*, which no longer holds them.
      await refreshUnpushedMarker(active);
      return drained;
    },
    outboxSize: () => runWithRecovery((store) => store.outboxSize()),

    getCursor: (deviceId) => runWithRecovery((store) => store.getCursor(deviceId)),
    setCursor: (deviceId, offset) => runWithRecovery((store) => store.setCursor(deviceId, offset)),
    getAllCursors: () => runWithRecovery((store) => store.getAllCursors()),

    getMeta: (key) => runWithRecovery((store) => store.getMeta(key)),
    setMeta: (key, value) => runWithRecovery((store) => store.setMeta(key, value)),
    async clearAll() {
      await runWithRecovery((store) => store.clearAll());
      await refreshUnpushedMarker(active);
    },
  };

  // Optional migration extensions, forwarded only when the active store
  // implements them. Keeps `IndexedDbLocalStore`-only capabilities (whole-meta
  // enumeration, pending-batch adoption) reachable through the wrapper, which
  // a format migration needs when reading a legacy generation.
  const forwardOptional = (name: "getAllMeta" | "adoptPendingBatch") => {
    Object.defineProperty(adapter, name, {
      value: (...args: unknown[]) =>
        runWithRecovery((store) => {
          const method = (store as unknown as Record<string, unknown>)[name];
          if (typeof method !== "function") {
            return Promise.reject(new Error(`Active LocalStore does not implement ${name}()`));
          }
          return (method as (...a: unknown[]) => Promise<unknown>).apply(store, args);
        }),
      enumerable: false,
      writable: false,
    });
  };
  forwardOptional("getAllMeta");
  forwardOptional("adoptPendingBatch");

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
