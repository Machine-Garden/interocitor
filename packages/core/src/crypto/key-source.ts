import type { CredentialStore, StoredCredentials } from '../storage/credential-store.ts';

export interface MeshKeyContext {
  dbName: string;
  remotePath?: string;
  meshId?: string;
  deviceId: string;
}

export interface MeshKeyMaterial {
  encrypted: boolean;
  key: CryptoKey | null;
  portableKey?: string | null;
}

export interface MeshKeySource {
  load(context: MeshKeyContext): Promise<MeshKeyMaterial>;
  persist(context: MeshKeyContext, credentials: StoredCredentials): Promise<void>;
  clear(): Promise<void>;
}

export interface PortablePassphraseKeySourceOptions {
  portableKey?: string | null;
  credentialStore?: CredentialStore | null;
  generateIfMissing?: boolean;
}

export interface BoundSharedKeySourceOptions {
  credentialStore?: CredentialStore | null;
  derive: (context: MeshKeyContext & { portableKey: string }) => Promise<MeshKeyMaterial>;
  portableKey?: string | null;
}

export class PortablePassphraseKeySource implements MeshKeySource {
  private portableKey: string | null;
  private readonly credentialStore: CredentialStore | null;
  private readonly generateIfMissing: boolean;

  constructor(options: PortablePassphraseKeySourceOptions = {}) {
    this.portableKey = options.portableKey ?? null;
    this.credentialStore = options.credentialStore ?? null;
    this.generateIfMissing = options.generateIfMissing ?? true;
  }

  setPortableKey(portableKey: string | null): void {
    this.portableKey = portableKey;
  }

  getPortableKey(): string | null {
    return this.portableKey;
  }

  async load(_context: MeshKeyContext): Promise<MeshKeyMaterial> {
    if (this.portableKey) return { encrypted: true, key: null, portableKey: this.portableKey };
    const stored = this.credentialStore ? await this.credentialStore.load() : null;
    if (stored?.portableKey) {
      this.portableKey = stored.portableKey;
      return { encrypted: true, key: null, portableKey: stored.portableKey };
    }
    if (!this.generateIfMissing) return { encrypted: false, key: null, portableKey: null };
    return { encrypted: true, key: null, portableKey: null };
  }

  async persist(_context: MeshKeyContext, credentials: StoredCredentials): Promise<void> {
    this.portableKey = credentials.portableKey;
    if (this.credentialStore) await this.credentialStore.save(credentials);
  }

  async clear(): Promise<void> {
    this.portableKey = null;
    if (this.credentialStore) await this.credentialStore.clear();
  }
}

export class BoundSharedKeySource implements MeshKeySource {
  private portableKey: string | null;
  private readonly credentialStore: CredentialStore | null;
  private readonly deriveKey: BoundSharedKeySourceOptions['derive'];

  constructor(options: BoundSharedKeySourceOptions) {
    this.portableKey = options.portableKey ?? null;
    this.credentialStore = options.credentialStore ?? null;
    this.deriveKey = options.derive;
  }

  setPortableKey(portableKey: string | null): void {
    this.portableKey = portableKey;
  }

  getPortableKey(): string | null {
    return this.portableKey;
  }

  async load(context: MeshKeyContext): Promise<MeshKeyMaterial> {
    const stored = this.portableKey
      ? { portableKey: this.portableKey, deviceId: context.deviceId }
      : this.credentialStore
        ? await this.credentialStore.load()
        : null;

    if (!stored?.portableKey) return { encrypted: true, key: null, portableKey: null };
    this.portableKey = stored.portableKey;
    return this.deriveKey({ ...context, portableKey: stored.portableKey });
  }

  async persist(_context: MeshKeyContext, credentials: StoredCredentials): Promise<void> {
    this.portableKey = credentials.portableKey;
    if (this.credentialStore) await this.credentialStore.save(credentials);
  }

  async clear(): Promise<void> {
    this.portableKey = null;
    if (this.credentialStore) await this.credentialStore.clear();
  }
}
