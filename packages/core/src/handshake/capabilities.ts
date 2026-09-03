/**
 * Capability identifiers understood by the core pairing protocol.
 *
 * Capability ids remain strings on the wire so a deployment can require
 * features unknown to a peer. Unknown required ids must fail closed rather
 * than being discarded during decoding.
 */

export const INDIRECT_MESH_ROUTING_V1 = "mesh-routing:indirect:v1" as const;

export const MESH_GRANT_AUTHORIZATION_V1 = "mesh-authorization:grant:v1" as const;

export type PairingCapabilityId = string;

export interface PairingCapabilities {
  /** Features this client and adapter combination can complete. */
  readonly supported: readonly PairingCapabilityId[];
  /** Features the peer must support before received credentials may be accepted. */
  readonly required?: readonly PairingCapabilityId[];
}

export interface NormalizedPairingCapabilities {
  readonly supported: readonly string[];
  readonly required: readonly string[];
}

const MAX_CAPABILITIES = 32;
const MAX_CAPABILITY_ID_LENGTH = 128;

function sortedStrings(values: Iterable<string>): string[] {
  const result = [...values];
  // eslint-disable-next-line unicorn/no-array-sort -- core targets ES2022 without Array.prototype.toSorted.
  return result.sort();
}

function snapshotCapabilityIds(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`Invalid pairing capabilities: ${field} must be an array`);
  }
  const length = value.length;
  if (length > MAX_CAPABILITIES) {
    throw new TypeError(
      `Invalid pairing capabilities: ${field} must contain at most ${MAX_CAPABILITIES} ids`,
    );
  }

  const ids: string[] = [];
  for (let index = 0; index < length; index++) {
    if (!(index in value)) {
      throw new TypeError(`Invalid pairing capabilities: ${field} must not contain holes`);
    }
    const candidate = value[index];
    if (
      typeof candidate !== "string" ||
      candidate.length === 0 ||
      candidate.length > MAX_CAPABILITY_ID_LENGTH
    ) {
      throw new TypeError(`Invalid pairing capabilities: ${field} contains an invalid id`);
    }
    ids.push(candidate);
  }
  return Object.freeze(ids);
}

/** @internal Validate and freeze a capability profile without changing wire order. */
export function snapshotPairingCapabilities(value: unknown): PairingCapabilities {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid pairing capabilities");
  }

  let supported: unknown;
  let required: unknown;
  try {
    const profile = value as Record<string, unknown>;
    supported = profile.supported;
    required = profile.required;
  } catch {
    throw new TypeError("Invalid pairing capabilities");
  }

  return Object.freeze({
    supported: snapshotCapabilityIds(supported, "supported"),
    ...(required === undefined ? {} : { required: snapshotCapabilityIds(required, "required") }),
  });
}

/** @internal Validate and canonicalize a capability profile. */
export function normalizePairingCapabilities(
  value?: PairingCapabilities | null,
): NormalizedPairingCapabilities {
  if (value === undefined || value === null) {
    return Object.freeze({ supported: Object.freeze([]), required: Object.freeze([]) });
  }
  const snapshot = snapshotPairingCapabilities(value);

  return Object.freeze({
    supported: Object.freeze(sortedStrings(new Set(snapshot.supported))),
    required:
      snapshot.required === undefined
        ? Object.freeze([])
        : Object.freeze(sortedStrings(new Set(snapshot.required))),
  });
}

/** @internal Structural validation for decoded wire values. */
export function isPairingCapabilities(value: unknown): value is PairingCapabilities {
  try {
    normalizePairingCapabilities(value as PairingCapabilities);
    return value !== null && typeof value === "object";
  } catch {
    return false;
  }
}

/** @internal Merge profiles without allowing a caller to remove requirements. */
export function mergePairingCapabilities(
  ...values: Array<PairingCapabilities | null | undefined>
): NormalizedPairingCapabilities {
  const supported = new Set<string>();
  const required = new Set<string>();
  for (const value of values) {
    const normalized = normalizePairingCapabilities(value);
    for (const id of normalized.supported) supported.add(id);
    for (const id of normalized.required) required.add(id);
  }
  return normalizePairingCapabilities({
    supported: sortedStrings(supported),
    required: sortedStrings(required),
  });
}

/** @internal Omit an empty profile from the capability-free QR and relay shape. */
export function pairingCapabilitiesForWire(
  value: NormalizedPairingCapabilities,
): PairingCapabilities | undefined {
  if (value.supported.length === 0 && value.required.length === 0) return undefined;
  return Object.freeze({
    supported: Object.freeze([...value.supported]),
    ...(value.required.length > 0 && { required: Object.freeze([...value.required]) }),
  });
}

export class UnsupportedPairingCapabilityError extends Error {
  readonly code = "UNSUPPORTED_PAIRING_CAPABILITY" as const;
  readonly missingCapabilities: readonly string[];

  constructor(missingCapabilities: readonly string[]) {
    const missing = sortedStrings(new Set(missingCapabilities));
    super(`Pairing requires unsupported capabilities: ${missing.join(", ")}`);
    this.name = "UnsupportedPairingCapabilityError";
    this.missingCapabilities = Object.freeze(missing);
  }
}

/** @internal Require both participants to support every required feature. */
export function assertPairingCapabilitiesCompatible(
  local: NormalizedPairingCapabilities,
  peer: NormalizedPairingCapabilities,
): void {
  const localMissing = local.required.filter((id) => !local.supported.includes(id));
  const unsupportedLocally = peer.required.filter((id) => !local.supported.includes(id));
  const unsupportedByPeer = local.required.filter((id) => !peer.supported.includes(id));
  const peerMissing = peer.required.filter((id) => !peer.supported.includes(id));
  const missing = [...localMissing, ...unsupportedLocally, ...unsupportedByPeer, ...peerMissing];
  if (missing.length > 0) throw new UnsupportedPairingCapabilityError(missing);
}
