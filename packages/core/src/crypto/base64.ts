// compass: interocitor.trust.encryption

/**
 * Byte ↔ base64 conversion sized for file bodies, not just keys.
 *
 * The obvious `btoa(String.fromCodePoint(...))` loop grows a string one
 * character at a time and costs hundreds of milliseconds of main-thread
 * time for a multi-megabyte image. This module uses the native
 * `Uint8Array#toBase64` / `Uint8Array.fromBase64` when the runtime has them
 * and otherwise converts in 32 KiB chunks, which keeps the whole conversion
 * within a few milliseconds per megabyte. Output is byte-for-byte identical
 * to the loop it replaces, so stored envelopes do not change shape.
 */

const CHUNK = 0x8000;

type NativeEncode = (options?: {
  alphabet?: "base64" | "base64url";
  omitPadding?: boolean;
}) => string;
type NativeDecode = (
  text: string,
  options?: { alphabet?: "base64" | "base64url" },
) => Uint8Array<ArrayBuffer>;

function nativeEncode(bytes: Uint8Array): NativeEncode | undefined {
  const fn = (bytes as unknown as { toBase64?: NativeEncode }).toBase64;
  return typeof fn === "function" ? fn.bind(bytes) : undefined;
}

const nativeDecode: NativeDecode | undefined = (() => {
  const fn = (Uint8Array as unknown as { fromBase64?: NativeDecode }).fromBase64;
  return typeof fn === "function" ? fn.bind(Uint8Array) : undefined;
})();

function bytesToBinaryString(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCodePoint.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return binary;
}

function binaryStringToBytes(binary: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.codePointAt(i)!;
  return out;
}

/** Standard base64 with padding, as `btoa` would produce. */
export function bytesToBase64(bytes: Uint8Array): string {
  const native = nativeEncode(bytes);
  return native ? native() : btoa(bytesToBinaryString(bytes));
}

/** Decode standard base64; tolerant of missing padding like `atob`. */
export function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  if (nativeDecode) return nativeDecode(text);
  return binaryStringToBytes(atob(text));
}

/** URL-safe base64 without padding. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  const native = nativeEncode(bytes);
  if (native) return native({ alphabet: "base64url", omitPadding: true });
  return bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Decode URL-safe base64 with or without padding. */
export function base64UrlToBytes(text: string): Uint8Array<ArrayBuffer> {
  if (nativeDecode) return nativeDecode(text, { alphabet: "base64url" });
  const standard = text.replaceAll("-", "+").replaceAll("_", "/");
  return binaryStringToBytes(atob(standard + "=".repeat((4 - (standard.length % 4)) % 4)));
}
