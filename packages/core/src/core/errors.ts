/**
 * Typed error classes for the Interocitor engine.
 *
 * Callers should prefer `instanceof` over message/code string matching.
 * Every typed error keeps its `code` field stable across releases — it
 * is part of the public contract.
 */

/**
 * Thrown by `connect()` when the credential store has a record under the
 * engine's `dbName` but the stored `meshId` does not match the live mesh
 * the engine is connecting to.
 *
 * Common cause: app reuses the same `dbName` for "create new mesh" — the
 * old record (passphrase + deviceId for the previous mesh) survives the
 * recreate. Silently reusing the old key would either fail to decrypt
 * the new mesh's files or, worse, encrypt new writes under the wrong
 * key and poison the remote.
 *
 * Recovery: disconnect, confirm the intended mesh, clear the stale credential
 * record, and construct a new correctly configured engine. Alternatively use
 * a different `dbName` so the meshes have isolated credential stores.
 */
export class MeshCredentialMismatchError extends Error {
  readonly code = "MESH_CREDENTIAL_MISMATCH" as const;
  readonly dbName: string;
  readonly storedMeshId: string;
  readonly activeMeshId: string;

  constructor(dbName: string, storedMeshId: string, activeMeshId: string) {
    super(
      `Stored credentials under dbName="${dbName}" belong to meshId="${storedMeshId}" ` +
        `but the active mesh is meshId="${activeMeshId}". ` +
        `Refusing to silently reuse the wrong key. ` +
        `Disconnect, confirm the intended mesh, clear the stale credential record, ` +
        `and construct a new configured Interocitor instance; ` +
        `or use a different dbName for the new mesh.`,
    );
    this.name = "MeshCredentialMismatchError";
    this.dbName = dbName;
    this.storedMeshId = storedMeshId;
    this.activeMeshId = activeMeshId;
  }
}

/** Thrown when a configured key conflicts with durable credentials. */
export class CredentialReplacementRequiredError extends Error {
  readonly code = "CREDENTIAL_REPLACEMENT_REQUIRED" as const;
  readonly dbName: string;

  constructor(dbName: string) {
    super(
      `The configured key conflicts with credentials already stored under dbName="${dbName}". ` +
        `Refusing an in-place key swap. Use a fresh isolated local store, or fully erase ` +
        `the old local state and credential before constructing the replacement engine.`,
    );
    this.name = "CredentialReplacementRequiredError";
    this.dbName = dbName;
  }
}

export type CredentialPersistenceOperation = "inspect" | "persist";

/** Thrown when durable credential state cannot be safely inspected or saved. */
export class CredentialPersistenceError extends Error {
  readonly code = "CREDENTIAL_PERSISTENCE_FAILED" as const;
  readonly dbName: string;
  readonly operation: CredentialPersistenceOperation;

  constructor(dbName: string, operation: CredentialPersistenceOperation, cause?: unknown) {
    super(
      `Credential ${operation} failed for dbName="${dbName}". ` +
        `Refusing to continue without a durable, verified credential state.`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "CredentialPersistenceError";
    this.dbName = dbName;
    this.operation = operation;
  }
}

/** Thrown when a durable key source omits the required inspection hook. */
export class MeshKeySourceContractError extends Error {
  readonly code = "MESH_KEY_SOURCE_CONTRACT_INVALID" as const;

  constructor() {
    super(
      `A durable MeshKeySource must implement loadPersistedCredentials() so existing ` +
        `credentials can be checked before replacement.`,
    );
    this.name = "MeshKeySourceContractError";
  }
}

/**
 * Thrown by `connect()` when the configured key-source mode does not
 * match the encryption mode the remote mesh was bootstrapped with.
 *
 * Common cause: the app constructs the engine with `keySource: null` and then
 * connects to a protected mesh, or supplies a key source for a mesh created
 * without encryption. The remote is healthy and is not poisoned by this
 * error; the local engine configuration is wrong.
 *
 * Recovery: construct a new engine with the expected key-source mode and the
 * matching portable key when `expectedMode === true`.
 */
export class MeshEncryptionMismatchError extends Error {
  readonly code = "MESH_ENCRYPTION_MISMATCH" as const;
  readonly expectedMode: boolean;
  readonly actualMode: boolean;

  constructor(expectedMode: boolean, actualMode: boolean) {
    super(
      `Mesh encryption mode mismatch: remote mesh was bootstrapped with ` +
        `encrypted=${expectedMode} but this engine was created with ` +
        `encrypted=${actualMode}. Recreate the Interocitor instance with ` +
        (expectedMode ? "a matching non-null keySource" : "keySource=null") +
        `, or join a fresh mesh. Remote was NOT poisoned.`,
    );
    this.name = "MeshEncryptionMismatchError";
    this.expectedMode = expectedMode;
    this.actualMode = actualMode;
  }
}

// ─── Remote access ────────────────────────────────────────────────────

/**
 * Classification of an HTTP access outcome returned by a mailbox remote.
 *
 * - `unauthenticated` (401): the remote wants a sign-in.
 * - `forbidden` (403): the identity is known but this mesh or this write is
 *   not allowed.
 * - `not-found` (404 on a mesh-level route): the address is unknown, or the
 *   remote deliberately conceals a denial as 404.
 * - `rate-limited` (429): quota or rate limit; not an access change.
 * - `policy-unavailable` (503): the remote's authorization service failed;
 *   the decision is unknown, not negative.
 */
export type RemoteAccessKind =
  | "unauthenticated"
  | "forbidden"
  | "not-found"
  | "rate-limited"
  | "policy-unavailable";

export interface RemoteAccessErrorInit {
  /** HTTP status returned by the remote. */
  status: number;
  /** Adapter name, e.g. `cloudflare`, `webdav`, `google-drive`. */
  adapter: string;
  /** Adapter operation that was rejected, e.g. `listFiles`. */
  operation: string;
  /** Remote path or address involved, when known. */
  path?: string;
  /** Parsed `Retry-After`, in milliseconds, when the remote supplied one. */
  retryAfterMs?: number;
  /** Override the classification derived from `status`. */
  kind?: RemoteAccessKind;
}

const REMOTE_ACCESS_HINTS: Record<RemoteAccessKind, string> = {
  unauthenticated:
    "The remote wants a sign-in. Re-authenticate with the identity provider, " +
    "give the adapter the new credential, then call connect() again.",
  forbidden:
    "The identity is known but this mesh or this write is not allowed. " +
    "Access was removed or is read-only; retrying without a policy change will not help.",
  "not-found":
    "The mesh address is unknown, or access is concealed. " +
    "Replace the address or alias, then call connect() again.",
  "rate-limited": "Quota or rate limit. Back off; this is not an access change.",
  "policy-unavailable":
    "The remote's policy service failed. Retry later; the access decision is unknown.",
};

/**
 * Thrown by storage adapters when the remote answers with an HTTP status that
 * expresses an access decision rather than a transport or storage fault.
 *
 * The engine recognises this error wherever it talks to the remote. A
 * negative decision (`denied === true`) pauses remote sync for the mesh and
 * emits a `remote:access` event so the application can prompt for sign-in,
 * switch to a read-only view, or leave the mesh. A temporary condition
 * (`rate-limited`, `policy-unavailable`) is reported without pausing and
 * backs off polling. Interocitor never performs a login flow itself.
 */
export class RemoteAccessError extends Error {
  readonly code = "REMOTE_ACCESS" as const;
  readonly status: number;
  readonly kind: RemoteAccessKind;
  readonly adapter: string;
  readonly operation: string;
  readonly path?: string;
  readonly retryAfterMs?: number;

  constructor(init: RemoteAccessErrorInit) {
    const kind = init.kind ?? RemoteAccessError.kindForStatus(init.status) ?? "forbidden";
    const where = init.path ? ` ${init.path}` : "";
    super(
      `${init.adapter} ${init.operation}${where} rejected with HTTP ${init.status} (${kind}). ` +
        REMOTE_ACCESS_HINTS[kind],
    );
    this.name = "RemoteAccessError";
    this.status = init.status;
    this.kind = kind;
    this.adapter = init.adapter;
    this.operation = init.operation;
    this.path = init.path;
    this.retryAfterMs = init.retryAfterMs;
  }

  /**
   * True when the remote made a negative access decision (401, 403, 404).
   * Retrying without a change on the host or provider side is pointless.
   * False for temporary conditions (429, 503) where a later retry may succeed.
   */
  get denied(): boolean {
    return (
      this.kind === "unauthenticated" || this.kind === "forbidden" || this.kind === "not-found"
    );
  }

  /**
   * Map an HTTP status to an access classification, or `null` when the
   * status is not an access outcome. `404` is included only when
   * `notFoundIsAccess` is set, because a missing file is ordinary for a
   * mailbox while a missing mesh address is an access outcome.
   */
  static kindForStatus(status: number, notFoundIsAccess = false): RemoteAccessKind | null {
    switch (status) {
      case 401:
        return "unauthenticated";
      case 403:
        return "forbidden";
      case 404:
        return notFoundIsAccess ? "not-found" : null;
      case 429:
        return "rate-limited";
      case 503:
        return "policy-unavailable";
      default:
        return null;
    }
  }
}

/** Narrow an unknown rejection to {@link RemoteAccessError}. */
export function isRemoteAccessError(err: unknown): err is RemoteAccessError {
  return (
    err instanceof RemoteAccessError ||
    (typeof err === "object" &&
      err !== null &&
      (err as { code?: unknown }).code === "REMOTE_ACCESS" &&
      typeof (err as { status?: unknown }).status === "number")
  );
}

/**
 * Thrown by `getFile(ref)` and `openFile(ref).open()` when the plaintext
 * opened for a `FileRef` does not hash to the digest the reference carries.
 *
 * The row said one thing and storage returned another: the path was
 * overwritten after the reference was taken, or the remote returned the wrong
 * object. Treat the bytes as untrusted. Recovery: re-read the row for a newer
 * reference, or re-upload and store a fresh `toFileRef` result.
 */
export class FileIntegrityError extends Error {
  readonly code = "FILE_INTEGRITY" as const;
  readonly path: string;
  readonly expectedDigest: string;
  readonly actualDigest: string;

  constructor(path: string, expectedDigest: string, actualDigest: string) {
    super(
      `Durable file ${path} does not match its reference: expected sha256 ${expectedDigest}, ` +
        `opened bytes hash to ${actualDigest}. The path was overwritten after the reference ` +
        `was taken, or the remote returned the wrong object.`,
    );
    this.name = "FileIntegrityError";
    this.path = path;
    this.expectedDigest = expectedDigest;
    this.actualDigest = actualDigest;
  }
}
