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

/**
 * Cloudflare Worker environment bindings consumed by Interocitor.
 *
 * All fields are optional — the package fails fast with a clear message
 * when a required binding is missing at runtime.
 *
 * You can extend this interface in your own `wrangler.toml` / env type:
 * ```ts
 * interface MyEnv extends InterocitorEnv {
 *   MY_KV: KVNamespace;
 * }
 * ```
 */
export interface InterocitorEnv extends Record<string, unknown> {
  /** D1 database binding. Required unless you pass `db` explicitly via mount options. */
  INTEROCITOR_DB?: D1Database;
  /** Shared secret used to derive per-prefix access tokens. */
  INTEROCITOR_ACCESS_TOKEN?: string;
  /** Bearer token required to call system ops (prune, reconcile, maintenance). */
  INTEROCITOR_SYSTEM_TOKEN?: string;
  /** Set to `'1'` to enable TTL-based maintenance in the `scheduled` handler. */
  INTEROCITOR_ENABLE_SCHEDULED_MAINTENANCE?: string;
  /** Hours after last activity before a path is eligible for TTL deletion. 0 = disabled. */
  INTEROCITOR_PATH_TTL_HOURS?: string | number;
  /** Max bytes for control files (manifest pointer, head, device heartbeat). Default 256 KiB. */
  INTEROCITOR_MAX_CONTROL_BYTES?: string | number;
  /** Max bytes for change files. Default 8 MiB. */
  INTEROCITOR_MAX_CHANGE_BYTES?: string | number;
  /** Max bytes for mainline snapshot files. Default 16 MiB. */
  INTEROCITOR_MAX_MAINLINE_BYTES?: string | number;
  /** Max bytes for any other file type. Default 8 MiB. */
  INTEROCITOR_MAX_GENERIC_FILE_BYTES?: string | number;
  /**
   * HMAC secret for issuing and validating mesh/team IDs.
   *
   * Worker uses this to mint mesh IDs via `issueMeshId()` and to verify
   * incoming mesh IDs via `isValidMeshId()`.
   *
   * Default: `'interocitor'`.
   *
   * ⚠️  Changing this secret invalidates ALL existing mesh IDs.
   * Peers will fail to join or sync with previously issued IDs.
   * Treat this as a permanent, deploy-once value.
   */
  INTEROCITOR_MESH_SECRET?: string;
}

/**
 * Thin adapter over a D1Database that adds convenience query helpers.
 * Obtain one via {@link createDatabaseAdapter}.
 */
export interface DatabaseAdapter {
  /** The adapter kind — always `'d1'` for this implementation. */
  kind: 'd1';
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

/** Options accepted by {@link createInterocitorMount} and {@link withInterocitor}. */
export interface InterocitorRuntimeOptions<Env = unknown> {
  accessToken?: (env: Env) => string | undefined;
  systemToken?: (env: Env) => string | undefined;
  enableScheduledMaintenance?: (env: Env) => string | number | boolean | undefined;
  pathTtlHours?: (env: Env) => string | number | undefined;
  maxControlBytes?: (env: Env) => string | number | undefined;
  maxChangeBytes?: (env: Env) => string | number | undefined;
  maxMainlineBytes?: (env: Env) => string | number | undefined;
  maxGenericFileBytes?: (env: Env) => string | number | undefined;
  meshSecret?: (env: Env) => string | undefined;
}

export interface InterocitorMountOptions<Env = unknown> {
  /**
   * URL prefix Interocitor will claim, e.g. `'/todo-interocitor'`.
   * Omit or pass `null` to mount at the root (handles all paths).
   */
  mountPrefix?: string | null;
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
  runtime?: InterocitorRuntimeOptions<Env>;
    /**
   * Resolve the relay Durable Object namespace from the Worker env at request time.
   *
   * Realtime notify routes are enabled only when this getter is provided.
   * ```ts
   * withInterocitor(appWorker, { mountPrefix: '/sync', relay: (env) => env.MY_RELAY });
   * ```
   */
  relay?: (env: Env) => DurableObjectNamespace;
}

/** A frozen Interocitor mount that can be embedded in any Worker. */
export interface InterocitorMount<Env = unknown> {
  /** The normalized URL prefix claimed by this mount, e.g. `'/io'`. */
  mountPrefix: string;
  /** Absolute path of the health endpoint. */
  healthPath: string;
  /** Base path of the IO subsystem. */
  ioBase: string;
  /** Base path of the WebSocket notify subsystem. */
  notifyBase: string;
  /** Base path of the system ops subsystem. */
  systemBase: string;
  /** Returns `true` if the given pathname belongs to this mount. */
  matches(pathname: string): boolean;
  /** Handle a request that has already been matched to this mount. */
  fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response>;
}

// PathType is defined in paths.ts as a const union — imported from there.
// Re-exported here so consumers can import everything from one place.
export type { PathType } from './paths.ts';
