/**
 * @interocitor/core low-level handshake channel
 *
 * Ephemeral ECDH-P256 key exchange over a shared cloud backend (relay).
 * Direct mode can use the mesh backend; protected pairing can use a separately
 * authorized bootstrap adapter.
 *
 * ## Roles (determined by QR intent, not by which device is "bigger")
 *
 *   Generator  — device that created the QR or pair URL and holds the
 *                corresponding ephemeral ECDH private key.
 *
 *   Scanner    — device that obtained the payload and has generatorPub.
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
 *                                  write scanner-pub.json (Es, capabilities?) →
 *                                                                  read scanner-pub.json
 *                                                                  sharedSecret = ECDH(Es, eg)
 *                                                                  wrappingKey  = HKDF(sharedSecret)
 *                                                                  validate capabilities
 *
 *   ── if intent == "share": Generator has credentials, Scanner receives ──
 *                                                                  encrypt credentials
 *                                  ← write credentials.json
 *   read credentials.json
 *   decrypt → remotePath, passphrase, connectionConfig?
 *
 *   ── if intent == "join": Scanner has credentials, Generator receives ──
 *   encrypt credentials
 *                                  write credentials.json →
 *                                                                  read credentials.json
 *                                                                  decrypt → remotePath, passphrase,
 *                                                                            connectionConfig?
 *
 *   [whoever received credentials deletes relay files — best-effort]
 *
 * ## Relay files (scoped by handshakeId)
 *
 *   {relayBase}/handshake/{handshakeId}/scanner-pub.json
 *     — scanner's ephemeral ECDH public key and optional capability profile
 *   {relayBase}/handshake/{handshakeId}/credentials.json
 *     — encrypted {remotePath, passphrase?, connectionConfig?}; version 2
 *       authenticates the negotiated capability transcript when required
 *
 * ## Security
 *
 *   wrappingKey is derived from ECDH(generatorPub, scannerPriv)
 *              = ECDH(scannerPub, generatorPriv)   (commutativity)
 *
 *   Anyone with cloud access sees scanner-pub.json and credentials.json.
 *   Without generatorPub from the invitation payload and one participant's
 *   private key, cloud access alone cannot derive wrappingKey. Anyone who
 *   obtains the complete invitation payload and can access the relay can act
 *   as the scanner, so applications must treat QR images and pair URLs as
 *   short-lived capabilities.
 */

import { base64UrlToBytes, bytesToBase64Url } from "../crypto/base64.ts";
import { asBufferSource } from "../crypto/bytes.ts";
import type { StorageAdapter } from "../core/types.ts";
import {
  assertPairingCapabilitiesCompatible,
  isPairingCapabilities,
  normalizePairingCapabilities,
  pairingCapabilitiesForWire,
  type NormalizedPairingCapabilities,
  type PairingCapabilities,
} from "./capabilities.ts";
import { assertValidHandshakeId } from "./handshake-id.ts";
import {
  assertHandshakeIntent,
  snapshotHandshakeQRPayload,
  type HandshakeQRPayload,
} from "./qr.ts";

// ─── ECDH / crypto helpers ───────────────────────────────────────────

const ECDH_PARAMS = { name: "ECDH", namedCurve: "P-256" } as const;
const HKDF_PARAMS = { name: "HKDF", hash: "SHA-256" } as const;
const WRAP_ALGO = { name: "AES-GCM", length: 256 } as const;
const IV_LEN = 12;
const HKDF_INFO = "interocitor-handshake-v1";

const uint8ToB64url = bytesToBase64Url;
const b64urlToUint8 = base64UrlToBytes;

const toBuffer = asBufferSource;

export async function generateECDHKeypair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(ECDH_PARAMS, true, ["deriveKey", "deriveBits"]);
}

export async function exportECDHPublicKey(key: CryptoKey): Promise<string> {
  return uint8ToB64url(new Uint8Array(await crypto.subtle.exportKey("spki", key)));
}

export async function importECDHPublicKey(spki: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("spki", toBuffer(b64urlToUint8(spki)), ECDH_PARAMS, true, []);
}

async function deriveWrappingKey(myPriv: CryptoKey, peerPub: CryptoKey): Promise<CryptoKey> {
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: peerPub }, myPriv, 256);
  const ikm = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  const info = new TextEncoder().encode(HKDF_INFO);
  return crypto.subtle.deriveKey(
    { ...HKDF_PARAMS, salt: new ArrayBuffer(32), info: toBuffer(info) },
    ikm,
    WRAP_ALGO,
    false,
    ["encrypt", "decrypt"],
  );
}

// ─── Credential envelope ─────────────────────────────────────────────

interface CredentialEnvelope {
  v: 1 | 2;
  iv: string; // base64url AES-GCM IV
  ct: string; // base64url ciphertext of JSON-encoded CredentialPayload
}

interface CredentialPayload {
  remotePath: string;
  passphrase?: string; // base58 passphrase, omitted for unencrypted meshes
  connectionConfig?: string; // recipient-specific final adapter config, encrypted only
}

/** @internal Validate and freeze credentials before an asynchronous handshake. */
export function snapshotHandshakeCredentials(value: unknown): HandshakeCredentials {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid handshake credentials");
  }

  let remotePath: unknown;
  let passphrase: unknown;
  let connectionConfig: unknown;
  try {
    const credentials = value as Record<string, unknown>;
    remotePath = credentials.remotePath;
    passphrase = credentials.passphrase;
    connectionConfig = credentials.connectionConfig;
  } catch {
    throw new TypeError("Invalid handshake credentials");
  }
  if (
    typeof remotePath !== "string" ||
    (passphrase !== null && typeof passphrase !== "string") ||
    (connectionConfig !== undefined && typeof connectionConfig !== "string")
  ) {
    throw new TypeError("Invalid handshake credentials");
  }
  return Object.freeze({
    remotePath,
    passphrase,
    ...(connectionConfig !== undefined && { connectionConfig }),
  });
}

async function encryptCredentials(
  wrappingKey: CryptoKey,
  creds: HandshakeCredentials,
  additionalData?: Uint8Array,
): Promise<string> {
  const stableCredentials = snapshotHandshakeCredentials(creds);
  const payload: CredentialPayload = { remotePath: stableCredentials.remotePath };
  if (stableCredentials.passphrase !== null) {
    payload.passphrase = stableCredentials.passphrase;
  }
  if (stableCredentials.connectionConfig !== undefined) {
    payload.connectionConfig = stableCredentials.connectionConfig;
  }
  const pt = new TextEncoder().encode(JSON.stringify(payload));
  const ivRaw = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const iv = toBuffer(ivRaw);
  const ct = await crypto.subtle.encrypt(
    additionalData === undefined
      ? { name: "AES-GCM", iv }
      : { name: "AES-GCM", iv, additionalData: toBuffer(additionalData) },
    wrappingKey,
    pt,
  );
  const env: CredentialEnvelope = {
    v: additionalData === undefined ? 1 : 2,
    iv: uint8ToB64url(ivRaw),
    ct: uint8ToB64url(new Uint8Array(ct)),
  };
  return JSON.stringify(env);
}

async function decryptCredentials(
  wrappingKey: CryptoKey,
  envelope: string,
  additionalData?: Uint8Array,
): Promise<HandshakeCredentials> {
  const { v, iv, ct } = JSON.parse(envelope) as CredentialEnvelope;
  if (v !== 1 && v !== 2) throw new Error(`Unknown handshake envelope version: ${v}`);
  if (v === 1 && additionalData !== undefined) {
    throw new Error("Pairing capability negotiation requires handshake envelope version 2");
  }
  if (v === 2 && additionalData === undefined) {
    throw new Error("Unexpected capability-bound handshake envelope");
  }
  if (typeof iv !== "string" || typeof ct !== "string") {
    throw new TypeError("Invalid handshake credential envelope");
  }
  const ivBytes = b64urlToUint8(iv);
  const ctBytes = b64urlToUint8(ct);
  const pt = await crypto.subtle.decrypt(
    additionalData === undefined
      ? { name: "AES-GCM", iv: toBuffer(ivBytes) }
      : {
          name: "AES-GCM",
          iv: toBuffer(ivBytes),
          additionalData: toBuffer(additionalData),
        },
    wrappingKey,
    toBuffer(ctBytes),
  );
  const raw = JSON.parse(new TextDecoder().decode(pt)) as CredentialPayload;
  if (
    typeof raw.remotePath !== "string" ||
    (raw.passphrase !== undefined && typeof raw.passphrase !== "string") ||
    (raw.connectionConfig !== undefined && typeof raw.connectionConfig !== "string")
  ) {
    throw new Error("Invalid handshake credentials");
  }
  return {
    remotePath: raw.remotePath,
    passphrase: raw.passphrase ?? null,
    ...(raw.connectionConfig !== undefined && { connectionConfig: raw.connectionConfig }),
  };
}

interface ScannerHello {
  pub: string;
  capabilities?: PairingCapabilities;
}

interface CapabilityTranscript {
  v: 2;
  intent: "share" | "join";
  handshakeId: string;
  generatorPub: string;
  scannerPub: string;
  generatorCapabilities: NormalizedPairingCapabilities;
  scannerCapabilities: NormalizedPairingCapabilities;
}

function parseScannerHello(data: string): ScannerHello {
  const raw = JSON.parse(data) as Partial<ScannerHello>;
  if (
    typeof raw.pub !== "string" ||
    (raw.capabilities !== undefined && !isPairingCapabilities(raw.capabilities))
  ) {
    throw new Error("Invalid handshake scanner hello");
  }
  return {
    pub: raw.pub,
    ...(raw.capabilities !== undefined && { capabilities: raw.capabilities }),
  };
}

function capabilityTranscriptBytes(
  intent: "share" | "join",
  handshakeId: string,
  generatorPub: string,
  scannerPub: string,
  generatorCapabilities: NormalizedPairingCapabilities,
  scannerCapabilities: NormalizedPairingCapabilities,
): Uint8Array | undefined {
  if (generatorCapabilities.required.length === 0 && scannerCapabilities.required.length === 0) {
    return undefined;
  }
  const transcript: CapabilityTranscript = {
    v: 2,
    intent,
    handshakeId,
    generatorPub,
    scannerPub,
    generatorCapabilities,
    scannerCapabilities,
  };
  return new TextEncoder().encode(JSON.stringify(transcript));
}

// ─── Relay paths ─────────────────────────────────────────────────────

function relayPaths(handshakeId: string, relayBase: string) {
  assertValidHandshakeId(handshakeId);
  const base = `${relayBase}/handshake/${handshakeId}`;
  return {
    scannerPub: `${base}/scanner-pub.json`,
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

async function relayCleanup(
  adapter: StorageAdapter,
  paths: { scannerPub: string; credentials: string },
): Promise<void> {
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
  /**
   * Opaque recipient-specific final adapter configuration.
   * It is carried only inside the encrypted credential envelope, never the QR.
   */
  connectionConfig?: string;
}

export interface HandshakeChannelOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
  /** Features supported or required by this participant. */
  capabilities?: PairingCapabilities;
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
    intent: "share" | "join",
    ownCredentials: HandshakeCredentials | null,
    options?: HandshakeChannelOptions,
  ): Promise<HandshakeCredentials | null>;
}

export async function createGeneratorSession(): Promise<GeneratorSession> {
  const keypair = await generateECDHKeypair();
  const generatorPub = await exportECDHPublicKey(keypair.publicKey);

  return {
    generatorPub,
    async complete(adapter, handshakeId, relayBase, intent, ownCredentials, options = {}) {
      assertHandshakeIntent(intent);
      let credentialsToShare: HandshakeCredentials | null = null;
      if (intent === "share") {
        if (!ownCredentials) throw new Error("intent=share requires ownCredentials");
        credentialsToShare = snapshotHandshakeCredentials(ownCredentials);
      }
      const { pollIntervalMs = 2000, timeoutMs = 120_000 } = options;
      const paths = relayPaths(handshakeId, relayBase);
      const generatorCapabilities = normalizePairingCapabilities(options.capabilities);
      assertPairingCapabilitiesCompatible(generatorCapabilities, generatorCapabilities);

      // Wait for the scanner to upload their ephemeral public key.
      const scannerHello = await pollFor(
        async () => {
          const data = await relayRead(adapter, paths.scannerPub);
          if (!data) return null;
          return parseScannerHello(data);
        },
        pollIntervalMs,
        timeoutMs,
      );

      const scannerCapabilities = normalizePairingCapabilities(scannerHello.capabilities);
      assertPairingCapabilitiesCompatible(generatorCapabilities, scannerCapabilities);

      const scannerPublicKey = await importECDHPublicKey(scannerHello.pub);
      const wrappingKey = await deriveWrappingKey(keypair.privateKey, scannerPublicKey);
      const additionalData = capabilityTranscriptBytes(
        intent,
        handshakeId,
        generatorPub,
        scannerHello.pub,
        generatorCapabilities,
        scannerCapabilities,
      );

      if (intent === "share") {
        // Generator has credentials → encrypt and push them for the scanner.
        const envelope = await encryptCredentials(wrappingKey, credentialsToShare!, additionalData);
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
      const credentials = await decryptCredentials(wrappingKey, envelope, additionalData);
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
  payload: HandshakeQRPayload,
  ownCredentials: HandshakeCredentials | null,
  relayBase: string,
  options: HandshakeChannelOptions = {},
): Promise<HandshakeCredentials | null> {
  const stablePayload = snapshotHandshakeQRPayload(payload);
  const { intent, handshakeId, generatorPub } = stablePayload;
  let credentialsToSend: HandshakeCredentials | null = null;
  if (intent === "join") {
    if (!ownCredentials) throw new Error("intent=join requires scanner to have ownCredentials");
    credentialsToSend = snapshotHandshakeCredentials(ownCredentials);
  }
  const { pollIntervalMs = 2000, timeoutMs = 120_000 } = options;
  const paths = relayPaths(handshakeId, relayBase);
  const generatorCapabilities = normalizePairingCapabilities(stablePayload.capabilities);
  const scannerCapabilities = normalizePairingCapabilities(options.capabilities);

  // Reject before publishing a scanner hello or any credentials.
  assertPairingCapabilitiesCompatible(scannerCapabilities, generatorCapabilities);

  const keypair = await generateECDHKeypair();
  const scannerPub = await exportECDHPublicKey(keypair.publicKey);

  // Upload our public key — this signals the generator we are here.
  const scannerCapabilitiesWire = pairingCapabilitiesForWire(scannerCapabilities);
  await relayWrite(
    adapter,
    paths.scannerPub,
    JSON.stringify({
      pub: scannerPub,
      ...(scannerCapabilitiesWire !== undefined && {
        capabilities: scannerCapabilitiesWire,
      }),
    }),
  );

  // Derive the shared wrapping key using the generator's public key from the QR.
  const generatorPublicKey = await importECDHPublicKey(generatorPub);
  const wrappingKey = await deriveWrappingKey(keypair.privateKey, generatorPublicKey);
  const additionalData = capabilityTranscriptBytes(
    intent,
    handshakeId,
    generatorPub,
    scannerPub,
    generatorCapabilities,
    scannerCapabilities,
  );

  if (intent === "share") {
    // Generator will push credentials → wait and decrypt.
    const envelope = await pollFor(
      () => relayRead(adapter, paths.credentials),
      pollIntervalMs,
      timeoutMs,
    );
    const credentials = await decryptCredentials(wrappingKey, envelope, additionalData);
    relayCleanup(adapter, paths).catch(() => {});
    return credentials;
  }
  // intent === 'join': we push credentials to the generator.
  const envelope = await encryptCredentials(wrappingKey, credentialsToSend!, additionalData);
  await relayWrite(adapter, paths.credentials, envelope);
  // Scanner already has credentials; nothing new to return.
  return null;
}
