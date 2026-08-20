import type { FileBody, FileBodyStore, FileBodyValue, FileBodyWriteOptions } from "./types.ts";

const encoder = new TextEncoder();
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export interface S3FileBodyStoreConfig {
  /** Provider bucket name. */
  bucket: string;
  /** Provider region used in the SigV4 credential scope. */
  region: string;
  /** Access key with object access limited to this bucket's durable-file prefix. */
  accessKeyId: string;
  /** Secret access key. Supply it through a Worker secret binding. */
  secretAccessKey: string;
  /** Optional token when the credentials are temporary. */
  sessionToken?: string;
  /** Optional key prefix prepended to every Interocitor object key. */
  keyPrefix?: string;
  /**
   * S3-compatible service endpoint. When omitted, the AWS regional endpoint
   * for `region` is used.
   */
  endpoint?: string | URL;
  /** URL addressing mode. Custom endpoints default to path style. */
  addressingStyle?: S3AddressingStyle;
  /** Fetch implementation. Defaults to the Worker global `fetch`. */
  fetcher?: typeof fetch;
}

export type S3AddressingStyle = "path" | "virtual";

export interface AwsS3FileBodyStoreConfig extends S3FileBodyStoreConfig {
  /** Optional customer-managed AWS KMS key used for every PUT. */
  kmsKeyId?: string;
}

function assertBucketName(bucket: string): void {
  const hasControlCharacter = Array.from(bucket).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (!bucket.trim() || bucket.includes("/") || hasControlCharacter) {
    throw new Error("S3 bucket must be a non-empty name without path separators");
  }
}

function assertRegion(region: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(region)) {
    throw new Error("S3 region must be a non-empty provider region");
  }
}

function assertEndpoint(endpoint: URL): void {
  if (endpoint.protocol !== "https:") {
    throw new Error("S3 endpoint must use HTTPS");
  }
  if (endpoint.username || endpoint.password) {
    throw new Error("S3 endpoint must not include credentials");
  }
  if (endpoint.search || endpoint.hash) {
    throw new Error("S3 endpoint must not include a query or fragment");
  }
}

function assertConfig(config: S3FileBodyStoreConfig): void {
  assertBucketName(config.bucket);
  assertRegion(config.region);
  if (!config.endpoint && config.region === "auto") {
    throw new Error("S3 endpoint is required when region is auto");
  }
  if (!config.accessKeyId.trim() || !config.secretAccessKey) {
    throw new Error("S3 accessKeyId and secretAccessKey are required");
  }
  const endpoint = new URL(config.endpoint || `https://s3.${config.region}.amazonaws.com`);
  assertEndpoint(endpoint);
}

function assertAwsBucketName(bucket: string): void {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes("..")) {
    throw new Error("AWS S3 bucket must be a valid general-purpose bucket name");
  }
}

function assertAwsRegion(region: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(region)) {
    throw new Error("AWS S3 region must be an explicit AWS region such as ap-southeast-2");
  }
}

function normalizeAwsConfig(config: AwsS3FileBodyStoreConfig): S3FileBodyStoreConfig {
  assertAwsBucketName(config.bucket);
  assertAwsRegion(config.region);
  const kmsRegion = /^arn:[^:]+:kms:([^:]+):/.exec(config.kmsKeyId || "")?.[1];
  if (kmsRegion && kmsRegion !== config.region) {
    throw new Error("AWS S3 kmsKeyId must belong to the configured AWS region");
  }
  return config;
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

async function bytesFromValue(value: FileBodyValue): Promise<Uint8Array> {
  if (value === null) return new Uint8Array();
  if (typeof value === "string") return encoder.encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  return new Uint8Array(await new Response(value).arrayBuffer());
}

class S3ObjectBody implements FileBody {
  readonly body: ReadableStream<Uint8Array>;
  readonly size: number;
  readonly etag?: string;

  constructor(response: Response) {
    this.body = response.body ?? new Blob([]).stream();
    this.size = Number.parseInt(response.headers.get("Content-Length") || "0", 10) || 0;
    this.etag = response.headers.get("ETag") || undefined;
  }
}

/**
 * S3-compatible implementation of the durable file-body-store boundary.
 *
 * It deliberately implements only exact-key GET, PUT, and DELETE. CRDT sync
 * objects, recovery wrappers, quotas, and durable-file metadata remain in D1.
 */
export class S3FileBodyStore implements FileBodyStore {
  protected readonly config: S3FileBodyStoreConfig;
  private readonly fetcher: typeof fetch;
  private readonly prefix: string;
  private readonly endpoint: URL;
  private readonly addressingStyle: S3AddressingStyle;

  constructor(config: S3FileBodyStoreConfig) {
    assertConfig(config);
    this.config = { ...config };
    this.fetcher = config.fetcher ?? fetch;
    this.prefix = normalizePrefix(config.keyPrefix);
    this.endpoint = new URL(config.endpoint || `https://s3.${config.region}.amazonaws.com`);
    this.addressingStyle = config.addressingStyle ?? (config.endpoint ? "path" : "virtual");
  }

  async get(key: string): Promise<FileBody | null> {
    const response = await this.request("GET", key);
    if (response.status === 404) return null;
    await this.assertOk(response, "GET");
    return new S3ObjectBody(response);
  }

  async put(key: string, value: FileBodyValue, options: FileBodyWriteOptions = {}): Promise<void> {
    const bytes = await bytesFromValue(value);
    const headers = this.createPutHeaders(options);
    const response = await this.request("PUT", key, bytes, headers);
    await this.assertOk(response, "PUT");
  }

  async delete(key: string): Promise<void> {
    const response = await this.request("DELETE", key);
    await this.assertOk(response, "DELETE");
  }

  protected createPutHeaders(options: FileBodyWriteOptions): Headers {
    const headers = new Headers();
    headers.set("Content-Type", options.contentType || "application/octet-stream");
    return headers;
  }

  private objectUrl(key: string): URL {
    const fullKey = [this.prefix, key].filter(Boolean).join("/");
    const encoded = encodeKey(fullKey);
    const endpointPath = this.endpoint.pathname.replace(/\/+$/, "");
    const useVirtualAddressing =
      this.addressingStyle === "virtual" && !this.config.bucket.includes(".");
    if (useVirtualAddressing) {
      return new URL(
        `${this.endpoint.protocol}//${this.config.bucket}.${this.endpoint.host}${endpointPath}/${encoded}`,
      );
    }
    return new URL(
      `${this.endpoint.origin}${endpointPath}/${encodePathPart(this.config.bucket)}/${encoded}`,
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

/**
 * AWS-oriented S3 store with AWS bucket/region validation and optional SSE-KMS.
 *
 * `S3FileBodyStore` remains the provider-neutral implementation and defaults
 * to the same AWS regional endpoint when `endpoint` is omitted.
 */
export class AwsS3FileBodyStore extends S3FileBodyStore {
  private readonly kmsKeyId?: string;

  constructor(config: AwsS3FileBodyStoreConfig) {
    super(normalizeAwsConfig(config));
    this.kmsKeyId = config.kmsKeyId;
  }

  protected override createPutHeaders(options: FileBodyWriteOptions): Headers {
    const headers = super.createPutHeaders(options);
    if (this.kmsKeyId) {
      headers.set("x-amz-server-side-encryption", "aws:kms");
      headers.set("x-amz-server-side-encryption-aws-kms-key-id", this.kmsKeyId);
    }
    return headers;
  }
}
