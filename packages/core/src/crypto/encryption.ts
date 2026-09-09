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

function base58Decode(str: string): Uint8Array {
  let num = 0n;
  for (const char of str) {
    const idx = BASE58_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error(`Invalid base58 character: ${char}`);
    num = num * 58n + BigInt(idx);
  }

  // Convert BigInt to byte array
  const hex = num.toString(16).padStart(64, "0"); // 256 bits = 64 hex chars
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16) ?? 0;
  }

  return bytes;
}

// ─── Key lifecycle ───────────────────────────────────────────────────

/** Generate a new 256-bit AES-GCM key. */
export async function generateKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true, // extractable for export/transfer
    ["encrypt", "decrypt"],
  );
}

/** Export key to raw bytes. */
export async function exportKeyRaw(key: CryptoKey): Promise<Uint8Array> {
  const buffer = await crypto.subtle.exportKey("raw", key);
  return new Uint8Array(buffer);
}

/** Import key from raw bytes. */
export async function importKeyRaw(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw.buffer as ArrayBuffer, { name: "AES-GCM" }, true, [
    "encrypt",
    "decrypt",
  ]);
}

/** Export key as a base58 string (~43 chars, human-transferable). */
export async function keyToPassphrase(key: CryptoKey): Promise<string> {
  const raw = await exportKeyRaw(key);
  return base58Encode(raw);
}

/** Import key from a base58 passphrase. */
export async function passphraseToKey(passphrase: string): Promise<CryptoKey> {
  const raw = base58Decode(passphrase.trim());
  return importKeyRaw(raw);
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
