/**
 * interocitor/handshake
 *
 * Secure device pairing via QR code.
 *
 * Both devices run an interocitor instance with a preconfigured backend
 * adapter. Neither device needs to know the mesh `remotePath` or master
 * key beforehand — everything is bootstrapped through the handshake.
 *
 * ## Two intents
 *
 * A QR code is generated with one of two intents, declared by the
 * **generator** (the device showing the QR):
 *
 *   "share" — I have mesh credentials. Scan me and I will push them to
 *             you through the relay.
 *
 *   "join"  — I want to join a mesh. Scan me and push your credentials
 *             to me through the relay.
 *
 * The **scanner** (the device that reads the QR) always does the
 * opposite: it receives when the generator shares, and it pushes when
 * the generator joins.
 *
 * ## Which device shows the QR?
 *
 *   Desktop already in mesh, Mobile wants to join
 *     → Desktop generates "share" QR, Mobile scans → Mobile joins.
 *
 *   Mobile wants to join, shows QR to Desktop that is already in mesh
 *     → Mobile generates "join" QR, Desktop scans → Mobile joins.
 *
 * ## QR payload — two pieces
 *
 *   Cloud piece  →  handshakeId
 *                   Scopes two relay files on the shared backend.
 *                   Visible in the cloud but useless without the key.
 *
 *   Eyes-only    →  generatorPub (ephemeral ECDH-P256 public key)
 *                   The scanner derives a wrapping key from it via ECDH.
 *                   Only someone who physically saw the QR can do this.
 *
 * remotePath and meshKey are NEVER in the QR. They travel through the
 * relay, encrypted with the ECDH-derived wrapping key.
 *
 * ## Usage
 *
 * ### Generate a "share" QR (device already in mesh)
 *
 * ```ts
 * import { generateShareQR } from 'interocitor';
 *
 * const { qrEncoded, pairUrl, complete } = await generateShareQR({
 *   adapter,
 *   relayBase:  '/Interocitor',   // any path on the shared backend
 *   remotePath: '/Interocitor/team-alpha',
 *   meshKey,                       // CryptoKey | null
 *   pairBaseUrl: 'https://app.example.com/pair',
 * });
 *
 * renderQR(qrEncoded);   // show QR on screen
 * await complete();      // wait for scanner to pick up credentials
 * ```
 *
 * ### Generate a "join" QR (device wanting to join)
 *
 * ```ts
 * import { generateJoinQR } from 'interocitor';
 *
 * const { qrEncoded, pairUrl, credentials } = await generateJoinQR({
 *   adapter,
 *   relayBase: '/Interocitor',
 *   pairBaseUrl: 'https://app.example.com/pair',
 * });
 *
 * renderQR(qrEncoded);
 * const { remotePath, meshKey } = await credentials;
 * // configure engine and connect
 * ```
 *
 * ### Handle a scanned QR / opened pair URL
 *
 * ```ts
 * import { handleScannedQR, parseQRFromUrl } from 'interocitor';
 *
 * const payload = parseQRFromUrl(window.location.hash);
 * // or: const payload = decodeQRPayload(rawQRString);
 *
 * const result = await handleScannedQR({
 *   adapter,
 *   relayBase: '/Interocitor',
 *   payload,
 *   // required when payload.intent === 'join' (scanner must have credentials):
 *   ownCredentials: { remotePath, meshKey },
 * });
 *
 * if (result) {
 *   // intent was 'share' — we received credentials
 *   const { remotePath, meshKey } = result;
 *   if (meshKey) engine.setEncryptionKey(meshKey);
 *   await engine.connect(remotePath);
 * }
 * // intent was 'join' — we pushed credentials, nothing to do on scanner side
 * ```
 */

import type { StorageAdapter } from '../core/types.ts';
import { CloudflareAdapter, type CloudflareHandshakeConfig } from '../adapters/cloudflare.ts';
import {
  encodeQRPayload,
  buildPairUrl,
  type HandshakeQRPayload,
} from './qr.ts';
import {
  createGeneratorSession,
  runScannerHandshake,
  type HandshakeCredentials,
} from './channel.ts';

export {
  encodeQRPayload,
  decodeQRPayload,
  buildPairUrl,
  parseQRFromUrl,
} from './qr.ts';
export type { HandshakeQRPayload, HandshakeIntent } from './qr.ts';
export {
  generateECDHKeypair,
  exportECDHPublicKey,
  importECDHPublicKey,
  createGeneratorSession,
  runScannerHandshake,
} from './channel.ts';
export type { HandshakeCredentials, GeneratorSession } from './channel.ts';

// ─── Helpers ─────────────────────────────────────────────────────────

function generateHandshakeId(): string {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

// ─── generateShareQR ─────────────────────────────────────────────────

export interface GenerateShareQROptions {
  /** Storage adapter connected to the shared backend. */
  adapter: StorageAdapter;
  /**
   * Base path on the backend used for relay files.
   * Relay files are written under `{relayBase}/handshake/{handshakeId}/`.
   * Typically the same root path your mesh uses.
   */
  relayBase: string;
  /** The mesh cloud folder path to share with the joiner. */
  remotePath: string;
  /** Base58 passphrase for the mesh encryption key, or null for unencrypted. */
  passphrase: string | null;
  /** Base URL for the pair link embedded in the QR payload (optional). */
  pairBaseUrl?: string;
  /** Polling interval while waiting for the scanner (ms, default 2000). */
  pollIntervalMs?: number;
  /** Give up after this long (ms, default 120000). */
  timeoutMs?: number;
}

export interface GenerateShareQRResult {
  /** The raw QR payload object. */
  qrPayload: HandshakeQRPayload;
  /** Compact base64url string — pass to any QR library. */
  qrEncoded: string;
  /** Full pair URL with payload in fragment. null if pairBaseUrl not provided. */
  pairUrl: string | null;
  /**
   * Wait for the scanner to pick up the credentials.
   * Resolves when the scanner has read the relay and cleaned up.
   */
  complete(): Promise<void>;
}

/**
 * Generate a "share" QR code. Call this on a device that already belongs
 * to a mesh and wants to invite another device.
 */
export async function generateShareQR(options: GenerateShareQROptions): Promise<GenerateShareQRResult> {
  const { adapter, relayBase, remotePath, passphrase, pairBaseUrl, pollIntervalMs, timeoutMs } = options;

  const session = await createGeneratorSession();
  const handshakeId = generateHandshakeId();

  const adapterConfig = adapter.getHandshakeConfig?.();
  const qrPayload: HandshakeQRPayload = {
    intent: 'share',
    handshakeId,
    generatorPub: session.generatorPub,
    ...(adapterConfig !== undefined && { adapterConfig }),
  };

  return {
    qrPayload,
    qrEncoded: encodeQRPayload(qrPayload),
    pairUrl: pairBaseUrl ? buildPairUrl(pairBaseUrl, qrPayload) : null,
    async complete() {
      await session.complete(
        adapter, handshakeId, relayBase, 'share',
        { remotePath, passphrase },
        { pollIntervalMs, timeoutMs },
      );
    },
  };
}

// ─── generateJoinQR ──────────────────────────────────────────────────

export interface GenerateJoinQROptions {
  /** Storage adapter connected to the shared backend. */
  adapter: StorageAdapter;
  /**
   * Base path on the backend used for relay files.
   * Must match the relayBase used by the scanning device.
   */
  relayBase: string;
  /** Base URL for the pair link embedded in the QR payload (optional). */
  pairBaseUrl?: string;
  /** Polling interval while waiting for credentials (ms, default 2000). */
  pollIntervalMs?: number;
  /** Give up after this long (ms, default 120000). */
  timeoutMs?: number;
}

export interface GenerateJoinQRResult {
  /** The raw QR payload object. */
  qrPayload: HandshakeQRPayload;
  /** Compact base64url string — pass to any QR library. */
  qrEncoded: string;
  /** Full pair URL with payload in fragment. null if pairBaseUrl not provided. */
  pairUrl: string | null;
  /**
   * Resolves with the received credentials once the scanner has pushed them.
   * Configure your engine with these and connect.
   */
  credentials: Promise<HandshakeCredentials>;
}

/**
 * Generate a "join" QR code. Call this on a device that wants to join a mesh
 * but does not yet have credentials. Show this QR to a device that is already
 * in the mesh; that device scans it and pushes credentials.
 */
export async function generateJoinQR(options: GenerateJoinQROptions): Promise<GenerateJoinQRResult> {
  const { adapter, relayBase, pairBaseUrl, pollIntervalMs, timeoutMs } = options;

  const session = await createGeneratorSession();
  const handshakeId = generateHandshakeId();

  const adapterConfig = adapter.getHandshakeConfig?.();
  const qrPayload: HandshakeQRPayload = {
    intent: 'join',
    handshakeId,
    generatorPub: session.generatorPub,
    ...(adapterConfig !== undefined && { adapterConfig }),
  };

  const credentialsPromise = session.complete(
    adapter, handshakeId, relayBase, 'join',
    null, // generator doesn't have credentials — it wants them
    { pollIntervalMs, timeoutMs },
  ).then(result => {
    if (!result) throw new Error('join handshake produced no credentials');
    return result;
  });

  return {
    qrPayload,
    qrEncoded: encodeQRPayload(qrPayload),
    pairUrl: pairBaseUrl ? buildPairUrl(pairBaseUrl, qrPayload) : null,
    credentials: credentialsPromise,
  };
}

function adapterFromPayloadConfig(payload: HandshakeQRPayload): StorageAdapter | null {
  if (!payload.adapterConfig) return null;
  try {
    const cfg = JSON.parse(payload.adapterConfig) as CloudflareHandshakeConfig;
    if (cfg?.baseUrl) return new CloudflareAdapter({ baseUrl: cfg.baseUrl });
  } catch {
    // ignore and fall through
  }
  return null;
}

// ─── handleScannedQR ─────────────────────────────────────────────────

export interface HandleScannedQROptions {
  /**
   * Storage adapter connected to the shared backend.
   * Optional when payload.adapterConfig is present and can reconstruct one.
   */
  adapter?: StorageAdapter;
  /**
   * Base path on the backend used for relay files.
   * Must match the relayBase used by the generating device.
   */
  relayBase: string;
  /** Payload decoded from the scanned QR or opened pair URL. */
  payload: HandshakeQRPayload;
  /**
   * The scanner's own mesh credentials.
   * Required when payload.intent === 'join' (you must push credentials).
   * Ignored when payload.intent === 'share' (you will receive credentials).
   */
  ownCredentials?: HandshakeCredentials;
  /** Polling interval (ms, default 2000). */
  pollIntervalMs?: number;
  /** Give up after this long (ms, default 120000). */
  timeoutMs?: number;
}

/**
 * Handle a scanned QR code or opened pair URL.
 *
 * Returns the received credentials when intent === 'share' (null otherwise,
 * because the scanner already has credentials when intent === 'join').
 */
export async function handleScannedQR(options: HandleScannedQROptions): Promise<HandshakeCredentials | null> {
  const { adapter: explicitAdapter, relayBase, payload, ownCredentials, pollIntervalMs, timeoutMs } = options;
  const adapter = explicitAdapter ?? adapterFromPayloadConfig(payload);
  if (!adapter) {
    throw new Error('handleScannedQR: adapter required when payload has no supported adapterConfig');
  }

  if (payload.intent === 'join' && !ownCredentials) {
    throw new Error(
      'handleScannedQR: ownCredentials required when scanning a "join" QR ' +
      '(the scanner must push credentials to the generator)',
    );
  }

  return runScannerHandshake(
    adapter,
    payload,
    ownCredentials ?? null,
    relayBase,
    { pollIntervalMs, timeoutMs },
  );
}
