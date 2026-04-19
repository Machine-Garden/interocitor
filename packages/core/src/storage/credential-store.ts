/**
 * Credential Store — pluggable persistence for key material.
 *
 * Safari ITP wipes localStorage after 7 days of inactivity.
 * That kills the passphrase and device ID. Lost key = lost data.
 *
 * This module provides:
 *  - `LocalStorageCredentialStore` — current behaviour, extracted.
 *  - `WebAuthnCredentialStore`    — OS keychain via navigator.credentials + largeBlob.
 *  - `createCredentialStore()`    — auto-detects best backend.
 *
 * The engine uses `CredentialStore` for all key material persistence.
 * Apps never touch this directly unless they want a custom backend.
 */

// ─── Interface ───────────────────────────────────────────────────────

export interface StoredCredentials {
  /** Base58 passphrase for the mesh encryption key. */
  passphrase: string;
  /** Stable device identifier. */
  deviceId: string;
}

export interface CredentialStore {
  /** Persist credentials to the primary store (localStorage). Silent. */
  save(creds: StoredCredentials): Promise<void>;
  /** Load persisted credentials from the primary store only. Silent. */
  load(): Promise<StoredCredentials | null>;
  /** Wipe stored credentials. */
  clear(): Promise<void>;
  /**
   * Persist credentials to the OS keychain via biometrics (WebAuthn).
   * Call on intentional user action (pairing, "secure my keys" button).
   * Returns true if saved, false if unavailable or cancelled.
   * Optional — stores that don't support biometrics return false.
   */
  secureWithBiometrics?(): Promise<boolean>;
  /**
   * Restore credentials from the OS keychain via biometrics (WebAuthn).
   * Call on intentional user action only: "try restore purchases",
   * "restore access", etc. Never automatic.
   * Returns restored credentials or null if unavailable/cancelled/not found.
   */
  restoreWithBiometrics?(): Promise<StoredCredentials | null>;
}

// ─── localStorage backend ────────────────────────────────────────────

export class LocalStorageCredentialStore implements CredentialStore {
  constructor(private readonly dbName: string) {}

  private keyKey(): string { return `interocitor-key:${this.dbName}`; }
  private get deviceKey(): string { return 'interocitor-device-id'; }

  async save(creds: StoredCredentials): Promise<void> {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(this.keyKey(), creds.passphrase);
    localStorage.setItem(this.deviceKey, creds.deviceId);
  }

  async load(): Promise<StoredCredentials | null> {
    if (typeof localStorage === 'undefined') return null;
    const passphrase = localStorage.getItem(this.keyKey());
    const deviceId = localStorage.getItem(this.deviceKey);
    if (!passphrase || !deviceId) return null;
    return { passphrase, deviceId };
  }

  async clear(): Promise<void> {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(this.keyKey());
    // Device ID intentionally kept — shared across meshes, survives credential clear.
  }
}

// ─── WebAuthn + largeBlob backend ────────────────────────────────────

/**
 * Stores credentials in the OS keychain via WebAuthn `largeBlob` extension.
 *
 * Survives Safari ITP, browser data clears, and profile resets.
 * Requires a platform authenticator with largeBlob support (Touch ID,
 * Face ID, Windows Hello). Falls back gracefully — `save()` rejects
 * if the authenticator doesn't support largeBlob.
 *
 * Flow:
 *  1. `save()` → `navigator.credentials.create()` with largeBlob write.
 *     User sees a biometric prompt. Credential ID stored in localStorage
 *     as a hint for faster `load()`, but not required.
 *  2. `load()` → `navigator.credentials.get()` with largeBlob read.
 *     User sees a biometric prompt. Returns the blob.
 *  3. If localStorage hint is gone (ITP wipe), load uses an empty
 *     allowCredentials list — the authenticator picks the right one.
 */
export class WebAuthnCredentialStore implements CredentialStore {
  private static readonly CRED_ID_KEY_PREFIX = 'interocitor-cred:';
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  constructor(
    private readonly dbName: string,
    private readonly rpId: string = globalThis.location?.hostname ?? 'localhost',
    /** Human-readable app name shown in biometric prompts and OS keychain. */
    private readonly displayName: string = 'Interocitor',
  ) {}

  private credIdKey(): string {
    return `${WebAuthnCredentialStore.CRED_ID_KEY_PREFIX}${this.dbName}`;
  }

  private encode(creds: StoredCredentials): Uint8Array {
    return this.encoder.encode(JSON.stringify(creds));
  }

  private decode(blob: ArrayBuffer): StoredCredentials {
    return JSON.parse(this.decoder.decode(blob));
  }

  /** Read credential ID hint from localStorage (best-effort, survives only if ITP hasn't wiped). */
  private loadCredentialIdHint(): ArrayBuffer | null {
    if (typeof localStorage === 'undefined') return null;
    try {
      const stored = localStorage.getItem(this.credIdKey());
      if (!stored) return null;
      const raw = Uint8Array.from(atob(stored), c => c.charCodeAt(0));
      return raw.buffer as ArrayBuffer;
    } catch {
      return null;
    }
  }

  private saveCredentialIdHint(rawId: ArrayBuffer): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const bytes = new Uint8Array(rawId);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      const b64 = btoa(binary);
      localStorage.setItem(this.credIdKey(), b64);
    } catch { /* best-effort */ }
  }

  async save(creds: StoredCredentials): Promise<void> {
    const blob = this.encode(creds);
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const userId = crypto.getRandomValues(new Uint8Array(16));

    const credential = await navigator.credentials.create({
      publicKey: {
        rp: { name: this.displayName, id: this.rpId },
        user: {
          id: userId,
          name: `${this.displayName.toLowerCase().replaceAll(/\s+/g, '-')}:${this.dbName}`,
          displayName: this.displayName,
        },
        challenge,
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },   // ES256
          { type: 'public-key', alg: -257 },  // RS256
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

    // Write the blob in a separate get() call — largeBlob write requires
    // an assertion, not registration, on most platforms.
    this.saveCredentialIdHint(credential.rawId);

    await this.writeLargeBlob(credential.rawId, blob);
  }

  private async writeLargeBlob(credentialId: ArrayBuffer, blob: Uint8Array): Promise<void> {
    const challenge = crypto.getRandomValues(new Uint8Array(32));

    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge,
        rpId: this.rpId,
        allowCredentials: [{
          type: 'public-key' as const,
          id: credentialId,
        }],
        userVerification: 'required',
        extensions: {
          largeBlob: { write: blob },
        } as AuthenticationExtensionsClientInputs,
      },
    }) as PublicKeyCredential | null;

    if (!assertion) throw new Error('WebAuthn assertion cancelled');

    const results = (assertion as any).getClientExtensionResults?.() as any;
    if (!results?.largeBlob?.written) {
      throw new Error('largeBlob write failed — authenticator may not support it');
    }
  }

  async load(): Promise<StoredCredentials | null> {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const credentialIdHint = this.loadCredentialIdHint();

    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge,
        rpId: this.rpId,
        // If we have the hint, scope to it. Otherwise let the authenticator
        // show all resident credentials for this RP (discoverable flow).
        allowCredentials: credentialIdHint
          ? [{ type: 'public-key' as const, id: credentialIdHint }]
          : [],
        userVerification: 'required',
        extensions: {
          largeBlob: { read: true },
        } as AuthenticationExtensionsClientInputs,
      },
    }) as PublicKeyCredential | null;

    if (!assertion) return null;

    const results = (assertion as any).getClientExtensionResults?.() as any;
    const blob = results?.largeBlob?.blob;
    if (!blob) return null;

    // Got credentials back — re-save the hint in case localStorage was wiped.
    this.saveCredentialIdHint(assertion.rawId);

    return this.decode(blob);
  }

  async clear(): Promise<void> {
    // Can't programmatically delete WebAuthn credentials.
    // Remove the localStorage hint; the credential stays in the keychain
    // but won't be found without the hint (or user manually picks it).
    try { localStorage.removeItem(this.credIdKey()); } catch { /* ok */ }
  }
}

// ─── Auto-detection ──────────────────────────────────────────────────

/** Check if WebAuthn with largeBlob is likely available. */
async function isWebAuthnLargeBlobAvailable(): Promise<boolean> {
  if (globalThis.PublicKeyCredential === undefined) return false;
  try {
    // Check platform authenticator availability
    const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    if (!available) return false;
    // No standard way to check largeBlob support without creating a credential.
    // We rely on the 'required' support flag during create() to fail fast.
    return true;
  } catch {
    return false;
  }
}

/**
 * Create the best available credential store.
 *
 * Prefers WebAuthn (survives ITP) when available, falls back to
 * localStorage. Returns a `FallbackCredentialStore` that tries
 * WebAuthn first and uses localStorage as backup on every operation.
 */
export function createCredentialStore(dbName: string, displayName?: string): CredentialStore {
  return new FallbackCredentialStore(dbName, displayName);
}

/**
 * Tries WebAuthn on save/load; falls back to localStorage on failure.
 *
 * Save: always writes localStorage (silent). WebAuthn only written via
 * explicit `secureWithBiometrics()` call — never automatically on first
 * key generation. This avoids a confusing biometric prompt on first open.
 *
 * Load: tries localStorage first (fast). If empty (ITP wipe?), tries
 * WebAuthn recovery (biometric prompt — user understands why at this point).
 */
class FallbackCredentialStore implements CredentialStore {
  private readonly ls: LocalStorageCredentialStore;
  private webauthn: WebAuthnCredentialStore | null = null;
  private webauthnChecked = false;

  constructor(
    private readonly dbName: string,
    private readonly displayName?: string,
  ) {
    this.ls = new LocalStorageCredentialStore(dbName);
  }

  private async getWebAuthn(): Promise<WebAuthnCredentialStore | null> {
    if (this.webauthnChecked) return this.webauthn;
    this.webauthnChecked = true;
    if (await isWebAuthnLargeBlobAvailable()) {
      this.webauthn = new WebAuthnCredentialStore(this.dbName, undefined, this.displayName);
    }
    return this.webauthn;
  }

  async save(creds: StoredCredentials): Promise<void> {
    // Save to localStorage only (silent, no prompt).
    // WebAuthn enrollment happens via secureWithBiometrics().
    await this.ls.save(creds);
  }

  /**
   * Persist current credentials to the OS keychain via biometrics.
   * Call this when the user takes an intentional action — after pairing,
   * after a "Secure my keys" button press, etc. Not on first open.
   *
   * Returns true if saved, false if WebAuthn unavailable or user cancelled.
   */
  async secureWithBiometrics(): Promise<boolean> {
    const creds = await this.ls.load();
    if (!creds) return false;

    const wa = await this.getWebAuthn();
    if (!wa) return false;

    try {
      await wa.save(creds);
      return true;
    } catch {
      return false;
    }
  }

  async load(): Promise<StoredCredentials | null> {
    // Silent primary path only. No biometric prompt here.
    return this.ls.load();
  }

  async restoreWithBiometrics(): Promise<StoredCredentials | null> {
    const wa = await this.getWebAuthn();
    if (!wa) return null;

    try {
      const restored = await wa.load();
      if (restored) {
        // Re-populate localStorage for normal silent opens after restore.
        await this.ls.save(restored);
        return restored;
      }
    } catch {
      // unavailable / cancelled / not found
    }
    return null;
  }

  async clear(): Promise<void> {
    await this.ls.clear();
    const wa = await this.getWebAuthn();
    if (wa) {
      try { await wa.clear(); } catch { /* best-effort */ }
    }
  }
}
