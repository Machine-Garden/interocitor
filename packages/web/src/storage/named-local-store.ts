// compass: interocitor.rows.local-store

import { MemoryLocalStore } from "@interocitor/core";
import { IndexedDbLocalStore, INTERNAL_META_KEYS } from "./indexed-db-local-store.ts";
import {
  isGeneratedLocalDatabaseName,
  UnstableCredentialNamespaceError,
} from "./local-database-name.ts";
import {
  createDefaultSlotStore,
  createResilientLocalStore,
  hasUnpushedLocalWrites,
  setUnpushedLocalWrites,
  UnpushedLocalWritesError,
} from "./resilient-store.ts";
import type { ChangeEntry, LocalStore, DatabaseSchemaDefinition } from "@interocitor/core";
import type { LocalStoreMigrationExtensions } from "./indexed-db-local-store.ts";
import type {
  KeyValueSlots,
  LocalStoreDegradationInfo,
  LocalStoreDegradedHook,
} from "./resilient-store.ts";

/**
 * Versioned IndexedDB rotation primitive and store-format seam.
 *
 * Two distinct kinds of version live here, and conflating them is how a
 * migration loses data:
 *
 * - **Physical generation** — the IndexedDB database *name* (`baseName`, then
 *   `baseName-v2-4f3a…`). Rotating it abandons one physical database and
 *   starts another. It carries no meaning about the shape of what is stored.
 * - **Store format** — what the bytes in a database *mean*: today
 *   {@link LEGACY_PLAINTEXT_ROWS_FORMAT}, structured-clone plaintext rows;
 *   tomorrow, an encrypted local mailbox. Recorded inside the database itself
 *   under {@link STORE_FORMAT_META_KEY}.
 *
 * Invariant ("will never stuck"): the application must keep working no matter
 * what state IndexedDB is in. When a disaster occurs (handle keeps closing,
 * repeated blocked open, irrecoverable corruption) we rotate to the next
 * physical generation, remember the new pointer in a small persistent slot,
 * and reopen — *unless* the outgoing generation holds writes the remote has
 * never seen, in which case rotation is refused with a typed
 * {@link UnpushedLocalWritesError}. Availability does not outrank a user's
 * unsynced work.
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
 * ## Why a format change must rotate
 *
 * IndexedDB sits on LevelDB (Chromium) or SQLite (WebKit). Both are
 * append-oriented: overwriting a record does not erase the bytes of the record
 * it replaced, and deleting the logical database (see `resetLocalDatabase`)
 * guarantees nothing about the underlying blocks. An *in-place* rewrite of a
 * plaintext database into an encrypted one therefore cannot retroactively
 * protect anything already written — the old plaintext may still be on disk.
 * Only writing the new format into a *fresh physical generation* gives the new
 * format a database whose entire history was written under it. Hence
 * {@link StoreFormatDescriptor.requiresFreshGeneration} defaults to `true`.
 *
 * This module deliberately depends on `createResilientLocalStore` so it gets
 * the open-deadline, post-open closing-handle recovery, and the unpushed-write
 * guard for free.
 */

// ── Store format seam ──────────────────────────────────────────────

/** Meta key under which a database records the format of its own contents. */
export const STORE_FORMAT_META_KEY = "interocitor:store:format";

/**
 * The format every install in the field is on today: structured-clone
 * plaintext `Row` objects in `rows`, plaintext change history in `outbox` and
 * `pendingOps`, keyed by `${table}/${rowId}`.
 */
export const LEGACY_PLAINTEXT_ROWS_FORMAT = "plaintext-rows-v1";

/** What a migration is handed. */
export interface StoreFormatMigrationContext {
  /** Format id the data is currently in. */
  readonly from: string;
  /** Format id the data must end up in. */
  readonly to: string;
  /** The opened store holding the `from` data. Read-only by convention. */
  readonly source: LocalStore & LocalStoreMigrationExtensions;
  /**
   * The opened store to write `to`-format data into. A different physical
   * database unless the descriptor opted into an in-place upgrade, in which
   * case it is the same object as `source`.
   */
  readonly target: LocalStore & LocalStoreMigrationExtensions;
  /** True when `source === target`. */
  readonly inPlace: boolean;
  /** Physical database name behind `source`. */
  readonly sourceDatabaseName: string;
  /** Physical database name behind `target`. */
  readonly targetDatabaseName: string;
}

/**
 * Move data from `ctx.from` into `ctx.to`. Must be idempotent-safe to
 * re-attempt: it runs against a freshly created target, and a throw leaves the
 * source untouched and the pointer un-advanced.
 */
export type StoreFormatMigration = (ctx: StoreFormatMigrationContext) => Promise<void>;

/** A registered store format and the paths into it. */
export interface StoreFormatDescriptor {
  /** Stable id recorded in the database. Never reuse an id for a new shape. */
  readonly id: string;
  /**
   * Migrations *into* this format, keyed by the id being migrated *from*.
   * A format with no entry for the recorded id cannot be reached from it, and
   * `open()` refuses with {@link UnsupportedStoreFormatUpgradeError}.
   */
  readonly migrateFrom?: Readonly<Record<string, StoreFormatMigration>>;
  /**
   * Whether reaching this format requires a fresh physical database
   * generation. Defaults to `true`, which is the correct answer for any
   * format whose point is that the *old* bytes must stop existing — an
   * in-place rewrite cannot deliver that (see the module note above).
   * Set `false` only for a format change that is purely structural.
   */
  readonly requiresFreshGeneration?: boolean;
}

const registeredFormats = new Map<string, StoreFormatDescriptor>();

/**
 * The identity format. It declares a no-op migration from itself so the
 * decision procedure has one uniform shape: there is no special "current
 * format" branch, only a migration that happens to do nothing.
 */
const legacyFormat: StoreFormatDescriptor = {
  id: LEGACY_PLAINTEXT_ROWS_FORMAT,
  requiresFreshGeneration: false,
  migrateFrom: {
    [LEGACY_PLAINTEXT_ROWS_FORMAT]: async () => {
      /* identity */
    },
  },
};
registeredFormats.set(legacyFormat.id, legacyFormat);

/**
 * Register a store format so `createNamedLocalStore({ storeFormat })` can
 * target it. A future encrypted local mailbox registers itself here; nothing
 * in this module knows anything about encryption.
 */
export function registerStoreFormat(descriptor: StoreFormatDescriptor): void {
  if (descriptor.id === LEGACY_PLAINTEXT_ROWS_FORMAT) {
    throw new Error(`Cannot re-register the built-in format ${JSON.stringify(descriptor.id)}.`);
  }
  registeredFormats.set(descriptor.id, descriptor);
}

/** Remove a registered format. Intended for tests and host teardown. */
export function unregisterStoreFormat(id: string): void {
  if (id === LEGACY_PLAINTEXT_ROWS_FORMAT) return;
  registeredFormats.delete(id);
}

/** Look up a format descriptor by id. */
export function getStoreFormat(id: string): StoreFormatDescriptor | undefined {
  return registeredFormats.get(id);
}

/** All format ids this build understands. */
export function listStoreFormats(): string[] {
  return Array.from(registeredFormats.keys());
}

/** Base class for every typed store-format refusal. Never an unhandled throw. */
export class StoreFormatError extends Error {
  constructor(
    message: string,
    readonly code: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "StoreFormatError";
  }
}

/**
 * The database records a format id this build has never heard of — almost
 * always a *downgrade*: a newer build wrote the database, then the user
 * loaded an older one. Opening it as anything would misread it, so refuse
 * and leave every byte alone.
 */
export class UnknownStoreFormatError extends StoreFormatError {
  constructor(
    readonly recordedFormat: string,
    readonly databaseName: string,
    readonly knownFormats: readonly string[],
  ) {
    super(
      `Local database ${JSON.stringify(databaseName)} records store format ` +
        `${JSON.stringify(recordedFormat)}, which this build does not understand ` +
        `(known: ${knownFormats.join(", ")}). This is normally a downgrade — a newer build wrote ` +
        `this database. Refusing to open or modify it.`,
      "UNKNOWN_STORE_FORMAT",
    );
    this.name = "UnknownStoreFormatError";
  }
}

/** The recorded format is known, but no registered path reaches the desired one. */
export class UnsupportedStoreFormatUpgradeError extends StoreFormatError {
  constructor(
    readonly recordedFormat: string,
    readonly desiredFormat: string,
    readonly databaseName: string,
  ) {
    super(
      `No registered migration from store format ${JSON.stringify(recordedFormat)} to ` +
        `${JSON.stringify(desiredFormat)} for local database ${JSON.stringify(databaseName)}. ` +
        `Register a migration on the target format, or open with the recorded format.`,
      "UNSUPPORTED_STORE_FORMAT_UPGRADE",
    );
    this.name = "UnsupportedStoreFormatUpgradeError";
  }
}

/**
 * A migration path existed and threw. The source generation and the rotation
 * pointer are untouched: the app is still on its old data and a host can
 * retry, report, or ship a fix.
 */
export class StoreFormatMigrationFailedError extends StoreFormatError {
  constructor(
    readonly fromFormat: string,
    readonly toFormat: string,
    readonly sourceDatabaseName: string,
    readonly targetDatabaseName: string,
    cause: unknown,
  ) {
    super(
      `Migration of local database ${JSON.stringify(sourceDatabaseName)} from store format ` +
        `${JSON.stringify(fromFormat)} to ${JSON.stringify(toFormat)} failed. The source database ` +
        `was left untouched and the active generation pointer was not advanced.`,
      "STORE_FORMAT_MIGRATION_FAILED",
      { cause },
    );
    this.name = "StoreFormatMigrationFailedError";
  }
}

/**
 * Copy every piece of durable state from one store into another, verbatim.
 *
 * This is the body of the identity-shaped migration and the starting point for
 * a real one: a format that re-encodes rows still has to carry the outbox, the
 * open pending batch, all cursors, and all app meta, or the device silently
 * forks the mesh. Transforming formats should call this and then rewrite, or
 * copy selectively with the same completeness.
 *
 * Copy order is chosen so a crash mid-migration leaves the target strictly
 * *behind*, never ahead: rows first, then cursors/meta, then unpushed change
 * history last, so the target is never advertising a sync position for change
 * history it does not yet hold.
 */
export async function copyLocalStoreState(
  source: LocalStore & LocalStoreMigrationExtensions,
  target: LocalStore & LocalStoreMigrationExtensions,
): Promise<void> {
  // Rows, tombstones included: a tombstone is state, and dropping one
  // resurrects a deleted row on the next merge.
  const rows = await source.getAllRows();
  if (rows.length > 0) await target.putRows(rows);

  const cursors = await source.getAllCursors();
  for (const [deviceId, offset] of Object.entries(cursors)) {
    await target.setCursor(deviceId, offset);
  }

  if (typeof source.getAllMeta === "function") {
    const meta = await source.getAllMeta();
    for (const [key, value] of Object.entries(meta)) {
      if (INTERNAL_META_KEYS.includes(key)) continue;
      if (key === STORE_FORMAT_META_KEY) continue;
      await target.setMeta(key, value);
    }
  } else {
    throw new Error(
      "Store-format migration source cannot enumerate its meta store. Copying an allowlist of " +
        "meta keys risks dropping the mesh id or HLC and forking the mesh; refusing to guess.",
    );
  }

  const outbox = await source.peekOutbox();
  if (outbox.length > 0) await target.pushOutboxEntries(outbox as ChangeEntry[]);

  const pending = await source.peekPendingBatch();
  if (pending) {
    if (typeof target.adoptPendingBatch !== "function") {
      throw new Error(
        "Store-format migration target cannot adopt an open pending batch. Promoting it into the " +
          "outbox instead would publish a batch the engine still considers open; refusing.",
      );
    }
    await target.adoptPendingBatch(pending);
  }
}

// ── Rotation ───────────────────────────────────────────────────────

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
  /**
   * Store format this build wants the active database to be in.
   * Defaults to {@link LEGACY_PLAINTEXT_ROWS_FORMAT}.
   */
  storeFormat?: string;
  /**
   * Formats visible to this store in addition to (and overriding) the global
   * registry. Lets a host or a test supply a format without global state.
   */
  formats?: readonly StoreFormatDescriptor[];
  /** Notified after a successful format migration. */
  onFormatMigrated?: (info: {
    from: string;
    to: string;
    sourceDatabaseName: string;
    targetDatabaseName: string;
  }) => void;
  /**
   * Opt out of the unpushed-write guard: allow degrade-to-memory and rotation
   * even when the outgoing database holds change history the remote has never
   * seen. Off by default.
   */
  allowDiscardingUnpushedWrites?: boolean;
  /** Override the unpushed-marker slots (tests, SSR). */
  unpushedSlots?: KeyValueSlots;
  /** Notified when a rotation was refused to protect unpushed writes. */
  onRotationRefused?: (info: { databaseName: string; reason: string }) => void;
}

/**
 * A rotatable local cache with a stable encryption-domain identity.
 *
 * `credentialNamespace` is safe to pass to the engine and credential stores.
 * `activeDatabaseName` is the current physical IndexedDB generation and is
 * exposed for diagnostics and exact maintenance only.
 * `storeFormat` is the format the active database is recorded to be in.
 */
export interface NamedLocalStore extends LocalStore {
  readonly credentialNamespace: string;
  readonly activeDatabaseName: string;
  readonly storeFormat: string;
}

export interface PointerStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

function defaultPointerStore(): PointerStore {
  return createDefaultSlotStore();
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

export interface RotateLocalDatabaseNameOptions {
  /**
   * Rotate even though the outgoing generation holds unpushed writes,
   * accepting that they will be stranded in an abandoned database.
   */
  force?: boolean;
  /** Override the unpushed-marker slots (tests, SSR). */
  unpushedSlots?: KeyValueSlots;
}

/**
 * Advance a logical store to a fresh physical IndexedDB generation.
 *
 * Call only after disconnecting the current engine. This does not delete the
 * previous database or change the encryption domain. Credentials remain
 * anchored to the stable `baseName`, never to the returned physical name.
 *
 * Refuses with {@link UnpushedLocalWritesError} when the outgoing generation
 * still holds change history the remote has never seen. Rotating past it would
 * strand the user's own writes in a database nothing will ever open again —
 * indistinguishable from deleting them, and it forks the mesh. Pass
 * `{ force: true }` only when the caller has accepted that loss.
 */
export function rotateLocalDatabaseName(
  baseName: string,
  pointer: PointerStore = defaultPointerStore(),
  options: RotateLocalDatabaseNameOptions = {},
): { from: string; to: string } {
  const slot = pointerKey(baseName);
  const from = pointer.get(slot) ?? baseName;
  if (!options.force && hasUnpushedLocalWrites(from, options.unpushedSlots)) {
    throw new UnpushedLocalWritesError(from, "rotate");
  }
  // The counter is diagnostic only. The random suffix makes physical names
  // distinct even when two tabs race the pointer's read-modify-write cycle.
  const to = freshGenerationName(baseName, parseVersion(from, baseName) + 1);
  pointer.set(slot, to);
  return { from, to };
}

// ── Format decision at open ────────────────────────────────────────

/**
 * Decide what a database's contents are, given what it records and what the
 * caller wants. Pure: it reads nothing and destroys nothing.
 */
function resolveFormatPlan(
  recorded: string,
  desired: string,
  databaseName: string,
  lookup: (id: string) => StoreFormatDescriptor | undefined,
  knownFormats: readonly string[],
):
  | { kind: "identity" }
  | { kind: "migrate"; migration: StoreFormatMigration; freshGeneration: boolean } {
  if (!lookup(recorded)) {
    throw new UnknownStoreFormatError(recorded, databaseName, knownFormats);
  }
  const target = lookup(desired);
  if (!target) {
    throw new UnknownStoreFormatError(desired, databaseName, knownFormats);
  }
  if (recorded === desired) return { kind: "identity" };

  const migration = target.migrateFrom?.[recorded];
  if (!migration) {
    throw new UnsupportedStoreFormatUpgradeError(recorded, desired, databaseName);
  }
  return {
    kind: "migrate",
    migration,
    freshGeneration: target.requiresFreshGeneration ?? true,
  };
}

/**
 * Create a `LocalStore` that automatically rotates to a new versioned
 * IndexedDB name when the active DB handle becomes unusable, and that
 * reconciles the store format of the active database at open time.
 *
 * `open()` either succeeds on a database recorded to be in
 * `options.storeFormat`, or rejects with a typed {@link StoreFormatError} /
 * {@link UnpushedLocalWritesError}. It never throws an unclassified exception
 * and never destroys a database it could not understand.
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
  const desiredFormat = options.storeFormat ?? LEGACY_PLAINTEXT_ROWS_FORMAT;

  const localFormats = new Map<string, StoreFormatDescriptor>();
  for (const descriptor of options.formats ?? []) localFormats.set(descriptor.id, descriptor);
  const lookupFormat = (id: string): StoreFormatDescriptor | undefined =>
    localFormats.get(id) ?? registeredFormats.get(id);
  const knownFormats = (): string[] =>
    Array.from(new Set([...localFormats.keys(), ...registeredFormats.keys()]));

  const persistedName = pointer.get(slot);
  const initialVersion = persistedName ? parseVersion(persistedName, options.baseName) : 1;
  let activeName = persistedName ?? buildName(options.baseName, initialVersion);
  pointer.set(slot, activeName);
  let activeFormat = desiredFormat;

  const rotate = (reason: string): void => {
    try {
      const { from: previousName, to: nextName } = rotateLocalDatabaseName(
        options.baseName,
        pointer,
        {
          force: options.allowDiscardingUnpushedWrites,
          unpushedSlots: options.unpushedSlots,
        },
      );
      activeName = nextName;
      if (options.onRotated) {
        try {
          options.onRotated({ from: previousName, to: nextName, reason });
        } catch {
          /* never stuck */
        }
      }
    } catch (error) {
      if (!(error instanceof UnpushedLocalWritesError)) throw error;
      // Availability does not outrank the user's unsynced work. Stay on the
      // troubled generation and let the caller see the failure.
      if (options.onRotationRefused) {
        try {
          options.onRotationRefused({ databaseName: error.dbName, reason });
        } catch {
          /* never stuck */
        }
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
    // it for those. Note this hook only fires for a degrade that was allowed:
    // a degrade blocked by unpushed writes throws instead, so no rotation can
    // be scheduled off the back of it.
    if (info.reason === "idb-handle-closing" || info.reason === "idb-open-stalled-or-unavailable") {
      rotate(info.reason);
    }
  };

  const makeInner = (name: string): LocalStore =>
    createResilientLocalStore({
      dbName: name,
      schema: options.schema,
      openTimeoutMs: options.openTimeoutMs,
      onDegraded: wrappedOnDegraded,
      allowDegradeWithUnpushedWrites: options.allowDiscardingUnpushedWrites,
      unpushedSlots: options.unpushedSlots,
      markerName: name,
      primaryFactory: () => new IndexedDbLocalStore(name, undefined, options.schema),
      fallbackFactory: () => new MemoryLocalStore(),
    });

  let inner: LocalStore = makeInner(activeName);
  const store = (): LocalStore => inner;

  /** Read the recorded format, inferring it for databases written before the seam existed. */
  const readRecordedFormat = async (
    current: LocalStore,
  ): Promise<{ format: string; stamped: boolean }> => {
    const recorded = await current.getMeta(STORE_FORMAT_META_KEY);
    if (typeof recorded === "string" && recorded.length > 0) {
      return { format: recorded, stamped: true };
    }

    // No stamp. Either a database written before this seam existed (which is
    // legacy plaintext rows by definition — it is the only format that has
    // ever shipped), or one we just created. Emptiness distinguishes them, and
    // the answer is the same for a fresh database only because `desiredFormat`
    // decides that case.
    const [rows, outboxSize, pending] = await Promise.all([
      current.getAllRows(),
      current.outboxSize(),
      current.peekPendingBatch(),
    ]);
    const empty = rows.length === 0 && outboxSize === 0 && pending === null;
    return { format: empty ? desiredFormat : LEGACY_PLAINTEXT_ROWS_FORMAT, stamped: false };
  };

  const reconcileFormat = async (): Promise<void> => {
    const { format: recorded, stamped } = await readRecordedFormat(inner);
    const plan = resolveFormatPlan(
      recorded,
      desiredFormat,
      activeName,
      lookupFormat,
      knownFormats(),
    );

    if (plan.kind === "identity") {
      // Stamp so the next open is a cheap meta read instead of a scan, and so
      // a future build can tell "legacy" from "unknown" without guessing.
      // Stamping is the only write the identity path performs: it records what
      // the database already is, and changes no row, outbox entry, or cursor.
      if (!stamped) await inner.setMeta(STORE_FORMAT_META_KEY, recorded);
      activeFormat = recorded;
      return;
    }

    const source = inner as LocalStore & LocalStoreMigrationExtensions;

    if (!plan.freshGeneration) {
      try {
        await plan.migration({
          from: recorded,
          to: desiredFormat,
          source,
          target: source,
          inPlace: true,
          sourceDatabaseName: activeName,
          targetDatabaseName: activeName,
        });
      } catch (error) {
        throw new StoreFormatMigrationFailedError(
          recorded,
          desiredFormat,
          activeName,
          activeName,
          error,
        );
      }
      await inner.setMeta(STORE_FORMAT_META_KEY, desiredFormat);
      activeFormat = desiredFormat;
      return;
    }

    // Fresh-generation migration. Mint the next physical name *without*
    // advancing the pointer: the pointer moves only once the target database
    // is complete and stamped, so a crash anywhere in between simply reopens
    // the untouched source on the next run.
    const targetName = freshGenerationName(
      options.baseName,
      parseVersion(activeName, options.baseName) + 1,
    );
    const target = new IndexedDbLocalStore(targetName, undefined, options.schema);
    let migrated = false;
    try {
      await target.open();
      await plan.migration({
        from: recorded,
        to: desiredFormat,
        source,
        target,
        inPlace: false,
        sourceDatabaseName: activeName,
        targetDatabaseName: targetName,
      });
      await target.setMeta(STORE_FORMAT_META_KEY, desiredFormat);
      // The target now owns the unpushed history the source held; mark it
      // before the pointer moves, so a crash cannot leave a dirty source and a
      // clean-looking successor.
      const [outboxSize, pending] = await Promise.all([
        target.outboxSize(),
        target.peekPendingBatch(),
      ]);
      setUnpushedLocalWrites(
        targetName,
        outboxSize > 0 || pending !== null,
        options.unpushedSlots,
      );
      migrated = true;
    } catch (error) {
      throw new StoreFormatMigrationFailedError(
        recorded,
        desiredFormat,
        activeName,
        targetName,
        error,
      );
    } finally {
      target.close();
      if (!migrated) {
        // Nothing points at the half-built target; it is inert. It is
        // deliberately NOT deleted: a delete request cannot be cancelled and
        // may land on a name a later attempt has reused.
      }
    }

    // Swap over. The source generation is retained, never deleted — see the
    // module note on LevelDB/SQLite: deleting it would not erase its bytes
    // anyway, and retaining it keeps the failed-migration forensic path open.
    const sourceName = activeName;
    inner.close();
    pointer.set(slot, targetName);
    activeName = targetName;
    activeFormat = desiredFormat;
    inner = makeInner(activeName);
    await inner.open();
    if (options.onFormatMigrated) {
      try {
        options.onFormatMigrated({
          from: recorded,
          to: desiredFormat,
          sourceDatabaseName: sourceName,
          targetDatabaseName: targetName,
        });
      } catch {
        /* never stuck */
      }
    }
  };

  return {
    credentialNamespace: options.baseName,
    get activeDatabaseName() {
      return activeName;
    },
    get storeFormat() {
      return activeFormat;
    },
    withLock: (name, operation) => store().withLock(name, operation),
    async open() {
      await inner.open();
      await reconcileFormat();
    },
    close: () => store().close(),
    getRow: (table, rowId) => store().getRow(table, rowId),
    getRows: (refs) => store().getRows(refs),
    putRow: (row) => store().putRow(row),
    putRows: (rows) => store().putRows(rows),
    getTable: (table) => store().getTable(table),
    queryWhere: (table, clause) => store().queryWhere(table, clause),
    getAllRows: () => store().getAllRows(),
    clearRows: () => store().clearRows(),
    getTableNames: () => store().getTableNames(),
    commitLocalMutation: (row, change) => store().commitLocalMutation(row, change),
    peekPendingBatch: () => store().peekPendingBatch(),
    promotePendingBatch: () => store().promotePendingBatch(),
    pushOutbox: (entry) => store().pushOutbox(entry),
    pushOutboxEntries: (entries) => store().pushOutboxEntries(entries),
    peekOutbox: () => store().peekOutbox(),
    acknowledgeOutbox: (entryIds) => store().acknowledgeOutbox(entryIds),
    drainOutbox: () => store().drainOutbox(),
    outboxSize: () => store().outboxSize(),
    getCursor: (deviceId) => store().getCursor(deviceId),
    setCursor: (deviceId, offset) => store().setCursor(deviceId, offset),
    getAllCursors: () => store().getAllCursors(),
    getMeta: (key) => store().getMeta(key),
    setMeta: (key, value) => store().setMeta(key, value),
    clearAll: () => store().clearAll(),
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
