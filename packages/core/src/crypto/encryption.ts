// compass: interocitor.trust.encryption

/**
 * Encryption layer — AES-256-GCM via Web Crypto API
 *
 * The key is a 256-bit symmetric key. It never leaves the device.
 * Each entry is independently encrypted with a random 96-bit IV.
 *
 * The key can be transferred as:
 *  - base58 string (~43 chars, copy-pasteable)
 *  - URL fragment (#key=base64url)
 *  - QR code containing either of the above
 */

import {
  base64ToBytes as base64ToUint8,
  bytesToBase64 as uint8ToBase64,
  base64UrlToBytes,
  bytesToBase64Url,
} from "./base64.ts";
import { asBufferSource } from "./bytes.ts";

const IV_LENGTH = 12; // 96-bit IV for AES-GCM
const ENVELOPE_VERSION = 1;

// ─── Base58 (Bitcoin alphabet) ───────────────────────────────────────

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(bytes: Uint8Array): string {
  // Convert byte array to BigInt
  let num = 0n;
  for (const b of bytes) {
    num = num * 256n + BigInt(b);
  }

  let result = "";
  while (num > 0n) {
    const mod = Number(num % 58n);
    result = BASE58_ALPHABET[mod] + result;
    num = num / 58n;
  }

  // Preserve leading zeros
  for (const b of bytes) {
    if (b === 0) result = "1" + result;
    else break;
  }

  return result;
}

/** Raw byte length of a mesh key (AES-256). */
const KEY_BYTES = 32;

/**
 * Decode base58 into exactly {@link KEY_BYTES} bytes.
 *
 * Values wider than the key are rejected here rather than deferred to
 * `importKey`. Narrow values are left-padded with zero bytes, which is
 * lossless for the decode itself — {@link passphraseToKey} is what rejects
 * non-canonical (short) inputs, by re-encoding and comparing.
 */
function base58Decode(str: string): Uint8Array {
  let num = 0n;
  for (const char of str) {
    const idx = BASE58_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error(`Invalid base58 character: ${char}`);
    num = num * 58n + BigInt(idx);
  }

  // Convert BigInt to a fixed-width byte array, least-significant byte last.
  // Done arithmetically rather than through a hex string: `toString(16)` can
  // yield an odd number of digits, which used to slice a half byte out of the
  // front of oversized inputs.
  const bytes = new Uint8Array(KEY_BYTES);
  for (let i = KEY_BYTES - 1; i >= 0; i--) {
    bytes[i] = Number(num & 0xffn);
    num >>= 8n;
  }
  if (num > 0n) {
    throw new Error(`Invalid mesh key: decodes to more than ${KEY_BYTES} bytes`);
  }

  return bytes;
}

// ─── Key lifecycle ───────────────────────────────────────────────────

/**
 * How a mesh key enters Web Crypto.
 *
 * `extractable: false` — the default for {@link importKeyRaw}, and so for
 * {@link passphraseToKey} — means `crypto.subtle.exportKey` rejects for the
 * resulting `CryptoKey`. Page script that reaches the key object (an extension
 * escalated into the MAIN world, a compromised first-party dependency) can
 * still encrypt and decrypt with it while the tab is open, but cannot copy the
 * raw bytes out for later or offline use. Mesh key bytes are a permanent
 * read-and-write capability over the whole mesh, so that is the difference
 * between a session-scoped compromise and a permanent one.
 *
 * Pass `extractable: true` only where the bytes genuinely have to come back
 * out of the `CryptoKey` itself. Almost nothing does: the base58 portable key
 * is retained separately by every key source, derivations go through the HKDF
 * twin described below, and {@link generateMeshKeyMaterial} hands back the
 * portable form alongside the key.
 */
export interface MeshKeyImportOptions {
  /** Default `false` on import, `true` on {@link generateKey}. */
  extractable?: boolean;
}

/**
 * HKDF input-keying-material twin for every mesh key this module imports.
 *
 * An AES-GCM `CryptoKey` cannot itself be HKDF input: Web Crypto rejects it as
 * a `deriveKey` base key, and AES-GCM keys cannot carry the `deriveKey` usage
 * at all. Until now the only way to key a derivation off the mesh key was
 * `exportKey` then re-import as HKDF — precisely the extractability this
 * module exists to remove. So each import registers a second, independent view
 * of the same 32 bytes: an HKDF base key, handed out by
 * {@link meshKeyDerivationBase}.
 *
 * Holding it leaks nothing. Web Crypto forbids extractable HKDF keys outright
 * (`importKey` throws `SyntaxError`), so the twin is as opaque as the AES-GCM
 * key beside it, and this registry is module-private and weakly keyed, so it
 * neither exposes the twin nor pins the mesh key in memory.
 */
const derivationTwins = new WeakMap<CryptoKey, CryptoKey>();

/**
 * Generate a new 256-bit AES-GCM key.
 *
 * Unlike {@link importKeyRaw}, this still defaults to `extractable: true`: its
 * callers generate a key precisely in order to read the bytes back out as the
 * portable base58 form and persist them. {@link generateMeshKeyMaterial} is
 * the better shape for that — it produces both halves at once and never needs
 * an extractable key — and `generateKey({ extractable: false })` is here for
 * callers that want only the key.
 */
export async function generateKey(options: MeshKeyImportOptions = {}): Promise<CryptoKey> {
  if (options.extractable ?? true) {
    return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
      "encrypt",
      "decrypt",
    ]);
  }
  const raw = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  try {
    return await importKeyRaw(raw);
  } finally {
    raw.fill(0);
  }
}

/**
 * Mint a fresh mesh key and its portable form together.
 *
 * The raw bytes exist only inside this call: the base58 string is encoded from
 * the same buffer that seeds the import, and the buffer is zeroed before the
 * function returns. The key itself is non-extractable, so the portable string
 * is the only copy of the material, held where the caller decides.
 *
 * This is the shape a key source wants at first run. `generateKey()` followed
 * by `keyToPassphrase()` needs an extractable key purely to read back bytes
 * the generator already had in hand.
 */
export async function generateMeshKeyMaterial(): Promise<{
  key: CryptoKey;
  portableKey: string;
}> {
  const raw = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  try {
    return { key: await importKeyRaw(raw), portableKey: base58Encode(raw) };
  } finally {
    raw.fill(0);
  }
}

/**
 * Export key to raw bytes.
 *
 * Rejects with `InvalidAccessError` for a non-extractable key — which is every
 * key {@link importKeyRaw} and {@link passphraseToKey} produce unless the
 * caller opted in. That is the point; read the material from whatever base58
 * or raw value you already retained instead.
 */
export async function exportKeyRaw(key: CryptoKey): Promise<Uint8Array> {
  const buffer = await crypto.subtle.exportKey("raw", key);
  return new Uint8Array(buffer);
}

/**
 * Import key from raw bytes. Non-extractable unless asked otherwise; see
 * {@link MeshKeyImportOptions}.
 */
export async function importKeyRaw(
  raw: Uint8Array,
  options: MeshKeyImportOptions = {},
): Promise<CryptoKey> {
  const material = asBufferSource(raw);
  // Both imports copy their bytes synchronously, so the caller may zero the
  // buffer as soon as this returns.
  const [key, twin] = await Promise.all([
    crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, options.extractable ?? false, [
      "encrypt",
      "decrypt",
    ]),
    crypto.subtle.importKey("raw", material, "HKDF", false, ["deriveKey"]),
  ]);
  derivationTwins.set(key, twin);
  return key;
}

/**
 * The HKDF base key to hang a derivation off a mesh or file-seal key.
 *
 * Returns the twin registered at import when this module minted the key, so a
 * non-extractable mesh key can still key a derivation. Falls back to
 * export-and-reimport for a `CryptoKey` this module did not mint — an
 * application-supplied file seal key, or one from a second copy of this
 * module. That fallback is exactly what every caller did before the twin
 * existed, and HKDF over the same 32 bytes is byte-identical either way, so
 * object names and seal guards are unchanged by which path a key takes.
 */
export async function meshKeyDerivationBase(key: CryptoKey): Promise<CryptoKey> {
  const twin = derivationTwins.get(key);
  if (twin) return twin;

  let raw: Uint8Array;
  try {
    raw = await exportKeyRaw(key);
  } catch (cause) {
    throw new Error(
      "Cannot derive from this key: it is non-extractable and was not imported by " +
        "@interocitor/core, so no HKDF twin is registered for it. Import the material " +
        "with importKeyRaw() instead of importing it directly.",
      { cause },
    );
  }
  try {
    return await crypto.subtle.importKey("raw", asBufferSource(raw), "HKDF", false, ["deriveKey"]);
  } finally {
    raw.fill(0);
  }
}

/**
 * Export key as a base58 string (~43 chars, human-transferable).
 *
 * Requires an extractable key. Prefer the portable string a key source already
 * holds (`PortablePassphraseKeySource.getPortableKey()`), or mint both halves
 * at once with {@link generateMeshKeyMaterial}.
 */
export async function keyToPassphrase(key: CryptoKey): Promise<string> {
  const raw = await exportKeyRaw(key);
  try {
    return base58Encode(raw);
  } finally {
    raw.fill(0);
  }
}

/**
 * Import a mesh key from its base58 form.
 *
 * The argument is key material, not a human-chosen password: there is no KDF
 * behind this, so whatever entropy the string carries is the entropy of the
 * mesh. Only the canonical base58 encoding of exactly {@link KEY_BYTES} bytes
 * is accepted — the exact form {@link keyToPassphrase} produces.
 *
 * Anything else throws:
 *  - a short, human-chosen string ("hunter2") used to left-pad into a
 *    structurally valid AES-256 key with a few dozen bits of entropy;
 *  - an over-long string used to throw deep inside `importKey`;
 *  - a truncated or otherwise mistyped key, which used to surface later as an
 *    undiagnosable decryption failure against the remote.
 *
 * Callers wanting a key from a human passphrase must run their own KDF
 * (see `BoundSharedKeySource`) and hand the derived 32 bytes to
 * {@link importKeyRaw}.
 *
 * The returned key is non-extractable unless `options.extractable` says
 * otherwise. The caller already holds the base58 string, so there is nothing
 * to learn by exporting the key again.
 */
export async function passphraseToKey(
  passphrase: string,
  options: MeshKeyImportOptions = {},
): Promise<CryptoKey> {
  const trimmed = passphrase.trim();
  if (!trimmed) throw new Error("Invalid mesh key: empty");

  const raw = base58Decode(trimmed);
  if (base58Encode(raw) !== trimmed) {
    throw new Error(
      `Invalid mesh key: expected the canonical base58 encoding of ${KEY_BYTES} bytes ` +
        `(as produced by keyToPassphrase), got ${trimmed.length} characters. ` +
        `A mesh key is generated key material, not a chosen password.`,
    );
  }

  try {
    return await importKeyRaw(raw, options);
  } finally {
    raw.fill(0);
  }
}

/**
 * Export key as a URL fragment (never hits server).
 * @param baseUrl - e.g. "https://yourapp.com/join"
 */
export function keyToShareUrl(raw: Uint8Array, baseUrl: string): string {
  return `${baseUrl}#key=${bytesToBase64Url(raw)}`;
}

/** Extract key bytes from a URL fragment. */
export function keyFromFragment(hash: string): Uint8Array | null {
  const match = hash.match(/key=([A-Za-z0-9_-]+)/);
  if (!match) return null;
  return base64UrlToBytes(match[1]);
}

// ─── Encrypt / Decrypt entries ───────────────────────────────────────

export interface EncryptedEnvelope {
  v: number;
  iv: string; // base64
  ct: string; // base64 (includes GCM auth tag)
}

async function sealEnvelope(key: CryptoKey, plaintext: BufferSource): Promise<EncryptedEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return {
    v: ENVELOPE_VERSION,
    iv: uint8ToBase64(iv),
    ct: uint8ToBase64(new Uint8Array(ciphertext)),
  };
}

function parseEnvelope(text: string): EncryptedEnvelope {
  const envelope: EncryptedEnvelope = JSON.parse(text);
  if (envelope.v !== ENVELOPE_VERSION) {
    throw new Error(`Unknown envelope version: ${envelope.v}`);
  }
  return envelope;
}

async function openEnvelope(
  key: CryptoKey,
  envelope: EncryptedEnvelope,
): Promise<Uint8Array<ArrayBuffer>> {
  const iv = base64ToUint8(envelope.iv);
  const ct = base64ToUint8(envelope.ct);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new Uint8Array(decrypted);
}

/** Encrypt a single plaintext string. */
export async function encryptEntry(key: CryptoKey, plaintext: string): Promise<string> {
  const envelope = await sealEnvelope(key, new TextEncoder().encode(plaintext));
  return JSON.stringify(envelope);
}

/** Decrypt a single encrypted envelope back to plaintext. */
export async function decryptEntry(key: CryptoKey, envelopeStr: string): Promise<string> {
  const bytes = await openEnvelope(key, parseEnvelope(envelopeStr));
  return new TextDecoder().decode(bytes);
}

/** Encrypt arbitrary binary data using the mesh AES-GCM key. */
export async function encryptBytes(key: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array> {
  const envelope = await sealEnvelope(key, asBufferSource(plaintext));
  return new TextEncoder().encode(JSON.stringify(envelope));
}

/** Decrypt binary data produced by {@link encryptBytes}. */
export async function decryptBytes(key: CryptoKey, envelopeBytes: Uint8Array): Promise<Uint8Array> {
  return openEnvelope(key, parseEnvelope(new TextDecoder().decode(envelopeBytes)));
}

/**
 * Encrypt multiple plaintext lines independently and join them as NDJSON.
 *
 * Each line gets its own IV and auth tag, so corruption is isolated to the
 * affected entry.
 */
export async function encryptNdjson(key: CryptoKey, lines: string[]): Promise<string> {
  const encryptedLines = await Promise.all(lines.map((line) => encryptEntry(key, line)));
  return encryptedLines.join("\n");
}

/**
 * Decrypt newline-delimited encrypted entries.
 *
 * Invalid or corrupted lines are returned as `null` instead of throwing so the
 * caller can recover as much of the stream as possible.
 */
export async function decryptNdjson(
  key: CryptoKey,
  content: string,
): Promise<Array<string | null>> {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return Promise.all(
    lines.map(async (line) => {
      try {
        return await decryptEntry(key, line);
      } catch {
        return null;
      }
    }),
  );
}

/** Quick verification: try decrypting a single line to confirm key is correct. */
export async function verifyKey(key: CryptoKey, sampleEncrypted: string): Promise<boolean> {
  try {
    await decryptEntry(key, sampleEncrypted);
    return true;
  } catch {
    return false;
  }
}
