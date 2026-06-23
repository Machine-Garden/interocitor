export {
  IndexedDbLocalStore,
} from './storage/indexed-db-local-store.ts';
export {
  createResilientLocalStore,
  DEFAULT_LOCAL_OPEN_TIMEOUT_MS,
  type ResilientLocalStoreOptions,
  type LocalStoreDegradedHook,
  type LocalStoreDegradationInfo,
  type LocalStoreDegradationReason,
} from './storage/resilient-store.ts';
export {
  createNamedLocalStore,
  getActiveLocalDatabaseName,
  type NamedLocalStoreOptions,
  type PointerStore,
} from './storage/named-local-store.ts';
export {
  resetLocalDatabase,
  resetLocalDatabaseWithDeadline,
  type ResetLocalDatabaseOutcome,
} from './storage/reset.ts';

export {
  LocalStorageCredentialStore,
  WebAuthnCredentialStore,
  createWebCredentialStore,
  type WebCredentialStore,
} from './credential-store.ts';

export {
  putImage,
  getImage,
  getImageBlobUrl,
  type ImageInput,
  type PutImageOptions,
  type StoredImage,
  type StoredImageBlobUrl,
  type StoredImageMetadata,
} from './image.ts';
