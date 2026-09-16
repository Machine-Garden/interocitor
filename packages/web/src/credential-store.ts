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
  CredentialAccessError,
  credentialAvailabilityOf,
  CredentialUnavailableError,
  CredentialUnreadableError,
  ResidualWebAuthnCredentialError,
  WebAuthnBlobStore,
  type WebAuthnAttachmentPreference,
  type WebAuthnBlobStoreOptions,
  type WebAuthnClearResult,
} from "./webauthn.ts";

export {
  CredentialAccessError,
  CredentialUnavailableError,
  CredentialUnreadableError,
  ResidualWebAuthnCredentialError,
  credentialAvailabilityOf,
  isCredentialAccessError,
  type CredentialAccessErrorInit,
  type CredentialAvailability,
  type WebAuthnClearOptions,
  type WebAuthnClearResult,
  type WebAuthnResidualRisk,
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
  /**
   * Stable identity of this provider, bound into the envelope's additional
   * authenticated data so an envelope cannot be replayed under a different
   * key provider. Defaults to `"custom"` when omitted.
   */
  readonly envelopeKeyId?: string;
  /**
   * Return the long-lived key directly. Used for v1 envelopes, which have no
   * KDF, and by providers that cannot derive.
   *
   * `request` carries the same `CredentialEnvelopeKeyRequest` that
   * {@link deriveKey} would receive, including the `keyId` of the envelope
   * being opened or written. It is a second, optional parameter rather than a
   * replacement for `purpose` so that every provider written against the
   * original one-argument signature keeps compiling and keeps behaving
   * identically: a provider that declares `getKey(purpose?)` — or `getKey()` —
   * simply ignores the extra argument and returns its single key, exactly as
   * before. Implement the `request` parameter only to support key rotation;
   * see {@link CredentialEnvelopeKeyRequest.keyId}.
   */
  getKey(
    purpose?: CredentialEnvelopeKeyPurpose,
    request?: CredentialEnvelopeKeyRequest,
  ): Promise<CryptoKey>;
  /**
   * Derive a per-envelope key-encryption key from a long-lived seed.
   *
   * Preferred over {@link getKey} for new envelopes: implementing it means the
   * material the provider custodies is a seed, not the KEK itself, so the
   * envelope can be rotated by writing a new salt without a new ceremony.
   */
  deriveKey?(request: CredentialEnvelopeKeyRequest): Promise<CryptoKey>;
  clear?(): Promise<void>;
}

/**
 * What {@link CredentialEnvelopeKeyProvider.deriveKey} and
 * {@link CredentialEnvelopeKeyProvider.getKey} bind a KEK to.
 */
export interface CredentialEnvelopeKeyRequest {
  purpose: CredentialEnvelopeKeyPurpose;
  /** Stable encryption domain — the credential namespace, not a rotatable db name. */
  dbName: string;
  /** Per-envelope salt stored in the envelope's `kdf.salt`. */
  salt: Uint8Array;
  /**
   * Which key the envelope is written under, or was written under.
   *
   * This is the exact value bound into the envelope's AAD, so a provider that
   * holds a current key plus previous keys can select the matching one instead
   * of guessing. Without it a wrong guess surfaces as
   * `CredentialUnreadableError` with no second chance, which makes rotation
   * impossible.
   *
   * - On `encrypt` it is the provider's own `envelopeKeyId` (defaulting to
   *   `"custom"`), i.e. the id the new envelope will record.
   * - On `decrypt` of a v2 envelope it is the `keyId` recorded in that
   *   envelope.
   * - On `decrypt` of a v1 envelope, which predates `keyId` and records none,
   *   it is the provider's current `envelopeKeyId`. A rotating provider
   *   therefore answers a v1 request with its current key, which is exactly
   *   what happened before this field existed.
   *
   * Optional only so that code which builds a request by hand keeps
   * compiling; {@link EnvelopedCredentialStore} always sets it. A provider
   * that ignores it behaves exactly as it did before.
   */
  keyId?: string;
}

/** Original envelope: the provider's key was used directly, with no AAD. */
export type StoredCredentialEnvelopeV1 = {
  v: 1;
  alg: "AES-GCM";
  iv: string;
  ciphertext: string;
};

/**
 * Current envelope.
 *
 * `kdf` is present when the key provider derived a per-envelope KEK from a
 * seed. The ciphertext is bound by AAD to the credential namespace, the key
 * provider identity, and the salt, so an envelope cannot be replayed into a
 * different namespace or under a different provider.
 */
export type StoredCredentialEnvelopeV2 = {
  v: 2;
  alg: "AES-GCM";
  kdf?: { name: "HKDF-SHA-256"; salt: string };
  keyId: string;
  iv: string;
  ciphertext: string;
};

export type StoredCredentialEnvelope = StoredCredentialEnvelopeV1 | StoredCredentialEnvelopeV2;

/** Version written by {@link EnvelopedCredentialStore.save}. */
export const CURRENT_CREDENTIAL_ENVELOPE_VERSION = 2 as const;

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

/**
 * View `bytes` as a `BufferSource` without copying.
 *
 * Mirrors `core/src/crypto/bytes.ts`: TypeScript widens `Uint8Array` to
 * `Uint8Array<ArrayBufferLike>` because the backing store could in theory be a
 * `SharedArrayBuffer`; this codebase never creates one.
 */
function asBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes as Uint8Array<ArrayBuffer>;
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
  readonly envelopeKeyId = "static" as const;

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
    if (envelope?.alg !== "AES-GCM") return null;
    return envelope.v === 1 || envelope.v === 2 ? envelope : null;
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
    private readonly dbName: string,
    storageNameOrStore: EnvelopeStorageLocation | CredentialEnvelopeStore,
    private readonly keyProvider: CredentialEnvelopeKeyProvider,
  ) {
    this.envelopeStore =
      typeof storageNameOrStore === "string"
        ? createCredentialEnvelopeStore(dbName, storageNameOrStore)
        : storageNameOrStore;
  }

  private keyId(): string {
    return this.keyProvider.envelopeKeyId ?? "custom";
  }

  /**
   * Additional authenticated data for a v2 envelope.
   *
   * Follows the `crypto/recovery.ts` wrapper precedent: a versioned literal
   * prefix plus every field the ciphertext must not be detachable from.
   */
  private aad(keyId: string, salt: string): Uint8Array<ArrayBuffer> {
    return asBufferSource(
      this.encoder.encode(`interocitor.credential.envelope.v2|${this.dbName}|${keyId}|${salt}`),
    );
  }

  /** Any non-taxonomy failure from a key provider is an `unavailable` read. */
  private async requireKey(
    request: CredentialEnvelopeKeyRequest,
    derive: boolean,
  ): Promise<CryptoKey> {
    try {
      return derive && this.keyProvider.deriveKey
        ? await this.keyProvider.deriveKey(request)
        : // `purpose` stays the first argument so providers written against the
          // original signature are unaffected; `request` carries the keyId a
          // rotating provider needs to select a previous key.
          await this.keyProvider.getKey(request.purpose, request);
    } catch (error) {
      if (error instanceof CredentialAccessError) throw error;
      throw new CredentialUnavailableError(
        `Credential envelope key for "${this.dbName}" could not be obtained`,
        { cause: error },
      );
    }
  }

  /**
   * Write the credential record as a v2 envelope.
   *
   * A record read from a v1 envelope is upgraded here: the next write after an
   * upgrade always produces v2.
   *
   * The same upgrade-in-place shape carries key rotation. The envelope is
   * always written under the provider's *current* `envelopeKeyId`, so once a
   * provider starts reporting a new id, the next `save()` re-wraps the record
   * under the new key and records the new id. Envelopes still on a previous id
   * keep opening, because `load()` hands that recorded id back to the provider.
   */
  async save(creds: StoredCredentials): Promise<void> {
    const keyId = this.keyId();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const derive = typeof this.keyProvider.deriveKey === "function";
    const saltText = derive ? encodeBase64(salt) : "";
    const key = await this.requireKey(
      { purpose: "encrypt", dbName: this.dbName, salt, keyId },
      derive,
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const payload: StoredCredentials = {
      portableKey: creds.portableKey,
      deviceId: creds.deviceId,
      ...(creds.meshId ? { meshId: creds.meshId } : {}),
    };
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: this.aad(keyId, saltText) },
      key,
      this.encoder.encode(JSON.stringify(payload)),
    );
    await this.envelopeStore.save({
      v: CURRENT_CREDENTIAL_ENVELOPE_VERSION,
      alg: "AES-GCM",
      ...(derive ? { kdf: { name: "HKDF-SHA-256" as const, salt: saltText } } : {}),
      keyId,
      iv: encodeBase64(iv),
      ciphertext: encodeBase64(new Uint8Array(ciphertext)),
    });
  }

  /**
   * Read the credential record.
   *
   * Returns `null` only when no envelope is stored (`absent`). A key provider
   * that cannot be consulted surfaces as {@link CredentialUnavailableError};
   * an envelope that fails its AEAD check or carries an unknown version
   * surfaces as {@link CredentialUnreadableError}. Neither is silently
   * downgraded to "no credentials", which would mint a forked mesh key.
   */
  async load(): Promise<StoredCredentials | null> {
    const envelope = await this.envelopeStore.load();
    if (!envelope) return null;
    const plaintext =
      envelope.v === 1 ? await this.decryptV1(envelope) : await this.decryptV2(envelope);
    try {
      return normalizeStoredCredentials(JSON.parse(this.decoder.decode(plaintext)));
    } catch (error) {
      throw new CredentialUnreadableError(
        `Credential envelope for "${this.dbName}" decrypted to invalid JSON`,
        { cause: error },
      );
    }
  }

  /** Legacy path: the provider's key is the KEK and there is no AAD. */
  private async decryptV1(envelope: StoredCredentialEnvelopeV1): Promise<ArrayBuffer> {
    const key = await this.requireKey(
      {
        purpose: "decrypt",
        dbName: this.dbName,
        salt: new Uint8Array(0),
        // A v1 envelope records no keyId, so there is nothing historical to
        // report. Passing the provider's current id keeps a rotating provider
        // on the same key it would have returned before this field existed.
        keyId: this.keyId(),
      },
      false,
    );
    try {
      return await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: decodeBase64(envelope.iv) },
        key,
        decodeBase64(envelope.ciphertext),
      );
    } catch (error) {
      throw new CredentialUnreadableError(
        `v1 credential envelope for "${this.dbName}" failed to decrypt`,
        { cause: error },
      );
    }
  }

  private async decryptV2(envelope: StoredCredentialEnvelopeV2): Promise<ArrayBuffer> {
    if (envelope.kdf && envelope.kdf.name !== "HKDF-SHA-256") {
      throw new CredentialUnreadableError(
        `Credential envelope for "${this.dbName}" uses unknown KDF "${envelope.kdf.name}"`,
      );
    }
    const derive = Boolean(envelope.kdf);
    if (derive && typeof this.keyProvider.deriveKey !== "function") {
      throw new CredentialUnreadableError(
        `Credential envelope for "${this.dbName}" needs a deriving key provider, but "${this.keyId()}" cannot derive`,
      );
    }
    const saltText = envelope.kdf?.salt ?? "";
    // One value for both the unwrap request and the AAD: the provider is asked
    // for exactly the key this ciphertext is bound to.
    const keyId = envelope.keyId ?? "custom";
    const key = await this.requireKey(
      {
        purpose: "decrypt",
        dbName: this.dbName,
        salt: saltText ? decodeBase64(saltText) : new Uint8Array(0),
        keyId,
      },
      derive,
    );
    try {
      return await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: decodeBase64(envelope.iv),
          additionalData: this.aad(keyId, saltText),
        },
        key,
        decodeBase64(envelope.ciphertext),
      );
    } catch (error) {
      throw new CredentialUnreadableError(
        `Credential envelope for "${this.dbName}" failed its authenticity check — wrong key, wrong namespace, or tampered ciphertext`,
        { cause: error },
      );
    }
  }

  /**
   * Remove the envelope and ask the key provider to destroy its key material.
   *
   * The envelope is cleared first so a failing provider cannot leave readable
   * ciphertext behind.
   */
  async clear(): Promise<void> {
    await this.envelopeStore.clear();
    await this.keyProvider.clear?.();
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

  /**
   * Returns `null` only when the ceremony succeeded and the credential holds
   * no record (`absent`). A declined or unsupported ceremony throws
   * {@link CredentialUnavailableError}; a blob belonging to another namespace
   * or one that is not a credential record throws
   * {@link CredentialUnreadableError}.
   */
  async load(): Promise<StoredCredentials | null> {
    const blob = await this.blobStore.load();
    if (!blob) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.decoder.decode(blob));
    } catch (error) {
      throw new CredentialUnreadableError(
        "WebAuthn largeBlob does not contain a credential record",
        { cause: error },
      );
    }
    const credentials = normalizeStoredCredentials(parsed);
    if (!credentials) {
      throw new CredentialUnreadableError(
        "WebAuthn largeBlob contains JSON that is not a credential record",
      );
    }
    return credentials;
  }

  /**
   * Destroy the stored record and report what survived.
   *
   * See {@link WebAuthnBlobStore.clear}: the blob is overwritten, but the
   * WebAuthn credential itself cannot be deleted by script.
   */
  async clearWithReport(): Promise<WebAuthnClearResult> {
    return this.blobStore.clear();
  }

  /**
   * Destroy the stored record.
   *
   * This runs a write ceremony per known credential that replaces the stored
   * blob with an empty one, then drops the local hints. It does NOT delete the
   * WebAuthn credential: the platform exposes no such API, so an empty passkey
   * survives in the OS keychain until the user removes it in system settings.
   *
   * Throws {@link ResidualWebAuthnCredentialError} when a known credential
   * could not be overwritten and may therefore still hold readable secret
   * bytes. Use {@link clearWithReport} for the full result, including the
   * `unknown` case where local hints were already gone and nothing could be
   * proven destroyed.
   */
  async clear(): Promise<void> {
    const result = await this.clearWithReport();
    if (result.residualRisk === "blob-may-survive") {
      throw new ResidualWebAuthnCredentialError(result);
    }
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
  readonly envelopeKeyId = "webauthn-largeblob" as const;
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

  /**
   * Fetch the custodied seed, enrolling one on the encrypt path when the
   * namespace is empty.
   *
   * The seed is 32 random bytes generated in place, so no extractable
   * `CryptoKey` ever exists for it. A v1 envelope treats these bytes directly
   * as its AES-256 KEK; a v2 envelope treats them as HKDF input keying
   * material.
   */
  private async seed(purpose: CredentialEnvelopeKeyPurpose): Promise<Uint8Array<ArrayBuffer>> {
    let stored: Uint8Array<ArrayBuffer> | null;
    try {
      stored = await this.blobStore.load();
    } catch (error) {
      // A read that could not complete is fatal on the decrypt path, and fatal
      // on the encrypt path too whenever a credential is known locally:
      // enrolling a second seed there would strand the envelope the first one
      // protects. With no local reference there is nothing to strand - the
      // browser simply has no credential to offer - and the caller is about to
      // write a fresh envelope anyway, so enroll rather than fail.
      if (
        purpose === "decrypt" ||
        credentialAvailabilityOf(error) !== "unavailable" ||
        this.blobStore.hasAuthenticator()
      ) {
        throw error;
      }
      stored = null;
    }
    if (stored) return stored;
    if (purpose === "decrypt") {
      throw new CredentialUnavailableError("No WebAuthn envelope key is available for decrypt");
    }
    const seed = crypto.getRandomValues(new Uint8Array(32));
    await this.blobStore.save(seed);
    return seed;
  }

  /**
   * Import the seed as the KEK itself, with no domain separation.
   *
   * Only v1 envelopes need this. The returned key is non-extractable: raw
   * bytes never leave this method.
   */
  async getKey(purpose: CredentialEnvelopeKeyPurpose = "decrypt"): Promise<CryptoKey> {
    const seed = await this.seed(purpose);
    try {
      return await crypto.subtle.importKey("raw", asBufferSource(seed), "AES-GCM", false, [
        "encrypt",
        "decrypt",
      ]);
    } finally {
      seed.fill(0);
    }
  }

  /**
   * HKDF a per-envelope, non-extractable KEK from the custodied seed.
   *
   * Domain separation comes from the `info` string; the per-envelope salt
   * makes every envelope's KEK distinct, so rewriting an envelope with a fresh
   * salt rotates its KEK without a new enrollment ceremony.
   */
  async deriveKey(request: CredentialEnvelopeKeyRequest): Promise<CryptoKey> {
    const seed = await this.seed(request.purpose);
    try {
      const source = await crypto.subtle.importKey("raw", asBufferSource(seed), "HKDF", false, [
        "deriveKey",
      ]);
      return await crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: asBufferSource(request.salt),
          info: asBufferSource(
            new TextEncoder().encode(`interocitor.credential.envelope.kek.v2|${request.dbName}`),
          ),
        },
        source,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    } finally {
      seed.fill(0);
    }
  }

  /**
   * Overwrite the custodied seed, best effort.
   *
   * Never throws for a residual credential: `EnvelopedCredentialStore.clear()`
   * calls this and must still complete. Inspect the returned report through
   * {@link clearWithReport} when the caller needs to tell the user that the
   * passkey shell survives.
   */
  async clear(): Promise<void> {
    await this.clearWithReport();
  }

  /** Like {@link clear}, but returns what survived. */
  async clearWithReport(): Promise<WebAuthnClearResult> {
    return this.blobStore.clear();
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
