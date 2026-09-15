// compass: interocitor.durable-files.file-api

import { decryptBytes, encryptBytes, meshKeyDerivationBase } from "../crypto/encryption.ts";

/**
 * What the remote is allowed to learn about a durable file: nothing beyond
 * the object it stores. The application path, content type, seal taint,
 * plaintext size, and digest travel inside the stored object, under the mesh
 * key, and the object is addressed by a keyed hash of the application path
 * so the remote never sees a client-facing name.
 */

const PATH_INFO = new TextEncoder().encode("interocitor/durable-file-path/v1");
const GUARD_INFO = new TextEncoder().encode("interocitor/durable-file-guard/v1");
const FRAME_VERSION = 1;

/** Plaintext-side description of a stored file, kept inside the frame. */
export interface StoredFileHeader {
  /** Plaintext byte length before any sealing. */
  size: number;
  /** Lowercase hex SHA-256 of the plaintext bytes. */
  digest: string;
  /** Application content type, when the uploader supplied one. */
  contentType?: string;
  /** Seal label when the body is encrypted under an extra key. */
  taint?: string;
}

/**
 * Derive the key that hides application paths from the mesh key.
 *
 * HKDF with a fixed info string keeps the AES-GCM mesh key and the HMAC path
 * key separate even though both come from the same secret.
 */
export async function deriveFilePathKey(meshKey: CryptoKey): Promise<CryptoKey> {
  return deriveHmacKey(meshKey, PATH_INFO);
}

/**
 * HKDF a single-purpose HMAC key out of a mesh or file-seal key.
 *
 * The base key comes from `meshKeyDerivationBase`, not from exporting
 * `secret`: an AES-GCM `CryptoKey` cannot be HKDF input keying material, and
 * the export that used to bridge that gap is what made the mesh key
 * exfiltratable. Core-imported keys carry an HKDF twin of the same bytes
 * instead; an application-supplied seal key still falls back to export, and
 * both paths derive byte-identical output, so object names and seal guards are
 * unchanged.
 */
async function deriveHmacKey(secret: CryptoKey, info: Uint8Array): Promise<CryptoKey> {
  const base = await meshKeyDerivationBase(secret);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: info as BufferSource },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
}

async function hmacHex(key: CryptoKey, text: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text) as BufferSource);
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Proof that a writer holds a sealed file's extra key, bound to the object
 * name. A store that keeps it can refuse to overwrite or delete the object
 * for anyone who cannot present the same value, without learning the seal
 * label or the key: mesh membership alone is not enough to replace a sealed
 * file. Different objects give unrelated guards, so the store cannot group
 * files by key either.
 */
export async function deriveFileGuard(sealKey: CryptoKey, objectName: string): Promise<string> {
  return hmacHex(await deriveHmacKey(sealKey, GUARD_INFO), objectName);
}

/** Normalize an application path: no empty segments, no leading slash. */
export function cleanFilePath(path: string): string {
  const clean = path.split("/").filter(Boolean).join("/");
  if (!clean) throw new Error("Stored object path must not be empty");
  return clean;
}

/**
 * The remote name for an application path: a keyed hash, so the same path
 * always resolves to the same object without an index, and a remote without
 * the mesh key cannot confirm a guessed name.
 */
export async function hideFilePath(pathKey: CryptoKey, path: string): Promise<string> {
  return hmacHex(pathKey, cleanFilePath(path));
}

/**
 * Frame layout: 4-byte big-endian header length, UTF-8 JSON header, body.
 * The frame is what the mesh key encrypts; the body is plaintext or, for a
 * sealed file, an envelope under the extra key.
 */
export function encodeStoredFrame(header: StoredFileHeader, body: Uint8Array): Uint8Array {
  const headerBytes = new TextEncoder().encode(JSON.stringify({ v: FRAME_VERSION, ...header }));
  const out = new Uint8Array(4 + headerBytes.byteLength + body.byteLength);
  new DataView(out.buffer).setUint32(0, headerBytes.byteLength);
  out.set(headerBytes, 4);
  out.set(body, 4 + headerBytes.byteLength);
  return out;
}

export function decodeStoredFrame(frame: Uint8Array): {
  header: StoredFileHeader;
  body: Uint8Array;
} {
  if (frame.byteLength < 4) throw new Error("Stored file frame is truncated");
  const headerLength = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0);
  if (4 + headerLength > frame.byteLength) throw new Error("Stored file frame is truncated");
  const parsed = JSON.parse(
    new TextDecoder().decode(frame.subarray(4, 4 + headerLength)),
  ) as StoredFileHeader & { v: number };
  if (parsed.v !== FRAME_VERSION) throw new Error(`Unknown stored file frame version: ${parsed.v}`);
  const { v: _v, ...header } = parsed;
  return { header, body: frame.subarray(4 + headerLength) };
}

/** Wrap a frame for the remote: under the mesh key when the mesh is encrypted. */
export async function sealStoredFrame(
  meshKey: CryptoKey | null,
  frame: Uint8Array,
): Promise<Uint8Array> {
  return meshKey ? encryptBytes(meshKey, frame) : frame;
}

/** Undo {@link sealStoredFrame}. */
export async function openStoredFrame(
  meshKey: CryptoKey | null,
  stored: Uint8Array,
): Promise<Uint8Array> {
  return meshKey ? decryptBytes(meshKey, stored) : stored;
}
