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

const IV_LENGTH = 12; // 96-bit IV for AES-GCM
const ENVELOPE_VERSION = 1;

// ─── Base58 (Bitcoin alphabet) ───────────────────────────────────────

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes: Uint8Array): string {
  // Convert byte array to BigInt
  let num = 0n;
  for (const b of bytes) {
    num = num * 256n + BigInt(b);
  }

  let result = '';
  while (num > 0n) {
    const mod = Number(num % 58n);
    result = BASE58_ALPHABET[mod] + result;
    num = num / 58n;
  }

  // Preserve leading zeros
  for (const b of bytes) {
    if (b === 0) result = '1' + result;
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
  const hex = num.toString(16).padStart(64, '0'); // 256 bits = 64 hex chars
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16) ?? 0;
  }

  return bytes;
}

// ─── Uint8 ↔ Base64 ─────────────────────────────────────────────────

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCodePoint(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.codePointAt(i);
  }
  return bytes;
}

// ─── Key lifecycle ───────────────────────────────────────────────────

/** Generate a new 256-bit AES-GCM key. */
export async function generateKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true, // extractable for export/transfer
    ['encrypt', 'decrypt']
  );
}

/** Export key to raw bytes. */
export async function exportKeyRaw(key: CryptoKey): Promise<Uint8Array> {
  const buffer = await crypto.subtle.exportKey('raw', key);
  return new Uint8Array(buffer);
}

/** Import key from raw bytes. */
export async function importKeyRaw(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    raw.buffer as ArrayBuffer,
    { name: 'AES-GCM' },
    true,
    ['encrypt', 'decrypt']
  );
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
  const b64url = uint8ToBase64(raw)
    .replaceAll(/\+/g, '-')
    .replaceAll(/\//g, '_')
    .replaceAll(/=/g, '');
  return `${baseUrl}#key=${b64url}`;
}

/** Extract key bytes from a URL fragment. */
export function keyFromFragment(hash: string): Uint8Array | null {
  const match = hash.match(/key=([A-Za-z0-9_-]+)/);
  if (!match) return null;
  const b64 = match[1].replaceAll(/-/g, '+').replaceAll(/_/g, '/');
  // Pad to multiple of 4
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  return base64ToUint8(padded);
}

// ─── Encrypt / Decrypt entries ───────────────────────────────────────

export interface EncryptedEnvelope {
  v: number;
  iv: string;  // base64
  ct: string;  // base64 (includes GCM auth tag)
}

/** Encrypt a single plaintext string. */
export async function encryptEntry(
  key: CryptoKey,
  plaintext: string
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoded = new TextEncoder().encode(plaintext);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoded
  );

  const envelope: EncryptedEnvelope = {
    v: ENVELOPE_VERSION,
    iv: uint8ToBase64(iv),
    ct: uint8ToBase64(new Uint8Array(ciphertext)),
  };

  return JSON.stringify(envelope);
}

/** Decrypt a single encrypted envelope back to plaintext. */
export async function decryptEntry(
  key: CryptoKey,
  envelopeStr: string
): Promise<string> {
  const envelope: EncryptedEnvelope = JSON.parse(envelopeStr);
  if (envelope.v !== ENVELOPE_VERSION) {
    throw new Error(`Unknown envelope version: ${envelope.v}`);
  }

  const iv = base64ToUint8(envelope.iv);
  const ct = base64ToUint8(envelope.ct);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    key,
    ct.buffer as ArrayBuffer
  );

  return new TextDecoder().decode(decrypted);
}

/**
 * Encrypt multiple plaintext lines independently and join them as NDJSON.
 *
 * Each line gets its own IV and auth tag, so corruption is isolated to the
 * affected entry.
 */
export async function encryptNdjson(key: CryptoKey, lines: string[]): Promise<string> {
  const encryptedLines = await Promise.all(lines.map((line) => encryptEntry(key, line)));
  return encryptedLines.join('\n');
}

/**
 * Decrypt newline-delimited encrypted entries.
 *
 * Invalid or corrupted lines are returned as `null` instead of throwing so the
 * caller can recover as much of the stream as possible.
 */
export async function decryptNdjson(key: CryptoKey, content: string): Promise<Array<string | null>> {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return Promise.all(lines.map(async (line) => {
    try {
      return await decryptEntry(key, line);
    } catch {
      return null;
    }
  }));
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

// ─── Local key persistence ───────────────────────────────────────────

const KEY_STORAGE_KEY = 'interocitor-key';

export async function storeKeyLocally(key: CryptoKey): Promise<void> {
  const raw = await exportKeyRaw(key);
  const b64 = uint8ToBase64(raw);
  localStorage.setItem(KEY_STORAGE_KEY, b64);
}

export async function loadKeyLocally(): Promise<CryptoKey | null> {
  const b64 = localStorage.getItem(KEY_STORAGE_KEY);
  if (!b64) return null;
  const raw = base64ToUint8(b64);
  return importKeyRaw(raw);
}

export function clearKeyLocally(): void {
  localStorage.removeItem(KEY_STORAGE_KEY);
}
