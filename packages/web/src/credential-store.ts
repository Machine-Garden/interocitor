/**
 * Credential Store — pluggable persistence for key material.
 *
 * The engine consumes the core `CredentialStore` contract. This module keeps
 * the browser-specific choices explicit: memory, sessionStorage,
 * localStorage, passkey-only WebAuthn, and envelope encryption where a
 * biometric/external key protects a local credential record.
 */

import type { CredentialStore, StoredCredentials } from '@interocitor/core';

export interface WebCredentialStore extends CredentialStore {
  secureWithBiometrics(): Promise<boolean>;
  restoreWithBiometrics?(): Promise<StoredCredentials | null>;
}

export type CredentialStorageLocation = 'memory' | 'sessionStorage' | 'localStorage' | 'passkey';
export type EnvelopeStorageLocation = 'memory' | 'sessionStorage' | 'localStorage';

export type CredentialEnvelopeKeyPurpose = 'encrypt' | 'decrypt';

export interface CredentialEnvelopeKeyProvider {
  getKey(purpose?: CredentialEnvelopeKeyPurpose): Promise<CryptoKey>;
  clear?(): Promise<void>;
}

export type StoredCredentialEnvelope = {
  v: 1;
  alg: 'AES-GCM';
  iv: string;
  ciphertext: string;
};

export interface CredentialEnvelopeStore {
  save(envelope: StoredCredentialEnvelope): Promise<void>;
  load(): Promise<StoredCredentialEnvelope | null>;
  clear(): Promise<void>;
}

export interface CreateWebCredentialStoreOptions {
  /** Where the mesh credential record is stored. Default: localStorage. */
  storage?: CredentialStorageLocation;
  /** Human-readable app name shown in biometric prompts. */
  displayName?: string;
  /** WebAuthn relying-party id. Defaults to current hostname. */
  rpId?: string;
  /** Optional shared map for tests or app-level in-memory vaults. */
  memory?: Map<string, StoredCredentials>;
  /** Wrap a credential record with AES-GCM before writing it to a pluggable envelope store. */
  envelope?: {
    storage?: EnvelopeStorageLocation;
    store?: CredentialEnvelopeStore;
    keyProvider: CredentialEnvelopeKeyProvider;
  };
}

type BrowserStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function normalizeStoredCredentials(value: unknown): StoredCredentials | null {
  if (!value || typeof value !== 'object') return null;
  const parsed = value as Partial<StoredCredentials>;
  if (typeof parsed.portableKey !== 'string' || typeof parsed.deviceId !== 'string') return null;
  return {
    portableKey: parsed.portableKey,
    deviceId: parsed.deviceId,
    ...(typeof parsed.meshId === 'string' && parsed.meshId ? { meshId: parsed.meshId } : {}),
  };
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCodePoint(bytes[i]);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const decoded = Uint8Array.from(atob(value), c => c.codePointAt(0)!);
  return new Uint8Array(decoded);
}

function getNamedStorage(location: EnvelopeStorageLocation | CredentialStorageLocation): BrowserStorage | null {
  if (location === 'localStorage') return typeof localStorage === 'undefined' ? null : localStorage;
  if (location === 'sessionStorage') return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  return null;
}

class NoopBiometricControls implements WebCredentialStore {
  constructor(private readonly inner: CredentialStore) {}

  save(creds: StoredCredentials): Promise<void> { return this.inner.save(creds); }
  load(): Promise<StoredCredentials | null> { return this.inner.load(); }
  clear(): Promise<void> { return this.inner.clear(); }
  async secureWithBiometrics(): Promise<boolean> { return false; }
}

// ─── Plain browser storage backends ───────────────────────────────────

class BrowserStorageCredentialStore implements CredentialStore {
  constructor(
    private readonly dbName: string,
    _storageName: EnvelopeStorageLocation,
    private readonly storageProvider: () => BrowserStorage | null,
  ) {}

  /** Single record per dbName. JSON-encoded `{portableKey, deviceId, meshId}`. */
  protected recordKey(): string { return `interocitor-creds:${this.dbName}`; }

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
    super(dbName, 'localStorage', () => getNamedStorage('localStorage'));
  }
}

export class SessionStorageCredentialStore extends BrowserStorageCredentialStore {
  constructor(dbName: string) {
    super(dbName, 'sessionStorage', () => getNamedStorage('sessionStorage'));
  }
}

export class MemoryCredentialStore implements CredentialStore {
  private readonly records: Map<string, StoredCredentials>;

  constructor(private readonly dbName: string, records?: Map<string, StoredCredentials>) {
    this.records = records ?? new Map();
  }

  private recordKey(): string { return `interocitor-creds:${this.dbName}`; }

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
  async getKey(): Promise<CryptoKey> { return this.key; }
}

export class BrowserCredentialEnvelopeStore implements CredentialEnvelopeStore {
  constructor(
    private readonly dbName: string,
    storageName: Exclude<EnvelopeStorageLocation, 'memory'>,
    private readonly storageProvider: () => BrowserStorage | null = () => getNamedStorage(storageName),
  ) {}

  private recordKey(): string { return `interocitor-creds-envelope:${this.dbName}`; }

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
    return envelope?.v === 1 && envelope.alg === 'AES-GCM' ? envelope : null;
  }

  async clear(): Promise<void> {
    const storage = this.storageProvider();
    if (storage) storage.removeItem(this.recordKey());
  }
}

export class MemoryCredentialEnvelopeStore implements CredentialEnvelopeStore {
  private readonly records: Map<string, StoredCredentialEnvelope>;

  constructor(private readonly dbName: string, records?: Map<string, StoredCredentialEnvelope>) {
    this.records = records ?? new Map();
  }

  private recordKey(): string { return `interocitor-creds-envelope:${this.dbName}`; }

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

function createCredentialEnvelopeStore(dbName: string, location: EnvelopeStorageLocation): CredentialEnvelopeStore {
  if (location === 'memory') return new MemoryCredentialEnvelopeStore(dbName);
  return new BrowserCredentialEnvelopeStore(dbName, location);
}

export class EnvelopedCredentialStore implements CredentialStore {
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();
  private readonly envelopeStore: CredentialEnvelopeStore;

  constructor(
    dbName: string,
    storageNameOrStore: EnvelopeStorageLocation | CredentialEnvelopeStore,
    private readonly keyProvider: CredentialEnvelopeKeyProvider,
  ) {
    this.envelopeStore = typeof storageNameOrStore === 'string'
      ? createCredentialEnvelopeStore(dbName, storageNameOrStore)
      : storageNameOrStore;
  }

  async save(creds: StoredCredentials): Promise<void> {
    const key = await this.keyProvider.getKey('encrypt');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const payload: StoredCredentials = {
      portableKey: creds.portableKey,
      deviceId: creds.deviceId,
      ...(creds.meshId ? { meshId: creds.meshId } : {}),
    };
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      this.encoder.encode(JSON.stringify(payload)),
    );
    await this.envelopeStore.save({
      v: 1,
      alg: 'AES-GCM',
      iv: encodeBase64(iv),
      ciphertext: encodeBase64(new Uint8Array(ciphertext)),
    });
  }

  async load(): Promise<StoredCredentials | null> {
    const envelope = await this.envelopeStore.load();
    if (!envelope) return null;
    const key = await this.keyProvider.getKey('decrypt');
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: decodeBase64(envelope.iv) },
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

class WebAuthnLargeBlobStore {
  private static readonly CRED_ID_KEY_PREFIX = 'interocitor-cred:';

  constructor(
    private readonly namespace: string,
    private readonly rpId: string = globalThis.location?.hostname ?? 'localhost',
    private readonly displayName: string = 'Interocitor',
  ) {}

  private credIdKey(): string {
    return `${WebAuthnLargeBlobStore.CRED_ID_KEY_PREFIX}${this.namespace}`;
  }

  private loadCredentialIdHint(): ArrayBuffer | null {
    if (typeof localStorage === 'undefined') return null;
    try {
      const stored = localStorage.getItem(this.credIdKey());
      if (!stored) return null;
      return decodeBase64(stored).buffer as ArrayBuffer;
    } catch {
      return null;
    }
  }

  private saveCredentialIdHint(rawId: ArrayBuffer): void {
    if (typeof localStorage === 'undefined') return;
    try { localStorage.setItem(this.credIdKey(), encodeBase64(new Uint8Array(rawId))); } catch { /* best-effort */ }
  }

  async save(blob: Uint8Array): Promise<void> {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const userId = crypto.getRandomValues(new Uint8Array(16));

    const credential = await navigator.credentials.create({
      publicKey: {
        rp: { name: this.displayName, id: this.rpId },
        user: {
          id: userId,
          name: `${this.displayName.toLowerCase().replaceAll(/\s+/g, '-')}:${this.namespace}`,
          displayName: this.displayName,
        },
        challenge,
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          residentKey: 'required',
          userVerification: 'required',
        },
        extensions: {
          largeBlob: { support: 'required' },
        } as AuthenticationExtensionsClientInputs,
      },
    }) as PublicKeyCredential | null;

    if (!credential) throw new Error('WebAuthn credential creation cancelled');
    this.saveCredentialIdHint(credential.rawId);
    await this.write(credential.rawId, blob);
  }

  private async write(credentialId: ArrayBuffer, blob: Uint8Array): Promise<void> {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge,
        rpId: this.rpId,
        allowCredentials: [{ type: 'public-key' as const, id: credentialId }],
        userVerification: 'required',
        extensions: {
          largeBlob: { write: blob },
        } as AuthenticationExtensionsClientInputs,
      },
    }) as PublicKeyCredential | null;

    if (!assertion) throw new Error('WebAuthn assertion cancelled');
    const results = (assertion as { getClientExtensionResults?: () => { largeBlob?: { written?: boolean } } }).getClientExtensionResults?.();
    if (!results?.largeBlob?.written) throw new Error('largeBlob write failed — authenticator may not support it');
  }

  async load(): Promise<ArrayBuffer | null> {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const credentialIdHint = this.loadCredentialIdHint();
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge,
        rpId: this.rpId,
        allowCredentials: credentialIdHint ? [{ type: 'public-key' as const, id: credentialIdHint }] : [],
        userVerification: 'required',
        extensions: {
          largeBlob: { read: true },
        } as AuthenticationExtensionsClientInputs,
      },
    }) as PublicKeyCredential | null;

    if (!assertion) return null;
    const results = (assertion as { getClientExtensionResults?: () => { largeBlob?: { blob?: ArrayBuffer } } }).getClientExtensionResults?.();
    const blob = results?.largeBlob?.blob;
    if (!blob) return null;
    this.saveCredentialIdHint(assertion.rawId);
    return blob;
  }

  async clear(): Promise<void> {
    try { localStorage.removeItem(this.credIdKey()); } catch { /* ok */ }
  }
}

/**
 * Stores credentials directly in the OS keychain via WebAuthn largeBlob.
 * No passphrase is written to localStorage/sessionStorage. A localStorage
 * credential-id hint may be written; the hint is not key material.
 */
export class WebAuthnCredentialStore implements CredentialStore {
  private readonly blobStore: WebAuthnLargeBlobStore;
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  constructor(
    dbName: string,
    rpId: string = globalThis.location?.hostname ?? 'localhost',
    displayName: string = 'Interocitor',
  ) {
    this.blobStore = new WebAuthnLargeBlobStore(dbName, rpId, displayName);
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
export class WebAuthnEnvelopeKeyProvider implements CredentialEnvelopeKeyProvider {
  private readonly blobStore: WebAuthnLargeBlobStore;

  constructor(
    dbName: string,
    rpId: string = globalThis.location?.hostname ?? 'localhost',
    displayName: string = 'Interocitor',
  ) {
    this.blobStore = new WebAuthnLargeBlobStore(`${dbName}:envelope-key`, rpId, displayName);
  }

  async getKey(purpose: CredentialEnvelopeKeyPurpose = 'decrypt'): Promise<CryptoKey> {
    const stored = await this.blobStore.load();
    if (stored) {
      return crypto.subtle.importKey('raw', stored, 'AES-GCM', false, ['encrypt', 'decrypt']);
    }
    if (purpose === 'decrypt') {
      throw new Error('No WebAuthn envelope key is available for decrypt');
    }

    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const raw = await crypto.subtle.exportKey('raw', key);
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
 * - `createWebCredentialStore(dbName)` → localStorage
 * - `createWebCredentialStore(dbName, 'App Name')` → localStorage with passkey display name
 * - `{ storage: 'memory' }` → key lives in JS memory only
 * - `{ storage: 'sessionStorage' }` → key survives reloads in the same tab only
 * - `{ storage: 'passkey' }` → key lives only in WebAuthn largeBlob
 * - `{ envelope: { storage, keyProvider } }` → encrypted local/memory record, key from provider
 * - `{ envelope: { store, keyProvider } }` → encrypted record from app/backend/custom storage
 */
export function createWebCredentialStore(dbName: string, displayName?: string): WebCredentialStore;
export function createWebCredentialStore(dbName: string, options: CreateWebCredentialStoreOptions): WebCredentialStore;
export function createWebCredentialStore(
  dbName: string,
  displayNameOrOptions?: string | CreateWebCredentialStoreOptions,
): WebCredentialStore {
  const options: CreateWebCredentialStoreOptions = typeof displayNameOrOptions === 'string'
    ? { displayName: displayNameOrOptions }
    : displayNameOrOptions ?? {};

  if (options.envelope) {
    return new NoopBiometricControls(new EnvelopedCredentialStore(
      dbName,
      options.envelope.store ?? options.envelope.storage ?? 'localStorage',
      options.envelope.keyProvider,
    ));
  }

  switch (options.storage ?? 'localStorage') {
    case 'memory':
      return new NoopBiometricControls(new MemoryCredentialStore(dbName, options.memory));
    case 'sessionStorage':
      return new NoopBiometricControls(new SessionStorageCredentialStore(dbName));
    case 'passkey':
      return new NoopBiometricControls(new WebAuthnCredentialStore(dbName, options.rpId, options.displayName));
    case 'localStorage':
      return new NoopBiometricControls(new LocalStorageCredentialStore(dbName));
  }
}
