// compass: interocitor.durable-files.image-helpers

import type { Interocitor, StoredFileMetadata } from "@interocitor/core";

export type ImageInput = Blob | ArrayBuffer | Uint8Array | string;

export interface PutImageOptions {
  /** Override content type. Defaults to Blob type, data URL media type, or path extension. */
  contentType?: string;
}

export interface StoredImageMetadata extends StoredFileMetadata {
  contentType: string;
}

export interface StoredImage {
  path: string;
  data: Uint8Array;
  blob: Blob;
  metadata: StoredImageMetadata | null;
  contentType: string;
}

export interface StoredImageBlobUrl {
  path: string;
  url: string;
  blob: Blob;
  metadata: StoredImageMetadata | null;
  contentType: string;
  revoke(): void;
}

function inferImageContentType(path: string, explicit?: string | null): string {
  if (explicit) {
    if (!explicit.toLowerCase().startsWith("image/")) {
      throw new Error(`Image content type must start with image/: ${explicit}`);
    }
    return explicit;
  }
  const ext = path.split("?")[0]?.split("#")[0]?.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "avif":
      return "image/avif";
    case "bmp":
      return "image/bmp";
    case "ico":
      return "image/x-icon";
    default:
      return "image/png";
  }
}

/**
 * Decode a data URL body without building a binary string one character at
 * a time; a pasted photo can be megabytes of base64.
 */
function decodeBase64Payload(payload: string): Uint8Array {
  const native = (Uint8Array as unknown as { fromBase64?: (text: string) => Uint8Array })
    .fromBase64;
  if (typeof native === "function") return native.call(Uint8Array, payload);
  const binary = atob(payload);
  const data = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) data[i] = binary.codePointAt(i)!;
  return data;
}

function parseImageDataUrl(dataUrl: string): { data: Uint8Array; contentType?: string } | null {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  const contentType = match[1] || undefined;
  const isBase64 = Boolean(match[2]);
  const payload = match[3] ?? "";
  if (isBase64) {
    return { data: decodeBase64Payload(payload.replaceAll(/\s+/g, "")), contentType };
  }
  return { data: new TextEncoder().encode(decodeURIComponent(payload)), contentType };
}

async function encodeImageInput(
  input: ImageInput,
  path: string,
  contentType?: string,
): Promise<{ data: Uint8Array; contentType: string }> {
  if (input instanceof Blob) {
    const type = inferImageContentType(path, contentType || input.type || undefined);
    return { data: new Uint8Array(await input.arrayBuffer()), contentType: type };
  }
  if (typeof input === "string") {
    const parsed = parseImageDataUrl(input);
    if (parsed)
      return {
        data: parsed.data,
        contentType: inferImageContentType(path, contentType || parsed.contentType),
      };
    return {
      data: new TextEncoder().encode(input),
      contentType: inferImageContentType(path, contentType || "image/svg+xml"),
    };
  }
  if (input instanceof Uint8Array)
    return { data: input, contentType: inferImageContentType(path, contentType) };
  if (input instanceof ArrayBuffer)
    return { data: new Uint8Array(input), contentType: inferImageContentType(path, contentType) };
  throw new Error("Unsupported image input in this runtime");
}

function coerceImageMetadata(
  meta: StoredFileMetadata | null,
  contentType: string,
): StoredImageMetadata | null {
  if (!meta) return null;
  return {
    ...meta,
    contentType: inferImageContentType(meta.path, meta.contentType || contentType),
  };
}

export async function putImage<
  S extends Record<string, Record<string, unknown>> = Record<string, Record<string, unknown>>,
>(
  db: Interocitor<S>,
  path: string,
  image: ImageInput,
  options: PutImageOptions = {},
): Promise<StoredImageMetadata> {
  const encoded = await encodeImageInput(image, path, options.contentType);
  const meta = await db.putFile(path, encoded.data, encoded.contentType);
  return { ...meta, contentType: encoded.contentType };
}

export async function getImage<
  S extends Record<string, Record<string, unknown>> = Record<string, Record<string, unknown>>,
>(db: Interocitor<S>, path: string): Promise<StoredImage> {
  // One download: the metadata lives inside the stored object, so opening the
  // file already answers both questions.
  const sealed = await db.openFile(path);
  const metadata = sealed.metadata;
  const contentType = inferImageContentType(path, metadata.contentType);
  const data = await sealed.open();
  const blob = new Blob([data as BlobPart], { type: contentType });
  return {
    path,
    data,
    blob,
    metadata: coerceImageMetadata(metadata, contentType),
    contentType,
  };
}

export async function getImageBlobUrl<
  S extends Record<string, Record<string, unknown>> = Record<string, Record<string, unknown>>,
>(db: Interocitor<S>, path: string): Promise<StoredImageBlobUrl> {
  const image = await getImage(db, path);
  const url = URL.createObjectURL(image.blob);
  return {
    path,
    url,
    blob: image.blob,
    metadata: image.metadata,
    contentType: image.contentType,
    revoke: () => URL.revokeObjectURL(url),
  };
}
