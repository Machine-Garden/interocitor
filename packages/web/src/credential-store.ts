// compass: interocitor.trust.credential-custody

/**
 * Credential Store — pluggable persistence for key material.
 *
 * The engine consumes the core `CredentialStore` contract. This module keeps
 * the browser-specific choices explicit: memory, sessionStorage,
 * localStorage, passkey-only WebAuthn, and envelope encryption where a
 * biometric/external key protects a local credential record.
 */

import type { CredentialStore, StoredCredentials } from "@interocitor/core";
import {
  WebAuthnBlobStore,
  type WebAuthnAttachmentPreference,
  type WebAuthnBlobStoreOptions,
} from "./webauthn.ts";
import {
  isGeneratedLocalDatabaseName,
  UnstableCredentialNamespaceError,
} from "./storage/local-database-name.ts";

export { UnstableCredentialNamespaceError } from "./storage/local-database-name.ts";

/**
 * Browser-facing credential store contract returned by
 * {@link createWebCredentialStore}.
 *
 * This extends core's neutral `CredentialStore` with optional browser UX
 * affordances. The stored payload is still Interocitor mesh credentials
 * (`portableKey`, `deviceId`, optional `meshId`), not an arbitrary signing key
 * API.
 */
export interface WebCredentialStore extends CredentialStore {
  /**
   * Ask the store to harden its existing credential record behind a biometric
   * or passkey-backed mechanism when the concrete implementation supports it.
   *
   * Returns `false` when the active store has no stronger biometric mode to
   * migrate into.
   */
  secureWithBiometrics(): Promise<boolean>;
  /**
   * Restore a credential record through a biometric/passkey ceremony when the
   * underlying implementation requires one.
   */
  restoreWithBiometrics?(): Promise<StoredCredentials | null>;
}

export type CredentialStorageLocation = "memory" | "sessionStorage" | "localStorage" | "passkey";
export type EnvelopeStorageLocation = "memory" | "sessionStorage" | "localStorage";

export type CredentialEnvelopeKeyPurpose = "encrypt" | "decrypt";

/**
 * Supplies a CryptoKey that protects an encrypted credential envelope.
 *
 * This is the right abstraction when a browser biometric/passkey confirmation
 * should unlock or derive the envelope key, while the encrypted credential
 * record itself lives in app-selected storage.
 */
export interface CredentialEnvelopeKeyProvider {
  getKey(purpose?: CredentialEnvelopeKeyPurpose): Promise<CryptoKey>;
  clear?(): Promise<void>;
}

export type StoredCredentialEnvelope = {
  v: 1;
  alg: "AES-GCM";
  iv: string;
  ciphertext: string;
};

/**
 * Storage backend for an encrypted credential envelope.
 *
 * The envelope contains ciphertext for Interocitor mesh credentials. It does
 * not need to be secret storage by itself as long as the corresponding
 * `CredentialEnvelopeKeyProvider` remains separate.
 */
export interface CredentialEnvelopeStore {
  save(envelope: StoredCredentialEnvelope): Promise<void>;
  load(): Promise<StoredCredentialEnvelope | null>;
  clear(): Promise<void>;
}

/**
 * Browser-specific configuration for {@link createWebCredentialStore}.
 *
 * Pick exactly one custody shape for the credential record:
 * - plain browser storage via `storage`
 * - passkey/WebAuthn-backed custody via `storage: 'passkey'`
 * - encrypted envelope storage via `envelope`
 *
 * The record being protected is still the Interocitor mesh credential record,
 * not a general-purpose application private key.
 */
export interface CreateWebCredentialStoreOptions {
  /** Where the mesh credential record is stored. Default: localStorage. */
  storage?: CredentialStorageLocation;
  /** Human-readable app name shown in biometric prompts. */
  displayName?: string;
  /** WebAuthn relying-party id. Defaults to current hostname. */
  rpId?: string;
  /**
   * Which authenticator class the browser should prefer for WebAuthn-backed
   * credential custody.
   *
   * Applies to `storage: 'passkey'` and `WebAuthnEnvelopeKeyProvider`.
   */
  authenticatorAttachment?: WebAuthnAttachmentPreference;
  /**
   * User verification requirement for WebAuthn read/write ceremonies.
   * Default: `required`.
   */
  userVerification?: UserVerificationRequirement;
  /** Optional shared map for tests or app-level in-memory vaults. */
  memory?: Map<string, StoredCredentials>;
  /** Wrap a credential record with AES-GCM before writing it to a pluggable envelope store. */
  envelope?: {
    storage?: EnvelopeStorageLocation;
    store?: CredentialEnvelopeStore;
    keyProvider: CredentialEnvelopeKeyProvider;
  };
}

type BrowserStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function normalizeStoredCredentials(value: unknown): StoredCredentials | null {
  if (!value || typeof value !== "object") return null;
  const parsed = value as Partial<StoredCredentials>;
  if (typeof parsed.portableKey !== "string" || typeof parsed.deviceId !== "string") return null;
  return {
    portableKey: parsed.portableKey,
    deviceId: parsed.deviceId,
    ...(typeof parsed.meshId === "string" && parsed.meshId ? { meshId: parsed.meshId } : {}),
  };
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

function getNamedStorage(
  location: EnvelopeStorageLocation | CredentialStorageLocation,
): BrowserStorage | null {
  if (location === "localStorage") return typeof localStorage === "undefined" ? null : localStorage;
  if (location === "sessionStorage")
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  return null;
}

class NoopBiometricControls implements WebCredentialStore {
  constructor(private readonly inner: CredentialStore) {}

  save(creds: StoredCredentials): Promise<void> {
    return this.inner.save(creds);
  }
  load(): Promise<StoredCredentials | null> {
    return this.inner.load();
  }
  clear(): Promise<void> {
    return this.inner.clear();
  }
  async secureWithBiometrics(): Promise<boolean> {
    return false;
  }
}

// ─── Plain browser storage backends ───────────────────────────────────

class BrowserStorageCredentialStore implements CredentialStore {
  constructor(
    private readonly dbName: string,
    _storageName: EnvelopeStorageLocation,
    private readonly storageProvider: () => BrowserStorage | null,
  ) {}

  /** Single record per dbName. JSON-encoded `{portableKey, deviceId, meshId}`. */
  protected recordKey(): string {
    return `interocitor-creds:${this.dbName}`;
  }

  async save(creds: StoredCredentials): Promise<void> {
    const storage = this.storageProvider();
    if (!storage) return;
    const payload: StoredCredentials = {
      portableKey: creds.portableKey,
      deviceId: creds.deviceId,
      ...(creds.meshId ? { meshId: creds.meshId } : {}),
    };
    storage.setItem(this.recordKey(), JSON.stringify(payload));
  }

  async load(): Promise<StoredCredentials | null> {
    const storage = this.storageProvider();
    if (!storage) return null;

    const raw = storage.getItem(this.recordKey());
    if (!raw) return null;
    try {
      return normalizeStoredCredentials(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  async clear(): Promise<void> {
    const storage = this.storageProvider();
    if (!storage) return;
    storage.removeItem(this.recordKey());
  }
}

export class LocalStorageCredentialStore extends BrowserStorageCredentialStore {
  constructor(dbName: string) {
    super(dbName, "localStorage", () => getNamedStorage("localStorage"));
  }
}

/** Stores the credential record only for the lifetime of the current tab session. */
export class SessionStorageCredentialStore extends BrowserStorageCredentialStore {
  constructor(dbName: string) {
    super(dbName, "sessionStorage", () => getNamedStorage("sessionStorage"));
  }
}

/** Keeps the credential record only in JS memory owned by the current page. */
export class MemoryCredentialStore implements CredentialStore {
  private readonly records: Map<string, StoredCredentials>;

  constructor(
    private readonly dbName: string,
    records?: Map<string, StoredCredentials>,
  ) {
    this.records = records ?? new Map();
  }

  private recordKey(): string {
    return `interocitor-creds:${this.dbName}`;
  }

  async save(creds: StoredCredentials): Promise<void> {
    this.records.set(this.recordKey(), {
      portableKey: creds.portableKey,
      deviceId: creds.deviceId,
      ...(creds.meshId ? { meshId: creds.meshId } : {}),
    });
  }

  async load(): Promise<StoredCredentials | null> {
    const stored = this.records.get(this.recordKey());
    return stored ? { ...stored } : null;
  }

  async clear(): Promise<void> {
    this.records.delete(this.recordKey());
  }
}

// ─── Envelope encryption over pluggable record storage ────────────────

export class StaticEnvelopeKeyProvider implements CredentialEnvelopeKeyProvider {
  constructor(private readonly key: CryptoKey) {}
  async getKey(): Promise<CryptoKey> {
    return this.key;
  }
}

/** Persists an encrypted credential envelope in browser storage. */
export class BrowserCredentialEnvelopeStore implements CredentialEnvelopeStore {
  constructor(
    private readonly dbName: string,
    storageName: Exclude<EnvelopeStorageLocation, "memory">,
    private readonly storageProvider: () => BrowserStorage | null = () =>
      getNamedStorage(storageName),
  ) {}

  private recordKey(): string {
    return `interocitor-creds-envelope:${this.dbName}`;
  }

  async save(envelope: StoredCredentialEnvelope): Promise<void> {
    const storage = this.storageProvider();
    if (storage) storage.setItem(this.recordKey(), JSON.stringify(envelope));
  }

  async load(): Promise<StoredCredentialEnvelope | null> {
    const storage = this.storageProvider();
    if (!storage) return null;
    const raw = storage.getItem(this.recordKey());
    if (!raw) return null;
    const envelope = JSON.parse(raw) as StoredCredentialEnvelope;
    return envelope?.v === 1 && envelope.alg === "AES-GCM" ? envelope : null;
  }

  async clear(): Promise<void> {
    const storage = this.storageProvider();
    if (storage) storage.removeItem(this.recordKey());
  }
}

export class MemoryCredentialEnvelopeStore implements CredentialEnvelopeStore {
  private readonly records: Map<string, StoredCredentialEnvelope>;

  constructor(
    private readonly dbName: string,
    records?: Map<string, StoredCredentialEnvelope>,
  ) {
    this.records = records ?? new Map();
  }

  private recordKey(): string {
    return `interocitor-creds-envelope:${this.dbName}`;
  }

  async save(envelope: StoredCredentialEnvelope): Promise<void> {
    this.records.set(this.recordKey(), { ...envelope });
  }

  async load(): Promise<StoredCredentialEnvelope | null> {
    const envelope = this.records.get(this.recordKey());
    return envelope ? { ...envelope } : null;
  }

  async clear(): Promise<void> {
    this.records.delete(this.recordKey());
  }
}

function createCredentialEnvelopeStore(
  dbName: string,
  location: EnvelopeStorageLocation,
): CredentialEnvelopeStore {
  if (location === "memory") return new MemoryCredentialEnvelopeStore(dbName);
  return new BrowserCredentialEnvelopeStore(dbName, location);
}

/**
 * Wraps a plaintext credential store with AES-GCM envelope encryption.
 *
 * The envelope store holds ciphertext only. The caller-provided
 * `CredentialEnvelopeKeyProvider` decides where the unwrap key comes from:
 * browser passkey UX, app memory, backend-provided session key, or another
 * custom source.
 */
export class EnvelopedCredentialStore implements CredentialStore {
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();
  private readonly envelopeStore: CredentialEnvelopeStore;

  constructor(
    dbName: string,
    storageNameOrStore: EnvelopeStorageLocation | CredentialEnvelopeStore,
    private readonly keyProvider: CredentialEnvelopeKeyProvider,
  ) {
    this.envelopeStore =
      typeof storageNameOrStore === "string"
        ? createCredentialEnvelopeStore(dbName, storageNameOrStore)
        : storageNameOrStore;
  }

  async save(creds: StoredCredentials): Promise<void> {
    const key = await this.keyProvider.getKey("encrypt");
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const payload: StoredCredentials = {
      portableKey: creds.portableKey,
      deviceId: creds.deviceId,
      ...(creds.meshId ? { meshId: creds.meshId } : {}),
    };
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      this.encoder.encode(JSON.stringify(payload)),
    );
    await this.envelopeStore.save({
      v: 1,
      alg: "AES-GCM",
      iv: encodeBase64(iv),
      ciphertext: encodeBase64(new Uint8Array(ciphertext)),
    });
  }

  async load(): Promise<StoredCredentials | null> {
    const envelope = await this.envelopeStore.load();
    if (!envelope) return null;
    const key = await this.keyProvider.getKey("decrypt");
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decodeBase64(envelope.iv) },
      key,
      decodeBase64(envelope.ciphertext),
    );
    return normalizeStoredCredentials(JSON.parse(this.decoder.decode(plaintext)));
  }

  async clear(): Promise<void> {
    await this.envelopeStore.clear();
  }
}

// ─── WebAuthn + largeBlob primitives ──────────────────────────────────

function resolveWebAuthnBlobOptions(
  rpIdOrOptions?: string | WebAuthnBlobStoreOptions,
  displayName?: string,
  options?: Pick<WebAuthnBlobStoreOptions, "authenticatorAttachment" | "userVerification">,
): WebAuthnBlobStoreOptions {
  if (typeof rpIdOrOptions === "string" || rpIdOrOptions === undefined) {
    return {
      ...(rpIdOrOptions ? { rpId: rpIdOrOptions } : {}),
      ...(displayName ? { displayName } : {}),
      ...options,
    };
  }
  return rpIdOrOptions;
}

/**
 * Stores credentials directly in the OS keychain via WebAuthn largeBlob.
 * No passphrase is written to localStorage/sessionStorage. A localStorage
 * credential-id hint may be written; the hint is not key material.
 */
/**
 * Stores the Interocitor credential record inside WebAuthn `largeBlob`.
 *
 * This is a custody mechanism for the mesh credential record. It does not give
 * application code a reusable passkey private key or a generic signing API.
 * The browser/platform owns the credential private key and exposes only the
 * WebAuthn ceremony needed to read or write the protected blob.
 */
export class WebAuthnCredentialStore implements CredentialStore {
  private readonly blobStore: WebAuthnBlobStore;
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  constructor(dbName: string, options?: WebAuthnBlobStoreOptions);
  constructor(
    dbName: string,
    rpId?: string,
    displayName?: string,
    options?: Pick<WebAuthnBlobStoreOptions, "authenticatorAttachment" | "userVerification">,
  );
  constructor(
    dbName: string,
    rpIdOrOptions: string | WebAuthnBlobStoreOptions = globalThis.location?.hostname ?? "localhost",
    displayName: string = "Interocitor",
    options?: Pick<WebAuthnBlobStoreOptions, "authenticatorAttachment" | "userVerification">,
  ) {
    this.blobStore = new WebAuthnBlobStore(
      dbName,
      resolveWebAuthnBlobOptions(rpIdOrOptions, displayName, options),
    );
  }

  async save(creds: StoredCredentials): Promise<void> {
    await this.blobStore.save(this.encoder.encode(JSON.stringify(creds)));
  }

  async load(): Promise<StoredCredentials | null> {
    const blob = await this.blobStore.load();
    if (!blob) return null;
    return normalizeStoredCredentials(JSON.parse(this.decoder.decode(blob)));
  }

  async clear(): Promise<void> {
    await this.blobStore.clear();
  }
}

/**
 * Stores an AES-GCM envelope key in WebAuthn largeBlob. Use with
 * `EnvelopedCredentialStore` when localStorage/sessionStorage may hold the
 * encrypted mesh credential but biometric/passkey access is required to unwrap it.
 */
/**
 * Uses a WebAuthn ceremony to derive or retrieve the AES key that protects an
 * encrypted credential envelope.
 *
 * Use this when the credential record itself should live in browser storage,
 * backend storage, or another custom store, but every encrypt/decrypt step
 * should require a browser-managed biometric/passkey confirmation.
 */
export class WebAuthnEnvelopeKeyProvider implements CredentialEnvelopeKeyProvider {
  private readonly blobStore: WebAuthnBlobStore;

  constructor(dbName: string, options?: WebAuthnBlobStoreOptions);
  constructor(
    dbName: string,
    rpId?: string,
    displayName?: string,
    options?: Pick<WebAuthnBlobStoreOptions, "authenticatorAttachment" | "userVerification">,
  );
  constructor(
    dbName: string,
    rpIdOrOptions: string | WebAuthnBlobStoreOptions = globalThis.location?.hostname ?? "localhost",
    displayName: string = "Interocitor",
    options?: Pick<WebAuthnBlobStoreOptions, "authenticatorAttachment" | "userVerification">,
  ) {
    this.blobStore = new WebAuthnBlobStore(
      `${dbName}:envelope-key`,
      resolveWebAuthnBlobOptions(rpIdOrOptions, displayName, options),
    );
  }

  async getKey(purpose: CredentialEnvelopeKeyPurpose = "decrypt"): Promise<CryptoKey> {
    const stored = await this.blobStore.load();
    if (stored) {
      return crypto.subtle.importKey("raw", stored, "AES-GCM", false, ["encrypt", "decrypt"]);
    }
    if (purpose === "decrypt") {
      throw new Error("No WebAuthn envelope key is available for decrypt");
    }

    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
      "encrypt",
      "decrypt",
    ]);
    const raw = await crypto.subtle.exportKey("raw", key);
    await this.blobStore.save(new Uint8Array(raw));
    return key;
  }

  async clear(): Promise<void> {
    await this.blobStore.clear();
  }
}

// ─── Auto-detection and configuration wiring ──────────────────────────

/**
 * Create a browser credential store.
 *
 * Forms:
 * - `createWebCredentialStore(credentialNamespace)` → localStorage
 * - `createWebCredentialStore(credentialNamespace, 'App Name')` → localStorage with passkey display name
 * - `{ storage: 'memory' }` → key lives in JS memory only
 * - `{ storage: 'sessionStorage' }` → key survives reloads in the same tab only
 * - `{ storage: 'passkey' }` → key lives only in WebAuthn largeBlob
 * - `{ envelope: { storage, keyProvider } }` → encrypted local/memory record, key from provider
 * - `{ envelope: { store, keyProvider } }` → encrypted record from app/backend/custom storage
 *
 * The returned store always manages the Interocitor mesh credential record.
 * `credentialNamespace` must identify the stable encryption domain. When using
 * `createNamedLocalStore`, pass its `credentialNamespace`, never its rotatable
 * `activeDatabaseName`. Generated physical names fail with
 * {@link UnstableCredentialNamespaceError}.
 *
 * Choose `storage: 'passkey'` when the whole record should live behind
 * WebAuthn. Choose `envelope` when the record may live elsewhere but unwrap
 * should be gated by a key provider such as {@link WebAuthnEnvelopeKeyProvider}.
 */
export function createWebCredentialStore(
  credentialNamespace: string,
  displayName?: string,
): WebCredentialStore;
export function createWebCredentialStore(
  credentialNamespace: string,
  options: CreateWebCredentialStoreOptions,
): WebCredentialStore;
export function createWebCredentialStore(
  credentialNamespace: string,
  displayNameOrOptions?: string | CreateWebCredentialStoreOptions,
): WebCredentialStore {
  if (isGeneratedLocalDatabaseName(credentialNamespace)) {
    throw new UnstableCredentialNamespaceError(credentialNamespace);
  }

  const options: CreateWebCredentialStoreOptions =
    typeof displayNameOrOptions === "string"
      ? { displayName: displayNameOrOptions }
      : (displayNameOrOptions ?? {});

  if (options.envelope) {
    return new NoopBiometricControls(
      new EnvelopedCredentialStore(
        credentialNamespace,
        options.envelope.store ?? options.envelope.storage ?? "localStorage",
        options.envelope.keyProvider,
      ),
    );
  }

  switch (options.storage ?? "localStorage") {
    case "memory":
      return new NoopBiometricControls(
        new MemoryCredentialStore(credentialNamespace, options.memory),
      );
    case "sessionStorage":
      return new NoopBiometricControls(new SessionStorageCredentialStore(credentialNamespace));
    case "passkey":
      return new NoopBiometricControls(
        new WebAuthnCredentialStore(credentialNamespace, {
          rpId: options.rpId,
          displayName: options.displayName,
          authenticatorAttachment: options.authenticatorAttachment,
          userVerification: options.userVerification,
        }),
      );
    case "localStorage":
      return new NoopBiometricControls(new LocalStorageCredentialStore(credentialNamespace));
  }
}
