import type { StoredCredentials } from '@interocitor/core';
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
} from './credential-store.ts';

export const sharedMemory = new Map<string, StoredCredentials>();
declare const providedKey: CryptoKey;

export const defaultStore: WebCredentialStore = createWebCredentialStore('app');
export const namedStore: WebCredentialStore = createWebCredentialStore('app', 'Meal Planner');
export const memoryStore: WebCredentialStore = createWebCredentialStore('app', { storage: 'memory', memory: sharedMemory });
export const sessionStore: WebCredentialStore = createWebCredentialStore('app', { storage: 'sessionStorage' });
export const localStore: WebCredentialStore = createWebCredentialStore('app', { storage: 'localStorage' });
export const passkeyOnlyStore: WebCredentialStore = createWebCredentialStore('app', {
  storage: 'passkey',
  displayName: 'Meal Planner',
  rpId: 'example.com',
});

export const keyProvider: CredentialEnvelopeKeyProvider = new StaticEnvelopeKeyProvider(providedKey);
export const envelopeStore: WebCredentialStore = createWebCredentialStore('app', {
  envelope: {
    storage: 'sessionStorage',
    keyProvider,
  },
});

export const passkeyEnvelopeKey: CredentialEnvelopeKeyProvider = new WebAuthnEnvelopeKeyProvider('app', 'example.com', 'Meal Planner');
export const passkeyEnvelopeStore: WebCredentialStore = createWebCredentialStore('app', {
  envelope: {
    storage: 'localStorage',
    keyProvider: passkeyEnvelopeKey,
  },
});

export const memoryEnvelopeRecordStore = new MemoryCredentialEnvelopeStore('app');
export const memoryEnvelopeStore: WebCredentialStore = createWebCredentialStore('app', {
  envelope: {
    storage: 'memory',
    keyProvider,
  },
});
export const injectedEnvelopeStore: WebCredentialStore = createWebCredentialStore('app', {
  envelope: {
    store: memoryEnvelopeRecordStore,
    keyProvider,
  },
});

export const backendEnvelopeRecordStore: CredentialEnvelopeStore = {
  async save(envelope) { void envelope; },
  async load() { return null; },
  async clear() {},
};
export const backendEnvelopeStore: WebCredentialStore = createWebCredentialStore('app', {
  envelope: {
    store: backendEnvelopeRecordStore,
    keyProvider,
  },
});

export const options: CreateWebCredentialStoreOptions = {
  storage: 'localStorage',
  envelope: undefined,
};

export const directMemory = new MemoryCredentialStore('app');
export const directSession = new SessionStorageCredentialStore('app');
export const directLocal = new LocalStorageCredentialStore('app');
export const directPasskey = new WebAuthnCredentialStore('app');
export const directBrowserEnvelopeStore = new BrowserCredentialEnvelopeStore('app', 'localStorage');
export const directMemoryEnvelopeStore = new MemoryCredentialEnvelopeStore('app');
export const directEnvelope = new EnvelopedCredentialStore('app', directBrowserEnvelopeStore, keyProvider);
