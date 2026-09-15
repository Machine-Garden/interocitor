export { IndexedDbLocalStore } from "./storage/indexed-db-local-store.ts";
export {
  createResilientLocalStore,
  DEFAULT_LOCAL_OPEN_TIMEOUT_MS,
  type ResilientLocalStoreOptions,
  type LocalStoreDegradedHook,
  type LocalStoreDegradationInfo,
  type LocalStoreDegradationReason,
} from "./storage/resilient-store.ts";
export {
  createNamedLocalStore,
  getActiveLocalDatabaseName,
  isGeneratedLocalDatabaseName,
  rotateLocalDatabaseName,
  type NamedLocalStore,
  type NamedLocalStoreOptions,
  type PointerStore,
} from "./storage/named-local-store.ts";
export {
  resetLocalDatabase,
  resetLocalDatabaseWithDeadline,
  type ResetLocalDatabaseOutcome,
} from "./storage/reset.ts";

export {
  WebAuthnBlobStore,
  type WebAuthnAttachmentPreference,
  type WebAuthnBlobStoreOptions,
  type WebAuthnCredentialRef,
  type WebAuthnEnrollOptions,
  type WebAuthnLoadOptions,
} from "./webauthn.ts";

export {
  BrowserStorageSecretStore,
  WebAuthnCrossPlatformSecretStore,
  WebAuthnPlatformSecretStore,
  createWebSecretStore,
  type CreateWebSecretStoreOptions,
  type WebAuthnSecretStore,
  type WebSecretCustody,
  type WebSecretStore,
} from "./secret-store.ts";

export {
  BrowserCredentialEnvelopeStore,
  EnvelopedCredentialStore,
  LocalStorageCredentialStore,
  MemoryCredentialEnvelopeStore,
  MemoryCredentialStore,
  SessionStorageCredentialStore,
  StaticEnvelopeKeyProvider,
  WebAuthnCredentialStore,
  WebAuthnEnvelopeKeyProvider,
  UnstableCredentialNamespaceError,
  createWebCredentialStore,
  type CreateWebCredentialStoreOptions,
  type CredentialEnvelopeKeyProvider,
  type CredentialEnvelopeKeyPurpose,
  type CredentialEnvelopeStore,
  type CredentialStorageLocation,
  type EnvelopeStorageLocation,
  type WebCredentialStore,
} from "./credential-store.ts";

export {
  putImage,
  getImage,
  getImageBlobUrl,
  type ImageInput,
  type PutImageOptions,
  type StoredImage,
  type StoredImageBlobUrl,
  type StoredImageMetadata,
} from "./image.ts";
