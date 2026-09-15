const GENERATED_DATABASE_SUFFIX = /-v\d+-[0-9a-f]{16}$/;

/** A generated physical database name was supplied where stable identity is required. */
export class UnstableCredentialNamespaceError extends Error {
  readonly code = "UNSTABLE_CREDENTIAL_NAMESPACE" as const;

  constructor(readonly credentialNamespace: string) {
    super(
      `Credential namespace ${JSON.stringify(credentialNamespace)} matches the reserved physical ` +
        "IndexedDB generation format. Use NamedLocalStore.credentialNamespace so cache rotation cannot change the mesh key.",
    );
    this.name = "UnstableCredentialNamespaceError";
  }
}

/** Whether a name is a physical generation minted by the named-store rotator. */
export function isGeneratedLocalDatabaseName(name: string): boolean {
  return GENERATED_DATABASE_SUFFIX.test(name);
}
