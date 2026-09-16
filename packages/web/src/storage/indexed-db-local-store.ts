// compass: interocitor.rows.local-store

/**
 * Local storage layer — IndexedDB
 *
 * This is a cache, not the source of truth.
 * If cleared, the app rehydrates from cloud.
 *
 * Stores:
 *  - rows: the current merged state of all tables
 *  - pendingOps: ops of the implicit batch that has not been promoted yet
 *  - outbox: change entries pending upload
 *  - cursors: byte offsets into each device's change log
 *  - meta: device ID, last snapshot epoch, etc.
 */

import type {
  Row,
  ChangeEntry,
  LocalStore,
  RowRef,
  DatabaseSchemaDefinition,
  TableIndexDefinition,
  SchemaField,
  WhereClause,
  WherePrimitive,
} from "@interocitor/core";

import { sharedGlobalState } from "../shared-global-state.ts";

const DEFAULT_DB_NAME = "interocitor";
// v2: adds the append-only pendingOps store and the outbox by_id index.
const DEFAULT_DB_VERSION = 2;
const PENDING_BATCH_META_KEY = "pendingBatch";
const OUTBOX_ID_INDEX = "by_id";
const CACHE_FINGERPRINT_META_KEY = "interocitor:cache:fingerprint";
const BLOCKED_UPGRADE_GRACE_MS = 1_000;

// ─── Cross-context locking ───────────────────────────────────────────
//
// `withLock` serializes the engine's read-modify-write cycles (see the JSDoc
// on IndexedDbLocalStore.withLock). Those cycles span several IndexedDB
// transactions and often a network round trip, so IndexedDB's own transaction
// atomicity cannot cover them — the mutual exclusion has to come from
// somewhere else, and it has to hold between *browsing contexts*, not just
// between callers inside one JavaScript realm.
//
// Web Locks is that mechanism: origin-scoped, genuinely cross-tab, released
// automatically when the holding context dies. Everything below exists to
// keep a defensible answer for the environments where it is unavailable.

/**
 * This realm's lock queue for the case where Web Locks is not usable.
 *
 * A module-level `Map` is the wrong home for a lock. A consumer's tree can
 * easily hold two copies of this module — a duplicate install, pnpm's
 * isolated layout, or a bundler emitting it into two chunks; a
 * `peerDependency` prevents none of those — and each copy would then own a
 * private queue. Two callers would serialize on two different chains, and a
 * lock that does not lock is worse than no lock at all, because the engine is
 * written assuming mutual exclusion.
 *
 * The `.v1` suffix is the migration seam: a future copy whose queue entries
 * mean something different must claim a new name rather than silently sharing
 * a structure it would misread.
 */
function fallbackLockTails(): Map<string, Promise<void>> {
  return sharedGlobalState(
    "web.fallback-lock-tails.v1",
    () => new Map<string, Promise<void>>(),
    (candidate) => candidate instanceof Map,
  );
}

/**
 * This realm's "Web Locks is not usable here" verdict.
 *
 * Shared for the same reason the queue is: two module copies that disagreed
 * about which mechanism to use would not exclude each other.
 */
function webLocksSupport(): { refused: boolean } {
  return sharedGlobalState(
    "web.web-locks-support.v1",
    () => ({ refused: false }),
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      typeof (candidate as { refused?: unknown }).refused === "boolean",
  );
}

/**
 * Serialize on a promise chain inside this realm.
 *
 * Honest about what it is: mutual exclusion among callers that share a
 * JavaScript context. A sibling tab serializes on its own chain and is not
 * excluded. That is the ceiling of any in-process mechanism, and the reason
 * Web Locks is tried first rather than second.
 */
async function withFallbackLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const tails = fallbackLockTails();
  const previous = tails.get(name) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  tails.set(name, current);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (tails.get(name) === current) tails.delete(name);
  }
}

function webLocksManager(): LockManager | null {
  if (webLocksSupport().refused) return null;
  try {
    // `navigator` is absent under SSR and in some worker contexts; `locks` is
    // absent on older Safari and outside secure contexts; a partial polyfill
    // can supply the object without a callable `request`. Reading the property
    // can itself throw behind an exotic getter, so the whole probe is guarded.
    if (typeof navigator === "undefined") return null;
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    return typeof locks?.request === "function" ? locks : null;
  } catch {
    return null;
  }
}

/**
 * True for refusals that describe the *environment* rather than the moment.
 *
 * An opaque origin (a sandboxed iframe, a `file://` document), a context where
 * the API is denied, or a shape that is not the API at all will refuse every
 * future request too, so the verdict is worth caching: it keeps every caller
 * in the realm on one mechanism. A transient refusal — `InvalidStateError`
 * from a document that is not fully active, say — must not be cached, because
 * poisoning a healthy page into the weaker in-process queue for the rest of
 * its life costs more than the one request it would have saved.
 */
function isPermanentWebLocksRefusal(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    return error.name === "SecurityError" || error.name === "NotSupportedError";
  }
  return false;
}

/**
 * Run `operation` under a lock named `lockName`, cross-tab where the platform
 * allows it and in-process where it does not.
 *
 * The lock is non-reentrant, matching both mechanisms: Web Locks queues a
 * second `exclusive` request behind the first even from the same context, and
 * the fallback chain does the same. Callers must therefore never re-enter a
 * section under the same name — the sync engine's `batchDepth` and
 * `compactInFlight` guards exist for exactly this reason.
 */
async function withCrossContextLock<T>(lockName: string, operation: () => Promise<T>): Promise<T> {
  const locks = webLocksManager();
  if (locks) {
    // Distinguishes "the lock was never granted" from "the section ran and
    // threw". Only the former may retry on the fallback; retrying the latter
    // would run a critical section twice.
    let entered = false;
    try {
      return (await locks.request(lockName, async (): Promise<T> => {
        entered = true;
        // Web Locks holds the lock for exactly as long as this callback's
        // promise is pending, and releases it on rejection as well as on
        // fulfilment — so a throw inside the section cannot wedge the queue.
        return operation();
      })) as T;
    } catch (error) {
      if (entered) throw error;
      if (isPermanentWebLocksRefusal(error)) webLocksSupport().refused = true;
    }
  }
  return withFallbackLock(lockName, operation);
}

const STORES = {
  rows: "rows", // key: "{table}/{rowId}"
  pendingOps: "pendingOps", // key: auto-increment (append order)
  outbox: "outbox", // key: auto-increment, unique index by_id on entry.id
  cursors: "cursors", // key: deviceId
  meta: "meta", // key: string
} as const;

const SCHEMA_INDEX_PREFIX = "idx:";

function schemaIndexName(table: string, indexName: string): string {
  return `${SCHEMA_INDEX_PREFIX}${table}:${indexName}`;
}

function schemaIndexKeyPath(field: string): string[] {
  // Index key is composite: [table, payload-field-value]. Both live under
  // namespaced parents now. ColumnEntry stores the user value under `.value`.
  return ["_meta.table", `payload.${field}.value`];
}

function normalizeSchema(schema?: DatabaseSchemaDefinition): DatabaseSchemaDefinition | undefined {
  if (!schema) return undefined;
  return schema;
}

function domStringListToArray(list: DOMStringList): string[] {
  const out: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list.item(i);
    if (item) out.push(item);
  }
  return out;
}

function expectedSchemaIndexes(
  schema?: DatabaseSchemaDefinition,
): Map<string, { keyPath: string[]; unique: boolean }> {
  const expected = new Map<string, { keyPath: string[]; unique: boolean }>();
  if (!schema) return expected;
  // Object.keys() returns a fresh array, and the package targets ES2022.
  // eslint-disable-next-line unicorn/no-array-sort
  for (const table of Object.keys(schema.tables).sort()) {
    const def = schema.tables[table]!;
    // Object.entries() returns a fresh array, and the package targets ES2022.
    // eslint-disable-next-line unicorn/no-array-sort
    const fieldEntries = Object.entries(def.fields ?? {}).sort(([a], [b]) => a.localeCompare(b));
    for (const [fieldName, input] of fieldEntries) {
      const fieldDef = normalizeFieldInput(input);
      if (!fieldDef.index && !fieldDef.unique) continue;
      expected.set(schemaIndexName(table, `by_${fieldName}`), {
        keyPath: schemaIndexKeyPath(fieldName),
        unique: fieldDef.unique ?? false,
      });
    }
    // The spread creates a fresh array, and the package targets ES2022.
    // eslint-disable-next-line unicorn/no-array-sort
    const indexes = [...(def.indexes ?? [])].sort(
      (a, b) => a.name.localeCompare(b.name) || a.field.localeCompare(b.field),
    );
    for (const index of indexes) {
      expected.set(schemaIndexName(table, index.name), {
        keyPath: schemaIndexKeyPath(index.field),
        unique: index.unique ?? false,
      });
    }
  }
  return expected;
}

function schemaFingerprint(schema?: DatabaseSchemaDefinition): string {
  return JSON.stringify(
    Array.from(expectedSchemaIndexes(schema).entries()).map(([name, def]) => ({
      name,
      keyPath: def.keyPath,
      unique: def.unique,
    })),
  );
}

function normalizeFieldInput(input: SchemaField<unknown>): { index: boolean; unique: boolean } {
  return {
    index: input.index ?? false,
    unique: input.unique ?? false,
  };
}

function readColumnValue(row: Row, field: string): unknown {
  const entry = row.payload?.[field];
  if (entry === undefined) return undefined;
  return entry.value;
}

function compare(a: WherePrimitive, b: WherePrimitive): number {
  const av = a instanceof Date ? a.getTime() : a;
  const bv = b instanceof Date ? b.getTime() : b;
  if (av < bv) return -1;
  if (av > bv) return 1;
  return 0;
}

function matchesClause(value: unknown, clause: WhereClause): boolean {
  if (value === undefined || value === null) return false;
  switch (clause.op) {
    case "equals":
      return compare(value as WherePrimitive, clause.value as WherePrimitive) === 0;
    case "above":
      return compare(value as WherePrimitive, clause.value as WherePrimitive) > 0;
    case "aboveOrEqual":
      return compare(value as WherePrimitive, clause.value as WherePrimitive) >= 0;
    case "below":
      return compare(value as WherePrimitive, clause.value as WherePrimitive) < 0;
    case "belowOrEqual":
      return compare(value as WherePrimitive, clause.value as WherePrimitive) <= 0;
    case "between": {
      const lowerCmp = compare(value as WherePrimitive, clause.lower as WherePrimitive);
      const upperCmp = compare(value as WherePrimitive, clause.upper as WherePrimitive);
      const lowerOk = clause.lowerOpen ? lowerCmp > 0 : lowerCmp >= 0;
      const upperOk = clause.upperOpen ? upperCmp < 0 : upperCmp <= 0;
      return lowerOk && upperOk;
    }
    case "startsWith":
      return typeof value === "string" && value.startsWith(String(clause.value));
    case "anyOf":
      return (clause.values ?? []).some((v) => compare(value as WherePrimitive, v) === 0);
    default:
      return false;
  }
}

function hasSchemaIndex(
  schema: DatabaseSchemaDefinition | undefined,
  table: string,
  field: string,
): TableIndexDefinition | undefined {
  const tableSchema = schema?.tables[table];
  if (!tableSchema) return undefined;

  const declaredIndex = tableSchema.indexes?.find((index) => index.field === field);
  if (declaredIndex) return declaredIndex;

  const fromField = tableSchema.fields?.[field] as SchemaField<unknown> | undefined;
  if (!fromField) return undefined;
  const fieldDef = normalizeFieldInput(fromField);
  if (!fieldDef.index && !fieldDef.unique) return undefined;
  return {
    name: `by_${field}`,
    field,
    unique: fieldDef.unique,
  };
}

function rangeForClause(table: string, clause: WhereClause): IDBKeyRange | null {
  // Schema indexes are keyed as [table, fieldValue]. Range queries must bound
  // both sides of the compound key; lowerBound([table, value]) alone would also
  // include later table names, and upperBound([table, value]) would include
  // earlier table names.
  const tableLowerBound = [table];
  const tableUpperBound = [table, []];

  switch (clause.op) {
    case "equals":
      return IDBKeyRange.only([table, clause.value]);
    case "above":
      return IDBKeyRange.bound([table, clause.value], tableUpperBound, true, false);
    case "aboveOrEqual":
      return IDBKeyRange.bound([table, clause.value], tableUpperBound, false, false);
    case "below":
      return IDBKeyRange.bound(tableLowerBound, [table, clause.value], false, true);
    case "belowOrEqual":
      return IDBKeyRange.bound(tableLowerBound, [table, clause.value], false, false);
    case "between":
      return IDBKeyRange.bound(
        [table, clause.lower],
        [table, clause.upper],
        clause.lowerOpen ?? false,
        clause.upperOpen ?? false,
      );
    case "startsWith": {
      const prefix = String(clause.value ?? "");
      return IDBKeyRange.bound([table, prefix], [table, `${prefix}\uFFFF`], false, false);
    }
    case "anyOf":
      return null;
    default:
      return null;
  }
}

function reconcileSchemaIndexes(
  rowsStore: IDBObjectStore,
  schema?: DatabaseSchemaDefinition,
): void {
  const expected = expectedSchemaIndexes(schema);
  const existing = domStringListToArray(rowsStore.indexNames).filter((name) =>
    name.startsWith(SCHEMA_INDEX_PREFIX),
  );

  for (const indexName of existing) {
    if (!expected.has(indexName)) {
      rowsStore.deleteIndex(indexName);
    }
  }

  for (const [indexName, def] of expected.entries()) {
    if (rowsStore.indexNames.contains(indexName)) {
      const index = rowsStore.index(indexName);
      const actualKeyPath = Array.isArray(index.keyPath) ? index.keyPath : [index.keyPath];
      if (
        JSON.stringify(actualKeyPath) === JSON.stringify(def.keyPath) &&
        index.unique === def.unique
      ) {
        continue;
      }
      // IndexedDB cannot alter an index descriptor. Recreate a same-name index
      // whose field or uniqueness changed while the versionchange transaction
      // is active.
      rowsStore.deleteIndex(indexName);
    }
    rowsStore.createIndex(indexName, def.keyPath, { unique: def.unique });
  }
}

function openDB(
  dbName: string,
  dbVersion: number | undefined,
  schema?: DatabaseSchemaDefinition,
  onProgress?: () => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let blockedTimer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const clearBlockedTimer = () => {
      if (blockedTimer) clearTimeout(blockedTimer);
      blockedTimer = null;
    };
    const req =
      dbVersion === undefined ? indexedDB.open(dbName) : indexedDB.open(dbName, dbVersion);

    req.onupgradeneeded = () => {
      // Signal "the platform is alive and processing". The resilient wrapper
      // uses this to disarm its open-deadline: a long-running upgrade
      // (creating indexes over many rows on a slow device) is making
      // progress, not blocked. Without this, a legitimate upgrade past the
      // deadline would falsely trigger memory-mode fallback.
      try {
        onProgress?.();
      } catch {
        /* never let a bad listener break open */
      }
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.rows)) {
        // keyPath uses dotted path into the new namespaced row shape.
        // IndexedDB resolves "_meta.key" against the stored object.
        const rows = db.createObjectStore(STORES.rows, { keyPath: "_meta.key" });
        rows.createIndex("by_table", "_meta.table", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.pendingOps)) {
        db.createObjectStore(STORES.pendingOps, { autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORES.outbox)) {
        db.createObjectStore(STORES.outbox, { autoIncrement: true });
      }
      const outboxStore = req.transaction?.objectStore(STORES.outbox);
      if (outboxStore && !outboxStore.indexNames.contains(OUTBOX_ID_INDEX)) {
        outboxStore.createIndex(OUTBOX_ID_INDEX, "id", { unique: true });
      }
      if (!db.objectStoreNames.contains(STORES.cursors)) {
        db.createObjectStore(STORES.cursors);
      }
      if (!db.objectStoreNames.contains(STORES.meta)) {
        db.createObjectStore(STORES.meta);
      }

      // Stamp the cache shape in the same upgrade transaction. A fresh
      // database must become current in one open; reopening v1 -> v2 -> v3
      // can make WebKit block on this store's own recently closed handle.
      req.transaction
        ?.objectStore(STORES.meta)
        .put(schemaFingerprint(schema), CACHE_FINGERPRINT_META_KEY);

      const rowsStore = req.transaction?.objectStore(STORES.rows);
      if (rowsStore) reconcileSchemaIndexes(rowsStore, schema);
    };

    req.onsuccess = () => {
      clearBlockedTimer();
      const db = req.result;
      if (settled) {
        db.close();
        return;
      }
      settled = true;
      // If another caller (sibling tab, worker, or even our own next open()
      // for an upgrade) requests a higher version, voluntarily close this
      // connection so the upgrade can proceed instead of blocking it.
      // Without this handler, an upgrade open elsewhere would hang on
      // 'blocked' until this connection is closed manually.
      db.onversionchange = () => {
        try {
          db.close();
        } catch {
          /* already closed */
        }
      };
      resolve(db);
    };
    req.onerror = () => {
      clearBlockedTimer();
      if (settled) return;
      settled = true;
      reject(req.error ?? new Error(`IndexedDB open failed for "${dbName}"`));
    };
    // Fired when an upgrade open is held up by another live connection at a
    // lower version. Without this handler the request never fires success or
    // error and the promise hangs forever — surfacing only as a downstream
    // init() timeout with no diagnostic. Reject loudly with an actionable
    // message instead.
    req.onblocked = () => {
      // WebKit can briefly report this store's own synchronously closed handle
      // as a blocker. Give that handle a bounded grace period to drain; a real
      // sibling-tab/worker blocker still rejects with an actionable error.
      if (blockedTimer) return;
      blockedTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new Error(
            `IndexedDB open blocked: another connection to "${dbName}" is open at a lower version ` +
              `(requested v${dbVersion ?? "current"}). Close other tabs/workers using this database, ` +
              `or ensure prior LocalStore instances called close(). The browser request cannot be ` +
              `cancelled and may still finish later; do not reuse this physical database name for a replacement.`,
          ),
        );
      }, BLOCKED_UPGRADE_GRACE_MS);
    };
  });
}

function tx(db: IDBDatabase, stores: string | string[], mode: IDBTransactionMode): IDBTransaction {
  return db.transaction(stores, mode);
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

/**
 * Meta record describing the open implicit batch. Ops live in the
 * append-only pendingOps store so each local write costs one `add` instead
 * of rewriting the whole batch.
 */
type Op = ChangeEntry["ops"][number];
type PendingBatchHeader = Omit<ChangeEntry, "ops"> & { ops?: Op[] };

async function readPendingBatch(t: IDBTransaction): Promise<ChangeEntry | null> {
  const header = (await reqToPromise(t.objectStore(STORES.meta).get(PENDING_BATCH_META_KEY))) as
    | PendingBatchHeader
    | undefined;
  if (!header) return null;
  const ops = (await reqToPromise(t.objectStore(STORES.pendingOps).getAll())) as Op[];
  const { ops: legacyOps, ...rest } = header;
  return { ...rest, ops: legacyOps ? [...legacyOps, ...ops] : ops };
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Meta keys that describe *this physical database* rather than the mesh.
 * A store-format migration must never copy them into a new generation: the
 * target stamps its own schema fingerprint, owns its own pending-batch header
 * (adopted explicitly), and records its own format id.
 */
export const INTERNAL_META_KEYS: readonly string[] = [
  CACHE_FINGERPRINT_META_KEY,
  PENDING_BATCH_META_KEY,
];

/**
 * Capabilities beyond `LocalStore` that a store-format migration needs.
 * Implemented by {@link IndexedDbLocalStore} and forwarded by the resilient
 * wrapper when the active store provides them.
 */
export interface LocalStoreMigrationExtensions {
  getAllMeta?(): Promise<Record<string, unknown>>;
  adoptPendingBatch?(entry: ChangeEntry): Promise<void>;
}

/**
 * Default IndexedDB-backed local persistence layer used by {@link Interocitor}.
 *
 * Most applications do not need to interact with this class directly unless
 * they are supplying a custom `LocalStore` or swapping local storage at
 * runtime for testing or advanced integrations.
 */
export class IndexedDbLocalStore implements LocalStore {
  private db: IDBDatabase | null = null;
  private opening: Promise<void> | null = null;
  private openAttempt = 0;
  private readonly dbName: string;
  private readonly configuredDbVersion?: number;
  private readonly schema?: DatabaseSchemaDefinition;
  private readonly expectedIndexes: Map<string, { keyPath: string[]; unique: boolean }>;
  private readonly desiredFingerprint: string;

  /**
   * @param dbName    IndexedDB database name. Use distinct names to isolate
   *                  multiple engine instances on the same origin.
   *                  Default: "interocitor"
   * @param dbVersion IndexedDB schema version. Default: 1
   */
  constructor(dbName?: string, dbVersion?: number, schema?: DatabaseSchemaDefinition) {
    this.schema = normalizeSchema(schema);
    this.dbName = dbName ?? DEFAULT_DB_NAME;
    this.configuredDbVersion = dbVersion;
    this.expectedIndexes = expectedSchemaIndexes(this.schema);
    this.desiredFingerprint = schemaFingerprint(this.schema);
  }

  /**
   * Serialize a named correctness-critical operation against every other
   * context using this physical database.
   *
   * What it guards is not an IndexedDB transaction — those are already atomic.
   * It guards the engine's *logical* read-modify-write cycles, which span
   * several transactions and usually a network round trip: promote the pending
   * batch, upload it, acknowledge it; read a device cursor, fetch changes from
   * that offset, write the cursor back; load the change-observation ledger,
   * merge receipts, store it. Two contexts interleaving there lose updates
   * that IndexedDB will happily commit — a clobbered cursor silently skips
   * remote changes, and a clobbered observation ledger breaks the
   * sync-completeness invariant that immutable change filenames prove
   * observation.
   *
   * Scope is `(physical database name, lock name)`. Two engines on different
   * databases must not block each other; two tabs on the same database must
   * serialize. The `interocitor:` prefix namespaces the Web Locks name against
   * the host application's own lock usage, which shares one origin-wide
   * namespace with us.
   *
   * The name format is frozen. Two tabs of the same app routinely run
   * different library versions across a deploy, and a renamed lock would make
   * them queue on different names — mutual exclusion would silently vanish
   * during exactly the window it is most needed.
   */
  async withLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
    return withCrossContextLock(`interocitor:${this.dbName}:${name}`, operation);
  }

  private async readCacheFingerprint(db: IDBDatabase): Promise<string | undefined> {
    const t = tx(db, STORES.meta, "readonly");
    const value = await reqToPromise(t.objectStore(STORES.meta).get(CACHE_FINGERPRINT_META_KEY));
    return typeof value === "string" ? value : undefined;
  }

  private async writeCacheFingerprint(db: IDBDatabase): Promise<void> {
    const t = tx(db, STORES.meta, "readwrite");
    t.objectStore(STORES.meta).put(this.desiredFingerprint, CACHE_FINGERPRINT_META_KEY);
    await txComplete(t);
  }

  private needsRepair(db: IDBDatabase, storedFingerprint?: string): boolean {
    if (!db.objectStoreNames.contains(STORES.rows)) return true;
    const rows = tx(db, STORES.rows, "readonly").objectStore(STORES.rows);
    const existing = domStringListToArray(rows.indexNames).filter((name) =>
      name.startsWith(SCHEMA_INDEX_PREFIX),
    );
    if (existing.length !== this.expectedIndexes.size) return true;
    for (const [name, expected] of this.expectedIndexes) {
      if (!rows.indexNames.contains(name)) return true;
      const index = rows.index(name);
      const actualKeyPath = Array.isArray(index.keyPath) ? index.keyPath : [index.keyPath];
      if (JSON.stringify(actualKeyPath) !== JSON.stringify(expected.keyPath)) return true;
      if (index.unique !== expected.unique) return true;
    }
    // A missing fingerprint is bookkeeping, not schema damage. It can be
    // written in place without a version upgrade once structure is verified.
    void storedFingerprint;
    return false;
  }

  open(onProgress?: () => void): Promise<void> {
    if (this.db) return Promise.resolve();
    if (this.opening) return this.opening;

    const attempt = ++this.openAttempt;
    const opening = this.performOpen(attempt, onProgress).finally(() => {
      if (this.opening === opening) this.opening = null;
    });
    this.opening = opening;
    return opening;
  }

  private abandonIfClosed(attempt: number, db: IDBDatabase): void {
    if (attempt === this.openAttempt) return;
    db.close();
    throw new DOMException(
      "IndexedDB open was abandoned because the LocalStore closed",
      "AbortError",
    );
  }

  private async performOpen(attempt: number, onProgress?: () => void): Promise<void> {
    const requestedVersion = this.configuredDbVersion ?? DEFAULT_DB_VERSION;
    let db: IDBDatabase;
    try {
      // Fresh databases are created directly at the current version, with all
      // stores, indexes, and the fingerprint in one upgrade transaction.
      db = await openDB(this.dbName, requestedVersion, this.schema, onProgress);
    } catch (error) {
      // An existing database may already be newer than a caller's configured
      // floor. Discover and accept that version instead of failing downgrade.
      if (!(error instanceof DOMException) || error.name !== "VersionError") throw error;
      db = await openDB(this.dbName, undefined, this.schema, onProgress);
    }
    this.abandonIfClosed(attempt, db);

    const reopenAt = async (nextVersion: number): Promise<IDBDatabase> => {
      // Close synchronously, then yield a macrotask before re-opening at the
      // higher version. db.close() only requests close; the actual close
      // happens after pending transactions drain. Reopening immediately can
      // race the prior connection still appearing live to indexedDB.open(),
      // producing a transient 'blocked' event. The yield gives the platform
      // a beat to finalize the close. Onversionchange on the prior handle
      // is still our backstop if any other connection lingers.
      db.close();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      if (attempt !== this.openAttempt) {
        throw new DOMException(
          "IndexedDB repair was abandoned because the LocalStore closed",
          "AbortError",
        );
      }
      // A reopen is itself "progress" — the deadline (if any) has already
      // been disarmed, but we keep the contract by signaling again on the
      // upcoming upgrade-needed.
      const reopened = await openDB(this.dbName, nextVersion, this.schema, onProgress);
      this.abandonIfClosed(attempt, reopened);
      return reopened;
    };

    let storedFingerprint = await this.readCacheFingerprint(db);
    this.abandonIfClosed(attempt, db);
    const repairVersion = this.needsRepair(db, storedFingerprint)
      ? Math.max(db.version + 1, requestedVersion)
      : null;

    if (repairVersion !== null) {
      db = await reopenAt(repairVersion);
      storedFingerprint = await this.readCacheFingerprint(db);
      this.abandonIfClosed(attempt, db);
    }

    if (storedFingerprint !== this.desiredFingerprint) {
      await this.writeCacheFingerprint(db);
      this.abandonIfClosed(attempt, db);
    }

    this.db = db;
  }

  /**
   * Close this store and abandon any in-flight `open()` or schema repair.
   * Native IndexedDB requests may still finish, but a late result closes its
   * handle instead of reviving this instance. A later `open()` starts a new
   * attempt.
   */
  close(): void {
    // IndexedDB open requests cannot be cancelled. Invalidating the attempt
    // makes a late success close its handle instead of reviving this store
    // after a resilient wrapper has already abandoned it for memory fallback.
    this.openAttempt += 1;
    this.opening = null;
    this.db?.close();
    this.db = null;
  }

  private ensureDB(): IDBDatabase {
    if (!this.db) throw new Error("LocalStore not opened");
    return this.db;
  }

  // ── Rows ─────────────────────────────────────────────────────────

  private rowKey(table: string, rowId: string): string {
    return `${table}/${rowId}`;
  }

  async getRow(table: string, rowId: string): Promise<Row | undefined> {
    const db = this.ensureDB();
    const t = tx(db, STORES.rows, "readonly");
    const store = t.objectStore(STORES.rows);
    const result = await reqToPromise(store.get(this.rowKey(table, rowId)));
    return result as Row | undefined;
  }

  async getRows(refs: readonly RowRef[]): Promise<(Row | undefined)[]> {
    if (refs.length === 0) return [];
    const db = this.ensureDB();
    const t = tx(db, STORES.rows, "readonly");
    const store = t.objectStore(STORES.rows);
    const requests = refs.map((ref) => store.get(this.rowKey(ref.table, ref.rowId)));
    await txComplete(t);
    return requests.map((request) => request.result as Row | undefined);
  }

  /** Stamp the composite IndexedDB key into row._meta.key. Pure. */
  private withKey(row: Row): Row {
    return {
      ...row,
      _meta: { ...row._meta, key: this.rowKey(row._meta.table, row._meta.rowId) },
      payload: row.payload,
    };
  }

  async putRow(row: Row): Promise<void> {
    const db = this.ensureDB();
    const t = tx(db, STORES.rows, "readwrite");
    const store = t.objectStore(STORES.rows);
    store.put(this.withKey(row));
    await txComplete(t);
  }

  async putRows(rows: Row[]): Promise<void> {
    if (rows.length === 0) return;
    const db = this.ensureDB();
    const t = tx(db, STORES.rows, "readwrite");
    const store = t.objectStore(STORES.rows);
    for (const row of rows) {
      store.put(this.withKey(row));
    }
    await txComplete(t);
  }

  async getTable(table: string): Promise<Row[]> {
    const db = this.ensureDB();
    const t = tx(db, STORES.rows, "readonly");
    const store = t.objectStore(STORES.rows);
    const index = store.index("by_table");
    const results = await reqToPromise(index.getAll(table));
    return (results as Row[]).filter((r) => !r._meta.deleted);
  }

  async queryWhere(table: string, clause: WhereClause): Promise<Row[]> {
    const db = this.ensureDB();
    const indexDef = hasSchemaIndex(this.schema, table, clause.field);

    if (!indexDef) {
      const rows = await this.getTable(table);
      return rows.filter((row) => matchesClause(readColumnValue(row, clause.field), clause));
    }

    const t = tx(db, STORES.rows, "readonly");
    const store = t.objectStore(STORES.rows);
    const indexName = schemaIndexName(table, indexDef.name);
    if (!store.indexNames.contains(indexName)) {
      const rows = await this.getTable(table);
      return rows.filter((row) => matchesClause(readColumnValue(row, clause.field), clause));
    }
    const index = store.index(indexName);

    if (clause.op === "anyOf") {
      const values = clause.values ?? [];
      const merged = new Map<string, Row>();
      for (const value of values) {
        const matches = await reqToPromise(index.getAll(IDBKeyRange.only([table, value])));
        for (const row of matches as Row[]) {
          if (!row._meta.deleted && row._meta.table === table) {
            merged.set(`${row._meta.table}/${row._meta.rowId}`, row);
          }
        }
      }
      return Array.from(merged.values());
    }

    const range = rangeForClause(table, clause);
    const results = await reqToPromise(index.getAll(range ?? undefined));
    return (results as Row[]).filter((row) => !row._meta.deleted && row._meta.table === table);
  }

  async getTableNames(): Promise<string[]> {
    const db = this.ensureDB();
    // Intentionally avoids openKeyCursor: Safari rejects null as a key range
    // argument in some IDB versions. A full-store getAll() is safe everywhere
    // and acceptable here — called once at init on an otherwise-empty DB.
    const t = tx(db, STORES.rows, "readonly");
    const store = t.objectStore(STORES.rows);
    const all = (await reqToPromise(store.getAll())) as Row[];
    const names = new Set<string>();
    for (const row of all) {
      const table = row._meta?.table;
      if (table) names.add(table);
    }
    return Array.from(names);
  }

  async getAllRows(): Promise<Row[]> {
    const db = this.ensureDB();
    const t = tx(db, STORES.rows, "readonly");
    const store = t.objectStore(STORES.rows);
    return reqToPromise(store.getAll()) as Promise<Row[]>;
  }

  async clearRows(): Promise<void> {
    const db = this.ensureDB();
    const t = tx(db, STORES.rows, "readwrite");
    t.objectStore(STORES.rows).clear();
    await txComplete(t);
  }

  // ── Outbox ───────────────────────────────────────────────────────

  async commitLocalMutation(row: Row, change: ChangeEntry): Promise<void> {
    const db = this.ensureDB();
    const t = tx(db, [STORES.rows, STORES.meta, STORES.pendingOps], "readwrite");
    const meta = t.objectStore(STORES.meta);
    const current = (await reqToPromise(meta.get(PENDING_BATCH_META_KEY))) as
      | PendingBatchHeader
      | undefined;
    let hlc = change.hlc;
    if (!current) {
      const { ops: _ops, ...header } = change;
      meta.put(header, PENDING_BATCH_META_KEY);
    } else if (current.hlc < change.hlc) {
      meta.put({ ...current, hlc: change.hlc }, PENDING_BATCH_META_KEY);
    } else {
      hlc = current.hlc;
    }
    const pendingOps = t.objectStore(STORES.pendingOps);
    for (const op of change.ops) pendingOps.add(op);
    t.objectStore(STORES.rows).put(this.withKey(row));
    meta.put(hlc, "hlc");
    await txComplete(t);
  }

  async peekPendingBatch(): Promise<ChangeEntry | null> {
    const db = this.ensureDB();
    const t = tx(db, [STORES.meta, STORES.pendingOps], "readonly");
    return readPendingBatch(t);
  }

  async promotePendingBatch(): Promise<ChangeEntry | null> {
    const db = this.ensureDB();
    const t = tx(db, [STORES.meta, STORES.pendingOps, STORES.outbox], "readwrite");
    const pending = await readPendingBatch(t);
    if (pending) {
      t.objectStore(STORES.outbox).add(pending);
      t.objectStore(STORES.pendingOps).clear();
      t.objectStore(STORES.meta).delete(PENDING_BATCH_META_KEY);
    }
    await txComplete(t);
    return pending;
  }

  async pushOutbox(entry: ChangeEntry): Promise<void> {
    await this.pushOutboxEntries([entry]);
  }

  async pushOutboxEntries(entries: ChangeEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const db = this.ensureDB();
    const t = tx(db, STORES.outbox, "readwrite");
    const store = t.objectStore(STORES.outbox);
    const byId = store.index(OUTBOX_ID_INDEX);
    // Re-queueing an entry that is already durable must be a no-op, not a
    // duplicate upload, so look each id up before appending.
    await Promise.all(
      entries.map(async (entry) => {
        const existing = await reqToPromise(byId.getKey(entry.id));
        if (existing === undefined) store.add(entry);
      }),
    );
    await txComplete(t);
  }

  async peekOutbox(): Promise<ChangeEntry[]> {
    const db = this.ensureDB();
    const t = tx(db, STORES.outbox, "readonly");
    return reqToPromise(t.objectStore(STORES.outbox).getAll()) as Promise<ChangeEntry[]>;
  }

  async acknowledgeOutbox(entryIds: readonly string[]): Promise<void> {
    if (entryIds.length === 0) return;
    const db = this.ensureDB();
    const t = tx(db, STORES.outbox, "readwrite");
    const store = t.objectStore(STORES.outbox);
    const byId = store.index(OUTBOX_ID_INDEX);
    await Promise.all(
      entryIds.map(async (id) => {
        const key = await reqToPromise(byId.getKey(id));
        if (key !== undefined) store.delete(key);
      }),
    );
    await txComplete(t);
  }

  async drainOutbox(): Promise<ChangeEntry[]> {
    const db = this.ensureDB();
    const t = tx(db, STORES.outbox, "readwrite");
    const store = t.objectStore(STORES.outbox);
    const entries = (await reqToPromise(store.getAll())) as ChangeEntry[];
    store.clear();
    await txComplete(t);
    return entries;
  }

  async outboxSize(): Promise<number> {
    const db = this.ensureDB();
    const t = tx(db, STORES.outbox, "readonly");
    return reqToPromise(t.objectStore(STORES.outbox).count());
  }

  // ── Cursors ──────────────────────────────────────────────────────

  async getCursor(deviceId: string): Promise<number> {
    const db = this.ensureDB();
    const t = tx(db, STORES.cursors, "readonly");
    const result = await reqToPromise(t.objectStore(STORES.cursors).get(deviceId));
    return (result as number) || 0;
  }

  async setCursor(deviceId: string, offset: number): Promise<void> {
    const db = this.ensureDB();
    const t = tx(db, STORES.cursors, "readwrite");
    t.objectStore(STORES.cursors).put(offset, deviceId);
    await txComplete(t);
  }

  async getAllCursors(): Promise<Record<string, number>> {
    const db = this.ensureDB();
    const t = tx(db, STORES.cursors, "readonly");
    const store = t.objectStore(STORES.cursors);
    const keys = (await reqToPromise(store.getAllKeys())) as string[];
    const values = (await reqToPromise(store.getAll())) as number[];
    const cursors: Record<string, number> = {};
    for (let i = 0; i < keys.length; i++) {
      cursors[keys[i]] = values[i];
    }
    return cursors;
  }

  // ── Meta ─────────────────────────────────────────────────────────

  async getMeta(key: string): Promise<unknown> {
    const db = this.ensureDB();
    const t = tx(db, STORES.meta, "readonly");
    return reqToPromise(t.objectStore(STORES.meta).get(key));
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    const db = this.ensureDB();
    const t = tx(db, STORES.meta, "readwrite");
    t.objectStore(STORES.meta).put(value, key);
    await txComplete(t);
  }

  /**
   * Enumerate the whole `meta` store.
   *
   * Not part of `LocalStore`: the interface exposes `getMeta(key)` only, which
   * is enough for the engine but not for a store-format migration, which must
   * carry *every* meta key (mesh id, HLC, app bookkeeping) into the new
   * generation. Dropping an unknown meta key is how a migration silently forks
   * a mesh, so the migration helper copies by enumeration, not by allowlist.
   *
   * Keys in {@link INTERNAL_META_KEYS} are per-database bookkeeping and are
   * returned here but must not be copied across generations.
   */
  async getAllMeta(): Promise<Record<string, unknown>> {
    const db = this.ensureDB();
    const t = tx(db, STORES.meta, "readonly");
    const store = t.objectStore(STORES.meta);
    const keys = (await reqToPromise(store.getAllKeys())) as IDBValidKey[];
    const values = (await reqToPromise(store.getAll())) as unknown[];
    const meta: Record<string, unknown> = {};
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (typeof key === "string") meta[key] = values[i];
    }
    return meta;
  }

  /**
   * Install an open (un-promoted) pending batch into this database.
   *
   * The inverse of {@link peekPendingBatch}, and the only way a migration can
   * carry an open batch into a new generation without prematurely promoting it
   * into the outbox — promotion would publish a batch the engine still
   * considers open, changing batching semantics behind the app's back.
   */
  async adoptPendingBatch(entry: ChangeEntry): Promise<void> {
    const db = this.ensureDB();
    const t = tx(db, [STORES.meta, STORES.pendingOps], "readwrite");
    const { ops, ...header } = entry;
    t.objectStore(STORES.meta).put(header, PENDING_BATCH_META_KEY);
    const pendingOps = t.objectStore(STORES.pendingOps);
    for (const op of ops) pendingOps.add(op);
    await txComplete(t);
  }

  /** Nuke everything. Used before full rehydration. */
  async clearAll(): Promise<void> {
    const db = this.ensureDB();
    const t = tx(db, Object.values(STORES), "readwrite");
    for (const name of Object.values(STORES)) {
      t.objectStore(name).clear();
    }
    await txComplete(t);
  }
}
