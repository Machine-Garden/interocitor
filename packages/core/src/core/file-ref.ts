// compass: interocitor.durable-files.file-api

import { asBufferSource } from "../crypto/bytes.ts";
import type { FileRef, StoredFileMetadata } from "./types.ts";

/** Lowercase hex SHA-256 of `bytes`, computed with Web Crypto. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", asBufferSource(bytes)));
  return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Build the row-side reference for a file `putFile` just stored.
 *
 * `path` is the application path (the argument to `putFile`), not the
 * adapter's stored path, so the reference round-trips through `getFile`.
 */
export function toFileRef(path: string, metadata: StoredFileMetadata): FileRef {
  if (!metadata.digest) {
    throw new Error(`Stored file metadata for ${path} carries no digest; use the putFile result`);
  }
  const size = metadata.plaintextSize ?? metadata.size;
  return {
    path,
    digest: metadata.digest,
    size,
    ...(metadata.contentType ? { contentType: metadata.contentType } : {}),
    ...(metadata.taint ? { taint: metadata.taint } : {}),
  };
}

/** Accept either a path or a `FileRef` wherever a file is addressed. */
export function fileTargetPath(target: string | FileRef): string {
  return typeof target === "string" ? target : target.path;
}

/** The digest a caller expects, when they addressed the file by reference. */
export function expectedFileDigest(target: string | FileRef): string | undefined {
  return typeof target === "string" ? undefined : target.digest;
}
