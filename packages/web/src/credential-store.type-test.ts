import type { StoredCredentials } from "@interocitor/core";
import {
  BrowserCredentialEnvelopeStore,
  EnvelopedCredentialStore,
  LocalStorageCredentialStore,
  MemoryCredentialEnvelopeStore,
  MemoryCredentialStore,
  SessionStorageCredentialStore,
  StaticEnvelopeKeyProvider,
  WebAuthnCredentialStore,
  WebAuthnEnvelopeKeyProvider,
  createWebCredentialStore,
  type CredentialEnvelopeKeyProvider,
  type CredentialEnvelopeStore,
  type CreateWebCredentialStoreOptions,
  type WebCredentialStore,
} from "./credential-store.ts";
import {
  WebAuthnBlobStore,
  type WebAuthnAttachmentPreference,
  type WebAuthnBlobStoreOptions,
} from "./webauthn.ts";
import {
  BrowserStorageSecretStore,
  WebAuthnCrossPlatformSecretStore,
  WebAuthnPlatformSecretStore,
  createWebSecretStore,
  type CreateWebSecretStoreOptions,
  type WebSecretCustody,
  type WebSecretStore,
} from "./secret-store.ts";

export const sharedMemory: Map<string, StoredCredentials> = new Map<string, StoredCredentials>();
declare const providedKey: CryptoKey;

export const defaultStore: WebCredentialStore = createWebCredentialStore("app");
export const namedStore: WebCredentialStore = createWebCredentialStore("app", "Meal Planner");
export const memoryStore: WebCredentialStore = createWebCredentialStore("app", {
  storage: "memory",
  memory: sharedMemory,
});
export const sessionStore: WebCredentialStore = createWebCredentialStore("app", {
  storage: "sessionStorage",
});
export const localStore: WebCredentialStore = createWebCredentialStore("app", {
  storage: "localStorage",
});
export const passkeyOnlyStore: WebCredentialStore = createWebCredentialStore("app", {
  storage: "passkey",
  displayName: "Meal Planner",
  rpId: "example.com",
  authenticatorAttachment: "cross-platform",
});

export const keyProvider: CredentialEnvelopeKeyProvider = new StaticEnvelopeKeyProvider(
  providedKey,
);
export const envelopeStore: WebCredentialStore = createWebCredentialStore("app", {
  envelope: {
    storage: "sessionStorage",
    keyProvider,
  },
});

export const passkeyEnvelopeKey: CredentialEnvelopeKeyProvider = new WebAuthnEnvelopeKeyProvider(
  "app",
  "example.com",
  "Meal Planner",
);
export const passkeyEnvelopeKeyOptions: CredentialEnvelopeKeyProvider =
  new WebAuthnEnvelopeKeyProvider("app", {
    rpId: "example.com",
    displayName: "Meal Planner",
    authenticatorAttachment: "platform",
  });
export const passkeyEnvelopeStore: WebCredentialStore = createWebCredentialStore("app", {
  envelope: {
    storage: "localStorage",
    keyProvider: passkeyEnvelopeKey,
  },
});

export const memoryEnvelopeRecordStore: MemoryCredentialEnvelopeStore =
  new MemoryCredentialEnvelopeStore("app");
export const memoryEnvelopeStore: WebCredentialStore = createWebCredentialStore("app", {
  envelope: {
    storage: "memory",
    keyProvider,
  },
});
export const injectedEnvelopeStore: WebCredentialStore = createWebCredentialStore("app", {
  envelope: {
    store: memoryEnvelopeRecordStore,
    keyProvider,
  },
});

export const backendEnvelopeRecordStore: CredentialEnvelopeStore = {
  async save(envelope) {
    void envelope;
  },
  async load() {
    return null;
  },
  async clear() {},
};
export const backendEnvelopeStore: WebCredentialStore = createWebCredentialStore("app", {
  envelope: {
    store: backendEnvelopeRecordStore,
    keyProvider,
  },
});

export const options: CreateWebCredentialStoreOptions = {
  storage: "localStorage",
  authenticatorAttachment: "auto",
  envelope: undefined,
};

export const blobStoreOptions: WebAuthnBlobStoreOptions = {
  rpId: "example.com",
  displayName: "Meal Planner",
  authenticatorAttachment: "cross-platform",
  hints: ["hybrid"],
  transports: ["hybrid"],
};
export const attachmentPreference: WebAuthnAttachmentPreference = "platform";

export const directMemory: MemoryCredentialStore = new MemoryCredentialStore("app");
export const directSession: SessionStorageCredentialStore = new SessionStorageCredentialStore(
  "app",
);
export const directLocal: LocalStorageCredentialStore = new LocalStorageCredentialStore("app");
export const directPasskey: WebAuthnCredentialStore = new WebAuthnCredentialStore("app");
export const directPasskeyOptions: WebAuthnCredentialStore = new WebAuthnCredentialStore(
  "app",
  blobStoreOptions,
);
export const directBlobStore: WebAuthnBlobStore = new WebAuthnBlobStore("app:signing-key", {
  displayName: "Meal Planner",
  authenticatorAttachment: attachmentPreference,
});
export const browserStorageSecretStore: WebSecretStore = createWebSecretStore("app:stored-key");
export const platformSecretStore: WebSecretStore = createWebSecretStore("app:protected-key", {
  custody: "webauthnPlatform",
  displayName: "Meal Planner",
});
export const crossPlatformSecretStore: WebSecretStore = createWebSecretStore("app:enforced-key", {
  custody: "webauthnCrossPlatform",
  displayName: "Meal Planner",
});
export const secretOptions: CreateWebSecretStoreOptions = {
  custody: "webauthnCrossPlatform",
  userVerification: "required",
  hints: ["hybrid"],
  transports: ["hybrid"],
};
export const secretCustody: WebSecretCustody = "browserStorage";
export const directBrowserStorageSecret: BrowserStorageSecretStore = new BrowserStorageSecretStore(
  "app:stored-key",
);
export const directPlatformSecret: WebAuthnPlatformSecretStore = new WebAuthnPlatformSecretStore(
  "app:protected-key",
);
export const directCrossPlatformSecret: WebAuthnCrossPlatformSecretStore =
  new WebAuthnCrossPlatformSecretStore("app:enforced-key");
export const directBrowserEnvelopeStore: BrowserCredentialEnvelopeStore =
  new BrowserCredentialEnvelopeStore("app", "localStorage");
export const directMemoryEnvelopeStore: MemoryCredentialEnvelopeStore =
  new MemoryCredentialEnvelopeStore("app");
export const directEnvelope: EnvelopedCredentialStore = new EnvelopedCredentialStore(
  "app",
  directBrowserEnvelopeStore,
  keyProvider,
);
