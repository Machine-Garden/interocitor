// compass: interocitor.trust.credential-custody

/**
 * Low-level WebAuthn `largeBlob` custody helpers for arbitrary application
 * secrets.
 *
 * These APIs do not expose the authenticator's own private key. They let the
 * app ask the browser/platform to protect an opaque blob behind a WebAuthn
 * ceremony, then read that blob back later after user verification.
 */

type BrowserStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type PublicKeyCredentialCreationOptionsWithHints = PublicKeyCredentialCreationOptions & {
  hints?: string[];
};
type PublicKeyCredentialRequestOptionsWithHints = PublicKeyCredentialRequestOptions & {
  hints?: string[];
};

export type WebAuthnAttachmentPreference = "auto" | "platform" | "cross-platform";

/**
 * Configuration for {@link WebAuthnBlobStore}.
 *
 * `authenticatorAttachment` is a preference, not a guarantee. Browsers own the
 * final ceremony UX and authenticator selection.
 */
export interface WebAuthnBlobStoreOptions {
  /** WebAuthn relying-party id. Defaults to the current hostname. */
  rpId?: string;
  /** Human-readable app name shown in passkey / biometric prompts. */
  displayName?: string;
  /**
   * Which authenticator class the app is asking the browser to prefer.
   *
   * - `platform`: same-device authenticator such as Touch ID / Face ID /
   *   Windows Hello
   * - `cross-platform`: roaming or hybrid authenticator such as a security key
   *   or phone-mediated flow
   * - `auto`: let the browser choose
   */
  authenticatorAttachment?: WebAuthnAttachmentPreference;
  /** User verification requirement for read/write ceremonies. Default: `required`. */
  userVerification?: UserVerificationRequirement;
  /** Browser UI hints such as `hybrid` for phone-mediated passkey flows. */
  hints?: string[];
  /** Credential descriptor transport hints used during read/write ceremonies. */
  transports?: AuthenticatorTransport[];
}

export interface WebAuthnCredentialRef {
  /** Base64 credential id used as a browser-side lookup hint. */
  id: string;
  /** App-provided label such as "Anton phone". */
  label?: string;
  /** Requested attachment class at enrollment time. */
  authenticatorAttachment: WebAuthnAttachmentPreference;
  createdAt: number;
  lastUsedAt?: number;
}

export interface WebAuthnEnrollOptions extends WebAuthnBlobStoreOptions {
  /** Human label stored in the local authenticator registry. */
  label?: string;
}

export interface WebAuthnLoadOptions {
  authenticatorAttachment?: WebAuthnAttachmentPreference;
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

function resolveAttachmentPreference(
  preference: WebAuthnAttachmentPreference | undefined,
): AuthenticatorAttachment | undefined {
  if (!preference || preference === "auto") return undefined;
  return preference;
}

/**
 * Stores and restores an application-owned blob behind a WebAuthn `largeBlob`
 * ceremony.
 *
 * Create multiple stores with different namespaces when the app needs separate
 * protected blobs, for example one mesh credential record and one signing-key
 * blob.
 *
 * @see {@link ../docs/webauthn-blob-store.md | WebAuthn blob store reference}
 *   — the `largeBlob` support a browser has to have, what each attachment
 *   preference asks of the user, and the failure modes worth handling.
 */
export class WebAuthnBlobStore {
  private static readonly CRED_ID_KEY_PREFIX = "interocitor-cred:";
  private static readonly REGISTRY_KEY_PREFIX = "interocitor-cred-registry:";
  private readonly rpId: string;
  private readonly displayName: string;
  private readonly authenticatorAttachment: WebAuthnAttachmentPreference;
  private readonly userVerification: UserVerificationRequirement;
  private readonly hints?: string[];
  private readonly transports?: AuthenticatorTransport[];

  constructor(
    private readonly namespace: string,
    options: WebAuthnBlobStoreOptions = {},
  ) {
    this.rpId = options.rpId ?? globalThis.location?.hostname ?? "localhost";
    this.displayName = options.displayName ?? "Interocitor";
    this.authenticatorAttachment = options.authenticatorAttachment ?? "platform";
    this.userVerification = options.userVerification ?? "required";
    this.hints = options.hints;
    this.transports = options.transports;
  }

  private credIdKey(): string {
    return `${WebAuthnBlobStore.CRED_ID_KEY_PREFIX}${this.namespace}`;
  }

  private registryKey(): string {
    return `${WebAuthnBlobStore.REGISTRY_KEY_PREFIX}${this.namespace}`;
  }

  private loadRegistry(): WebAuthnCredentialRef[] {
    const storage = getLocalStorage();
    if (!storage) return [];
    try {
      const stored = storage.getItem(this.registryKey());
      if (!stored) return this.loadLegacyCredentialRef();
      const refs = JSON.parse(stored) as Partial<WebAuthnCredentialRef>[];
      if (!Array.isArray(refs)) return this.loadLegacyCredentialRef();
      return refs.flatMap((ref) => {
        if (typeof ref.id !== "string" || !ref.id) return [];
        return [
          {
            id: ref.id,
            ...(typeof ref.label === "string" && ref.label ? { label: ref.label } : {}),
            authenticatorAttachment:
              ref.authenticatorAttachment === "auto" ||
              ref.authenticatorAttachment === "platform" ||
              ref.authenticatorAttachment === "cross-platform"
                ? ref.authenticatorAttachment
                : "auto",
            createdAt: typeof ref.createdAt === "number" ? ref.createdAt : Date.now(),
            ...(typeof ref.lastUsedAt === "number" ? { lastUsedAt: ref.lastUsedAt } : {}),
          },
        ];
      });
    } catch {
      return this.loadLegacyCredentialRef();
    }
  }

  private loadLegacyCredentialRef(): WebAuthnCredentialRef[] {
    const rawId = this.loadCredentialIdHint();
    if (!rawId) return [];
    return [
      {
        id: encodeBase64(new Uint8Array(rawId)),
        authenticatorAttachment: this.authenticatorAttachment,
        createdAt: Date.now(),
      },
    ];
  }

  private saveRegistry(refs: WebAuthnCredentialRef[]): void {
    const storage = getLocalStorage();
    if (!storage) return;
    try {
      storage.setItem(this.registryKey(), JSON.stringify(refs));
    } catch {
      // The registry is a hint for future ceremonies, not secret material.
    }
  }

  private saveCredentialRef(ref: WebAuthnCredentialRef): void {
    const existing = this.loadRegistry().filter((candidate) => candidate.id !== ref.id);
    const refs = [ref, ...existing];
    this.saveRegistry(refs);
    this.saveCredentialIdHint(decodeBase64(ref.id).buffer as ArrayBuffer);
  }

  private updateLastUsed(id: string): void {
    const now = Date.now();
    this.saveRegistry(
      this.loadRegistry().map((ref) => (ref.id === id ? { ...ref, lastUsedAt: now } : ref)),
    );
  }

  /** Return locally remembered authenticator refs for this namespace. */
  listAuthenticators(): WebAuthnCredentialRef[] {
    return this.loadRegistry();
  }

  /** Check whether a matching authenticator ref is locally remembered. */
  hasAuthenticator(options: WebAuthnLoadOptions = {}): boolean {
    return this.filterRefs(options).length > 0;
  }

  private filterRefs(options: WebAuthnLoadOptions = {}): WebAuthnCredentialRef[] {
    const refs = this.loadRegistry();
    const attachment = options.authenticatorAttachment;
    if (!attachment || attachment === "auto") return refs;
    return refs.filter((ref) => ref.authenticatorAttachment === attachment);
  }

  private loadCredentialIdHint(): ArrayBuffer | null {
    const storage = getLocalStorage();
    if (!storage) return null;
    try {
      const stored = storage.getItem(this.credIdKey());
      if (!stored) return null;
      return decodeBase64(stored).buffer as ArrayBuffer;
    } catch {
      return null;
    }
  }

  private saveCredentialIdHint(rawId: ArrayBuffer): void {
    const storage = getLocalStorage();
    if (!storage) return;
    try {
      storage.setItem(this.credIdKey(), encodeBase64(new Uint8Array(rawId)));
    } catch {
      // Best-effort hint only. The blob itself stays inside the authenticator.
    }
  }

  private selectionCriteria(
    options: WebAuthnBlobStoreOptions = {},
  ): AuthenticatorSelectionCriteria {
    const authenticatorAttachment = resolveAttachmentPreference(
      options.authenticatorAttachment ?? this.authenticatorAttachment,
    );
    return {
      ...(authenticatorAttachment ? { authenticatorAttachment } : {}),
      residentKey: "required",
      userVerification: options.userVerification ?? this.userVerification,
    };
  }

  private credentialDescriptor(
    id: ArrayBuffer,
    options: WebAuthnBlobStoreOptions = {},
  ): PublicKeyCredentialDescriptor {
    return {
      type: "public-key",
      id,
      ...((options.transports ?? this.transports)
        ? { transports: options.transports ?? this.transports }
        : {}),
    };
  }

  async save(blob: Uint8Array): Promise<void> {
    const [ref] = this.filterRefs({ authenticatorAttachment: this.authenticatorAttachment });
    if (ref) {
      await this.write(decodeBase64(ref.id).buffer as ArrayBuffer, blob, this.userVerification);
      this.updateLastUsed(ref.id);
      return;
    }
    await this.enrollAuthenticator(blob);
  }

  /** Enroll a new authenticator and write this namespace's blob into it. */
  async enrollAuthenticator(
    blob: Uint8Array,
    options: WebAuthnEnrollOptions = {},
  ): Promise<WebAuthnCredentialRef> {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const userId = crypto.getRandomValues(new Uint8Array(16));
    const rpId = options.rpId ?? this.rpId;
    const displayName = options.displayName ?? this.displayName;
    const authenticatorAttachment = options.authenticatorAttachment ?? this.authenticatorAttachment;

    const publicKey: PublicKeyCredentialCreationOptionsWithHints = {
      rp: { name: displayName, id: rpId },
      user: {
        id: userId,
        name: `${displayName.toLowerCase().replaceAll(/\s+/g, "-")}:${this.namespace}`,
        displayName,
      },
      challenge,
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: this.selectionCriteria(options),
      hints: options.hints ?? this.hints,
      extensions: {
        largeBlob: { support: "required" },
      } as AuthenticationExtensionsClientInputs,
    };

    const credential = (await navigator.credentials.create({
      publicKey,
    })) as PublicKeyCredential | null;

    if (!credential) throw new Error("WebAuthn credential creation cancelled");
    const ref: WebAuthnCredentialRef = {
      id: encodeBase64(new Uint8Array(credential.rawId)),
      ...(options.label ? { label: options.label } : {}),
      authenticatorAttachment,
      createdAt: Date.now(),
    };
    this.saveCredentialRef(ref);
    await this.write(
      credential.rawId,
      blob,
      options.userVerification ?? this.userVerification,
      rpId,
    );
    return ref;
  }

  private async write(
    credentialId: ArrayBuffer,
    blob: Uint8Array,
    userVerification: UserVerificationRequirement,
    rpId: string = this.rpId,
  ): Promise<void> {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const assertion = (await navigator.credentials.get({
      publicKey: {
        challenge,
        rpId,
        allowCredentials: [
          this.credentialDescriptor(credentialId, { transports: this.transports }),
        ],
        userVerification,
        extensions: {
          largeBlob: { write: blob },
        } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;

    if (!assertion) throw new Error("WebAuthn assertion cancelled");
    const results = (
      assertion as {
        getClientExtensionResults?: () => { largeBlob?: { written?: boolean } };
      }
    ).getClientExtensionResults?.();
    if (!results?.largeBlob?.written) {
      throw new Error("largeBlob write failed - authenticator may not support it");
    }
  }

  async load(options: WebAuthnLoadOptions = {}): Promise<Uint8Array<ArrayBuffer> | null> {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const refs = this.filterRefs(options);
    const publicKey: PublicKeyCredentialRequestOptionsWithHints = {
      challenge,
      rpId: this.rpId,
      ...(refs.length > 0
        ? {
            allowCredentials: refs.map((ref) =>
              this.credentialDescriptor(decodeBase64(ref.id).buffer as ArrayBuffer),
            ),
          }
        : {}),
      hints: this.hints,
      userVerification: this.userVerification,
      extensions: {
        largeBlob: { read: true },
      } as AuthenticationExtensionsClientInputs,
    };

    const assertion = (await navigator.credentials.get({
      publicKey,
    })) as PublicKeyCredential | null;

    if (!assertion) return null;
    const results = (
      assertion as {
        getClientExtensionResults?: () => { largeBlob?: { blob?: ArrayBuffer } };
      }
    ).getClientExtensionResults?.();
    const blob = results?.largeBlob?.blob;
    if (!blob) return null;
    this.saveCredentialIdHint(assertion.rawId);
    const refId = encodeBase64(new Uint8Array(assertion.rawId));
    if (this.loadRegistry().some((ref) => ref.id === refId)) {
      this.updateLastUsed(refId);
    }
    return new Uint8Array(blob);
  }

  async clear(): Promise<void> {
    const storage = getLocalStorage();
    if (!storage) return;
    try {
      storage.removeItem(this.credIdKey());
      storage.removeItem(this.registryKey());
    } catch {
      // Ignore hint cleanup failures.
    }
  }
}
