export interface StoredCredentials {
  /** Base58 passphrase for the mesh encryption key. */
  passphrase: string;
  /** Stable device identifier. */
  deviceId: string;
  /**
   * Mesh id the credentials were minted for.
   *
   * Optional only for records persisted by older or custom stores. New writes
   * include it once the mesh is known so the engine can detect stale records
   * that share the same local namespace.
   */
  meshId?: string;
}

/**
 * Runtime-owned credential persistence contract.
 *
 * Core never creates a default implementation. Browser, Node, and application
 * packages decide where passphrases and device anchors are stored.
 */
export interface CredentialStore {
  save(creds: StoredCredentials): Promise<void>;
  load(): Promise<StoredCredentials | null>;
  clear(): Promise<void>;
}
