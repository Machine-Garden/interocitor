const HANDSHAKE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** @internal Whether a relay session id is one bounded, URL-safe path segment. */
export function isValidHandshakeId(value: unknown): value is string {
  return typeof value === "string" && HANDSHAKE_ID_PATTERN.test(value);
}

/** @internal Reject a relay session id before constructing an adapter path. */
export function assertValidHandshakeId(value: unknown): asserts value is string {
  if (!isValidHandshakeId(value)) {
    throw new TypeError("Invalid handshake id");
  }
}

/** @internal Create a random 12-byte lowercase-hex relay session id. */
export function generateHandshakeId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}
