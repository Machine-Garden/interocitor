/**
 * Structured ID generation and validation.
 *
 * Device IDs: UUIDv7 — timestamp + random, client-generated.
 * Checksummed IDs: UUIDv7 + HMAC tag — optional authority-issued values that
 *                  a Worker can accept as mesh addresses.
 * Row IDs:    UUID v4/v7 with optional prefix — client-generated.
 */

// ─── UUIDv7 ──────────────────────────────────────────────────────────

/**
 * Generate a UUIDv7: 48-bit ms timestamp + 74 bits random, RFC 9562.
 * Sortable by creation time. Globally unique without coordination.
 */
export function uuidv7(): string {
  const now = Date.now();

  // 6 bytes timestamp (48-bit ms)
  const tsBytes = new Uint8Array(6);
  let ts = now;
  for (let i = 5; i >= 0; i--) {
    tsBytes[i] = ts & 0xff;
    ts = Math.floor(ts / 256);
  }

  // 10 bytes random
  const randBytes = crypto.getRandomValues(new Uint8Array(10));

  // Assemble 16 bytes
  const bytes = new Uint8Array(16);
  bytes.set(tsBytes, 0);
  bytes.set(randBytes, 6);

  // Set version 7 (bits 48-51)
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  // Set variant 10xx (bits 64-65)
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  // Format as UUID string
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

// ─── Device IDs ──────────────────────────────────────────────────────

/** Generate a device ID. UUIDv7 — sortable, globally unique. */
export function createDeviceId(): string {
  return uuidv7();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Validate a device ID (must be UUIDv7). */
export function isValidDeviceId(id: unknown): id is string {
  return typeof id === "string" && UUID_RE.test(id);
}

// ─── Mesh / Team IDs ─────────────────────────────────────────────────

/**
 * Issue a checksummed mesh ID with an embedded HMAC tag.
 *
 * Layout (opaque string):
 *   <uuidv7>.<tag>
 *
 * Where tag = base64url(HMAC-SHA256(secret, uuidv7))[0..10]
 *
 * Only callers with the secret can mint a value accepted by
 * `isValidMeshId(id, secret)`. This proves issuance by that authority; it
 * does not authenticate a requester. A Worker's route address may instead be
 * a stable name admitted by its own integrity gate.
 *
 * @param secret — HMAC key (CryptoKey or raw bytes). Workers hold this.
 */
export async function issueMeshId(secret: CryptoKey): Promise<string> {
  const id = uuidv7();
  const tag = await computeTag(id, secret);
  return `${id}.${tag}`;
}

/**
 * Validate a mesh ID: format check + HMAC tag verification.
 *
 * @param id     — the full mesh ID string (uuid.tag)
 * @param secret — same HMAC key used to issue
 */
export async function isValidMeshId(id: unknown, secret: CryptoKey): Promise<boolean> {
  if (typeof id !== "string") return false;
  const dot = id.lastIndexOf(".");
  if (dot === -1) return false;
  const uuid = id.slice(0, dot);
  const tag = id.slice(dot + 1);
  if (!UUID_RE.test(uuid) || !tag) return false;
  const expected = await computeTag(uuid, secret);
  return timingSafeEqual(tag, expected);
}

/**
 * Parse a mesh ID into its parts. Does NOT verify tag.
 */
export function parseMeshId(id: string): { uuid: string; tag: string } | null {
  const dot = id.lastIndexOf(".");
  if (dot === -1) return null;
  const uuid = id.slice(0, dot);
  const tag = id.slice(dot + 1);
  if (!UUID_RE.test(uuid) || !tag) return null;
  return { uuid, tag };
}

/**
 * Create a mesh HMAC secret key for use with issueMeshId / isValidMeshId.
 */
export async function createMeshSecret(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, true, ["sign", "verify"]);
}

// ─── Internal helpers ────────────────────────────────────────────────

const encoder = new TextEncoder();

async function computeTag(data: string, secret: CryptoKey): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", secret, encoder.encode(data));
  // Take first 8 bytes (64 bits) → base64url (11 chars)
  const bytes = new Uint8Array(sig, 0, 8);
  return base64url(bytes);
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCodePoint(bytes[i]!);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Constant-time string comparison to prevent timing attacks on tag. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.codePointAt(i)! ^ b.codePointAt(i)!;
  }
  return result === 0;
}
