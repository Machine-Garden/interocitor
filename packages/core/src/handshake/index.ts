// compass: interocitor.trust.pairing

/**
 * @interocitor/core handshake API
 *
 * Secure device pairing via QR code.
 *
 * Both devices must be able to reach and authenticate to the relay backend.
 * An optional adapterConfig in the payload can identify the endpoint, but it
 * must not contain storage credentials.
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
 * ## QR or pair-link payload
 *
 *   Cloud piece  →  handshakeId
 *                   Scopes two relay files on the shared backend.
 *                   Carries no decryption key or authorization by itself.
 *
 *   Invitation   →  generatorPub (ephemeral ECDH-P256 public key)
 *                   The scanner derives a wrapping key from it via ECDH.
 *
 * Treat the complete QR or pair URL as a short-lived invitation capability:
 * anyone who obtains it and can access the relay can act as the scanner.
 * remotePath, passphrase, and optional recipient-specific connectionConfig are
 * not in the payload. They travel through the relay in the ECDH-encrypted
 * credential envelope. Capability metadata is public negotiation state.
 *
 * ## Usage
 *
 * ### Generate a "share" QR (device already in mesh)
 *
 * ```ts
 * import { generateShareQR } from '@interocitor/core';
 *
 * const { qrEncoded, pairUrl, complete } = await generateShareQR({
 *   adapter,
 *   relayBase:  '/Interocitor',   // any path on the shared backend
 *   remotePath: '/Interocitor/team-alpha',
 *   passphrase: keySource.getPortableKey(), // base58 string or null
 *   pairBaseUrl: 'https://app.example.com/pair',
 * });
 *
 * renderQR(qrEncoded);   // show QR on screen
 * await complete();      // publish credentials after receiving the scanner hello
 * ```
 *
 * ### Generate a "join" QR (device wanting to join)
 *
 * ```ts
 * import {
 *   generateJoinQR,
 *   Interocitor,
 *   PortablePassphraseKeySource,
 * } from '@interocitor/core';
 *
 * const { qrEncoded, pairUrl, credentials } = await generateJoinQR({
 *   adapter,
 *   relayBase: '/Interocitor',
 *   pairBaseUrl: 'https://app.example.com/pair',
 * });
 *
 * renderQR(qrEncoded);
 * const received = await credentials;
 * const db = new Interocitor(adapter, {
 *   remotePath: received.remotePath,
 *   localStore,
 *   keySource: received.passphrase === null
 *     ? null
 *     : new PortablePassphraseKeySource({ portableKey: received.passphrase }),
 * });
 * await db.init();
 * await db.connect();
 * ```
 *
 * ### Handle a scanned QR / opened pair URL
 *
 * ```ts
 * import { handleScannedQR, parseQRFromUrl } from '@interocitor/core';
 *
 * const payload = parseQRFromUrl(urlFragment);
 * // or: const payload = decodeQRPayload(rawQRString);
 *
 * const result = await handleScannedQR({
 *   adapter,
 *   relayBase: '/Interocitor',
 *   payload,
 *   // required when payload.intent === 'join' (scanner must have credentials):
 *   ownCredentials: { remotePath, passphrase: keySource.getPortableKey() },
 * });
 *
 * if (result) {
 *   // intent was 'share'; this application helper constructs a new engine
 *   await connectReceivedCredentials(result.remotePath, result.passphrase);
 * }
 * // intent was 'join' — we pushed credentials, nothing to do on scanner side
 * ```
 */

import type { StorageAdapter } from "../core/types.ts";
import {
  encodeQRPayload,
  buildPairUrl,
  snapshotHandshakeQRPayload,
  type HandshakeQRPayload,
} from "./qr.ts";
import {
  createGeneratorSession,
  runScannerHandshake,
  snapshotHandshakeCredentials,
  type HandshakeCredentials,
} from "./channel.ts";
import {
  assertPairingCapabilitiesCompatible,
  mergePairingCapabilities,
  pairingCapabilitiesForWire,
  snapshotPairingCapabilities,
  type PairingCapabilities,
} from "./capabilities.ts";
import { generateHandshakeId } from "./handshake-id.ts";

export { encodeQRPayload, decodeQRPayload, buildPairUrl, parseQRFromUrl } from "./qr.ts";
export type { HandshakeQRPayload, HandshakeIntent } from "./qr.ts";
export {
  INDIRECT_MESH_ROUTING_V1,
  MESH_GRANT_AUTHORIZATION_V1,
  UnsupportedPairingCapabilityError,
} from "./capabilities.ts";
export type { PairingCapabilities, PairingCapabilityId } from "./capabilities.ts";
export {
  generateECDHKeypair,
  exportECDHPublicKey,
  importECDHPublicKey,
  createGeneratorSession,
  runScannerHandshake,
} from "./channel.ts";
export type { HandshakeChannelOptions, HandshakeCredentials, GeneratorSession } from "./channel.ts";

// ─── Helpers ─────────────────────────────────────────────────────────

async function resolvePairingCapabilities(
  adapter: StorageAdapter,
  explicit?: PairingCapabilities,
): Promise<PairingCapabilities | undefined> {
  const explicitCapabilities =
    explicit === undefined ? undefined : snapshotPairingCapabilities(explicit);
  const reportedAdapterCapabilities = await adapter.getPairingCapabilities?.();
  const adapterCapabilities =
    reportedAdapterCapabilities === undefined || reportedAdapterCapabilities === null
      ? undefined
      : snapshotPairingCapabilities(reportedAdapterCapabilities);
  const capabilities = mergePairingCapabilities(adapterCapabilities, explicitCapabilities);
  assertPairingCapabilitiesCompatible(capabilities, capabilities);
  return pairingCapabilitiesForWire(capabilities);
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
  /**
   * Opaque recipient-specific final adapter configuration.
   * Sent only inside the encrypted credential envelope.
   */
  connectionConfig?: string;
  /** Additional client capabilities, unioned with adapter capabilities. */
  capabilities?: PairingCapabilities;
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
   * Wait for scanner hello, then publish the encrypted credentials.
   * Resolution does not acknowledge scanner receipt or relay cleanup.
   */
  complete(): Promise<void>;
}

/**
 * Generate a "share" QR code. Call this on a device that already belongs
 * to a mesh and wants to invite another device.
 *
 * @see {@link ../../docs/pairing.md | Pair devices}
 *   — what crosses the relay, what stays on the two devices, and the
 *   capability negotiation both sides have to agree on.
 */
export async function generateShareQR(
  options: GenerateShareQROptions,
): Promise<GenerateShareQRResult> {
  const {
    adapter,
    relayBase,
    remotePath,
    passphrase,
    connectionConfig,
    capabilities,
    pairBaseUrl,
    pollIntervalMs,
    timeoutMs,
  } = options;
  const credentials = snapshotHandshakeCredentials({
    remotePath,
    passphrase,
    ...(connectionConfig !== undefined && { connectionConfig }),
  });
  const stableCapabilities =
    capabilities === undefined ? undefined : snapshotPairingCapabilities(capabilities);

  const session = await createGeneratorSession();
  const handshakeId = generateHandshakeId();
  const resolvedCapabilities = await resolvePairingCapabilities(adapter, stableCapabilities);

  const adapterConfig = adapter.getHandshakeConfig?.();
  const qrPayload: HandshakeQRPayload = {
    intent: "share",
    handshakeId,
    generatorPub: session.generatorPub,
    ...(adapterConfig !== undefined && { adapterConfig }),
    ...(resolvedCapabilities !== undefined && { capabilities: resolvedCapabilities }),
  };

  return {
    qrPayload,
    qrEncoded: encodeQRPayload(qrPayload),
    pairUrl: pairBaseUrl ? buildPairUrl(pairBaseUrl, qrPayload) : null,
    async complete() {
      await session.complete(adapter, handshakeId, relayBase, "share", credentials, {
        pollIntervalMs,
        timeoutMs,
        capabilities: resolvedCapabilities,
      });
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
  /** Additional client capabilities, unioned with adapter capabilities. */
  capabilities?: PairingCapabilities;
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
export async function generateJoinQR(
  options: GenerateJoinQROptions,
): Promise<GenerateJoinQRResult> {
  const { adapter, relayBase, capabilities, pairBaseUrl, pollIntervalMs, timeoutMs } = options;
  const stableCapabilities =
    capabilities === undefined ? undefined : snapshotPairingCapabilities(capabilities);

  const session = await createGeneratorSession();
  const handshakeId = generateHandshakeId();
  const resolvedCapabilities = await resolvePairingCapabilities(adapter, stableCapabilities);

  const adapterConfig = adapter.getHandshakeConfig?.();
  const qrPayload: HandshakeQRPayload = {
    intent: "join",
    handshakeId,
    generatorPub: session.generatorPub,
    ...(adapterConfig !== undefined && { adapterConfig }),
    ...(resolvedCapabilities !== undefined && { capabilities: resolvedCapabilities }),
  };

  const credentialsPromise = session
    .complete(
      adapter,
      handshakeId,
      relayBase,
      "join",
      null, // generator doesn't have credentials — it wants them
      { pollIntervalMs, timeoutMs, capabilities: resolvedCapabilities },
    )
    .then((result) => {
      if (!result) throw new Error("join handshake produced no credentials");
      return result;
    });

  return {
    qrPayload,
    qrEncoded: encodeQRPayload(qrPayload),
    pairUrl: pairBaseUrl ? buildPairUrl(pairBaseUrl, qrPayload) : null,
    credentials: credentialsPromise,
  };
}

// ─── handleScannedQR ─────────────────────────────────────────────────

export interface HandleScannedQROptions {
  /**
   * Storage adapter connected to the shared backend.
   * Optional only when `adapterFromConfig` can reconstruct one from the QR.
   */
  adapter?: StorageAdapter;
  /**
   * Runtime-owned adapter factory for QR payloads that include adapterConfig.
   * Core treats the string as opaque.
   */
  adapterFromConfig?: (
    adapterConfig: string,
  ) => StorageAdapter | null | Promise<StorageAdapter | null>;
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
  /** Additional client capabilities, unioned with adapter capabilities. */
  capabilities?: PairingCapabilities;
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
 *
 * @see {@link ../../docs/pairing.md | Pair devices}
 *   — both intents side by side, and the URL-fragment form of the same
 *   payload.
 */
export async function handleScannedQR(
  options: HandleScannedQROptions,
): Promise<HandshakeCredentials | null> {
  const {
    adapter: explicitAdapter,
    adapterFromConfig,
    relayBase,
    payload: unsafePayload,
    ownCredentials,
    capabilities,
    pollIntervalMs,
    timeoutMs,
  } = options;
  const payload = snapshotHandshakeQRPayload(unsafePayload);
  const stableCapabilities =
    capabilities === undefined ? undefined : snapshotPairingCapabilities(capabilities);
  if (payload.intent === "join" && !ownCredentials) {
    throw new Error(
      'handleScannedQR: ownCredentials required when scanning a "join" QR ' +
        "(the scanner must push credentials to the generator)",
    );
  }
  const stableOwnCredentials =
    payload.intent === "join" ? snapshotHandshakeCredentials(ownCredentials) : null;

  const adapter =
    explicitAdapter ??
    (payload.adapterConfig && adapterFromConfig
      ? await adapterFromConfig(payload.adapterConfig)
      : null);
  if (!adapter) {
    throw new Error(
      "handleScannedQR: adapter required when payload has no runtime adapter factory",
    );
  }

  const resolvedCapabilities = await resolvePairingCapabilities(adapter, stableCapabilities);

  return runScannerHandshake(adapter, payload, stableOwnCredentials, relayBase, {
    pollIntervalMs,
    timeoutMs,
    capabilities: resolvedCapabilities,
  });
}
