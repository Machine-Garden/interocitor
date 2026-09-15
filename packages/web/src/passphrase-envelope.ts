// compass: interocitor.trust.credential-custody

/**
 * Passphrase-derived envelope keys.
 *
 * {@link PassphraseEnvelopeKeyProvider} implements the
 * `CredentialEnvelopeKeyProvider` contract by deriving an AES-GCM
 * key-encryption key from a user-supplied passphrase, so the mesh credential
 * record can sit in localStorage as ciphertext that a copied browser profile
 * cannot open without the phrase.
 *
 * The derivation follows `@interocitor/core`'s recovery-wrapper style — one
 * public parameter record, AAD binding, strict validation — with three
 * deliberate differences, each explained at its constant below: a random
 * per-install salt, a stored (rather than pinned) iteration count, and a
 * single PBKDF2 stage.
 *
 * @see {@link ../docs/passphrase-envelope.md | Passphrase envelope keys}
 *   — threat model, cache policy, and the deployments this must not be used in.
 */

import type {
  CredentialEnvelopeKeyProvider,
  CredentialEnvelopeKeyPurpose,
} from "./credential-store.ts";
import { CredentialAccessError, type CredentialAvailability } from "./webauthn.ts";

const encoder = new TextEncoder();

/**
 * Work factor for new records.
 *
 * Measured with WebCrypto PBKDF2-HMAC-SHA-256 in headless Chromium 147 on an
 * Apple-silicon Mac: 100k ≈ 6 ms, 310k ≈ 18 ms, 600k ≈ 35 ms, 1M ≈ 58 ms
 * (median of three, warmed). CDP CPU throttling up to 20x did not move those
 * numbers, because Chromium runs WebCrypto off the main thread — so this is
 * unlock *latency*, not main-thread jank, and it is paid once per unlock, not
 * once per `load()`, because the derived key is cached.
 *
 * Scaling the measured cost by the 8-15x that a low-end Android device
 * typically gives against this class of machine puts 600k at roughly
 * 0.3-0.5 s, which is inside the budget for a one-time unlock and well under
 * the 1-2 s a user would notice as a stall. The attacker here is doing offline
 * guessing against a copied profile — exactly the situation OWASP's 600k
 * PBKDF2-SHA-256 figure is written for — so there is no reason to spend less
 * than the recovery wrapper does when the user-visible cost is a third of a
 * second on a bad phone.
 */
export const DEFAULT_PASSPHRASE_KDF_ITERATIONS = 600_000;

/**
 * Lowest work factor this build will accept in an existing record.
 *
 * Unlike the recovery wrapper, which pins `iterations` by equality and so can
 * never raise its work factor without a format bump, a record stores the count
 * it was written with and is accepted whenever that count is at or above this
 * floor. Raising {@link DEFAULT_PASSPHRASE_KDF_ITERATIONS} therefore applies to
 * new records without orphaning old ones; raising this floor is the deliberate,
 * separately reviewable act of refusing old ones.
 *
 * 210k is OWASP's PBKDF2-HMAC-SHA-256 floor.
 */
export const MINIMUM_PASSPHRASE_KDF_ITERATIONS = 210_000;

/** Upper bound, so a tampered record cannot turn an unlock into a denial of service. */
export const MAXIMUM_PASSPHRASE_KDF_ITERATIONS = 10_000_000;

/**
 * How long the derived key survives without being used. Measured from the last
 * `getKey`, not from unlock, so an active session is never interrupted and an
 * abandoned tab does not keep an unwrapping key warm all afternoon.
 */
export const DEFAULT_PASSPHRASE_IDLE_TIMEOUT_MS: number = 5 * 60_000;

const RECORD_VERSION = 1;
const KDF_NAME = "PBKDF2-HMAC-SHA-256";
/**
 * Domain separator prefixed to the random salt. The namespace is deliberately
 * *not* mixed in here: it is bound through AAD instead (see {@link recordAad}),
 * which keeps the KDF parameters namespace-independent and makes relabeling a
 * record an authentication failure rather than a silent derivation miss.
 */
const SALT_PREFIX = encoder.encode("interocitor.passphrase.kek.v1|");
const SALT_BYTES = 16;
const VERIFIER_PLAINTEXT = encoder.encode("interocitor.passphrase.envelope.verifier.v1");

// ─── Errors ───────────────────────────────────────────────────────────
//
// Every failure below is thrown, never converted into a null/absent
// credential. A credential record that exists but cannot be opened must not
// look like "no credentials", because a caller that reads absence as "first
// run" will mint a fresh mesh key and fork the mesh.

/**
 * Base class for every passphrase-envelope failure.
 *
 * This extends {@link CredentialAccessError} rather than `Error` so that
 * `EnvelopedCredentialStore` re-throws these unchanged instead of flattening
 * them into a generic `CredentialUnavailableError`. The distinction between
 * "wrong passphrase" and "the record is gone" is the whole point of this
 * taxonomy, and it has to survive the trip through the envelope store.
 *
 * Every subclass therefore also declares an `availability`: `"unavailable"`
 * when the key could not be derived at all, `"unreadable"` when a record was
 * found but does not open. Neither is `"absent"` — a caller that reads any of
 * these as "nothing stored" will mint a fresh mesh key and fork the mesh.
 */
export class PassphraseEnvelopeError extends CredentialAccessError {
  constructor(
    availability: Exclude<CredentialAvailability, "absent">,
    message: string,
    options?: ErrorOptions,
  ) {
    super(availability, message, { cause: options?.cause });
    this.name = "PassphraseEnvelopeError";
  }
}

/**
 * The supplied passphrase did not authenticate the stored record.
 *
 * Also raised when a record's public parameters were edited — including
 * relabeling one namespace's record as another's — because AAD covers them and
 * the two cases are not distinguishable from outside.
 */
export class WrongPassphraseError extends PassphraseEnvelopeError {
  constructor(options?: ErrorOptions) {
    // A record was found and its AEAD check failed: unreadable, not missing.
    super("unreadable", "Passphrase does not match this credential envelope", options);
    this.name = "WrongPassphraseError";
  }
}

/** No passphrase is cached and none could be requested. */
export class PassphraseLockedError extends PassphraseEnvelopeError {
  constructor(message = "Credential envelope is locked; unlock it with a passphrase") {
    // The custody mechanism could not be consulted; the record is untouched.
    super("unavailable", message);
    this.name = "PassphraseLockedError";
  }
}

/**
 * A decrypt was asked for but the key record is gone.
 *
 * This is a distinct, loud failure rather than an empty result: the ciphertext
 * may still be there, and treating it as "no credentials" would fork the mesh.
 */
export class MissingPassphraseKeyRecordError extends PassphraseEnvelopeError {
  constructor(namespace: string) {
    // No key can be derived, so the envelope cannot be consulted at all.
    super("unavailable", `No passphrase key record is stored for "${namespace}"`);
    this.name = "MissingPassphraseKeyRecordError";
  }
}

/** A stored record is malformed, unsupported, or below the accepted work factor. */
export class InvalidPassphraseKeyRecordError extends PassphraseEnvelopeError {
  constructor(reason: string, options?: ErrorOptions) {
    super("unreadable", `Invalid passphrase key record: ${reason}`, options);
    this.name = "InvalidPassphraseKeyRecordError";
  }
}

/** The stored record belongs to a different credential namespace. */
export class PassphraseNamespaceMismatchError extends PassphraseEnvelopeError {
  constructor(expected: string, found: string) {
    super("unreadable", `Passphrase key record is bound to "${found}", not "${expected}"`);
    this.name = "PassphraseNamespaceMismatchError";
  }
}

// ─── Record shape and storage ─────────────────────────────────────────

/**
 * Public, non-secret derivation parameters stored beside the encrypted
 * credential envelope.
 *
 * Nothing here is confidential: the salt, the work factor, and the verifier
 * ciphertext are all safe to hand an attacker, which is why this record can
 * live in the same localStorage as the envelope it describes.
 */
export interface PassphraseKeyRecord {
  /** Record format version. */
  v: 1;
  /** Credential namespace this record unlocks. Also bound through AAD. */
  namespace: string;
  kdf: {
    name: "PBKDF2-HMAC-SHA-256";
    /** Work factor used when this record was written; accepted at or above the minimum. */
    iterations: number;
    /** Random per-install salt, base64url. */
    salt: string;
  };
  /**
   * A fixed plaintext encrypted under the derived key with the record's AAD.
   * Decrypting it proves the passphrase is right *before* any credential
   * ciphertext is touched, which is what makes a wrong passphrase report
   * itself as a wrong passphrase.
   */
  verifier: {
    iv: string;
    ciphertext: string;
  };
  createdAt: string;
}

/** Where the public key record lives. It holds no secrets. */
export interface PassphraseKeyRecordStore {
  save(record: PassphraseKeyRecord): Promise<void>;
  load(): Promise<PassphraseKeyRecord | null>;
  clear(): Promise<void>;
}

export type PassphraseRecordStorageLocation = "localStorage" | "sessionStorage" | "memory";

type BrowserStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function namedStorage(location: PassphraseRecordStorageLocation): BrowserStorage | null {
  if (location === "localStorage") return typeof localStorage === "undefined" ? null : localStorage;
  if (location === "sessionStorage")
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  return null;
}

function recordKey(namespace: string): string {
  return `interocitor-creds-passphrase:${namespace}`;
}

/** Keeps the public key record in localStorage/sessionStorage. */
export class BrowserPassphraseKeyRecordStore implements PassphraseKeyRecordStore {
  constructor(
    private readonly namespace: string,
    private readonly location: Exclude<PassphraseRecordStorageLocation, "memory"> = "localStorage",
  ) {}

  async save(record: PassphraseKeyRecord): Promise<void> {
    namedStorage(this.location)?.setItem(recordKey(this.namespace), JSON.stringify(record));
  }

  async load(): Promise<PassphraseKeyRecord | null> {
    const raw = namedStorage(this.location)?.getItem(recordKey(this.namespace));
    if (!raw) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      // A record that is present but unreadable is corruption, not absence.
      throw new InvalidPassphraseKeyRecordError("stored record is not valid JSON", {
        cause: error,
      });
    }
    assertKeyRecord(parsed);
    return parsed;
  }

  async clear(): Promise<void> {
    namedStorage(this.location)?.removeItem(recordKey(this.namespace));
  }
}

/** Keeps the public key record in JS memory. Mostly useful in tests. */
export class MemoryPassphraseKeyRecordStore implements PassphraseKeyRecordStore {
  private readonly records: Map<string, PassphraseKeyRecord>;

  constructor(
    private readonly namespace: string,
    records?: Map<string, PassphraseKeyRecord>,
  ) {
    this.records = records ?? new Map();
  }

  async save(record: PassphraseKeyRecord): Promise<void> {
    this.records.set(recordKey(this.namespace), structuredClone(record));
  }

  async load(): Promise<PassphraseKeyRecord | null> {
    const record = this.records.get(recordKey(this.namespace));
    return record ? structuredClone(record) : null;
  }

  async clear(): Promise<void> {
    this.records.delete(recordKey(this.namespace));
  }
}

function createRecordStore(
  namespace: string,
  location: PassphraseRecordStorageLocation,
): PassphraseKeyRecordStore {
  return location === "memory"
    ? new MemoryPassphraseKeyRecordStore(namespace)
    : new BrowserPassphraseKeyRecordStore(namespace, location);
}

// ─── Encoding and validation ──────────────────────────────────────────
//
// `@interocitor/core` has base64url helpers, but they are not part of its
// published surface, so these are local rather than a cross-package reach.

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlToBytes(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(padded), (character) => character.codePointAt(0)!);
}

const BASE64URL_RE = /^[\w-]+$/;

function assertKeyRecord(value: unknown): asserts value is PassphraseKeyRecord {
  if (!value || typeof value !== "object")
    throw new InvalidPassphraseKeyRecordError("not an object");
  const record = value as Partial<PassphraseKeyRecord>;
  if (record.v !== RECORD_VERSION) {
    throw new InvalidPassphraseKeyRecordError(`unsupported version ${String(record.v)}`);
  }
  if (typeof record.namespace !== "string" || !record.namespace) {
    throw new InvalidPassphraseKeyRecordError("missing namespace");
  }
  if (record.kdf?.name !== KDF_NAME) {
    throw new InvalidPassphraseKeyRecordError(`unsupported kdf ${String(record.kdf?.name)}`);
  }
  const { iterations, salt } = record.kdf;
  if (!Number.isSafeInteger(iterations) || iterations > MAXIMUM_PASSPHRASE_KDF_ITERATIONS) {
    throw new InvalidPassphraseKeyRecordError(`implausible iteration count ${String(iterations)}`);
  }
  if (typeof salt !== "string" || !BASE64URL_RE.test(salt)) {
    throw new InvalidPassphraseKeyRecordError("malformed salt");
  }
  if (
    typeof record.verifier?.iv !== "string" ||
    !BASE64URL_RE.test(record.verifier.iv) ||
    typeof record.verifier.ciphertext !== "string" ||
    !BASE64URL_RE.test(record.verifier.ciphertext)
  ) {
    throw new InvalidPassphraseKeyRecordError("malformed verifier");
  }
  if (typeof record.createdAt !== "string") {
    throw new InvalidPassphraseKeyRecordError("missing createdAt");
  }
}

/**
 * Authenticated-but-unencrypted context for the verifier.
 *
 * Binding the namespace here is the difference from `EnvelopedCredentialStore`,
 * which passes no AAD at all: a record lifted from one credential namespace and
 * relabeled as another fails to authenticate instead of quietly deriving a key
 * that decrypts somebody else's envelope.
 */
function recordAad(namespace: string, salt: string, iterations: number): Uint8Array {
  return encoder.encode(`interocitor.passphrase.envelope.v1|${namespace}|${salt}|${iterations}`);
}

/** NFKD + whitespace collapse, matching the recovery phrase normalization. */
function normalizePassphrase(passphrase: string): string {
  return passphrase.normalize("NFKD").trim().replaceAll(/\s+/g, " ");
}

async function deriveKek(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const normalized = normalizePassphrase(passphrase);
  if (!normalized) throw new PassphraseEnvelopeError("unavailable", "Passphrase must not be empty");
  const source = await crypto.subtle.importKey(
    "raw",
    encoder.encode(normalized) as unknown as BufferSource,
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const salted = new Uint8Array(SALT_PREFIX.length + salt.length);
  salted.set(SALT_PREFIX, 0);
  salted.set(salt, SALT_PREFIX.length);
  // One PBKDF2 stage straight to the AES key. The recovery wrapper's second
  // HKDF stage exists to fan a phrase-derived root out into a locator plus a
  // KEK; there is no locator here, so a second stage would only add moving
  // parts. `extractable: false`: nothing ever needs to export a KEK.
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salted as unknown as BufferSource, iterations },
    source,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// ─── Provider ─────────────────────────────────────────────────────────

export interface PassphraseEnvelopeKeyProviderOptions {
  /**
   * Asked for a passphrase when {@link PassphraseEnvelopeKeyProvider.getKey}
   * runs while locked. Return `null` to refuse, which surfaces as
   * {@link PassphraseLockedError}. Without this callback a locked provider
   * throws instead of prompting.
   */
  requestPassphrase?: (context: {
    purpose: CredentialEnvelopeKeyPurpose;
    namespace: string;
    /** `true` when no record exists yet and one will be provisioned. */
    provisioning: boolean;
  }) => Promise<string | null> | string | null;
  /** Idle timeout in ms. `0` or `Infinity` disables expiry. Default: 5 minutes. */
  idleTimeoutMs?: number;
  /** Work factor for newly provisioned records. Default: 600 000. */
  iterations?: number;
  /** Lowest work factor accepted in an existing record. Default: 210 000. */
  minimumIterations?: number;
  /** Where the public key record lives. Default: localStorage. */
  storage?: PassphraseRecordStorageLocation;
  /** Custom record store; overrides `storage`. */
  recordStore?: PassphraseKeyRecordStore;
  /**
   * Lock when the page is hidden or unloaded.
   *
   * Off by default. `visibilitychange` fires on every tab switch and every
   * app switch on mobile, so locking on it re-prompts users constantly and
   * breaks a sync that resumes in a backgrounded tab. Turn it on for shared
   * or kiosk machines, where that cost is the point.
   */
  lockOnHide?: boolean;
}

/**
 * Derives the credential-envelope KEK from a user passphrase.
 *
 * ```ts
 * const keyProvider = new PassphraseEnvelopeKeyProvider("case-vault");
 * await keyProvider.unlock(await promptUser());
 * const credentialStore = createWebCredentialStore("case-vault", {
 *   envelope: { storage: "localStorage", keyProvider },
 * });
 * ```
 *
 * The derived key is cached in memory only, for `idleTimeoutMs` after its last
 * use. The passphrase string itself is never cached and never persisted.
 *
 * This protects a credential record against someone who copies the browser
 * profile off disk. It does nothing against hostile first-party JavaScript,
 * and nothing at all while the cache is warm. Use it only with a *local*
 * envelope store unless the passphrase is high-entropy and generated — see the
 * module docs.
 */
export class PassphraseEnvelopeKeyProvider implements CredentialEnvelopeKeyProvider {
  private readonly records: PassphraseKeyRecordStore;
  private readonly idleTimeoutMs: number;
  private readonly iterations: number;
  private readonly minimumIterations: number;
  private readonly requestPassphrase: PassphraseEnvelopeKeyProviderOptions["requestPassphrase"];

  /** Derived key plus the record identity it was derived for. Never the passphrase. */
  private cache: { key: CryptoKey; salt: string; expiresAt: number } | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly hideListener?: () => void;
  private inFlight: Promise<CryptoKey> | null = null;

  constructor(
    private readonly namespace: string,
    options: PassphraseEnvelopeKeyProviderOptions = {},
  ) {
    if (!namespace)
      throw new PassphraseEnvelopeError("unavailable", "Credential namespace must not be empty");
    this.records =
      options.recordStore ?? createRecordStore(namespace, options.storage ?? "localStorage");
    const idle = options.idleTimeoutMs ?? DEFAULT_PASSPHRASE_IDLE_TIMEOUT_MS;
    this.idleTimeoutMs = idle > 0 ? idle : Number.POSITIVE_INFINITY;
    this.iterations = options.iterations ?? DEFAULT_PASSPHRASE_KDF_ITERATIONS;
    this.minimumIterations = options.minimumIterations ?? MINIMUM_PASSPHRASE_KDF_ITERATIONS;
    if (this.iterations < this.minimumIterations) {
      throw new PassphraseEnvelopeError(
        "unavailable",
        "iterations must be at least minimumIterations",
      );
    }
    if (this.iterations > MAXIMUM_PASSPHRASE_KDF_ITERATIONS) {
      throw new PassphraseEnvelopeError("unavailable", "iterations exceeds the supported maximum");
    }
    this.requestPassphrase = options.requestPassphrase;

    if (options.lockOnHide && typeof globalThis.addEventListener === "function") {
      this.hideListener = () => {
        if (typeof document === "undefined" || document.visibilityState === "hidden") {
          void this.lock();
        }
      };
      globalThis.addEventListener("pagehide", this.hideListener);
      globalThis.addEventListener("visibilitychange", this.hideListener);
    }
  }

  /** `true` while a derived key is cached and not yet idle-expired. */
  isUnlocked(): boolean {
    return this.peek() !== null;
  }

  /**
   * Derive and cache the key for this namespace, provisioning a record when
   * none exists yet.
   *
   * Throws {@link WrongPassphraseError} when a record exists and the phrase
   * does not authenticate it. The passphrase argument is used for the
   * derivation and then dropped; see the docs for what "dropped" can and
   * cannot mean for a JS string.
   */
  async unlock(passphrase: string): Promise<void> {
    const record = await this.records.load();
    if (record) this.assertNamespace(record);
    await this.derive(passphrase, "encrypt", record);
  }

  /** Drop the cached key. The stored record and envelope are untouched. */
  async lock(): Promise<void> {
    this.cache = null;
    if (this.expiryTimer !== null) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
  }

  /**
   * `CredentialEnvelopeKeyProvider.clear` — drops the cached key only.
   *
   * It deliberately does not delete the key record: `clear()` is reachable
   * from generic credential-store teardown, and destroying the record would
   * strand any envelope still on disk. Use {@link deleteKeyRecord} to do that
   * on purpose.
   */
  async clear(): Promise<void> {
    await this.lock();
  }

  /**
   * Lock and detach any `lockOnHide` listeners. Call when the owning component
   * goes away.
   */
  async dispose(): Promise<void> {
    await this.lock();
    if (this.hideListener && typeof globalThis.removeEventListener === "function") {
      globalThis.removeEventListener("pagehide", this.hideListener);
      globalThis.removeEventListener("visibilitychange", this.hideListener);
    }
  }

  /**
   * Delete the stored key record and lock.
   *
   * Any credential envelope encrypted under it becomes permanently unopenable,
   * so clear the envelope in the same step.
   */
  async deleteKeyRecord(): Promise<void> {
    await this.lock();
    await this.records.clear();
  }

  /** The stored public parameters, or `null` when this namespace is unprovisioned. */
  async keyRecord(): Promise<PassphraseKeyRecord | null> {
    return this.records.load();
  }

  /**
   * The envelope KEK.
   *
   * `decrypt` never invents a key: with no stored record it throws
   * {@link MissingPassphraseKeyRecordError} rather than reporting absence, so a
   * caller cannot mistake an unopenable credential for a first run and mint a
   * fresh mesh identity.
   */
  async getKey(purpose: CredentialEnvelopeKeyPurpose = "decrypt"): Promise<CryptoKey> {
    // Serialize concurrent callers so two parallel `load()`s do not run two
    // PBKDF2 derivations or two passphrase prompts.
    this.inFlight ??= this.resolveKey(purpose).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async resolveKey(purpose: CredentialEnvelopeKeyPurpose): Promise<CryptoKey> {
    const record = await this.records.load();
    if (record) this.assertNamespace(record);
    if (!record && purpose === "decrypt") {
      throw new MissingPassphraseKeyRecordError(this.namespace);
    }

    const cached = this.peek();
    // A record replaced by another tab invalidates the cached key.
    if (cached && record && cached.salt === record.kdf.salt) {
      this.touch();
      return cached.key;
    }
    await this.lock();

    const passphrase = await this.requestPassphrase?.({
      purpose,
      namespace: this.namespace,
      provisioning: !record,
    });
    if (typeof passphrase !== "string" || !passphrase) {
      throw new PassphraseLockedError(
        record
          ? "Credential envelope is locked; unlock it with a passphrase"
          : "No passphrase was supplied to provision a credential envelope",
      );
    }
    return this.derive(passphrase, purpose, record);
  }

  private assertNamespace(record: PassphraseKeyRecord): void {
    if (record.namespace !== this.namespace) {
      throw new PassphraseNamespaceMismatchError(this.namespace, record.namespace);
    }
    if (record.kdf.iterations < this.minimumIterations) {
      throw new InvalidPassphraseKeyRecordError(
        `work factor ${record.kdf.iterations} is below the accepted minimum ${this.minimumIterations}`,
      );
    }
  }

  private async derive(
    passphrase: string,
    purpose: CredentialEnvelopeKeyPurpose,
    existing: PassphraseKeyRecord | null,
  ): Promise<CryptoKey> {
    if (existing) {
      const key = await deriveKek(
        passphrase,
        base64UrlToBytes(existing.kdf.salt),
        existing.kdf.iterations,
      );
      await this.verify(key, existing);
      this.store(key, existing.kdf.salt);
      return key;
    }

    if (purpose === "decrypt") throw new MissingPassphraseKeyRecordError(this.namespace);

    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const saltText = bytesToBase64Url(salt);
    const key = await deriveKek(passphrase, salt, this.iterations);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: iv as unknown as BufferSource,
        additionalData: recordAad(
          this.namespace,
          saltText,
          this.iterations,
        ) as unknown as BufferSource,
      },
      key,
      VERIFIER_PLAINTEXT as unknown as BufferSource,
    );
    await this.records.save({
      v: RECORD_VERSION,
      namespace: this.namespace,
      kdf: { name: KDF_NAME, iterations: this.iterations, salt: saltText },
      verifier: {
        iv: bytesToBase64Url(iv),
        ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
      },
      createdAt: new Date().toISOString(),
    });
    this.store(key, saltText);
    return key;
  }

  /**
   * Prove the passphrase before any credential ciphertext is touched, so a
   * wrong passphrase reports itself as a wrong passphrase.
   */
  private async verify(key: CryptoKey, record: PassphraseKeyRecord): Promise<void> {
    let plaintext: ArrayBuffer;
    try {
      plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: base64UrlToBytes(record.verifier.iv) as unknown as BufferSource,
          additionalData: recordAad(
            record.namespace,
            record.kdf.salt,
            record.kdf.iterations,
          ) as unknown as BufferSource,
        },
        key,
        base64UrlToBytes(record.verifier.ciphertext) as unknown as BufferSource,
      );
    } catch (error) {
      throw new WrongPassphraseError({ cause: error });
    }
    const actual = new Uint8Array(plaintext);
    if (
      actual.length !== VERIFIER_PLAINTEXT.length ||
      actual.some((byte, index) => byte !== VERIFIER_PLAINTEXT[index])
    ) {
      throw new InvalidPassphraseKeyRecordError("verifier payload does not match");
    }
  }

  private store(key: CryptoKey, salt: string): void {
    this.cache = { key, salt, expiresAt: 0 };
    this.touch();
  }

  /** Read the cache, enforcing expiry lazily as well as by timer. */
  private peek(): { key: CryptoKey; salt: string; expiresAt: number } | null {
    if (!this.cache) return null;
    // Background tabs throttle timers, so never trust the timer alone.
    if (Date.now() >= this.cache.expiresAt) {
      void this.lock();
      return null;
    }
    return this.cache;
  }

  private touch(): void {
    if (!this.cache) return;
    this.cache.expiresAt =
      this.idleTimeoutMs === Number.POSITIVE_INFINITY
        ? Number.POSITIVE_INFINITY
        : Date.now() + this.idleTimeoutMs;
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer);
    this.expiryTimer =
      this.idleTimeoutMs === Number.POSITIVE_INFINITY
        ? null
        : setTimeout(() => void this.lock(), this.idleTimeoutMs);
  }
}
