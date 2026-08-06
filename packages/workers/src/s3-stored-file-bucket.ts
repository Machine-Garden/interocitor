import type { StoredFileBucket, StoredFileObjectBody } from "./types.ts";

const encoder = new TextEncoder();
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export interface S3StoredFileBucketConfig {
  /** AWS S3 bucket name. */
  bucket: string;
  /** Exact AWS region used in both the endpoint and SigV4 credential scope. */
  region: string;
  /** IAM access key with object access limited to this bucket's durable-file prefix. */
  accessKeyId: string;
  /** IAM secret access key. Supply it through a Worker secret binding. */
  secretAccessKey: string;
  /** Optional token when the credentials are temporary. */
  sessionToken?: string;
  /** Optional key prefix prepended to every Interocitor object key. */
  keyPrefix?: string;
  /** Optional customer-managed KMS key used for every PUT. */
  kmsKeyId?: string;
  /** Fetch implementation. Defaults to the Worker global `fetch`. */
  fetcher?: typeof fetch;
}

function assertConfig(config: S3StoredFileBucketConfig): void {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket) || config.bucket.includes("..")) {
    throw new Error("S3 bucket must be a valid general-purpose bucket name");
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(config.region)) {
    throw new Error("S3 region must be an explicit AWS region such as ap-southeast-2");
  }
  if (!config.accessKeyId.trim() || !config.secretAccessKey) {
    throw new Error("S3 accessKeyId and secretAccessKey are required");
  }
  const kmsRegion = /^arn:[^:]+:kms:([^:]+):/.exec(config.kmsKeyId || "")?.[1];
  if (kmsRegion && kmsRegion !== config.region) {
    throw new Error("S3 kmsKeyId must belong to the configured AWS region");
  }
}

function hex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(view, (value) => value.toString(16).padStart(2, "0")).join("");
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function sha256(data: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", arrayBuffer(data)));
}

async function hmac(key: Uint8Array, value: string): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey(
    "raw",
    arrayBuffer(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, encoder.encode(value)));
}

function encodePathPart(value: string): string {
  return encodeURIComponent(value).replaceAll(
    /[!'()*]/g,
    (char) => `%${char.codePointAt(0)!.toString(16).toUpperCase()}`,
  );
}

function encodeKey(key: string): string {
  return key
    .split("/")
    .map((part) => encodePathPart(part))
    .join("/");
}

function normalizePrefix(prefix: string | undefined): string {
  return String(prefix || "")
    .split("/")
    .filter(Boolean)
    .join("/");
}

function amzDate(now: Date): { timestamp: string; datestamp: string } {
  const timestamp = now.toISOString().replaceAll(/[:-]|\.\d{3}/g, "");
  return { timestamp, datestamp: timestamp.slice(0, 8) };
}

function canonicalHeaderValue(value: string): string {
  return value.trim().replaceAll(/\s+/g, " ");
}

function sortedStrings(values: Iterable<string>): string[] {
  const sorted: string[] = [];
  for (const value of values) {
    const index = sorted.findIndex((candidate) => candidate > value);
    if (index === -1) sorted.push(value);
    else sorted.splice(index, 0, value);
  }
  return sorted;
}

async function bytesFromValue(
  value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
): Promise<Uint8Array> {
  if (value === null) return new Uint8Array();
  if (typeof value === "string") return encoder.encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  return new Uint8Array(await new Response(value).arrayBuffer());
}

class S3ObjectBody implements StoredFileObjectBody {
  readonly body: ReadableStream<Uint8Array>;
  readonly size: number;
  readonly etag?: string;
  readonly httpEtag?: string;
  private readonly contentType?: string;

  constructor(response: Response) {
    this.body = response.body ?? new Blob([]).stream();
    this.size = Number.parseInt(response.headers.get("Content-Length") || "0", 10) || 0;
    this.httpEtag = response.headers.get("ETag") || undefined;
    this.etag =
      this.httpEtag?.startsWith('"') && this.httpEtag.endsWith('"')
        ? this.httpEtag.slice(1, -1)
        : this.httpEtag;
    this.contentType = response.headers.get("Content-Type") || undefined;
  }

  writeHttpMetadata(headers: Headers): void {
    if (this.contentType) headers.set("Content-Type", this.contentType);
  }
}

/**
 * AWS S3 implementation of the durable-file object-store boundary.
 *
 * It deliberately implements only exact-key GET, PUT, and DELETE. CRDT sync
 * objects, recovery wrappers, quotas, and durable-file metadata remain in D1.
 */
export class S3StoredFileBucket implements StoredFileBucket {
  private readonly config: S3StoredFileBucketConfig;
  private readonly fetcher: typeof fetch;
  private readonly prefix: string;

  constructor(config: S3StoredFileBucketConfig) {
    assertConfig(config);
    this.config = { ...config };
    this.fetcher = config.fetcher ?? fetch;
    this.prefix = normalizePrefix(config.keyPrefix);
  }

  async get(key: string): Promise<StoredFileObjectBody | null> {
    const response = await this.request("GET", key);
    if (response.status === 404) return null;
    await this.assertOk(response, "GET");
    return new S3ObjectBody(response);
  }

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
    options: {
      httpMetadata?: Record<string, string>;
      customMetadata?: Record<string, string>;
    } = {},
  ): Promise<unknown> {
    const bytes = await bytesFromValue(value);
    const headers = new Headers();
    headers.set("Content-Type", options.httpMetadata?.contentType || "application/octet-stream");
    if (this.config.kmsKeyId) {
      headers.set("x-amz-server-side-encryption", "aws:kms");
      headers.set("x-amz-server-side-encryption-aws-kms-key-id", this.config.kmsKeyId);
    }
    const response = await this.request("PUT", key, bytes, headers);
    await this.assertOk(response, "PUT");
    return { etag: response.headers.get("ETag") || undefined };
  }

  async delete(key: string): Promise<void> {
    const response = await this.request("DELETE", key);
    await this.assertOk(response, "DELETE");
  }

  private objectUrl(key: string): URL {
    const fullKey = [this.prefix, key].filter(Boolean).join("/");
    const encoded = encodeKey(fullKey);
    if (this.config.bucket.includes(".")) {
      return new URL(
        `https://s3.${this.config.region}.amazonaws.com/${encodePathPart(this.config.bucket)}/${encoded}`,
      );
    }
    return new URL(
      `https://${this.config.bucket}.s3.${this.config.region}.amazonaws.com/${encoded}`,
    );
  }

  private async request(
    method: "GET" | "PUT" | "DELETE",
    key: string,
    body?: Uint8Array,
    initialHeaders = new Headers(),
  ): Promise<Response> {
    const url = this.objectUrl(key);
    const payloadHash = body ? await sha256(body) : EMPTY_SHA256;
    const { timestamp, datestamp } = amzDate(new Date());
    const headers = new Headers(initialHeaders);
    headers.set("x-amz-content-sha256", payloadHash);
    headers.set("x-amz-date", timestamp);
    if (this.config.sessionToken) headers.set("x-amz-security-token", this.config.sessionToken);

    const canonicalHeaders = new Map<string, string>([["host", url.host]]);
    headers.forEach((value, name) =>
      canonicalHeaders.set(name.toLowerCase(), canonicalHeaderValue(value)),
    );
    const signedHeaderNames = sortedStrings(canonicalHeaders.keys());
    const signedHeaders = signedHeaderNames.join(";");
    const canonicalHeaderBlock = signedHeaderNames
      .map((name) => `${name}:${canonicalHeaders.get(name)}\n`)
      .join("");
    const canonicalRequest = [
      method,
      url.pathname,
      "",
      canonicalHeaderBlock,
      signedHeaders,
      payloadHash,
    ].join("\n");
    const credentialScope = `${datestamp}/${this.config.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      timestamp,
      credentialScope,
      await sha256(encoder.encode(canonicalRequest)),
    ].join("\n");

    const dateKey = await hmac(encoder.encode(`AWS4${this.config.secretAccessKey}`), datestamp);
    const regionKey = await hmac(dateKey, this.config.region);
    const serviceKey = await hmac(regionKey, "s3");
    const signingKey = await hmac(serviceKey, "aws4_request");
    const signature = hex(await hmac(signingKey, stringToSign));
    headers.set(
      "Authorization",
      `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    );

    return this.fetcher(url, {
      method,
      headers,
      body: body as unknown as BodyInit | undefined,
      redirect: "error",
    });
  }

  private async assertOk(response: Response, operation: string): Promise<void> {
    if (response.ok) return;
    const requestId = response.headers.get("x-amz-request-id");
    throw new Error(
      `S3 ${operation} failed: HTTP ${response.status}${requestId ? ` (request ${requestId})` : ""}`,
    );
  }
}
