/**
 * Typed error classes for the Interocitor engine.
 *
 * Callers should prefer `instanceof` over message/code string matching.
 * Every typed error keeps its `code` field stable across releases — it
 * is part of the public contract.
 */

/**
 * Thrown by `connect()` when the engine's `encrypted` flag does not
 * match the encryption mode the remote mesh was bootstrapped with.
 *
 * Common cause: the app constructs the engine with `encrypted: false`
 * on first run (e.g. before the user supplies a passphrase) and later
 * reconnects with `encrypted: true`. The remote is healthy and is
 * NOT poisoned by this error — the local engine config is wrong.
 *
 * Recovery: rebuild the engine with `encrypted` set to `expectedMode`
 * and supply the matching passphrase when `expectedMode === true`.
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
 * Recovery: the caller decides — either `clearCredentials()` and retry,
 * or change `dbName` so the two meshes have isolated credential stores.
 */
export class MeshCredentialMismatchError extends Error {
  readonly code = 'MESH_CREDENTIAL_MISMATCH' as const;
  readonly dbName: string;
  readonly storedMeshId: string;
  readonly activeMeshId: string;

  constructor(dbName: string, storedMeshId: string, activeMeshId: string) {
    super(
      `Stored credentials under dbName="${dbName}" belong to meshId="${storedMeshId}" ` +
        `but the active mesh is meshId="${activeMeshId}". ` +
        `Refusing to silently reuse the wrong key. ` +
        `Call engine.clearCredentials() to drop the stale record, ` +
        `or use a different dbName for the new mesh.`,
    );
    this.name = 'MeshCredentialMismatchError';
    this.dbName = dbName;
    this.storedMeshId = storedMeshId;
    this.activeMeshId = activeMeshId;
  }
}

export class MeshEncryptionMismatchError extends Error {
  readonly code = 'MESH_ENCRYPTION_MISMATCH' as const;
  readonly expectedMode: boolean;
  readonly actualMode: boolean;

  constructor(expectedMode: boolean, actualMode: boolean) {
    super(
      `Mesh encryption mode mismatch: remote mesh was bootstrapped with ` +
        `encrypted=${expectedMode} but this engine was created with ` +
        `encrypted=${actualMode}. Recreate the Interocitor instance with ` +
        `encrypted=${expectedMode}` +
        (expectedMode ? ' and supply the matching passphrase' : '') +
        `, or join a fresh mesh. Remote was NOT poisoned.`,
    );
    this.name = 'MeshEncryptionMismatchError';
    this.expectedMode = expectedMode;
    this.actualMode = actualMode;
  }
}
