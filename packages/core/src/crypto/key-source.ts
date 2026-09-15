// compass: interocitor.trust.key-sources

import type { CredentialStore, StoredCredentials } from "../storage/credential-store.ts";

// ─── Credential availability contract ────────────────────────────────

/**
 * Why a credential read did or did not produce mesh key material.
 *
 * The distinction exists because exactly one of these states may mint a new
 * mesh key. `CredentialStore.load()` alone cannot express it: returning `null`
 * conflates "this device has never joined a mesh" with "the user cancelled the
 * biometric prompt", and treating the second as the first forks the mesh into
 * two halves that can never merge.
 *
 * - `present` — credentials were read. Use them.
 * - `absent` — the store is reachable and authoritatively holds nothing for
 *   this namespace. First run; generating a new key is correct.
 * - `unavailable` — the store could not be consulted: the user declined or
 *   dismissed an unlock ceremony, no authenticator is present, the
 *   ceremony aborted or timed out, permission was denied. Whether credentials
 *   exist is *unknown*. Fail closed.
 * - `unreadable` — a record exists but could not be decrypted or parsed:
 *   wrong wrapping key, corrupt blob, unknown schema version. Fail closed.
 */
export type MeshCredentialStatus = "present" | "absent" | "unavailable" | "unreadable";

/** The two states that must never auto-generate a key. */
export type MeshCredentialFailureStatus = Extract<
  MeshCredentialStatus,
  "unavailable" | "unreadable"
>;

/**
 * A credential read that reports *why* it produced what it produced.
 *
 * `credentials` is meaningful only when `status === "present"`, and must be
 * non-null there. `reason` is operator-facing text and must never contain key
 * material.
 */
export interface MeshCredentialLoadResult {
  status: MeshCredentialStatus;
  credentials?: StoredCredentials | null;
  reason?: string;
  cause?: unknown;
}

/**
 * Optional `CredentialStore` extension: a store that can distinguish absence
 * from inaccessibility.
 *
 * Implement `loadCredentialState()` alongside the existing `load()`. Core
 * calls it when present and falls back to `load()` otherwise, so a store that
 * does not implement it keeps today's behaviour exactly (`null` → `absent` →
 * a new key is generated on first run).
 *
 * Contract for implementers:
 *  - Return `{ status: "present", credentials }` only with a usable record.
 *  - Return `{ status: "absent" }` ONLY when the store was successfully
 *    consulted and holds nothing. This is the only status that permits a new
 *    mesh key to be minted, so never use it as a catch-all.
 *  - Return `{ status: "unavailable", reason }` when the store could not be
 *    consulted at all (ceremony cancelled/aborted/timed out, no authenticator,
 *    permission denied, storage unreachable).
 *  - Return `{ status: "unreadable", reason, cause }` when a record was found
 *    but could not be decrypted or parsed.
 *  - Prefer returning a result over throwing; a throw is also treated as
 *    fail-closed (`unavailable`) rather than as absence.
 *  - Never put key material, ciphertext, or any substring of either into
 *    `reason`.
 */
export interface CredentialStateStore extends CredentialStore {
  loadCredentialState(): Promise<MeshCredentialLoadResult>;
}

/**
 * Thrown when mesh credentials could not be read and generating a replacement
 * would fork the mesh.
 *
 * `status` says which case it was, so a host can retry an `unavailable`
 * ceremony (the user can simply be asked again) while treating `unreadable`
 * as a recovery/repair situation.
 */
export class MeshCredentialAccessError extends Error {
  readonly code = "MESH_CREDENTIAL_ACCESS_FAILED" as const;
  readonly status: MeshCredentialFailureStatus;
  readonly dbName: string | undefined;

  constructor(
    status: MeshCredentialFailureStatus,
    options: { dbName?: string; reason?: string; cause?: unknown } = {},
  ) {
    const scope = options.dbName ? ` for dbName="${options.dbName}"` : "";
    const detail = options.reason ? ` (${options.reason})` : "";
    super(
      status === "unavailable"
        ? `Mesh credentials are unavailable${scope}${detail}. The credential store could not be ` +
            `consulted, so whether a key exists is unknown. Refusing to generate a new mesh key: ` +
            `that would fork the mesh. Retry once the store is reachable.`
        : `Mesh credentials are unreadable${scope}${detail}. A credential record exists but could ` +
            `not be decrypted or parsed. Refusing to generate a new mesh key: that would fork the ` +
            `mesh. Recover or explicitly clear the record instead.`,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "MeshCredentialAccessError";
    this.status = status;
    this.dbName = options.dbName;
  }
}

/** True for the fail-closed credential error, across module instances. */
export function isMeshCredentialAccessError(err: unknown): err is MeshCredentialAccessError {
  return (
    err instanceof Error &&
    (err as Partial<MeshCredentialAccessError>).code === "MESH_CREDENTIAL_ACCESS_FAILED"
  );
}

const CREDENTIAL_STATUSES: readonly string[] = ["present", "absent", "unavailable", "unreadable"];

/**
 * Read a credential store, preferring the richer {@link CredentialStateStore}
 * hook and degrading safely to the plain `load()` contract.
 *
 * Deliberately defensive: an unrecognised status, or a `present` result with
 * no usable record, is treated as `unreadable` rather than as absence. Only a
 * store that explicitly says `absent` — or a legacy store that returns `null`
 * from `load()` — permits key generation.
 */
async function readCredentialState(
  store: CredentialStore | null,
  context: { dbName?: string },
): Promise<MeshCredentialLoadResult> {
  if (!store) return { status: "absent", credentials: null };

  const richLoad = (store as Partial<CredentialStateStore>).loadCredentialState;
  if (typeof richLoad !== "function") {
    // Legacy contract: `null` is indistinguishable from absence, and that is
    // exactly the behaviour these stores have today.
    const credentials = await store.load();
    return credentials?.portableKey
      ? { status: "present", credentials }
      : { status: "absent", credentials: null };
  }

  let result: MeshCredentialLoadResult;
  try {
    result = await richLoad.call(store);
  } catch (cause) {
    throw new MeshCredentialAccessError("unavailable", {
      dbName: context.dbName,
      reason: "credential store threw while reading",
      cause,
    });
  }

  const status = result?.status;
  if (!CREDENTIAL_STATUSES.includes(status as string)) {
    throw new MeshCredentialAccessError("unreadable", {
      dbName: context.dbName,
      reason: `credential store reported an unrecognised status: ${String(status)}`,
    });
  }
  if (status === "unavailable" || status === "unreadable") {
    throw new MeshCredentialAccessError(status, {
      dbName: context.dbName,
      reason: result.reason,
      cause: result.cause,
    });
  }
  if (status === "present" && !result.credentials?.portableKey) {
    throw new MeshCredentialAccessError("unreadable", {
      dbName: context.dbName,
      reason: "credential store reported present credentials with no portable key",
    });
  }
  return status === "present"
    ? { status: "present", credentials: result.credentials }
    : { status: "absent", credentials: null };
}

export interface MeshKeyContext {
  dbName: string;
  remotePath?: string;
  meshId?: string;
  deviceId: string;
}

export interface MeshKeyMaterial {
  encrypted: boolean;
  key: CryptoKey | null;
  portableKey?: string | null;
  /**
   * Why this load produced no key material, for sources that report it.
   *
   * A source may either throw {@link MeshCredentialAccessError} or return
   * `"unavailable"` / `"unreadable"` here; the engine treats both the same way
   * and refuses to generate a replacement key. Omitting the field keeps the
   * historical behaviour: no key means first run, so one is generated.
   */
  credentialStatus?: MeshCredentialStatus;
}

export type MeshKeyCredentialPersistence = "none" | "durable";

/**
 * How an engine obtains the mesh key it encrypts with.
 *
 * @see {@link ../../docs/security-model.md | Security model}
 *   — what the key protects, and what remains visible to the remote whatever
 *   the source.
 * @see {@link ../../docs/shared-key-scenarios.md | Shared key scenarios}
 *   — the portable and bound contracts, and who holds each key component.
 */
export interface MeshKeySource {
  /**
   * Whether this source writes credentials outside the engine's LocalStore.
   * Durable sources must expose side-effect-free inspection so the engine can
   * compare before replacing. Nonpersistent sources opt out explicitly.
   */
  readonly credentialPersistence: MeshKeyCredentialPersistence;
  load(context: MeshKeyContext): Promise<MeshKeyMaterial>;
  persist(context: MeshKeyContext, credentials: StoredCredentials): Promise<void>;
  clear(): Promise<void>;
  /**
   * Return the credential record already held by this source, without changing
   * the active key. Engines use this optional inspection hook to detect a
   * stale mesh anchor before adopting or overwriting persisted credentials.
   * Required when `credentialPersistence === "durable"`.
   */
  loadPersistedCredentials?(): Promise<StoredCredentials | null>;
}

export interface PortablePassphraseKeySourceOptions {
  portableKey?: string | null;
  credentialStore?: CredentialStore | null;
  generateIfMissing?: boolean;
}

export interface BoundSharedKeySourceOptions {
  credentialStore?: CredentialStore | null;
  derive: (context: MeshKeyContext & { portableKey: string }) => Promise<MeshKeyMaterial>;
  portableKey?: string | null;
}

/**
 * One portable key, held by every device in the mesh.
 *
 * @see {@link ../../docs/shared-key-scenarios.md | Shared key scenarios}
 *   — what this custody choice exposes in a database dump, and when the bound
 *   contract is the better trade.
 */
export class PortablePassphraseKeySource implements MeshKeySource {
  readonly credentialPersistence: MeshKeyCredentialPersistence;
  private portableKey: string | null;
  private readonly credentialStore: CredentialStore | null;
  private readonly generateIfMissing: boolean;

  constructor(options: PortablePassphraseKeySourceOptions = {}) {
    this.portableKey = options.portableKey ?? null;
    this.credentialStore = options.credentialStore ?? null;
    this.generateIfMissing = options.generateIfMissing ?? true;
    this.credentialPersistence = this.credentialStore ? "durable" : "none";
  }

  setPortableKey(portableKey: string | null): void {
    this.portableKey = portableKey;
  }

  getPortableKey(): string | null {
    return this.portableKey;
  }

  /**
   * @throws {MeshCredentialAccessError} when the store reports `unavailable`
   *   or `unreadable`. Inspection must not report "nothing stored" for a
   *   credential it simply could not read.
   */
  async loadPersistedCredentials(): Promise<StoredCredentials | null> {
    const state = await readCredentialState(this.credentialStore, {});
    return state.credentials ?? null;
  }

  /**
   * @throws {MeshCredentialAccessError} when the store reports `unavailable`
   *   or `unreadable`, so a cancelled ceremony never mints a second mesh key.
   */
  async load(context: MeshKeyContext): Promise<MeshKeyMaterial> {
    if (this.portableKey) {
      return {
        encrypted: true,
        key: null,
        portableKey: this.portableKey,
        credentialStatus: "present",
      };
    }
    const state = await readCredentialState(this.credentialStore, { dbName: context?.dbName });
    const stored = state.credentials;
    if (stored?.portableKey) {
      this.portableKey = stored.portableKey;
      return {
        encrypted: true,
        key: null,
        portableKey: stored.portableKey,
        credentialStatus: "present",
      };
    }
    if (!this.generateIfMissing) {
      return { encrypted: false, key: null, portableKey: null, credentialStatus: "absent" };
    }
    return { encrypted: true, key: null, portableKey: null, credentialStatus: "absent" };
  }

  async persist(_context: MeshKeyContext, credentials: StoredCredentials): Promise<void> {
    this.portableKey = credentials.portableKey;
    if (this.credentialStore) await this.credentialStore.save(credentials);
  }

  async clear(): Promise<void> {
    this.portableKey = null;
    if (this.credentialStore) await this.credentialStore.clear();
  }
}

/**
 * A portable component plus an application-supplied `derive`, so no single
 * stored component is the mesh key.
 *
 * @see {@link ../../docs/shared-key-scenarios.md | Shared key scenarios}
 *   — what `derive` must guarantee, and the exposure this contract removes.
 */
export class BoundSharedKeySource implements MeshKeySource {
  readonly credentialPersistence: MeshKeyCredentialPersistence;
  private portableKey: string | null;
  private readonly credentialStore: CredentialStore | null;
  private readonly deriveKey: BoundSharedKeySourceOptions["derive"];

  constructor(options: BoundSharedKeySourceOptions) {
    this.portableKey = options.portableKey ?? null;
    this.credentialStore = options.credentialStore ?? null;
    this.deriveKey = options.derive;
    this.credentialPersistence = this.credentialStore ? "durable" : "none";
  }

  setPortableKey(portableKey: string | null): void {
    this.portableKey = portableKey;
  }

  getPortableKey(): string | null {
    return this.portableKey;
  }

  /**
   * @throws {MeshCredentialAccessError} when the store reports `unavailable`
   *   or `unreadable`.
   */
  async loadPersistedCredentials(): Promise<StoredCredentials | null> {
    const state = await readCredentialState(this.credentialStore, {});
    return state.credentials ?? null;
  }

  /**
   * @throws {MeshCredentialAccessError} when the store reports `unavailable`
   *   or `unreadable`, so a cancelled ceremony never mints a second mesh key.
   */
  async load(context: MeshKeyContext): Promise<MeshKeyMaterial> {
    const stored = this.portableKey
      ? { portableKey: this.portableKey, deviceId: context.deviceId }
      : (await readCredentialState(this.credentialStore, { dbName: context?.dbName })).credentials;

    if (!stored?.portableKey) {
      return { encrypted: true, key: null, portableKey: null, credentialStatus: "absent" };
    }
    this.portableKey = stored.portableKey;
    const derived = await this.deriveKey({ ...context, portableKey: stored.portableKey });
    return { credentialStatus: "present", ...derived };
  }

  async persist(_context: MeshKeyContext, credentials: StoredCredentials): Promise<void> {
    this.portableKey = credentials.portableKey;
    if (this.credentialStore) await this.credentialStore.save(credentials);
  }

  async clear(): Promise<void> {
    this.portableKey = null;
    if (this.credentialStore) await this.credentialStore.clear();
  }
}
