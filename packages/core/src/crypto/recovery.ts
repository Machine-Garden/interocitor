// compass: interocitor.trust.recovery

/**
 * Recovery-key protocol for portable-key meshes.
 *
 * An application-provided recovery phrase never leaves the client. It is
 * converted into a recovery root, which deterministically produces an opaque
 * lookup locator and derives a KEK for encrypted mesh credentials.
 */

import type { StorageAdapter } from "../core/types.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const RECOVERY_ROOT_SALT = encoder.encode("interocitor.recovery.root.v1");
const LOCATOR_INFO = encoder.encode("interocitor.recovery.locator.v1");
const KEK_INFO = encoder.encode("interocitor.recovery.kek.v1");
const ROOT_ITERATIONS = 600_000;
const RECOVERY_FOLDER = "/.interocitor/recovery";
const LOCATOR_RE = /^[A-Za-z0-9_-]{43}$/;

export interface RecoveredMeshCredentials {
  /** Remote root passed back to `Interocitor` as `remotePath`. */
  remotePath: string;
  /** High-entropy base58 material consumed by `PortablePassphraseKeySource`. */
  portableKey: string;
  /** Manifest mesh identity when it was known while creating the wrapper. */
  meshId?: string;
}

/** Serialized encrypted recovery record stored by a remote adapter. */
export interface RecoveryWrapper {
  /** Recovery-wrapper format version. */
  v: 1;
  /** Authenticated-encryption algorithm used for `ciphertext`. */
  alg: "AES-GCM";
  /** Public derivation parameters required to reproduce the wrapping key. */
  kdf: {
    root: {
      name: "PBKDF2-HMAC-SHA-256";
      /** Fixed work factor accepted by this format version. */
      iterations: number;
    };
    kek: {
      name: "HKDF-SHA-256";
      /** Per-wrapper random salt encoded as base64url. */
      salt: string;
    };
  };
  /** Phrase-derived, base64url lookup capability; it does not contain the mesh ID. */
  locator: string;
  /** Random 96-bit AES-GCM IV encoded as base64url. */
  iv: string;
  /** Authenticated encrypted `RecoveredMeshCredentials` JSON, encoded as base64url. */
  ciphertext: string;
  /** ISO timestamp recorded by the creating client. */
  createdAt: string;
}

/**
 * Adapter extension for services that keep recovery wrappers outside a known
 * mesh path. Generic adapters use `/.interocitor/recovery/` instead.
 */
export interface RecoveryStorageAdapter {
  /** Return the serialized wrapper for an already validated locator. */
  readRecoveryWrapper(locator: string): Promise<Uint8Array>;
  /** Store one serialized wrapper under an already validated locator. */
  writeRecoveryWrapper(locator: string, data: Uint8Array): Promise<void>;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded =
    value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.codePointAt(0)!);
}

function asBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function normalizePhrase(phrase: string): string {
  return phrase.normalize("NFKD").trim().replaceAll(/\s+/g, " ");
}

function assertPhrase(phrase: string): string {
  const normalized = normalizePhrase(phrase);
  if (!normalized) throw new Error("Recovery phrase must not be empty");
  return normalized;
}

function assertWrapper(value: unknown): asserts value is RecoveryWrapper {
  if (!value || typeof value !== "object") throw new Error("Invalid recovery wrapper");
  const wrapper = value as Partial<RecoveryWrapper>;
  if (
    wrapper.v !== 1 ||
    wrapper.alg !== "AES-GCM" ||
    wrapper.kdf?.root?.name !== "PBKDF2-HMAC-SHA-256" ||
    wrapper.kdf.root.iterations !== ROOT_ITERATIONS ||
    wrapper.kdf.kek?.name !== "HKDF-SHA-256" ||
    typeof wrapper.kdf.kek.salt !== "string" ||
    !LOCATOR_RE.test(String(wrapper.locator || "")) ||
    typeof wrapper.iv !== "string" ||
    typeof wrapper.ciphertext !== "string" ||
    typeof wrapper.createdAt !== "string"
  ) {
    throw new Error("Invalid recovery wrapper");
  }
}

async function deriveRecoveryRoot(phrase: string): Promise<Uint8Array> {
  const phraseBytes = encoder.encode(assertPhrase(phrase));
  const source = await crypto.subtle.importKey(
    "raw",
    phraseBytes.buffer as ArrayBuffer,
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: RECOVERY_ROOT_SALT, iterations: ROOT_ITERATIONS },
    source,
    256,
  );
  return new Uint8Array(bits);
}

async function deriveLocator(root: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    root.buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, LOCATOR_INFO)));
}

async function deriveKek(root: Uint8Array, salt: Uint8Array): Promise<CryptoKey> {
  const source = await crypto.subtle.importKey("raw", root.buffer as ArrayBuffer, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: asBuffer(salt), info: asBuffer(KEK_INFO) },
    source,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function wrapperAad(locator: string, salt: string): Uint8Array {
  return encoder.encode(`interocitor.recovery.wrapper.v1|${locator}|${salt}`);
}

function recoveryPath(locator: string): string {
  if (!LOCATOR_RE.test(locator)) throw new Error("Invalid recovery locator");
  return `${RECOVERY_FOLDER}/${locator}.json`;
}

function recoveryAdapter(adapter: StorageAdapter): RecoveryStorageAdapter | null {
  const candidate = adapter as StorageAdapter & Partial<RecoveryStorageAdapter>;
  return typeof candidate.readRecoveryWrapper === "function" &&
    typeof candidate.writeRecoveryWrapper === "function"
    ? (candidate as RecoveryStorageAdapter)
    : null;
}

/**
 * Derive the opaque remote lookup identifier for a recovery phrase.
 *
 * Whitespace is normalized with NFKD before derivation. Rejects an empty
 * phrase. The returned locator is stable for the same normalized phrase and
 * can be used to test phrase guesses against a copied wrapper.
 */
export async function recoveryLocator(phrase: string): Promise<string> {
  return deriveLocator(await deriveRecoveryRoot(phrase));
}

/**
 * Encrypt portable mesh credentials under an application-provided phrase.
 *
 * This creates the wrapper in memory; call `publishRecoveryWrapper` to
 * store it. Rejects an empty phrase or missing `remotePath`/`portableKey`.
 * Phrase generation and validation remain application responsibilities.
 */
export async function createRecoveryWrapper(
  phrase: string,
  credentials: RecoveredMeshCredentials,
): Promise<RecoveryWrapper> {
  if (!credentials.remotePath || !credentials.portableKey) {
    throw new Error("Recovery credentials require remotePath and portableKey");
  }
  const root = await deriveRecoveryRoot(phrase);
  const [locator, salt] = await Promise.all([
    deriveLocator(root),
    Promise.resolve(crypto.getRandomValues(new Uint8Array(16))),
  ]);
  const saltText = toBase64Url(salt);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const kek = await deriveKek(root, salt);
  const plaintext: RecoveredMeshCredentials = {
    remotePath: credentials.remotePath,
    portableKey: credentials.portableKey,
    ...(credentials.meshId ? { meshId: credentials.meshId } : {}),
  };
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: asBuffer(iv), additionalData: asBuffer(wrapperAad(locator, saltText)) },
    kek,
    encoder.encode(JSON.stringify(plaintext)),
  );
  return {
    v: 1,
    alg: "AES-GCM",
    kdf: {
      root: { name: "PBKDF2-HMAC-SHA-256", iterations: ROOT_ITERATIONS },
      kek: { name: "HKDF-SHA-256", salt: saltText },
    },
    locator,
    iv: toBase64Url(iv),
    ciphertext: toBase64Url(new Uint8Array(ciphertext)),
    createdAt: new Date().toISOString(),
  };
}

/**
 * Validate and decrypt a recovery wrapper with the supplied phrase.
 *
 * Rejects unsupported/malformed wrappers, a phrase whose locator differs, an
 * authentication failure, or decrypted data without the required credentials.
 */
export async function unwrapRecoveryWrapper(
  phrase: string,
  wrapper: RecoveryWrapper,
): Promise<RecoveredMeshCredentials> {
  assertWrapper(wrapper);
  const root = await deriveRecoveryRoot(phrase);
  const locator = await deriveLocator(root);
  if (locator !== wrapper.locator) throw new Error("Recovery phrase does not match this wrapper");
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: asBuffer(fromBase64Url(wrapper.iv)),
        additionalData: asBuffer(wrapperAad(wrapper.locator, wrapper.kdf.kek.salt)),
      },
      await deriveKek(root, fromBase64Url(wrapper.kdf.kek.salt)),
      asBuffer(fromBase64Url(wrapper.ciphertext)),
    );
    const value = JSON.parse(decoder.decode(plaintext)) as Partial<RecoveredMeshCredentials>;
    if (!value || typeof value.remotePath !== "string" || typeof value.portableKey !== "string") {
      throw new Error("Recovery wrapper contains invalid credentials");
    }
    return {
      remotePath: value.remotePath,
      portableKey: value.portableKey,
      ...(typeof value.meshId === "string" && value.meshId ? { meshId: value.meshId } : {}),
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Recovery wrapper contains"))
      throw error;
    throw new Error("Recovery phrase could not unlock this wrapper", { cause: error });
  }
}

/**
 * Serialize and upload a validated wrapper.
 *
 * Adapters implementing `RecoveryStorageAdapter` choose the recovery
 * endpoint. Generic adapters, including WebDAV, write beneath
 * `/.interocitor/recovery/`. Overwrite behavior belongs to that adapter.
 */
export async function publishRecoveryWrapper(
  adapter: StorageAdapter,
  wrapper: RecoveryWrapper,
): Promise<void> {
  assertWrapper(wrapper);
  const data = encoder.encode(JSON.stringify(wrapper));
  const recovery = recoveryAdapter(adapter);
  if (recovery) return recovery.writeRecoveryWrapper(wrapper.locator, data);
  await adapter.ensureFolder(RECOVERY_FOLDER);
  await adapter.writeFile(recoveryPath(wrapper.locator), data);
}

/**
 * Locate, download, validate, and decrypt portable mesh credentials.
 *
 * The caller still supplies an adapter that can authenticate to the storage
 * provider. Rejects remote read failures, malformed wrappers, and phrases that
 * cannot authenticate the stored ciphertext.
 */
export async function recoverMeshCredentials(
  adapter: StorageAdapter,
  phrase: string,
): Promise<RecoveredMeshCredentials> {
  const locator = await recoveryLocator(phrase);
  const recovery = recoveryAdapter(adapter);
  const data = recovery
    ? await recovery.readRecoveryWrapper(locator)
    : await adapter.readFile(recoveryPath(locator));
  let wrapper: unknown;
  try {
    wrapper = JSON.parse(decoder.decode(data));
  } catch {
    throw new Error("Invalid recovery wrapper");
  }
  assertWrapper(wrapper);
  return unwrapRecoveryWrapper(phrase, wrapper);
}
