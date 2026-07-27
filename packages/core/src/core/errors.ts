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
  readonly code = 'MESH_CREDENTIAL_MISMATCH' as const;
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
    this.name = 'MeshCredentialMismatchError';
    this.dbName = dbName;
    this.storedMeshId = storedMeshId;
    this.activeMeshId = activeMeshId;
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
  readonly code = 'MESH_ENCRYPTION_MISMATCH' as const;
  readonly expectedMode: boolean;
  readonly actualMode: boolean;

  constructor(expectedMode: boolean, actualMode: boolean) {
    super(
      `Mesh encryption mode mismatch: remote mesh was bootstrapped with ` +
        `encrypted=${expectedMode} but this engine was created with ` +
        `encrypted=${actualMode}. Recreate the Interocitor instance with ` +
        (expectedMode ? 'a matching non-null keySource' : 'keySource=null') +
        `, or join a fresh mesh. Remote was NOT poisoned.`,
    );
    this.name = 'MeshEncryptionMismatchError';
    this.expectedMode = expectedMode;
    this.actualMode = actualMode;
  }
}
