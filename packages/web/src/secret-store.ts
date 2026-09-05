// compass: interocitor.trust.credential-custody

import {
  WebAuthnBlobStore,
  type WebAuthnBlobStoreOptions,
  type WebAuthnCredentialRef,
  type WebAuthnEnrollOptions,
  type WebAuthnLoadOptions,
} from "./webauthn.ts";

type BrowserStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type WebSecretCustody = "browserStorage" | "webauthnPlatform" | "webauthnCrossPlatform";

/**
 * Stores an application-owned secret under a browser custody primitive.
 *
 * This is for app secrets such as signing-key bundles, record-seal keys, or
 * wrapped group keys. Mesh credential custody remains owned by
 * `createWebCredentialStore`.
 */
export interface WebSecretStore {
  readonly custody: WebSecretCustody;
  save(bytes: Uint8Array): Promise<void>;
  load(): Promise<Uint8Array | null>;
  clear(): Promise<void>;
}

export interface WebAuthnSecretStore extends WebSecretStore {
  listAuthenticators(): WebAuthnCredentialRef[];
  enrollAuthenticator(
    bytes: Uint8Array,
    options?: WebAuthnEnrollOptions,
  ): Promise<WebAuthnCredentialRef>;
}

export interface CreateWebSecretStoreOptions extends WebAuthnBlobStoreOptions {
  /** Default: `browserStorage`. */
  custody?: WebSecretCustody;
  /** Override localStorage for tests or host-managed storage. */
  storage?: BrowserStorage;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCodePoint(bytes[i]);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const decoded = Uint8Array.from(atob(value), (c) => c.codePointAt(0)!);
  return new Uint8Array(decoded);
}

function getLocalStorage(): BrowserStorage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

export class BrowserStorageSecretStore implements WebSecretStore {
  readonly custody = "browserStorage" as const;

  constructor(
    private readonly namespace: string,
    private readonly storageProvider: () => BrowserStorage | null = getLocalStorage,
  ) {}

  private recordKey(): string {
    return `interocitor-secret:${this.namespace}`;
  }

  async save(bytes: Uint8Array): Promise<void> {
    const storage = this.storageProvider();
    if (!storage) return;
    storage.setItem(this.recordKey(), encodeBase64(bytes));
  }

  async load(): Promise<Uint8Array<ArrayBuffer> | null> {
    const storage = this.storageProvider();
    if (!storage) return null;
    const raw = storage.getItem(this.recordKey());
    return raw ? decodeBase64(raw) : null;
  }

  async clear(): Promise<void> {
    const storage = this.storageProvider();
    if (storage) storage.removeItem(this.recordKey());
  }
}

abstract class WebAuthnSecretStoreBase implements WebAuthnSecretStore {
  protected readonly store: WebAuthnBlobStore;

  protected constructor(
    readonly custody: Extract<WebSecretCustody, "webauthnPlatform" | "webauthnCrossPlatform">,
    namespace: string,
    protected readonly loadOptions: WebAuthnLoadOptions,
    options: WebAuthnBlobStoreOptions,
  ) {
    this.store = new WebAuthnBlobStore(namespace, options);
  }

  save(bytes: Uint8Array): Promise<void> {
    return this.store.save(bytes);
  }

  load(): Promise<Uint8Array<ArrayBuffer> | null> {
    return this.store.load(this.loadOptions);
  }

  clear(): Promise<void> {
    return this.store.clear();
  }

  listAuthenticators(): WebAuthnCredentialRef[] {
    return this.store.listAuthenticators();
  }

  enrollAuthenticator(
    bytes: Uint8Array,
    options: WebAuthnEnrollOptions = {},
  ): Promise<WebAuthnCredentialRef> {
    return this.store.enrollAuthenticator(bytes, options);
  }
}

/**
 * Stores key bytes behind same-device WebAuthn user verification.
 */
export class WebAuthnPlatformSecretStore extends WebAuthnSecretStoreBase {
  constructor(namespace: string, options: WebAuthnBlobStoreOptions = {}) {
    super(
      "webauthnPlatform",
      namespace,
      { authenticatorAttachment: "platform" },
      {
        ...options,
        authenticatorAttachment: "platform",
      },
    );
  }
}

/**
 * Stores key bytes behind a cross-platform WebAuthn credential.
 *
 * The default hints request the hybrid transport so browser UI can surface a
 * phone-mediated passkey flow when supported.
 */
export class WebAuthnCrossPlatformSecretStore extends WebAuthnSecretStoreBase {
  constructor(namespace: string, options: WebAuthnBlobStoreOptions = {}) {
    super(
      "webauthnCrossPlatform",
      namespace,
      { authenticatorAttachment: "cross-platform" },
      {
        ...options,
        authenticatorAttachment: "cross-platform",
        hints: options.hints ?? ["hybrid"],
        transports: options.transports ?? ["hybrid"],
      },
    );
  }
}

export function createWebSecretStore(
  namespace: string,
  options: CreateWebSecretStoreOptions & { custody: "webauthnPlatform" },
): WebAuthnPlatformSecretStore;
export function createWebSecretStore(
  namespace: string,
  options: CreateWebSecretStoreOptions & { custody: "webauthnCrossPlatform" },
): WebAuthnCrossPlatformSecretStore;
export function createWebSecretStore(
  namespace: string,
  options?: CreateWebSecretStoreOptions & { custody?: "browserStorage" },
): BrowserStorageSecretStore;
/**
 * Create an application-secret store for a browser custody primitive.
 *
 * - `browserStorage`: localStorage, no WebAuthn prompt
 * - `webauthnPlatform`: platform authenticator / same-device passkey
 * - `webauthnCrossPlatform`: cross-platform WebAuthn credential
 */
export function createWebSecretStore(
  namespace: string,
  options: CreateWebSecretStoreOptions = {},
): WebSecretStore {
  switch (options.custody ?? "browserStorage") {
    case "browserStorage":
      return new BrowserStorageSecretStore(namespace, () => options.storage ?? getLocalStorage());
    case "webauthnPlatform":
      return new WebAuthnPlatformSecretStore(namespace, options);
    case "webauthnCrossPlatform":
      return new WebAuthnCrossPlatformSecretStore(namespace, options);
  }
}
