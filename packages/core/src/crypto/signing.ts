// compass: interocitor.trust.signing

/**
 * Signing layer — ECDSA P-256 / SHA-256 via Web Crypto API.
 *
 * Asymmetric signatures: a private key signs data, the matching public key
 * verifies it. Unlike the mesh key (symmetric AES-GCM) and the pairing
 * channel (ECDH key agreement), signing keys are about *authenticity* and
 * *integrity*, not confidentiality. Signed payloads are not secret — anyone
 * with the public key can read and verify them.
 *
 * `signToken`/`verifyToken` produce a compact, JWT-shaped token on our own
 * terms: `base64url(claims).base64url(signature)`. There is no algorithm
 * negotiation and no JOSE header — the algorithm is fixed (ES256), so a token
 * cannot be downgraded by an attacker rewriting a header. Claims are a plain
 * JSON object the caller controls; this module only adds/checks `iat`/`exp`
 * when asked.
 *
 * @example
 * ```ts
 * import {
 *   generateSigningKeypair,
 *   exportPublicKey,
 *   importPublicKey,
 *   signToken,
 *   verifyToken,
 * } from '@interocitor/core/crypto/signing';
 *
 * const { privateKey, publicKey } = await generateSigningKeypair();
 * const token = await signToken(privateKey, { sub: 'device-1', scope: 'read' });
 *
 * // Anyone holding the exported public key can verify:
 * const pub = await exportPublicKey(publicKey);
 * const claims = await verifyToken(await importPublicKey(pub), token);
 * // claims => { sub: 'device-1', scope: 'read' } or null if invalid/expired
 * ```
 */

const ECDSA_PARAMS = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN_ALGO = { name: "ECDSA", hash: "SHA-256" } as const;

// ─── base64url helpers ───────────────────────────────────────────────

function uint8ToB64url(b: Uint8Array): string {
  let s = "";
  for (const byte of b) s += String.fromCodePoint(byte);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function b64urlToUint8(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replaceAll("-", "+").replaceAll("_", "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.codePointAt(i)!;
  return out;
}

function toBuffer(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

// ─── Key generation & transport ──────────────────────────────────────

/** Generate an ECDSA P-256 signing keypair. The private key is extractable
 *  so it can be exported for backup/custody; keep it secret. */
export async function generateSigningKeypair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(ECDSA_PARAMS, true, ["sign", "verify"]);
}

/** Export the public key as a base64url SPKI string (safe to publish). */
export async function exportPublicKey(key: CryptoKey): Promise<string> {
  return uint8ToB64url(new Uint8Array(await crypto.subtle.exportKey("spki", key)));
}

/** Import a public key from a base64url SPKI string produced by exportPublicKey. */
export async function importPublicKey(spki: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("spki", toBuffer(b64urlToUint8(spki)), ECDSA_PARAMS, true, [
    "verify",
  ]);
}

/** Export the private key as a base64url PKCS#8 string. Treat as a secret. */
export async function exportPrivateKey(key: CryptoKey): Promise<string> {
  return uint8ToB64url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", key)));
}

/** Import a private key from a base64url PKCS#8 string produced by exportPrivateKey. */
export async function importPrivateKey(pkcs8: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", toBuffer(b64urlToUint8(pkcs8)), ECDSA_PARAMS, true, [
    "sign",
  ]);
}

// ─── Raw byte signing ────────────────────────────────────────────────

/** Sign raw bytes; returns the base64url signature (P-1363 r||s, 64 bytes). */
export async function sign(privateKey: CryptoKey, data: Uint8Array): Promise<string> {
  const sig = await crypto.subtle.sign(SIGN_ALGO, privateKey, toBuffer(data));
  return uint8ToB64url(new Uint8Array(sig));
}

/** Verify a base64url signature over raw bytes. */
export async function verify(
  publicKey: CryptoKey,
  data: Uint8Array,
  signature: string,
): Promise<boolean> {
  try {
    return await crypto.subtle.verify(
      SIGN_ALGO,
      publicKey,
      toBuffer(b64urlToUint8(signature)),
      toBuffer(data),
    );
  } catch {
    return false;
  }
}

// ─── Token (JWT-shaped, on our terms) ────────────────────────────────

export type SignedClaims = Record<string, unknown>;

export interface SignTokenOptions {
  /** Seconds until expiry. When set, an `exp` claim (epoch seconds) is added. */
  expiresInSeconds?: number;
  /** Override the issued-at time (epoch seconds). Defaults to now. */
  issuedAt?: number;
}

export interface VerifyTokenOptions {
  /** Reject tokens whose `exp` is in the past. Default: true. */
  checkExpiry?: boolean;
  /** Clock-skew tolerance in seconds when checking `exp`. Default: 0. */
  toleranceSeconds?: number;
}

/**
 * Create a compact signed token: `base64url(claims).base64url(signature)`.
 *
 * The signed bytes are exactly the encoded-claims segment, so verification is
 * unambiguous and there is no header to tamper with. The algorithm is fixed
 * (ES256) and never read from the token.
 */
export async function signToken(
  privateKey: CryptoKey,
  claims: SignedClaims,
  options: SignTokenOptions = {},
): Promise<string> {
  const now = options.issuedAt ?? Math.floor(Date.now() / 1000);
  const body: SignedClaims = { iat: now, ...claims };
  if (options.expiresInSeconds !== undefined) {
    body.exp = now + options.expiresInSeconds;
  }
  const encodedClaims = uint8ToB64url(new TextEncoder().encode(JSON.stringify(body)));
  const signingInput = new TextEncoder().encode(encodedClaims);
  const signature = await sign(privateKey, signingInput);
  return `${encodedClaims}.${signature}`;
}

/**
 * Verify a token produced by signToken and return its claims, or `null` if the
 * signature is invalid, the token is malformed, or it has expired.
 */
export async function verifyToken(
  publicKey: CryptoKey,
  token: string,
  options: VerifyTokenOptions = {},
): Promise<SignedClaims | null> {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const encodedClaims = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  const ok = await verify(publicKey, new TextEncoder().encode(encodedClaims), signature);
  if (!ok) return null;

  let claims: SignedClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlToUint8(encodedClaims))) as SignedClaims;
  } catch {
    return null;
  }

  const checkExpiry = options.checkExpiry ?? true;
  if (checkExpiry && typeof claims.exp === "number") {
    const now = Math.floor(Date.now() / 1000);
    if (now > claims.exp + (options.toleranceSeconds ?? 0)) return null;
  }

  return claims;
}
