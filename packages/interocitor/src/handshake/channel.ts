/**
 * interocitor/handshake/channel
 *
 * Ephemeral ECDH-P256 key exchange over the shared cloud backend (relay).
 * No extra server required — the backend the mesh already uses is the relay.
 *
 * ## Roles (determined by QR intent, not by which device is "bigger")
 *
 *   Generator  — device that created the QR (has the ECDH private key).
 *                Receives credentials from the scanner via the relay.
 *
 *   Scanner    — device that scanned the QR (has generatorPub from the QR).
 *                Pushes credentials to the generator via the relay.
 *
 * ## Protocol
 *
 *   intent = "share"  →  Generator already has credentials.
 *                         Scanner is joining → Scanner reads relay → gets credentials.
 *                         (Scanner pushes scannerPub so Generator can encrypt for it.)
 *
 *   intent = "join"   →  Generator wants credentials.
 *                         Scanner has credentials → Scanner writes to relay.
 *                         (Generator just waits and reads.)
 *
 * Both intents use identical wire mechanics; only which side writes
 * credentials differs.
 *
 * ## Wire sequence (both intents)
 *
 *   Scanner                                  Relay                    Generator
 *   ───────                                  ─────                    ─────────
 *   [has generatorPub from QR]
 *   generate ephemeral keypair (Es, es)
 *   sharedSecret = ECDH(generatorPub, es)
 *   wrappingKey  = HKDF(sharedSecret)
 *                                  write scanner-pub.json (Es) →
 *                                                                  read scanner-pub.json
 *                                                                  sharedSecret = ECDH(Es, eg)
 *                                                                  wrappingKey  = HKDF(sharedSecret)
 *
 *   ── if intent == "join": Generator has credentials, Scanner receives ──
 *                                                                  encrypt {remotePath, meshKey}
 *                                  ← write credentials.json
 *   read credentials.json
 *   decrypt → remotePath, meshKey
 *
 *   ── if intent == "share": Scanner has credentials, Generator receives ──
 *   encrypt {remotePath, meshKey}
 *                                  write credentials.json →
 *                                                                  read credentials.json
 *                                                                  decrypt → remotePath, meshKey
 *
 *   [whoever received credentials deletes relay files — best-effort]
 *
 * ## Relay files (scoped by handshakeId)
 *
 *   {relayBase}/scanner-pub.json   — scanner's ephemeral ECDH public key
 *   {relayBase}/credentials.json   — encrypted {remotePath, meshKey?}
 *
 * ## Security
 *
 *   wrappingKey is derived from ECDH(generatorPub, scannerPriv)
 *              = ECDH(scannerPub, generatorPriv)   (commutativity)
 *
 *   Anyone with cloud access sees scanner-pub.json and credentials.json.
 *   Without generatorPriv (which never leaves the generating device) they
 *   cannot derive wrappingKey and cannot decrypt credentials.json.
 *   generatorPriv is only accessible to someone who physically held the
 *   device that generated the QR.
 */

import type { StorageAdapter } from '../core/types.ts';

// ─── ECDH / crypto helpers ───────────────────────────────────────────

const ECDH_PARAMS = { name: 'ECDH', namedCurve: 'P-256' } as const;
const HKDF_PARAMS = { name: 'HKDF', hash: 'SHA-256' } as const;
const WRAP_ALGO  = { name: 'AES-GCM', length: 256 } as const;
const IV_LEN     = 12;
const HKDF_INFO  = 'interocitor-handshake-v1';

function uint8ToB64url(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCodePoint(b[i]);
  return btoa(s).replaceAll(/\+/g, '-').replaceAll(/\//g, '_').replaceAll(/=/g, '');
}

function b64urlToUint8(s: string): Uint8Array {
  const p = s.replaceAll(/-/g, '+').replaceAll(/_/g, '/');
  const pad = (4 - (p.length % 4)) % 4;
  const bin = atob(p + '='.repeat(pad));
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.codePointAt(i);
  return b;
}

function toBuffer(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

export async function generateECDHKeypair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(ECDH_PARAMS, true, ['deriveKey', 'deriveBits']);
}

export async function exportECDHPublicKey(key: CryptoKey): Promise<string> {
  return uint8ToB64url(new Uint8Array(await crypto.subtle.exportKey('spki', key)));
}

export async function importECDHPublicKey(spki: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('spki', toBuffer(b64urlToUint8(spki)), ECDH_PARAMS, true, []);
}

async function deriveWrappingKey(myPriv: CryptoKey, peerPub: CryptoKey): Promise<CryptoKey> {
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: peerPub }, myPriv, 256);
  const ikm  = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  const info = new TextEncoder().encode(HKDF_INFO);
  return crypto.subtle.deriveKey(
    { ...HKDF_PARAMS, salt: new ArrayBuffer(32), info: toBuffer(info) },
    ikm,
    WRAP_ALGO,
    false,
    ['encrypt', 'decrypt'],
  );
}

// ─── Credential envelope ─────────────────────────────────────────────

interface CredentialEnvelope {
  v: 1;
  iv: string;   // base64url AES-GCM IV
  ct: string;   // base64url ciphertext of JSON-encoded CredentialPayload
}

interface CredentialPayload {
  remotePath: string;
  passphrase?: string;  // base58 passphrase, omitted for unencrypted meshes
}

async function encryptCredentials(
  wrappingKey: CryptoKey,
  creds: HandshakeCredentials,
): Promise<string> {
  const payload: CredentialPayload = { remotePath: creds.remotePath };
  if (creds.passphrase !== null) {
    payload.passphrase = creds.passphrase;
  }
  const pt   = new TextEncoder().encode(JSON.stringify(payload));
  const ivRaw = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const iv    = toBuffer(ivRaw);
  const ct    = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, pt);
  const env: CredentialEnvelope = { v: 1, iv: uint8ToB64url(ivRaw), ct: uint8ToB64url(new Uint8Array(ct)) };
  return JSON.stringify(env);
}

async function decryptCredentials(
  wrappingKey: CryptoKey,
  envelope: string,
): Promise<HandshakeCredentials> {
  const { v, iv, ct } = JSON.parse(envelope) as CredentialEnvelope;
  if (v !== 1) throw new Error(`Unknown handshake envelope version: ${v}`);
  const ivBytes = b64urlToUint8(iv);
  const ctBytes = b64urlToUint8(ct);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toBuffer(ivBytes) },
    wrappingKey,
    toBuffer(ctBytes),
  );
  const raw = JSON.parse(new TextDecoder().decode(pt)) as CredentialPayload;
  return { remotePath: raw.remotePath, passphrase: raw.passphrase ?? null };
}

// ─── Relay paths ─────────────────────────────────────────────────────

function relayPaths(handshakeId: string, relayBase: string) {
  const base = `${relayBase}/handshake/${handshakeId}`;
  return {
    scannerPub:  `${base}/scanner-pub.json`,
    credentials: `${base}/credentials.json`,
  };
}

// ─── Polling ─────────────────────────────────────────────────────────

async function pollFor<T>(
  fn: () => Promise<T | null>,
  intervalMs: number,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fn();
    if (r !== null) return r;
    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }
  throw new Error(`Handshake timed out after ${timeoutMs}ms`);
}

// ─── Relay I/O ───────────────────────────────────────────────────────

async function relayRead(adapter: StorageAdapter, path: string): Promise<string | null> {
  try {
    const bytes = await adapter.readFile(path);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

async function relayWrite(adapter: StorageAdapter, path: string, data: string): Promise<void> {
  await adapter.writeFile(path, data);
}

async function relayCleanup(adapter: StorageAdapter, paths: { scannerPub: string; credentials: string }): Promise<void> {
  await Promise.allSettled([
    adapter.deleteFile(paths.scannerPub),
    adapter.deleteFile(paths.credentials),
  ]);
}

// ─── Public result type ──────────────────────────────────────────────

export interface HandshakeCredentials {
  remotePath: string;
  /** Base58 passphrase for the mesh encryption key, or null for unencrypted meshes. */
  passphrase: string | null;
}

// ─── Generator side ──────────────────────────────────────────────────

export interface GeneratorSession {
  /** Generator's ephemeral ECDH public key — goes into the QR payload. */
  generatorPub: string;
  /**
   * Wait for the scanner to appear on the relay, then complete the handshake.
   *
   * intent = "share": generator already has credentials → waits for scannerPub,
   *                   encrypts and writes credentials, then resolves.
   *
   * intent = "join":  generator wants credentials → waits for scannerPub,
   *                   then waits for credentials, decrypts and resolves them.
   */
  complete(
    adapter: StorageAdapter,
    handshakeId: string,
    relayBase: string,
    intent: 'share' | 'join',
    ownCredentials: HandshakeCredentials | null,
    options?: { pollIntervalMs?: number; timeoutMs?: number },
  ): Promise<HandshakeCredentials | null>;
}

export async function createGeneratorSession(): Promise<GeneratorSession> {
  const keypair = await generateECDHKeypair();
  const generatorPub = await exportECDHPublicKey(keypair.publicKey);

  return {
    generatorPub,
    async complete(adapter, handshakeId, relayBase, intent, ownCredentials, options = {}) {
      const { pollIntervalMs = 2000, timeoutMs = 120_000 } = options;
      const paths = relayPaths(handshakeId, relayBase);

      // Wait for the scanner to upload their ephemeral public key.
      const scannerPubSpki = await pollFor(
        async () => {
          const data = await relayRead(adapter, paths.scannerPub);
          if (!data) return null;
          return (JSON.parse(data) as { pub: string }).pub ?? null;
        },
        pollIntervalMs,
        timeoutMs,
      );

      const scannerPublicKey = await importECDHPublicKey(scannerPubSpki);
      const wrappingKey = await deriveWrappingKey(keypair.privateKey, scannerPublicKey);

      if (intent === 'share') {
        // Generator has credentials → encrypt and push them for the scanner.
        if (!ownCredentials) throw new Error('intent=share requires ownCredentials');
        const envelope = await encryptCredentials(wrappingKey, ownCredentials);
        await relayWrite(adapter, paths.credentials, envelope);
        // Generator does not clean up — scanner deletes after reading.
        return null; // Generator already has credentials; nothing new to return.
      }
        // intent === 'join': scanner will push credentials to us.
        const envelope = await pollFor(
          () => relayRead(adapter, paths.credentials),
          pollIntervalMs,
          timeoutMs,
        );
        const credentials = await decryptCredentials(wrappingKey, envelope);
        // Clean up relay files after reading.
        relayCleanup(adapter, paths).catch(() => {});
        return credentials;
      
    },
  };
}

// ─── Scanner side ────────────────────────────────────────────────────

/**
 * Run the scanner side of the handshake.
 *
 * intent = "share":  generator has credentials and will push them →
 *                    scanner uploads scannerPub, waits for credentials,
 *                    decrypts and returns them.
 *
 * intent = "join":   generator wants credentials → scanner uploads
 *                    scannerPub, then writes encrypted credentials,
 *                    resolves with null (scanner already has them).
 */
export async function runScannerHandshake(
  adapter: StorageAdapter,
  payload: {
    intent: 'share' | 'join';
    handshakeId: string;
    generatorPub: string;
  },
  ownCredentials: HandshakeCredentials | null,
  relayBase: string,
  options: { pollIntervalMs?: number; timeoutMs?: number } = {},
): Promise<HandshakeCredentials | null> {
  const { intent, handshakeId, generatorPub } = payload;
  const { pollIntervalMs = 2000, timeoutMs = 120_000 } = options;
  const paths = relayPaths(handshakeId, relayBase);

  // Generate our ephemeral keypair.
  const keypair = await generateECDHKeypair();
  const scannerPub = await exportECDHPublicKey(keypair.publicKey);

  // Upload our public key — this signals the generator we are here.
  await relayWrite(adapter, paths.scannerPub, JSON.stringify({ pub: scannerPub }));

  // Derive the shared wrapping key using the generator's public key from the QR.
  const generatorPublicKey = await importECDHPublicKey(generatorPub);
  const wrappingKey = await deriveWrappingKey(keypair.privateKey, generatorPublicKey);

  if (intent === 'share') {
    // Generator will push credentials → wait and decrypt.
    const envelope = await pollFor(
      () => relayRead(adapter, paths.credentials),
      pollIntervalMs,
      timeoutMs,
    );
    const credentials = await decryptCredentials(wrappingKey, envelope);
    relayCleanup(adapter, paths).catch(() => {});
    return credentials;
  }
    // intent === 'join': we push credentials to the generator.
    if (!ownCredentials) throw new Error('intent=join requires scanner to have ownCredentials');
    const envelope = await encryptCredentials(wrappingKey, ownCredentials);
    await relayWrite(adapter, paths.credentials, envelope);
    // Scanner already has credentials; nothing new to return.
    return null;
  
}
