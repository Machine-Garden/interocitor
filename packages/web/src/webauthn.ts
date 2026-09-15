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
 * The three states a credential read can end in.
 *
 * - `absent`: the custody mechanism worked and holds nothing for this
 *   namespace. Minting fresh credentials is safe.
 * - `unavailable`: the custody mechanism could not be consulted — ceremony
 *   declined, cancelled, timed out, no authenticator, no browser support. A
 *   record may well exist. Minting fresh credentials here forks the mesh.
 * - `unreadable`: something was found but this build cannot turn it into
 *   credentials — wrong namespace, wrong key, corrupt bytes, unknown format.
 *   Minting fresh credentials here destroys access to the existing record.
 *
 * `absent` is reported as a `null` return. `unavailable` and `unreadable` are
 * reported as thrown {@link CredentialAccessError}s, so a caller that does not
 * know about this taxonomy fails loudly instead of silently treating a
 * declined biometric as "nothing stored".
 */
export type CredentialAvailability = "absent" | "unavailable" | "unreadable";

/** Structured context carried by a {@link CredentialAccessError}. */
export interface CredentialAccessErrorInit {
  /** Custody namespace the read was for, when known. */
  namespace?: string;
  cause?: unknown;
}

/**
 * Base class for the two non-`absent` credential-read outcomes.
 *
 * Follows the `core/src/core/errors.ts` convention: prefer `instanceof` (or
 * the stable `code` field) over message matching.
 */
export class CredentialAccessError extends Error {
  readonly availability: Exclude<CredentialAvailability, "absent">;
  readonly namespace?: string;

  constructor(
    availability: Exclude<CredentialAvailability, "absent">,
    message: string,
    init?: CredentialAccessErrorInit,
  ) {
    super(message, init?.cause === undefined ? undefined : { cause: init.cause });
    this.name = "CredentialAccessError";
    this.availability = availability;
    if (init?.namespace !== undefined) this.namespace = init.namespace;
  }
}

/**
 * The custody mechanism could not be consulted: ceremony declined, cancelled,
 * timed out, unsupported, or no authenticator present.
 *
 * The record may still exist. Callers MUST NOT treat this as "nothing stored"
 * and mint replacement credentials - that forks the mesh.
 */
export class CredentialUnavailableError extends CredentialAccessError {
  readonly code = "CREDENTIAL_UNAVAILABLE" as const;

  constructor(message: string, init?: CredentialAccessErrorInit) {
    super("unavailable", message, init);
    this.name = "CredentialUnavailableError";
  }
}

/**
 * Stored bytes were found but cannot be interpreted as this namespace's
 * record - a namespace mismatch, an unknown header version, a failed AEAD
 * check, or corrupt data.
 *
 * Minting replacement credentials here destroys access to the record that is
 * still sitting there.
 */
export class CredentialUnreadableError extends CredentialAccessError {
  readonly code = "CREDENTIAL_UNREADABLE" as const;

  constructor(message: string, init?: CredentialAccessErrorInit) {
    super("unreadable", message, init);
    this.name = "CredentialUnreadableError";
  }
}

/**
 * Narrow an unknown rejection to {@link CredentialAccessError}.
 *
 * Also matches a structurally identical error from another copy of this
 * module, so a consumer in another package does not depend on sharing one
 * class identity.
 */
export function isCredentialAccessError(err: unknown): err is CredentialAccessError {
  if (err instanceof CredentialAccessError) return true;
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === "CREDENTIAL_UNAVAILABLE" || code === "CREDENTIAL_UNREADABLE";
}

/**
 * Classify a thrown credential error.
 *
 * Returns `"unavailable"` / `"unreadable"` for a {@link CredentialAccessError}
 * and `null` for anything else. A `null` *return value* from a store's
 * `load()` is the `absent` case.
 */
export function credentialAvailabilityOf(error: unknown): CredentialAvailability | null {
  if (!isCredentialAccessError(error)) return null;
  const availability = (error as CredentialAccessError).availability;
  if (availability === "unavailable" || availability === "unreadable") return availability;
  return (error as { code?: unknown }).code === "CREDENTIAL_UNREADABLE"
    ? "unreadable"
    : "unavailable";
}

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
  /**
   * Rewrite a blob stored in the pre-namespace-header format with the current
   * header after a successful read. Default: `true`.
   *
   * The upgrade costs one extra write ceremony, once per credential, and is
   * best effort: a failed upgrade never fails the read. Set `false` when the
   * app would rather keep old blobs untagged than prompt again.
   */
  upgradeLegacyBlobs?: boolean;
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

/** How a blob that came back from an authenticator was framed. */
export type WebAuthnBlobFormat = "tagged" | "legacy";

export interface WebAuthnTaggedBlob {
  /** The application payload, with any namespace header stripped. */
  payload: Uint8Array<ArrayBuffer>;
  /**
   * `tagged` when the blob carried a verified namespace header, `legacy` when
   * it was written before headers existed. A `legacy` blob is upgraded to
   * `tagged` on the next write.
   */
  format: WebAuthnBlobFormat;
  /** Verified namespace for a `tagged` blob, `null` for a `legacy` one. */
  namespace: string | null;
  /** Base64 credential id of the authenticator that answered. */
  credentialId: string;
}

/** Options for {@link WebAuthnBlobStore.clear}. */
export interface WebAuthnClearOptions {
  /**
   * Run a write ceremony per known credential that replaces the stored blob
   * with an empty tagged blob. Default: `true`. Set `false` to skip the
   * ceremonies (and the user verification they require) and only drop the
   * local hints — which leaves the secret readable in the authenticator.
   */
  overwriteBlobs?: boolean;
}

/**
 * What survived a {@link WebAuthnBlobStore.clear}.
 *
 * - `credential-only`: every known credential's blob was overwritten. The
 *   WebAuthn credential itself survives in the OS keychain as an empty shell;
 *   script has no API to delete it.
 * - `blob-may-survive`: at least one known credential could not be
 *   overwritten, so readable secret bytes may remain in it.
 * - `unknown`: no local credential reference existed, so this store could not
 *   prove anything was destroyed. A credential enrolled before the browser's
 *   local hints were cleared may still hold a readable blob.
 */
export type WebAuthnResidualRisk = "credential-only" | "blob-may-survive" | "unknown";

export interface WebAuthnClearResult {
  /** Base64 credential ids whose blob was overwritten with an empty payload. */
  overwritten: string[];
  /** Base64 credential ids whose overwrite ceremony failed or was skipped. */
  notOverwritten: string[];
  /** Credential references this store knew about when `clear()` started. */
  knownCredentials: number;
  /** Whether the localStorage hint and registry entries were removed. */
  hintsCleared: boolean;
  residualRisk: WebAuthnResidualRisk;
  /** Human-readable summary, safe to show a user. */
  message: string;
}

/**
 * Thrown by `WebAuthnCredentialStore.clear()` when readable secret bytes may
 * still live inside a known authenticator.
 */
export class ResidualWebAuthnCredentialError extends Error {
  readonly code = "WEBAUTHN_RESIDUAL_CREDENTIAL" as const;

  constructor(readonly result: WebAuthnClearResult) {
    super(result.message);
    this.name = "ResidualWebAuthnCredentialError";
  }
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

/** `IOCB` — "interocitor blob". Prefix of every namespace-tagged blob. */
const BLOB_MAGIC = Uint8Array.of(0x49, 0x4f, 0x43, 0x42);
/** Header layout version. Bumped when the framing below changes. */
const BLOB_HEADER_VERSION = 1;
/** magic(4) + version(1) + namespace length(2). */
const BLOB_HEADER_PREFIX_LENGTH = BLOB_MAGIC.length + 3;

const blobTextEncoder = new TextEncoder();
const blobTextDecoder = new TextDecoder();

/**
 * Frame a payload with a versioned namespace header so a blob read back from
 * an authenticator can be proven to belong to the namespace that asked for it.
 *
 * Layout: `"IOCB" | version:u8 | namespaceLength:u16be | namespace | payload`.
 */
function tagBlob(namespace: string, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const namespaceBytes = blobTextEncoder.encode(namespace);
  if (namespaceBytes.length > 0xff_ff) {
    throw new Error("WebAuthn blob namespace is too long to tag");
  }
  const tagged = new Uint8Array(BLOB_HEADER_PREFIX_LENGTH + namespaceBytes.length + payload.length);
  tagged.set(BLOB_MAGIC, 0);
  tagged[BLOB_MAGIC.length] = BLOB_HEADER_VERSION;
  tagged[BLOB_MAGIC.length + 1] = (namespaceBytes.length >>> 8) & 0xff;
  tagged[BLOB_MAGIC.length + 2] = namespaceBytes.length & 0xff;
  tagged.set(namespaceBytes, BLOB_HEADER_PREFIX_LENGTH);
  tagged.set(payload, BLOB_HEADER_PREFIX_LENGTH + namespaceBytes.length);
  return tagged;
}

function hasBlobMagic(blob: Uint8Array): boolean {
  if (blob.length < BLOB_HEADER_PREFIX_LENGTH) return false;
  return BLOB_MAGIC.every((byte, index) => blob[index] === byte);
}

/**
 * Split a namespace header off a blob.
 *
 * Returns `null` for a blob written before headers existed (no magic), so old
 * deployments keep loading. Throws {@link CredentialUnreadableError} when the
 * header is present but this build cannot parse it.
 */
function parseTaggedBlob(
  blob: Uint8Array,
): { namespace: string; payload: Uint8Array<ArrayBuffer> } | null {
  if (!hasBlobMagic(blob)) return null;
  const version = blob[BLOB_MAGIC.length];
  if (version !== BLOB_HEADER_VERSION) {
    throw new CredentialUnreadableError(
      `WebAuthn blob header version ${version} is newer than this build understands (${BLOB_HEADER_VERSION})`,
    );
  }
  const namespaceLength = (blob[BLOB_MAGIC.length + 1] << 8) | blob[BLOB_MAGIC.length + 2];
  const payloadStart = BLOB_HEADER_PREFIX_LENGTH + namespaceLength;
  if (blob.length < payloadStart) {
    throw new CredentialUnreadableError("WebAuthn blob header is truncated");
  }
  return {
    namespace: blobTextDecoder.decode(blob.subarray(BLOB_HEADER_PREFIX_LENGTH, payloadStart)),
    payload: new Uint8Array(blob.subarray(payloadStart)),
  };
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
  private readonly upgradeLegacyBlobs: boolean;

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
    this.upgradeLegacyBlobs = options.upgradeLegacyBlobs ?? true;
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

  /**
   * Write this namespace's payload, enrolling an authenticator when none is
   * remembered. The payload is always framed with the current namespace
   * header, so a blob written in the previous untagged format is upgraded in
   * place by the next `save()`.
   */
  async save(blob: Uint8Array): Promise<void> {
    const [ref] = this.filterRefs({ authenticatorAttachment: this.authenticatorAttachment });
    if (ref) {
      await this.write(
        decodeBase64(ref.id).buffer as ArrayBuffer,
        tagBlob(this.namespace, blob),
        this.userVerification,
      );
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

    let credential: PublicKeyCredential | null;
    try {
      credential = (await navigator.credentials.create({
        publicKey,
      })) as PublicKeyCredential | null;
    } catch (error) {
      throw new CredentialUnavailableError(
        `WebAuthn enrollment for "${this.namespace}" did not complete`,
        { namespace: this.namespace, cause: error },
      );
    }

    if (!credential) {
      throw new CredentialUnavailableError(
        `WebAuthn enrollment for "${this.namespace}" was cancelled`,
        { namespace: this.namespace },
      );
    }
    const ref: WebAuthnCredentialRef = {
      id: encodeBase64(new Uint8Array(credential.rawId)),
      ...(options.label ? { label: options.label } : {}),
      authenticatorAttachment,
      createdAt: Date.now(),
    };
    this.saveCredentialRef(ref);
    await this.write(
      credential.rawId,
      tagBlob(this.namespace, blob),
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
    let assertion: PublicKeyCredential | null;
    try {
      assertion = (await navigator.credentials.get({
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
    } catch (error) {
      throw new CredentialUnavailableError(
        `WebAuthn write ceremony for "${this.namespace}" did not complete`,
        { namespace: this.namespace, cause: error },
      );
    }

    if (!assertion) {
      throw new CredentialUnavailableError(
        `WebAuthn write ceremony for "${this.namespace}" was cancelled`,
        { namespace: this.namespace },
      );
    }
    const results = (
      assertion as {
        getClientExtensionResults?: () => { largeBlob?: { written?: boolean } };
      }
    ).getClientExtensionResults?.();
    if (!results?.largeBlob?.written) {
      throw new CredentialUnavailableError(
        "largeBlob write failed - authenticator may not support it",
      );
    }
  }

  /**
   * Read this namespace's payload.
   *
   * Returns `null` only for the `absent` case: the ceremony succeeded and the
   * credential holds no blob for this namespace (including one this store
   * cleared). A declined, cancelled, or unsupported ceremony throws
   * {@link CredentialUnavailableError}; a blob belonging to another namespace
   * or framed in an unparseable header throws
   * {@link CredentialUnreadableError}.
   */
  async load(options: WebAuthnLoadOptions = {}): Promise<Uint8Array<ArrayBuffer> | null> {
    const tagged = await this.loadTagged(options);
    return tagged ? tagged.payload : null;
  }

  /**
   * Like {@link load}, but also reports whether the stored blob carried a
   * namespace header. `format: "legacy"` means the blob predates namespace
   * tagging and will be upgraded by the next `save()`.
   */
  async loadTagged(options: WebAuthnLoadOptions = {}): Promise<WebAuthnTaggedBlob | null> {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    // Never drop `allowCredentials` while any reference is known: without it
    // the browser may satisfy this read with any discoverable credential for
    // the relying party, including one enrolled for another namespace.
    const known = this.filterRefs(options);
    const refs = known.length > 0 ? known : this.loadRegistry();
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

    let assertion: PublicKeyCredential | null;
    try {
      assertion = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
    } catch (error) {
      throw new CredentialUnavailableError(
        `WebAuthn read ceremony for "${this.namespace}" did not complete`,
        { namespace: this.namespace, cause: error },
      );
    }

    if (!assertion) {
      throw new CredentialUnavailableError(
        `WebAuthn read ceremony for "${this.namespace}" returned no credential`,
        { namespace: this.namespace },
      );
    }
    const results = (
      assertion as {
        getClientExtensionResults?: () => { largeBlob?: { blob?: ArrayBuffer } };
      }
    ).getClientExtensionResults?.();
    const blob = results?.largeBlob?.blob;
    const credentialId = encodeBase64(new Uint8Array(assertion.rawId));
    if (!blob) return null;

    const bytes = new Uint8Array(blob);
    const parsed = parseTaggedBlob(bytes);
    if (parsed && parsed.namespace !== this.namespace) {
      throw new CredentialUnreadableError(
        `WebAuthn largeBlob belongs to namespace "${parsed.namespace}", not "${this.namespace}"`,
        { namespace: this.namespace },
      );
    }
    // An empty tagged payload is the tombstone `clear()` writes.
    if (parsed && parsed.payload.length === 0) return null;

    this.saveCredentialIdHint(assertion.rawId);
    if (this.loadRegistry().some((ref) => ref.id === credentialId)) {
      this.updateLastUsed(credentialId);
    }
    if (parsed) {
      return {
        payload: parsed.payload,
        format: "tagged",
        namespace: parsed.namespace,
        credentialId,
      };
    }
    // Upgrade in place: an untagged blob is exactly the shape a swapped
    // credential can impersonate, so re-frame it while the credential is at
    // hand. Best effort — the payload was already read successfully.
    if (this.upgradeLegacyBlobs) {
      try {
        await this.write(assertion.rawId, tagBlob(this.namespace, bytes), this.userVerification);
      } catch {
        // Keep the legacy blob; the next successful write upgrades it.
      }
    }
    return { payload: bytes, format: "legacy", namespace: null, credentialId };
  }

  private clearHints(): boolean {
    const storage = getLocalStorage();
    if (!storage) return false;
    try {
      storage.removeItem(this.credIdKey());
      storage.removeItem(this.registryKey());
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Destroy as much of this namespace's custody as the platform allows.
   *
   * WebAuthn gives script no way to delete a credential or its `largeBlob`.
   * The best achievable erase is a write ceremony per known credential that
   * replaces the stored blob with an empty tagged blob, after which `load()`
   * reports `absent`. The credential itself survives in the OS keychain as an
   * empty shell and can only be removed by the user in operating-system or
   * browser passkey settings.
   *
   * Overwriting requires user verification, so this may prompt once per known
   * credential. Failures are recorded in the result rather than thrown; see
   * {@link WebAuthnClearResult.residualRisk}.
   */
  async clear(options: WebAuthnClearOptions = {}): Promise<WebAuthnClearResult> {
    const refs = this.loadRegistry();
    const overwritten: string[] = [];
    const notOverwritten: string[] = [];

    if (options.overwriteBlobs ?? true) {
      const tombstone = tagBlob(this.namespace, new Uint8Array(0));
      for (const ref of refs) {
        try {
          // Ceremonies are serialized: browsers allow one at a time.
          // eslint-disable-next-line no-await-in-loop -- WebAuthn ceremonies cannot overlap.
          await this.write(
            decodeBase64(ref.id).buffer as ArrayBuffer,
            tombstone,
            this.userVerification,
          );
          overwritten.push(ref.id);
        } catch {
          notOverwritten.push(ref.id);
        }
      }
    } else {
      notOverwritten.push(...refs.map((ref) => ref.id));
    }

    const hintsCleared = this.clearHints();
    const residualRisk: WebAuthnResidualRisk =
      refs.length === 0
        ? "unknown"
        : notOverwritten.length > 0
          ? "blob-may-survive"
          : "credential-only";

    return {
      overwritten,
      notOverwritten,
      knownCredentials: refs.length,
      hintsCleared,
      residualRisk,
      message: clearMessage(this.namespace, residualRisk, notOverwritten.length),
    };
  }
}

function clearMessage(
  namespace: string,
  residualRisk: WebAuthnResidualRisk,
  notOverwritten: number,
): string {
  switch (residualRisk) {
    case "credential-only": {
      return `The stored blob for "${namespace}" was overwritten. The WebAuthn credential itself cannot be deleted by this site and still exists as an empty passkey; remove it in your operating system or browser passkey settings.`;
    }
    case "blob-may-survive": {
      return `${notOverwritten} credential(s) for "${namespace}" could not be overwritten, so readable secret bytes may still be stored in them. Remove the passkey in your operating system or browser passkey settings.`;
    }
    case "unknown": {
      return `No local credential reference for "${namespace}" existed, so nothing could be overwritten. If a passkey was enrolled before this browser's local storage was cleared, it may still hold a readable blob; remove it in your operating system or browser passkey settings.`;
    }
  }
}
