/** A single row returned by a D1 query. Values are JSON-compatible scalars. */
export type QueryRow = Record<string, unknown>;

/** Metadata attached to a D1 statement result. */
export interface D1ResultMeta {
  /** Number of rows inserted, updated, or deleted. */
  changes?: number;
  [key: string]: unknown;
}

/** Result envelope returned by D1 statements. */
export interface D1QueryResult<T extends QueryRow = QueryRow> {
  /** Rows returned by a SELECT statement. */
  results?: T[];
  /** Execution metadata. */
  meta?: D1ResultMeta;
}

/** A D1 prepared statement that supports binding, querying, and batching. */
export interface D1PreparedStatement {
  /** Bind positional parameters and return a new statement. */
  bind(...params: unknown[]): D1PreparedStatement;
  /** Execute and return the first row, or `null` if no rows match. */
  first<T extends QueryRow = QueryRow>(): Promise<T | null>;
  /** Execute a write statement and return the result envelope. */
  run<T extends QueryRow = QueryRow>(): Promise<D1QueryResult<T>>;
  /** Execute a SELECT and return all matching rows. */
  all<T extends QueryRow = QueryRow>(): Promise<D1QueryResult<T>>;
}

/** Cloudflare D1 database binding. */
export interface D1Database {
  /** Prepare a SQL statement for execution or batching. */
  prepare(sql: string): D1PreparedStatement;
  /** Execute multiple prepared statements in a single round-trip. */
  batch(statements: D1PreparedStatement[]): Promise<D1QueryResult[]>;
}

/** An opaque Durable Object identifier. */
export interface DurableObjectId {
  readonly name?: string;
}

/** A stub used to send requests to a specific Durable Object instance. */
export interface DurableObjectStub {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/** Cloudflare Durable Object namespace binding. */
export interface DurableObjectNamespace {
  /** Retrieve a stub for the given ID. */
  get(id: DurableObjectId): DurableObjectStub;
  /** Derive a deterministic ID from a string name. */
  idFromName(name: string): DurableObjectId;
}

/**
 * Subset of the Durable Object state used by the relay handler.
 * Only the WebSocket hibernation methods are required.
 */
export interface DurableObjectStateLike {
  /** Accept a WebSocket connection and hand it to the hibernation API. */
  acceptWebSocket(socket: WebSocket): void;
  /** Return all currently hibernated WebSocket connections. */
  getWebSockets(): WebSocket[];
}

/** Subset of the Cloudflare `ExecutionContext` used by this package. */
export interface ExecutionContextLike {
  /** Extend the Worker's lifetime until the given promise settles. */
  waitUntil?(promise: Promise<unknown>): void;
  /** Pass the request through to the origin on any uncaught exception. */
  passThroughOnException?(): void;
}

/** Subset of the Cloudflare `ScheduledController` passed to `scheduled()`. */
export interface ScheduledControllerLike {
  /** The cron expression that triggered this invocation, if any. */
  readonly cron?: string;
  /** Unix timestamp (ms) of the scheduled time. */
  readonly scheduledTime?: number;
}

/** Minimal Worker shape — both `fetch` and `scheduled` are optional. */
export interface WorkerLike<Env = unknown> {
  fetch?(request: Request, env: Env, ctx: ExecutionContextLike): Response | Promise<Response>;
  scheduled?(event: ScheduledControllerLike, env: Env, ctx: ExecutionContextLike): unknown;
}

/** Cache namespace interface (matches the Cloudflare Cache API). */
export interface WorkerCache {
  match(input: RequestInfo | URL): Promise<Response | undefined>;
  put(input: RequestInfo | URL, response: Response): Promise<void>;
  delete(input: RequestInfo | URL): Promise<boolean>;
}

/** Bytes returned by a configured durable file-body destination. */
export interface FileBody {
  body: ReadableStream<Uint8Array>;
  size: number;
  /** Provider ETag formatted for an HTTP `ETag` response header, when available. */
  etag?: string;
}

/** Request bodies accepted by a durable file-body destination. */
export type FileBodyValue =
  | ReadableStream<Uint8Array>
  | ArrayBuffer
  | ArrayBufferView
  | string
  | null
  | Blob;

/** Provider-neutral information supplied with a durable file-body write. */
export interface FileBodyWriteOptions {
  /** Media type persisted with the body when the provider supports it. */
  contentType?: string;
}

/**
 * Exact-key destination for durable file bodies.
 *
 * The Worker owns authorization, mesh routing, quotas, and D1 metadata. A
 * store implementation owns only body persistence and provider credentials.
 */
export interface FileBodyStore {
  /** Return the exact body stored at `key`, or `null` when it is absent. */
  get(key: string): Promise<FileBody | null>;
  /** Fully replace the body at `key`; reject instead of exposing a partial write. */
  put(key: string, value: FileBodyValue, options?: FileBodyWriteOptions): Promise<void>;
  /** Remove `key`; an absent key is a successful no-op. */
  delete(key: string): Promise<void>;
}

/** Object body returned by a Cloudflare R2 binding. */
export interface R2ObjectBody {
  body: ReadableStream<Uint8Array>;
  size: number;
  etag?: string;
  httpEtag?: string;
}

/** Cloudflare R2 binding wrapped by `R2FileBodyStore`. */
export interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  put(
    key: string,
    value: FileBodyValue,
    options?: { httpMetadata?: Record<string, string>; customMetadata?: Record<string, string> },
  ): Promise<{ etag?: string } | unknown>;
  delete(key: string): Promise<void>;
}

/** Stable mesh context supplied while selecting a durable file-body destination. */
export interface FileBodyStorageContext {
  /** Canonical storage address; equal to `canonicalAddress`. */
  address: string;
  /** Decoded route address supplied by the client. */
  presentedAddress: string;
  /** Stable D1, file-body, cache, and relay namespace. */
  canonicalAddress: string;
}

/**
 * Information presented to `authorizeFileUpload` before a durable file write.
 *
 * This is the server-visible metadata boundary for encrypted durable files.
 * The Worker can inspect path, stored size, client-supplied metadata, request
 * headers/cookies, and current quota usage. Encrypted file contents remain
 * opaque.
 */
export interface FileUploadAuthorizationRequest {
  /** Canonical storage address; equal to `canonicalAddress`. */
  address: string;
  /** Decoded route address supplied by the client. */
  presentedAddress: string;
  /** Stable namespace receiving the durable-file write. */
  canonicalAddress: string;
  /** Normalized durable-file path. */
  path: string;
  /** Client-supplied `X-Interocitor-Device-Id` value. */
  uploadedByDeviceId: string;
  /** Stored request-body bytes. */
  size: number;
  /** The write presents a seal guard: the client proved it holds the file's extra key. */
  sealed: boolean;
  /** The object being replaced is sealed; the presented guard already matched it. */
  overwritesSealed: boolean;
  /**
   * Stored bytes of the object this write replaces; `0` when the path is new.
   *
   * A replacement frees what it overwrites, so mesh usage after this write is
   * `currentMeshStoredBytes - replacedBytes + size`. Policy that compares
   * against a quota must subtract this, or it charges a re-saved file twice.
   */
  replacedBytes: number;
  /** Durable-file bytes recorded for the mesh before this write. */
  currentMeshStoredBytes: number;
  /** Resolved durable-file quota for the mesh. */
  maxMeshStoredBytes: number;
  /** Incoming request after its body has been consumed; headers remain usable. */
  request: Request;
}

/**
 * Durable-file upload decision. `false` rejects with `403`; an object can
 * supply a rejection status and response reason.
 */
export type FileUploadAuthorizationResult =
  | boolean
  | { allowed: boolean; reason?: string; status?: number };

/** The access requested from a mesh route. */
export type MeshAccess = "read" | "write";

/** Immutable identity retained while one public mesh request is handled. */
export interface MeshRouteIdentity {
  /** Decoded route address supplied by the client. */
  readonly presentedAddress: string;
  /** Stable D1, file-body, cache, and relay namespace. */
  readonly canonicalAddress: string;
}

/** Information supplied to an optional public mesh-route resolver. */
export interface MeshRouteContext {
  /** Decoded route address supplied by the client. */
  presentedAddress: string;
  /** Clone of the incoming request. */
  request: Request;
  /** Route family handling the request. */
  surface: "io" | "notify";
  /** Operation class determined before route resolution. */
  access: MeshAccess;
}

/** Successful one-hop public route resolution. */
export interface MeshRouteResolution {
  /** Stable namespace selected for this presented address. */
  canonicalAddress: string;
}

/** Resolve a public address to its canonical storage namespace. */
export type MeshRouteResolver<Env = unknown> = (
  context: MeshRouteContext,
  env: Env,
) => MeshRouteResolution | null | Promise<MeshRouteResolution | null>;

/** Information available while deciding whether a canonical mesh address exists. */
export interface MeshIntegrityContext {
  /** Canonical storage address; equal to `canonicalAddress`. */
  address: string;
  /** Decoded route address supplied by the client. */
  presentedAddress: string;
  /** Stable namespace being admitted. */
  canonicalAddress: string;
  /** Clone of the incoming request. */
  request: Request;
  /** Validate `address` with the checksum authority configured by `meshSecret`. */
  verifyChecksum(): Promise<boolean>;
}

/**
 * Decide whether an address designates a mesh in this deployment.
 *
 * Gates are OR-composed in array order. The first `true` accepts the address
 * unchanged. If every gate returns `false`, the request receives `404`; a
 * thrown, rejected, or non-boolean gate result produces `503`.
 */
export type MeshIntegrityGate<Env = unknown> = (
  context: MeshIntegrityContext,
  env: Env,
) => boolean | Promise<boolean>;

/** An accepted mesh request passed through application middleware. */
export interface MeshRequestContext {
  /** Canonical storage address; equal to `canonicalAddress`. */
  address: string;
  /** Decoded route address supplied by the client. */
  presentedAddress: string;
  /** Stable namespace selected for the request. */
  canonicalAddress: string;
  /** Clone of the incoming request. */
  request: Request;
  /** Route family handling the request. */
  surface: "io" | "notify";
  /** Operation class determined before middleware runs. */
  access: MeshAccess;
}

/**
 * One ordered layer around an accepted `/io` or `/notify` request.
 *
 * Return a response to stop the chain or call `next()` once to continue.
 * Recovery, global health, preflight, and system routes do not use this chain.
 */
export type MeshMiddleware<Env = unknown> = (
  context: MeshRequestContext,
  env: Env,
  next: () => Promise<Response>,
) => Response | Promise<Response>;

/**
 * Application access decision for one mesh request.
 *
 * - `none`: this mesh needs no application authorization; continue.
 * - `readonly`: continue reads and reject writes with `403`.
 * - `full`: continue reads and writes.
 * - `deny`: reject the request with `403`.
 */
export type MeshAuthorization = "none" | "readonly" | "full" | "deny";

/**
 * Return application access for one accepted mesh request.
 * A thrown/rejected authorizer or an invalid result produces `503`.
 */
export type MeshAuthorizer<Env = unknown> = (
  request: MeshRequestContext,
  env: Env,
) => MeshAuthorization | Promise<MeshAuthorization>;

/** Options for {@link createMeshAuthorizationMiddleware}. */
export interface MeshAuthorizationMiddlewareOptions {
  /**
   * Return `404 Not found` for authorization denials instead of `403 Forbidden`.
   * Enable this when callers must not learn that an integrity-accepted mesh
   * address exists. Defaults to `false`.
   */
  concealDenied?: boolean;
}

/** Outcome recorded after a storage operation completes. */
export type WorkerAuditOutcome = "ok" | "rejected" | "not-found";

/** Completed sync-storage, durable-file, or recovery operation. */
export interface WorkerAuditEvent {
  /** Stable event discriminator. */
  event: "interocitor.audit";
  /** ISO timestamp recorded after the storage operation. */
  at: string;
  /** Storage operation observed by the Worker. */
  op:
    | "read"
    | "write"
    | "delete"
    | "list"
    | "metadata"
    | "recovery-read"
    | "recovery-write"
    | "stored-file-read"
    | "stored-file-write"
    | "stored-file-delete"
    | "stored-file-metadata";
  /** Accepted mesh address, when the operation is mesh-scoped. */
  address?: string;
  /** Normalized object path, when applicable. */
  path?: string;
  /** Interocitor sync-object classification, when applicable. */
  pathType?: string;
  /** HTTP response status returned for the operation. */
  status: number;
  /** Terminal operation outcome. */
  outcome: WorkerAuditOutcome;
  /** Stored or transferred bytes, when measured. */
  bytes?: number;
  /** The object is sealed under an extra key the worker never sees. */
  sealed?: boolean;
  /** `CF-Ray` or `X-Request-Id`, when supplied by the request. */
  requestId?: string;
}

/**
 * Thin adapter over a D1Database that adds convenience query helpers.
 * Obtain one via {@link createDatabaseAdapter}.
 */
export interface DatabaseAdapter {
  /** The adapter kind — always `'d1'` for this implementation. */
  kind: "d1";
  /** The raw D1 binding. */
  raw: D1Database;
  /** Prepare a SQL statement. */
  prepare(sql: string): D1PreparedStatement;
  /** Execute a query and return the first row, or `null`. */
  first<T extends QueryRow = QueryRow>(sql: string, ...params: unknown[]): Promise<T | null>;
  /** Execute a write statement and return the result envelope. */
  run<T extends QueryRow = QueryRow>(sql: string, ...params: unknown[]): Promise<D1QueryResult<T>>;
  /** Execute a SELECT and return all rows as an array. */
  all<T extends QueryRow = QueryRow>(sql: string, ...params: unknown[]): Promise<T[]>;
  /** Execute a batch of prepared statements in one round-trip. */
  batch(statements: D1PreparedStatement[]): Promise<D1QueryResult[]>;
}

/**
 * Runtime behavior accepted by {@link createInterocitorMount} and
 * {@link withInterocitor}.
 */
export interface InterocitorRuntimeOptions<Env = unknown> {
  /**
   * Optional authoritative one-hop mapping for public IO/notify addresses.
   * When configured, returning `null` rejects with `404`; the runtime never
   * falls back to using the presented address directly.
   */
  resolveMeshRoute?: MeshRouteResolver<Env>;
  /**
   * Rules defining which mesh addresses exist. Required for mesh IO/notify:
   * the default empty list rejects every address with `404`.
   */
  meshIntegrityGates?: readonly MeshIntegrityGate<Env>[];
  /**
   * Ordered application layers around accepted `/io` and `/notify` requests.
   * The default empty list applies no additional request policy.
   */
  meshMiddleware?: readonly MeshMiddleware<Env>[];
  /**
   * Run an all-mesh TTL sweep from `withInterocitor(...).scheduled()`.
   * Enabled by `true`, `1`, or `'1'`; disabled by default.
   */
  enableScheduledMaintenance?: (env: Env) => string | number | boolean | undefined;
  /**
   * Inactive hours before maintenance deletes a D1 sync root. A positive
   * number enables TTL deletion; omitted, invalid, or non-positive disables it.
   */
  pathTtlHours?: (env: Env) => string | number | undefined;
  /** Max bytes for one control object or recovery wrapper. Default: 256 KiB. */
  maxControlBytes?: (env: Env) => string | number | undefined;
  /** Max bytes for one CRDT change object. Default: 8 MiB. */
  maxChangeBytes?: (env: Env) => string | number | undefined;
  /** Max bytes for one mainline snapshot. Default: 16 MiB. */
  maxMainlineBytes?: (env: Env) => string | number | undefined;
  /** Max bytes for another D1 sync object. Default: 8 MiB. */
  maxGenericFileBytes?: (env: Env) => string | number | undefined;
  /** Max stored bytes for one durable file-body upload. Default: 32 MiB. */
  maxStoredFileBytes?: (env: Env) => string | number | undefined;
  /** Max aggregate durable file-body bytes for one mesh. Default: 512 MiB. */
  maxMeshStoredBytes?: (env: Env) => string | number | undefined;
  /**
   * Additional application policy for durable-file uploads.
   *
   * Runs after size, quota, and required device-header checks and before the
   * file-body-store write. Request metadata such as device ID and plaintext size is
   * client-asserted.
   *
   * Return `true` to allow, `false` to reject with default status, or an
   * explicit `{ allowed, status, reason }` object to control the response.
   * A malformed result or unavailable configured callback returns `503`.
   *
   * For policy that turns on the state of the mesh rather than of this write —
   * its age, its announced devices, what it already stores — pass the request
   * to `meshInfo()`.
   *
   * @see {@link ../docs/upload-policy.md | Decide who may upload durable files}
   *   — which requirement belongs in a deployment limit, a plan ceiling, or a
   *   per-write decision, with bot-protection and paid-tier recipes.
   */
  authorizeFileUpload?: (
    request: FileUploadAuthorizationRequest,
    env: Env,
  ) => FileUploadAuthorizationResult | Promise<FileUploadAuthorizationResult>;
  /**
   * Awaited instrumentation for completed storage operations. Callback errors
   * are isolated from the request; callback latency is request latency.
   */
  storageOperationAudit?: (event: WorkerAuditEvent, env: Env) => void | Promise<void>;
  /**
   * HMAC authority for checksummed mesh IDs. Omitted or empty values use
   * `'interocitor'` for development; production deployments must supply it.
   */
  meshSecret?: (env: Env) => string | undefined;
  /** Enable documented diagnostics with `true`, `1`, or `'1'`. Default: false. */
  verbose?: (env: Env) => string | number | boolean | undefined;
}

/**
 * Wiring required to mount Interocitor under one Worker URL prefix.
 *
 * `db` is the only mandatory getter for CRDT sync. Add `files` for durable
 * file/image APIs and `relay` for realtime invalidation over WebSockets.
 */
export interface InterocitorMountOptions<Env = unknown> {
  /**
   * URL prefix Interocitor will claim, e.g. `'/todo-interocitor'`.
   * Omit or pass `null` to claim Interocitor routes at the Worker root.
   */
  mountPrefix?: string | null;
  /**
   * Cross-origin policy for this deployment's Interocitor routes. Omit it to
   * use the default `Access-Control-Allow-Origin: *` response. When set, only
   * exact request origins in `allowedOrigins` receive that header.
   */
  cors?: CorsOptions<Env>;
  /**
   * Resolve the D1 database from the Worker env at request time.
   *
   * Use this when your D1 binding has a non-default name:
   * ```ts
   * withInterocitor(appWorker, { mountPrefix: '/sync', db: (env) => env.MY_DB });
   * ```
   *
   */
  db: (env: Env) => D1Database;
  /**
   * Resolve the configured destination for durable app file bodies.
   * The same mesh must resolve to the same store across reads, writes, and
   * deletes; changing its selection strands previously stored bodies.
   */
  files?: (env: Env, context: FileBodyStorageContext) => FileBodyStore | undefined;
  /** Runtime address, access, limits, maintenance, and instrumentation policy. */
  runtime?: InterocitorRuntimeOptions<Env>;
  /**
   * Resolve the relay Durable Object namespace from the Worker env at request time.
   *
   * Without this getter, notify routes return `501` and clients use polling.
   * ```ts
   * withInterocitor(appWorker, { mountPrefix: '/sync', relay: (env) => env.MY_RELAY });
   * ```
   */
  relay?: (env: Env) => DurableObjectNamespace;
}

/** Cross-origin policy for an Interocitor route handler. */
export interface CorsOptions<Env = unknown> {
  /**
   * Exact browser origins permitted to read Interocitor responses. An empty
   * list disables cross-origin browser access. `'*'` is not a permitted entry.
   */
  allowedOrigins: readonly string[] | ((env: Env) => readonly string[]);
}

/** Frozen request handler bundle returned by {@link createInterocitorMount}. */
export interface InterocitorMount<Env = unknown> {
  /** The normalized URL prefix claimed by this mount, e.g. `'/io'`. */
  mountPrefix: string;
  /** Absolute path of the health endpoint. */
  healthPath: string;
  /** Base path of the IO subsystem. */
  ioBase: string;
  /** Base path of the WebSocket notify subsystem. */
  notifyBase: string;
  /** Base path of the recovery-wrapper subsystem. */
  recoveryBase: string;
  /** Returns `true` if the given pathname belongs to this mount. */
  matches(pathname: string): boolean;
  /** Handle a request that has already been matched to this mount. */
  fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response>;
}

/** Options consumed by {@link createInterocitorSystemHandler}. */
export interface InterocitorSystemHandlerOptions<Env = unknown> {
  /** URL prefix shared with the mesh mount. */
  mountPrefix?: string | null;
  /** Cross-origin policy for system-operation responses. */
  cors?: CorsOptions<Env>;
  /** Resolve the D1 database used by system operations. */
  db: (env: Env) => D1Database;
  /** Integrity, TTL, checksum, and diagnostic settings used by system operations. */
  runtime?: Pick<
    InterocitorRuntimeOptions<Env>,
    "meshIntegrityGates" | "pathTtlHours" | "meshSecret" | "verbose"
  >;
}

/** Separately routed mesh-ID, metrics, and maintenance handler. */
export interface InterocitorSystemHandler<Env = unknown> {
  /** Base path of the system operation route. */
  systemBase: string;
  /** Returns `true` when a pathname belongs to this handler. */
  matches(pathname: string): boolean;
  /** Handle a matched request after the host has applied its own policy. */
  fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response>;
}

export type { PathType } from "./paths.ts";
