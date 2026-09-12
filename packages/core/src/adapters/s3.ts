// compass: interocitor.mailbox-sync.storage-adapters

import type { FileEntry, StorageAdapter } from "../core/types.ts";
import { httpFailure } from "./http-status.ts";

const encoder = new TextEncoder();
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export type S3AddressingStyle = "path" | "virtual";

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Required for temporary credentials issued by STS or an equivalent provider. */
  sessionToken?: string;
}

export type S3CredentialsProvider = () => S3Credentials | Promise<S3Credentials>;

export interface S3Config {
  /** Bucket that carries Interocitor mailbox objects. */
  bucket: string;
  /** Provider region used in the SigV4 credential scope. */
  region: string;
  /** Static credentials or a provider that returns current credentials for each request. */
  credentials: S3Credentials | S3CredentialsProvider;
  /** Optional S3-compatible endpoint. Omission selects the AWS regional endpoint. */
  endpoint?: string | URL;
  /** Custom endpoints default to path style; AWS defaults to virtual-host style. */
  addressingStyle?: S3AddressingStyle;
  /** Prefix prepended to every Interocitor path in the bucket. */
  keyPrefix?: string;
  /** Per-request deadline. Defaults to 30 seconds. */
  requestTimeoutMs?: number;
  /** Runtime-owned fetch implementation, primarily for non-browser runtimes and tests. */
  fetcher?: typeof fetch;
}

/** Non-secret backend coordinates safe to carry in pairing metadata. */
export interface S3HandshakeConfig {
  bucket: string;
  region: string;
  endpoint?: string;
  addressingStyle: S3AddressingStyle;
  keyPrefix?: string;
}

interface QueryEntry {
  name: string;
  value: string;
}

interface ListPage {
  files: FileEntry[];
  folders: string[];
  nextContinuationToken?: string;
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

function assertCredentials(credentials: S3Credentials): void {
  if (!credentials.accessKeyId.trim() || !credentials.secretAccessKey) {
    throw new Error("S3 credentials require accessKeyId and secretAccessKey");
  }
  if (credentials.sessionToken !== undefined && !credentials.sessionToken) {
    throw new Error("S3 sessionToken must not be empty when supplied");
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function assertEndpoint(endpoint: URL): void {
  const secure = endpoint.protocol === "https:";
  const localDevelopment = endpoint.protocol === "http:" && isLoopback(endpoint.hostname);
  if (!secure && !localDevelopment) {
    throw new Error("S3 endpoint must use HTTPS (HTTP is allowed only for loopback development)");
  }
  if (endpoint.username || endpoint.password) {
    throw new Error("S3 endpoint must not include credentials");
  }
  if (endpoint.search || endpoint.hash) {
    throw new Error("S3 endpoint must not include a query or fragment");
  }
}

function normalizePrefix(prefix: string | undefined): string {
  return normalizePath(prefix ?? "", true);
}

function normalizePath(path: string, allowEmpty = false): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) {
    throw new Error("S3 adapter paths must not contain . or .. segments");
  }
  const normalized = parts.join("/");
  if (!allowEmpty && !normalized) throw new Error("S3 object path must not be empty");
  return normalized;
}

function uriEncode(value: string): string {
  return encodeURIComponent(value).replaceAll(
    /[!'()*]/g,
    (character) => `%${character.codePointAt(0)!.toString(16).toUpperCase()}`,
  );
}

function encodeKey(key: string): string {
  return key
    .split("/")
    .map((part) => uriEncode(part))
    .join("/");
}

function sortedValues<T>(values: Iterable<T>, compare: (left: T, right: T) => number): T[] {
  const sorted: T[] = [];
  for (const value of values) {
    const index = sorted.findIndex((candidate) => compare(candidate, value) > 0);
    if (index === -1) sorted.push(value);
    else sorted.splice(index, 0, value);
  }
  return sorted;
}

function canonicalQuery(entries: QueryEntry[]): string {
  return sortedValues(
    entries.map(({ name, value }) => ({ name: uriEncode(name), value: uriEncode(value) })),
    (left, right) =>
      left.name === right.name
        ? left.value < right.value
          ? -1
          : left.value > right.value
            ? 1
            : 0
        : left.name < right.name
          ? -1
          : 1,
  )
    .map(({ name, value }) => `${name}=${value}`)
    .join("&");
}

function canonicalHeaderValue(value: string): string {
  return value.trim().replaceAll(/\s+/g, " ");
}

function amzDate(now: Date): { timestamp: string; datestamp: string } {
  const timestamp = now.toISOString().replaceAll(/[:-]|\.\d{3}/g, "");
  return { timestamp, datestamp: timestamp.slice(0, 8) };
}

function hex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(view, (value) => value.toString(16).padStart(2, "0")).join("");
}

async function sha256(data: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>));
}

async function hmac(key: Uint8Array, value: string): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey(
    "raw",
    key as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, encoder.encode(value)));
}

function xmlBlocks(xml: string, localName: string): string[] {
  const escaped = localName.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    xml.match(
      new RegExp(`<(?:[\\w.-]+:)?${escaped}\\b[^>]*>[\\s\\S]*?<\\/(?:[\\w.-]+:)?${escaped}>`, "gi"),
    ) ?? []
  );
}

function xmlText(xml: string, localName: string): string | null {
  const escaped = localName.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `<(?:[\\w.-]+:)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${escaped}>`,
    "i",
  ).exec(xml);
  if (!match) return null;
  return decodeXml(match[1].replaceAll(/<[^>]+>/g, "").trim());
}

function decodeXml(value: string): string {
  return value
    .replaceAll(/&#x([0-9a-f]+);/gi, (_match, digits: string) =>
      String.fromCodePoint(Number.parseInt(digits, 16)),
    )
    .replaceAll(/&#([0-9]+);/g, (_match, digits: string) =>
      String.fromCodePoint(Number.parseInt(digits, 10)),
    )
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function isoTime(value: string | null): string {
  if (!value) return "";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
}

/**
 * Whole-mailbox adapter for AWS S3 and compatible object stores.
 *
 * It signs requests with Web Crypto and uses only browser `fetch`. Browser
 * applications should supply short-lived, prefix-scoped credentials through a
 * credentials provider; the adapter does not obtain or persist credentials.
 * The bucket must allow the application's origin, methods, and SigV4 headers.
 *
 * @example
 * ```ts
 * const adapter = new S3Adapter({
 *   bucket: 'my-interocitor-mailbox',
 *   region: 'ap-southeast-2',
 *   keyPrefix: 'production',
 *   credentials: async () => fetch('/api/s3-session').then((res) => res.json()),
 * });
 * ```
 *
 * @see {@link ../../docs/s3-browser.md | Use an S3 mailbox from a browser}
 *   — the bucket CORS and prefix policy this needs, and how to hand a browser
 *   short-lived credentials.
 */
export class S3Adapter implements StorageAdapter {
  readonly name = "s3";

  private readonly bucket: string;
  private readonly region: string;
  private readonly endpoint: URL;
  private readonly addressingStyle: S3AddressingStyle;
  private readonly prefix: string;
  private readonly fetcher: typeof fetch;
  private readonly requestTimeoutMs: number;
  private credentials: S3Credentials | S3CredentialsProvider;
  private authenticated = false;

  constructor(config: S3Config) {
    assertBucketName(config.bucket);
    assertRegion(config.region);
    if (!config.endpoint && config.region === "auto") {
      throw new Error("S3 endpoint is required when region is auto");
    }
    if (typeof config.credentials !== "function") assertCredentials(config.credentials);
    const endpoint = new URL(config.endpoint || `https://s3.${config.region}.amazonaws.com`);
    assertEndpoint(endpoint);
    const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new Error("S3 requestTimeoutMs must be a positive finite number");
    }

    this.bucket = config.bucket;
    this.region = config.region;
    this.endpoint = endpoint;
    this.addressingStyle = config.addressingStyle ?? (config.endpoint ? "path" : "virtual");
    this.prefix = normalizePrefix(config.keyPrefix);
    this.fetcher = config.fetcher ?? fetch;
    this.requestTimeoutMs = requestTimeoutMs;
    this.credentials = config.credentials;
  }

  /** Replace static credentials or the refresh provider and force re-authentication. */
  setCredentials(credentials: S3Credentials | S3CredentialsProvider): void {
    if (typeof credentials !== "function") assertCredentials(credentials);
    this.credentials = credentials;
    this.authenticated = false;
  }

  async authenticate(): Promise<void> {
    this.authenticated = false;
    const response = await this.request("authenticate", "GET", null, [
      { name: "list-type", value: "2" },
      { name: "max-keys", value: "1" },
      { name: "prefix", value: this.prefix ? `${this.prefix}/` : "" },
    ]);
    if (!response.ok) {
      throw this.failure(response, "authenticate", undefined, true);
    }
    this.authenticated = true;
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  getHandshakeConfig(): string {
    const config: S3HandshakeConfig = {
      bucket: this.bucket,
      region: this.region,
      addressingStyle: this.addressingStyle,
      ...(this.prefix ? { keyPrefix: this.prefix } : {}),
      ...(this.endpointIsDefaultAws() ? {} : { endpoint: this.endpoint.toString() }),
    };
    return JSON.stringify(config);
  }

  async ensureFolder(path: string): Promise<void> {
    normalizePath(path, true);
    // S3 prefixes are implicit; object writes create every apparent ancestor.
  }

  async listFiles(folderPath: string): Promise<FileEntry[]> {
    return (await this.list(folderPath)).files;
  }

  async listFolders(folderPath: string): Promise<string[]> {
    return (await this.list(folderPath)).folders;
  }

  async readFile(path: string): Promise<Uint8Array> {
    const response = await this.request("readFile", "GET", this.objectKey(path));
    if (!response.ok) {
      throw this.failure(response, "readFile", path);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    const body = typeof data === "string" ? encoder.encode(data) : data;
    const response = await this.request(
      "writeFile",
      "PUT",
      this.objectKey(path),
      [],
      body,
      new Headers({ "Content-Type": "application/octet-stream" }),
    );
    if (!response.ok) {
      throw this.failure(response, "writeFile", path);
    }
  }

  async deleteFile(path: string): Promise<void> {
    const response = await this.request("deleteFile", "DELETE", this.objectKey(path));
    if (!response.ok && response.status !== 404) {
      throw this.failure(response, "deleteFile", path);
    }
  }

  async getFileMetadata(path: string): Promise<FileEntry | null> {
    const response = await this.request("getFileMetadata", "HEAD", this.objectKey(path));
    if (response.status === 404) return null;
    if (!response.ok) {
      throw this.failure(response, "getFileMetadata", path);
    }
    const size = Number.parseInt(response.headers.get("Content-Length") ?? "0", 10);
    return {
      name: normalizePath(path).split("/").pop()!,
      path: this.adapterPath(path),
      size: Number.isFinite(size) ? size : 0,
      modifiedTime: isoTime(response.headers.get("Last-Modified")),
      etag: response.headers.get("ETag") ?? undefined,
    };
  }

  private endpointIsDefaultAws(): boolean {
    return this.endpoint.toString() === `https://s3.${this.region}.amazonaws.com/`;
  }

  private adapterPath(path: string): string {
    const normalized = normalizePath(path, true);
    return normalized ? `/${normalized}` : "/";
  }

  private objectKey(path: string): string {
    return [this.prefix, normalizePath(path)].filter(Boolean).join("/");
  }

  private folderPrefix(path: string): string {
    const normalized = normalizePath(path, true);
    const key = [this.prefix, normalized].filter(Boolean).join("/");
    return key ? `${key}/` : "";
  }

  private bucketUrl(key: string | null): URL {
    const endpointPath = this.endpoint.pathname.replace(/\/+$/, "");
    const encodedKey = key ? `/${encodeKey(key)}` : "/";
    const useVirtualAddressing = this.addressingStyle === "virtual" && !this.bucket.includes(".");
    if (useVirtualAddressing) {
      return new URL(
        `${this.endpoint.protocol}//${this.bucket}.${this.endpoint.host}${endpointPath}${encodedKey}`,
      );
    }
    return new URL(`${this.endpoint.origin}${endpointPath}/${uriEncode(this.bucket)}${encodedKey}`);
  }

  private async currentCredentials(): Promise<S3Credentials> {
    const credentials =
      typeof this.credentials === "function" ? await this.credentials() : this.credentials;
    assertCredentials(credentials);
    return credentials;
  }

  private async list(folderPath: string): Promise<{ files: FileEntry[]; folders: string[] }> {
    const prefix = this.folderPrefix(folderPath);
    const files = new Map<string, FileEntry>();
    const folders = new Set<string>();
    const observedTokens = new Set<string>();
    let continuationToken: string | undefined;

    do {
      const page = await this.listPage(folderPath, prefix, continuationToken);
      for (const file of page.files) files.set(file.name, file);
      for (const folder of page.folders) folders.add(folder);
      continuationToken = page.nextContinuationToken;
      if (continuationToken) {
        if (observedTokens.has(continuationToken)) {
          throw new Error("S3 listing repeated a continuation token");
        }
        observedTokens.add(continuationToken);
      }
    } while (continuationToken);

    return {
      files: sortedValues(files.values(), (left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      ),
      folders: sortedValues(folders, (left, right) => (left < right ? -1 : left > right ? 1 : 0)),
    };
  }

  private async listPage(
    folderPath: string,
    prefix: string,
    continuationToken?: string,
  ): Promise<ListPage> {
    const query: QueryEntry[] = [
      { name: "delimiter", value: "/" },
      { name: "list-type", value: "2" },
      { name: "prefix", value: prefix },
    ];
    if (continuationToken) {
      query.push({ name: "continuation-token", value: continuationToken });
    }
    const response = await this.request("list", "GET", null, query);
    if (!response.ok) {
      throw this.failure(response, "list", folderPath, true);
    }
    const xml = await response.text();
    if (!/<(?:[\w.-]+:)?ListBucketResult\b/i.test(xml)) {
      throw new Error("S3 list response is not valid ListObjectsV2 XML");
    }

    const files: FileEntry[] = [];
    for (const contents of xmlBlocks(xml, "Contents")) {
      const key = xmlText(contents, "Key") ?? "";
      if (!key.startsWith(prefix)) continue;
      const name = key.slice(prefix.length);
      if (!name || name.includes("/")) continue;
      const size = Number.parseInt(xmlText(contents, "Size") ?? "0", 10);
      files.push({
        name,
        path: `${this.adapterPath(folderPath).replace(/\/$/, "")}/${name}`,
        size: Number.isFinite(size) ? size : 0,
        modifiedTime: isoTime(xmlText(contents, "LastModified")),
        etag: xmlText(contents, "ETag") ?? undefined,
      });
    }

    const folders: string[] = [];
    for (const commonPrefix of xmlBlocks(xml, "CommonPrefixes")) {
      const key = xmlText(commonPrefix, "Prefix") ?? "";
      if (!key.startsWith(prefix)) continue;
      const name = key.slice(prefix.length).replace(/\/$/, "");
      if (name && !name.includes("/")) folders.push(name);
    }

    const truncated = xmlText(xml, "IsTruncated")?.toLowerCase() === "true";
    const nextContinuationToken = xmlText(xml, "NextContinuationToken") ?? undefined;
    if (truncated && !nextContinuationToken) {
      throw new Error("S3 list response is truncated without a continuation token");
    }
    return { files, folders, nextContinuationToken: truncated ? nextContinuationToken : undefined };
  }

  private async request(
    operation: string,
    method: "GET" | "PUT" | "DELETE" | "HEAD",
    key: string | null,
    queryEntries: QueryEntry[] = [],
    body?: Uint8Array,
    initialHeaders = new Headers(),
  ): Promise<Response> {
    const credentials = await this.currentCredentials();
    const url = this.bucketUrl(key);
    const query = canonicalQuery(queryEntries);
    if (query) url.search = query;

    const payloadHash = body ? await sha256(body) : EMPTY_SHA256;
    const { timestamp, datestamp } = amzDate(new Date());
    const headers = new Headers(initialHeaders);
    headers.set("x-amz-content-sha256", payloadHash);
    headers.set("x-amz-date", timestamp);
    if (credentials.sessionToken) {
      headers.set("x-amz-security-token", credentials.sessionToken);
    }

    const canonicalHeaders = new Map<string, string>([["host", url.host]]);
    headers.forEach((value, name) => {
      canonicalHeaders.set(name.toLowerCase(), canonicalHeaderValue(value));
    });
    const signedHeaderNames = sortedValues(canonicalHeaders.keys(), (left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    const signedHeaders = signedHeaderNames.join(";");
    const canonicalHeaderBlock = signedHeaderNames
      .map((name) => `${name}:${canonicalHeaders.get(name)}\n`)
      .join("");
    const canonicalRequest = [
      method,
      url.pathname,
      query,
      canonicalHeaderBlock,
      signedHeaders,
      payloadHash,
    ].join("\n");
    const credentialScope = `${datestamp}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      timestamp,
      credentialScope,
      await sha256(encoder.encode(canonicalRequest)),
    ].join("\n");
    const dateKey = await hmac(encoder.encode(`AWS4${credentials.secretAccessKey}`), datestamp);
    const regionKey = await hmac(dateKey, this.region);
    const serviceKey = await hmac(regionKey, "s3");
    const signingKey = await hmac(serviceKey, "aws4_request");
    const signature = hex(await hmac(signingKey, stringToSign));
    headers.set(
      "Authorization",
      `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    );

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      return await this.fetcher(url, {
        method,
        headers,
        body: body as BodyInit | undefined,
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`S3 ${operation} timed out after ${this.requestTimeoutMs}ms`, {
          cause: error,
        });
      }
      throw new Error(
        `S3 ${operation} failed before receiving a response; check endpoint reachability and bucket CORS`,
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private failure(
    response: Response,
    operation: string,
    path?: string,
    notFoundIsAccess = false,
  ): Error {
    if (response.status === 401 || response.status === 403) this.authenticated = false;
    const requestId = response.headers.get("x-amz-request-id");
    const message = `S3 ${operation} failed${requestId ? ` (request ${requestId})` : ""}`;
    return httpFailure(
      response,
      { adapter: this.name, operation, path, notFoundIsAccess },
      message,
    );
  }
}
