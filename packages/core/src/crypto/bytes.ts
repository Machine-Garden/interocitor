/**
 * View `bytes` as a `BufferSource` without copying.
 *
 * Web Crypto honours a view's `byteOffset`/`byteLength`, so slicing the
 * backing buffer before `crypto.subtle.*` only costs an extra copy. TypeScript
 * widens `Uint8Array` to `Uint8Array<ArrayBufferLike>` because the backing
 * store could in theory be a `SharedArrayBuffer`; this codebase never creates
 * one, so the cast is safe.
 */
export function asBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes as Uint8Array<ArrayBuffer>;
}
