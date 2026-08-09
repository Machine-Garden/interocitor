import { createDatabaseAdapter } from './db-adapter.ts';
import { uuidv7 } from './ids.ts';
import {
  fileNameFromPath,
  normalizePath,
  opDeletePath,
  opGetFile,
  opListChildren,
  opPutImmutable,
  opPutOverwrite,
  opPutSemantic,
  opReconcileMetrics,
} from './ops.ts';
import { PATH_TYPE, classifyPath, meshRootForPath } from './paths.ts';
import { broadcast } from './relay.ts';
import { getMaintenanceStatus, runMaintenance } from './maintenance.ts';
import type {
  D1Database,
  DatabaseAdapter,
  DurableObjectNamespace,
  ExecutionContextLike,
  InterocitorMount,
  InterocitorMountOptions,
  InterocitorSystemHandlerOptions,
  InterocitorRuntimeOptions,
  WorkerLike,
  FileBodyStore,
  FileUploadAuthorizationResult,
  CorsOptions,
  MeshAccess,
  MeshAuthorization,
  MeshAuthorizationMiddlewareOptions,
  MeshAuthorizer,
  MeshIntegrityContext,
  MeshIntegrityGate,
  MeshMiddleware,
  MeshRequestContext,
  InterocitorSystemHandler,
  WorkerAuditEvent,
} from './types.ts';
export type {
  InterocitorMountOptions,
  InterocitorSystemHandlerOptions,
  InterocitorRuntimeOptions,
  MeshAccess,
  MeshAuthorization,
  MeshAuthorizer,
  MeshIntegrityContext,
  MeshIntegrityGate,
  MeshMiddleware,
  MeshRequestContext,
  InterocitorSystemHandler,
} from './types.ts';

const IO_PREFIX = '/io';
const NOTIFY_PREFIX = '/notify';
const RECOVERY_PREFIX = '/recovery';
const SYSTEM_PREFIX = '/__interocitor/system';
const RECOVERY_STORAGE_PREFIX = '__interocitor_recovery__';
const RECOVERY_LOCATOR_RE = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_CONTROL_BYTES = 256 * 1024;
const DEFAULT_CHANGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAINLINE_BYTES = 16 * 1024 * 1024;
const DEFAULT_GENERIC_FILE_BYTES = 8 * 1024 * 1024;

const textEncoder = new TextEncoder();

function wrapSchemaError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (/no such table: (files|folders)/i.test(message)) {
    throw new Error(
      'Interocitor D1 schema missing. Seed your database with @interocitor/workers/schema.sql before serving requests. Original error: ' + message,
    );
  }
  throw error instanceof Error ? error : new Error(message);
}

const DEFAULT_MESH_SECRET = 'interocitor';
const DEFAULT_STORED_FILE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MESH_STORED_BYTES = 512 * 1024 * 1024;

interface ResolvedRuntimeConfig {
  meshIntegrityGates: readonly MeshIntegrityGate<unknown>[];
  meshMiddleware: readonly MeshMiddleware<unknown>[];
  enableScheduledMaintenance: boolean;
  pathTtlHours: number;
  maxControlBytes: number;
  maxChangeBytes: number;
  maxMainlineBytes: number;
  maxGenericFileBytes: number;
  maxStoredFileBytes: number;
  maxMeshStoredBytes: number;
  authorizeFileUpload?: InterocitorRuntimeOptions<unknown>['authorizeFileUpload'];
  storageOperationAudit?: InterocitorRuntimeOptions<unknown>['storageOperationAudit'];
  meshSecret: string;
  verbose: boolean;
}

function parsePositiveInt(value: string | number | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePositiveNumber(value: string | number | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveRuntimeConfig<Env>(env: Env, runtime?: InterocitorRuntimeOptions<Env>): ResolvedRuntimeConfig {
  const scheduledMaintenance = runtime?.enableScheduledMaintenance?.(env);
  const verbose = runtime?.verbose?.(env);
  return {
    meshIntegrityGates: (runtime?.meshIntegrityGates ?? []) as readonly MeshIntegrityGate<unknown>[],
    meshMiddleware: (runtime?.meshMiddleware ?? []) as readonly MeshMiddleware<unknown>[],
    enableScheduledMaintenance: scheduledMaintenance === true || scheduledMaintenance === '1' || scheduledMaintenance === 1,
    pathTtlHours: parsePositiveNumber(runtime?.pathTtlHours?.(env), 0),
    maxControlBytes: parsePositiveInt(runtime?.maxControlBytes?.(env), DEFAULT_CONTROL_BYTES),
    maxChangeBytes: parsePositiveInt(runtime?.maxChangeBytes?.(env), DEFAULT_CHANGE_BYTES),
    maxMainlineBytes: parsePositiveInt(runtime?.maxMainlineBytes?.(env), DEFAULT_MAINLINE_BYTES),
    maxGenericFileBytes: parsePositiveInt(runtime?.maxGenericFileBytes?.(env), DEFAULT_GENERIC_FILE_BYTES),
    maxStoredFileBytes: parsePositiveInt(runtime?.maxStoredFileBytes?.(env), DEFAULT_STORED_FILE_BYTES),
    maxMeshStoredBytes: parsePositiveInt(runtime?.maxMeshStoredBytes?.(env), DEFAULT_MESH_STORED_BYTES),
    authorizeFileUpload: runtime?.authorizeFileUpload as InterocitorRuntimeOptions<unknown>['authorizeFileUpload'],
    storageOperationAudit: runtime?.storageOperationAudit as InterocitorRuntimeOptions<unknown>['storageOperationAudit'],
    meshSecret: runtime?.meshSecret?.(env) || DEFAULT_MESH_SECRET,
    verbose: verbose === true || verbose === '1' || verbose === 1,
  };
}

function getMeshSecret(secret?: string): string {
  return secret || DEFAULT_MESH_SECRET;
}

async function importMeshSecretKey(secret?: string): Promise<CryptoKey> {
  const raw = new TextEncoder().encode(getMeshSecret(secret));
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/**
 * Compute the HMAC tag for a mesh-id UUID component. Mirrors the client-side
 * `computeTag` in `@interocitor/core` so issued ids round-trip cleanly.
 */
async function computeMeshTag(uuid: string, secret: CryptoKey): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', secret, textEncoder.encode(uuid));
  const tagBytes = new Uint8Array(sig, 0, 8);
  let binary = '';
  for (let i = 0; i < tagBytes.length; i++) binary += String.fromCodePoint(tagBytes[i]);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

const MESH_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function isValidChecksummedMesh(prefix: string, meshSecret?: string): Promise<boolean> {
  if (!prefix) return false;
  const dot = prefix.lastIndexOf('.');
  if (dot === -1) return false;
  const uuid = prefix.slice(0, dot);
  const tag = prefix.slice(dot + 1);
  if (!MESH_UUID_RE.test(uuid) || !tag) return false;
  const secret = await importMeshSecretKey(meshSecret);
  const expected = await computeMeshTag(uuid, secret);
  // Constant-time compare.
  if (tag.length !== expected.length) return false;
  let result = 0;
  for (let i = 0; i < tag.length; i++) result |= tag.codePointAt(i)! ^ expected.codePointAt(i)!;
  return result === 0;
}

/**
 * Accept `<UUIDv7>.<tag>` addresses issued with the configured `meshSecret`.
 * The tag is the first eight HMAC-SHA-256 bytes encoded as base64url. This
 * establishes address integrity; caller access remains a middleware decision.
 */
export const checksummedMeshIntegrityGate: MeshIntegrityGate = async ({ verifyChecksum }) =>
  verifyChecksum();

function fileSizeLimitForPathType(pathType: string, runtime: ResolvedRuntimeConfig): number {
  if (
    [
      PATH_TYPE.MANIFEST_POINTER,
      PATH_TYPE.MANIFEST_SNAPSHOT,
      PATH_TYPE.HEAD,
      PATH_TYPE.DEVICE_HEARTBEAT,
    ].includes(pathType as never)
  ) {
    return runtime.maxControlBytes;
  }
  if (pathType === PATH_TYPE.CHANGE_FILE) return runtime.maxChangeBytes;
  if (pathType === PATH_TYPE.MAINLINE_SNAPSHOT) return runtime.maxMainlineBytes;
  return runtime.maxGenericFileBytes;
}

/**
 * Enforce a four-state application access decision as mesh middleware.
 *
 * `none` and `full` continue, `readonly` rejects writes, and `deny` rejects
 * every request. Authorizer failures and invalid decisions return `503`.
 */
export function createMeshAuthorizationMiddleware<Env>(
  authorizer: MeshAuthorizer<Env>,
  options: MeshAuthorizationMiddlewareOptions = {},
): MeshMiddleware<Env> {
  const denied = () => jsonResponse(
    { error: options.concealDenied ? 'Not found' : 'Forbidden' },
    options.concealDenied ? 404 : 403,
  );
  return async (context, env, next) => {
    let decision: MeshAuthorization;
    try {
      decision = await authorizer({ ...context, request: context.request.clone() }, env);
    } catch {
      return jsonResponse({ error: 'Authorization unavailable' }, 503);
    }
    if (decision === 'none' || decision === 'full') return next();
    if (decision === 'readonly') return context.access === 'write' ? denied() : next();
    if (decision === 'deny') return denied();
    return jsonResponse({ error: 'Authorization unavailable' }, 503);
  };
}

async function resolveMesh<Env>(
  address: string,
  request: Request,
  env: Env,
  runtime: ResolvedRuntimeConfig,
): Promise<string | Response> {
  const integrity: MeshIntegrityContext = {
    address,
    request: request.clone(),
    verifyChecksum: () => isValidChecksummedMesh(address, runtime.meshSecret),
  };
  try {
    for (const gate of runtime.meshIntegrityGates) {
      if (await gate(integrity, env)) return address;
    }
  } catch (error) {
    if (runtime.verbose) console.warn('[interocitor:mesh] integrity gate failed', error);
    return jsonResponse({ error: 'Mesh integrity unavailable' }, 503);
  }
  return jsonResponse({ error: 'Not found' }, 404);
}

async function runMeshMiddleware<Env>(
  context: MeshRequestContext,
  env: Env,
  middleware: readonly MeshMiddleware<unknown>[],
  terminal: () => Promise<Response>,
  index = 0,
): Promise<Response> {
  const layer = middleware[index] as MeshMiddleware<Env> | undefined;
  if (!layer) return terminal();
  let continued = false;
  return layer(
    { ...context, request: context.request.clone() },
    env,
    () => {
      if (continued) return Promise.resolve(jsonResponse({ error: 'Middleware called next() more than once' }, 500));
      continued = true;
      return runMeshMiddleware(context, env, middleware, terminal, index + 1);
    },
  );
}

function ioRequestAccess(op: string, method: string): MeshAccess | null {
  if (op === 'health' && method === 'GET') return 'read';
  if (op === 'file' || op === 'stored-file') {
    if (method === 'GET') return 'read';
    if (method === 'PUT' || method === 'DELETE') return 'write';
    return null;
  }
  if (op === 'metadata' || op === 'stored-file-metadata' || op === 'ensure-folder' || op === 'list-files' || op === 'list-folders') {
    return method === 'POST' ? 'read' : null;
  }
  return null;
}

function resolveDatabase<Env>(
  env: Env,
  dbGetter: (env: Env) => D1Database,
): DatabaseAdapter {
  return createDatabaseAdapter(dbGetter(env));
}

function normalizeMountPrefix(prefix = ''): string {
  const trimmed = String(prefix || '').trim();
  if (!trimmed || trimmed === '/') return '';
  return `/${trimmed.replaceAll(/^\/+|\/+$/g, '')}`;
}

function joinMountPath(prefix: string, path: string): string {
  const mountPrefix = normalizeMountPrefix(prefix);
  return mountPrefix ? `${mountPrefix}${path}` : path;
}

function stripMountPrefix(pathname: string, mountPrefix = ''): string | null {
  const normalized = normalizeMountPrefix(mountPrefix);
  if (!normalized) return pathname;
  if (pathname === normalized) return '/';
  if (pathname.startsWith(`${normalized}/`)) return pathname.slice(normalized.length) || '/';
  return null;
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'OPTIONS, GET, PUT, DELETE, POST');
  headers.set('Access-Control-Allow-Headers', '*');
  headers.set('Access-Control-Expose-Headers', 'ETag');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function appendVary(headers: Headers, value: string): void {
  const values = headers.get('Vary')?.split(',').map(item => item.trim()).filter(Boolean) ?? [];
  if (!values.some(item => item.toLowerCase() === value.toLowerCase())) values.push(value);
  headers.set('Vary', values.join(', '));
}

function applyConfiguredCors<Env>(response: Response, request: Request, env: Env, cors?: CorsOptions<Env>): Response {
  // A WebSocket upgrade response carries Cloudflare-specific state that cannot
  // be preserved by reconstructing Response. Browsers do not apply CORS to it.
  if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') return response;

  const headers = new Headers(response.headers);
  if (cors) {
    const origins = typeof cors.allowedOrigins === 'function' ? cors.allowedOrigins(env) : cors.allowedOrigins;
    const origin = request.headers.get('Origin');
    headers.delete('Access-Control-Allow-Origin');
    appendVary(headers, 'Origin');
    if (origin && origin !== '*' && origins.includes(origin)) headers.set('Access-Control-Allow-Origin', origin);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function preflightResponse(): Response {
  return withCors(new Response('', { status: 200 }));
}

function jsonResponse(payload: unknown, status = 200): Response {
  return withCors(
    new Response(JSON.stringify(payload, null, 2), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    }),
  );
}

function requestId(request: Request): string | undefined {
  return request.headers.get('CF-Ray') || request.headers.get('X-Request-Id') || undefined;
}

async function emitAudit<Env>(runtime: ResolvedRuntimeConfig, env: Env, event: Omit<WorkerAuditEvent, 'event' | 'at'>): Promise<void> {
  if (!runtime.storageOperationAudit) return;
  const auditEvent: WorkerAuditEvent = { event: 'interocitor.audit', at: new Date().toISOString(), ...event };
  try {
    await runtime.storageOperationAudit(auditEvent, env);
  } catch (error) {
    if (runtime.verbose) console.warn('[interocitor:audit] callback failed', error);
  }
}

function bodyForEmptyResponse(status: number): null | '' {
  return status === 204 || status === 205 || status === 304 ? null : '';
}

function emptyResponse(status: number): Response {
  return withCors(new Response(bodyForEmptyResponse(status), { status }));
}

function parseIo(url: URL): { prefix: string; op: string } {
  const rest = url.pathname.slice(`${IO_PREFIX}/`.length);
  const parts = rest.split('/').filter(Boolean);
  const prefix = decodeURIComponent(parts.shift() || '');
  const op = decodeURIComponent(parts.shift() || '');
  return { prefix, op };
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    return await request.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function readBytes(request: Request): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await request.arrayBuffer());
  } catch {
    return null;
  }
}

async function handleGetFile<Env>(db: DatabaseAdapter, prefix: string, path: string, request: Request, runtime: ResolvedRuntimeConfig, env: Env): Promise<Response> {
  const pathType = classifyPath(path);
  const result = await opGetFile(db.raw, prefix, path, pathType);
  if (!result.found) {
    await emitAudit(runtime, env, { op: 'read', address: prefix, path: normalizePath(path), pathType, status: 404, outcome: 'not-found', requestId: requestId(request) });
    return withCors(new Response('Not found', { status: 404 }));
  }
  await emitAudit(runtime, env, { op: 'read', address: prefix, path: normalizePath(path), pathType, status: 200, outcome: 'ok', bytes: result.size, requestId: requestId(request) });
  return withCors(
    new Response(result.bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(result.size),
        ETag: result.etag ?? '',
        'Last-Modified': result.modifiedTime ?? '',
      },
    }),
  );
}

async function handleMetadata<Env>(db: DatabaseAdapter, prefix: string, path: string, request: Request, runtime: ResolvedRuntimeConfig, env: Env): Promise<Response> {
  const pathType = classifyPath(path);
  const result = await opGetFile(db.raw, prefix, path, pathType);
  if (!result.found) {
    await emitAudit(runtime, env, { op: 'metadata', address: prefix, path: normalizePath(path), pathType, status: 404, outcome: 'not-found', requestId: requestId(request) });
    return jsonResponse({ file: null }, 404);
  }
  await emitAudit(runtime, env, { op: 'metadata', address: prefix, path: normalizePath(path), pathType, status: 200, outcome: 'ok', bytes: result.size, requestId: requestId(request) });
  return jsonResponse({
    file: {
      name: fileNameFromPath(path),
      path: normalizePath(path),
      size: result.size,
      modifiedTime: result.modifiedTime,
      etag: result.etag,
    },
  }, 200);
}

async function handleWriteFile<Env>(
  db: DatabaseAdapter,
  prefix: string,
  path: string,
  request: Request,
  runtime: ResolvedRuntimeConfig,
  ctx: ExecutionContextLike,
  relay: DurableObjectNamespace | undefined,
  env: Env,
  requestIdValue?: string,
): Promise<Response> {
  const bytes = await readBytes(request);
  if (!bytes) return jsonResponse({ error: 'Invalid request body' }, 400);
  const pathType = classifyPath(path);
  const limit = fileSizeLimitForPathType(pathType, runtime);
  if (bytes.byteLength > limit) return jsonResponse({ error: 'Payload too large', limit }, 413);
  const remoteRoot = meshRootForPath(path, pathType);
  const shouldBroadcast = ![
    PATH_TYPE.DEVICE_HEARTBEAT,
    PATH_TYPE.MANIFEST_SNAPSHOT,
  ].includes(pathType as never);
  const notify = async (status: number, wrote = true): Promise<Response> => {
    await emitAudit(runtime, env, { op: 'write', address: prefix, path: normalizePath(path), pathType, status, outcome: status >= 200 && status < 300 ? 'ok' : 'rejected', bytes: bytes.byteLength, requestId: requestIdValue });
    if (wrote && shouldBroadcast && status >= 200 && status < 300) {
      const payload = { type: 'invalidation', op: 'write', path: normalizePath(path), pathType, ts: Date.now() };
      broadcast(relay, ctx, prefix, payload, { verbose: runtime.verbose });
    }
    return emptyResponse(status);
  };
  if (pathType === PATH_TYPE.MANIFEST_POINTER || pathType === PATH_TYPE.HEAD) {
    const result = await opPutSemantic(db.raw, prefix, path, bytes, pathType, remoteRoot);
    return notify(result.status);
  }
  if (pathType === PATH_TYPE.DEVICE_HEARTBEAT) {
    const result = await opPutOverwrite(db.raw, prefix, path, bytes, pathType, remoteRoot);
    return notify(result.status);
  }
  const result = await opPutImmutable(db.raw, prefix, path, bytes, pathType, remoteRoot);
  return notify(result.status);
}

async function handleListFiles<Env>(db: DatabaseAdapter, prefix: string, body: Record<string, unknown>, request: Request, runtime: ResolvedRuntimeConfig, env: Env): Promise<Response> {
  const path = normalizePath(String(body?.path || '/'));
  const listing = await opListChildren(db.raw, prefix, path);
  await emitAudit(runtime, env, { op: 'list', address: prefix, path, status: 200, outcome: 'ok', requestId: requestId(request) });
  return jsonResponse({ files: listing.files }, 200);
}

async function handleListFolders<Env>(db: DatabaseAdapter, prefix: string, body: Record<string, unknown>, request: Request, runtime: ResolvedRuntimeConfig, env: Env): Promise<Response> {
  const path = normalizePath(String(body?.path || '/'));
  const listing = await opListChildren(db.raw, prefix, path);
  await emitAudit(runtime, env, { op: 'list', address: prefix, path, status: 200, outcome: 'ok', requestId: requestId(request) });
  return jsonResponse({ folders: listing.folders }, 200);
}

async function handleDelete<Env>(
  db: DatabaseAdapter,
  prefix: string,
  path: string,
  ctx: ExecutionContextLike,
  runtime: ResolvedRuntimeConfig,
  relay: DurableObjectNamespace | undefined,
  env: Env,
  requestIdValue?: string,
): Promise<Response> {
  const remoteRoot = meshRootForPath(path);
  const deleted = await opDeletePath(db.raw, prefix, path, remoteRoot);
  await emitAudit(runtime, env, { op: 'delete', address: prefix, path: normalizePath(path), status: deleted ? 204 : 404, outcome: deleted ? 'ok' : 'not-found', requestId: requestIdValue });
  if (deleted) {
    broadcast(relay, ctx, prefix, { type: 'invalidation', op: 'delete', path: normalizePath(path), ts: Date.now() }, { verbose: runtime.verbose });
  }
  return emptyResponse(deleted ? 204 : 404);
}

interface StoredFileRow {
  [key: string]: unknown;
  prefix?: string;
  path?: string;
  body_key?: string;
  size?: number;
  plaintext_size?: number | null;
  content_type?: string | null;
  taint?: string | null;
  uploaded_by_device_id?: string;
  uploaded_at?: string;
  modified_time?: string;
  last_accessed_at?: string | null;
  use_count?: number;
  etag?: string | null;
}

function storedFileKey(prefix: string, path: string): string {
  return `meshes/${encodeURIComponent(prefix)}/files/${encodeURIComponent(normalizePath(path).slice(1))}`;
}

function storedFileMetadata(row: StoredFileRow): Record<string, unknown> {
  const path = normalizePath(String(row.path || '/'));
  return {
    name: fileNameFromPath(path),
    path,
    size: Number(row.size ?? 0),
    modifiedTime: String(row.modified_time || row.uploaded_at || ''),
    etag: row.etag || undefined,
    uploadedByDeviceId: String(row.uploaded_by_device_id || ''),
    uploadedAt: String(row.uploaded_at || ''),
    lastAccessedAt: row.last_accessed_at || undefined,
    useCount: Number(row.use_count ?? 0),
    plaintextSize: row.plaintext_size == null ? undefined : Number(row.plaintext_size),
    storedSize: Number(row.size ?? 0),
    contentType: row.content_type || undefined,
    taint: row.taint || undefined,
  };
}

async function currentStoredBytes(db: DatabaseAdapter, prefix: string): Promise<number> {
  const row = await db.first<{ total?: number }>('SELECT COALESCE(SUM(size), 0) AS total FROM stored_files WHERE prefix=?1', prefix);
  return Number(row?.total ?? 0);
}

async function handleStoredFileMetadata<Env>(db: DatabaseAdapter, prefix: string, path: string, request: Request, runtime: ResolvedRuntimeConfig, env: Env): Promise<Response> {
  const normalized = normalizePath(path);
  const row = await db.first<StoredFileRow>('SELECT * FROM stored_files WHERE prefix=?1 AND path=?2 LIMIT 1', prefix, normalized);
  if (!row) {
    await emitAudit(runtime, env, { op: 'stored-file-metadata', address: prefix, path: normalized, status: 404, outcome: 'not-found', requestId: requestId(request) });
    return jsonResponse({ file: null }, 404);
  }
  await emitAudit(runtime, env, { op: 'stored-file-metadata', address: prefix, path: normalized, status: 200, outcome: 'ok', bytes: Number(row.size ?? 0), taint: row.taint || undefined, requestId: requestId(request) });
  return jsonResponse({ file: storedFileMetadata(row) }, 200);
}

async function handleGetStoredFile<Env>(db: DatabaseAdapter, store: FileBodyStore | undefined, prefix: string, path: string, request: Request, runtime: ResolvedRuntimeConfig, env: Env): Promise<Response> {
  if (!store) return jsonResponse({ error: 'File body store not configured' }, 501);
  const normalized = normalizePath(path);
  const row = await db.first<StoredFileRow>('SELECT *, r2_key AS body_key FROM stored_files WHERE prefix=?1 AND path=?2 LIMIT 1', prefix, normalized);
  if (!row?.body_key) {
    await emitAudit(runtime, env, { op: 'stored-file-read', address: prefix, path: normalized, status: 404, outcome: 'not-found', requestId: requestId(request) });
    return withCors(new Response('Not found', { status: 404 }));
  }
  const object = await store.get(String(row.body_key));
  if (!object) {
    await emitAudit(runtime, env, { op: 'stored-file-read', address: prefix, path: normalized, status: 404, outcome: 'not-found', taint: row.taint || undefined, requestId: requestId(request) });
    return withCors(new Response('Not found', { status: 404 }));
  }
  const now = new Date().toISOString();
  await db.run('UPDATE stored_files SET last_accessed_at=?3, use_count=use_count+1 WHERE prefix=?1 AND path=?2', prefix, normalized, now);
  await emitAudit(runtime, env, { op: 'stored-file-read', address: prefix, path: normalized, status: 200, outcome: 'ok', bytes: Number(row.size ?? object.size), taint: row.taint || undefined, requestId: requestId(request) });
  const headers = new Headers({
    'Content-Type': String(row.content_type || 'application/octet-stream'),
    'Content-Length': String(object.size),
  });
  if (object.etag || row.etag) headers.set('ETag', String(object.etag || row.etag));
  return withCors(new Response(object.body, { status: 200, headers }));
}

async function normalizeAuthorization(result: FileUploadAuthorizationResult): Promise<{ allowed: boolean; reason?: string; status: number }> {
  if (typeof result === 'boolean') return { allowed: result, status: result ? 200 : 403 };
  return { allowed: result.allowed, reason: result.reason, status: result.status ?? (result.allowed ? 200 : 403) };
}

async function handlePutStoredFile<Env>(
  db: DatabaseAdapter,
  store: FileBodyStore | undefined,
  prefix: string,
  path: string,
  request: Request,
  runtime: ResolvedRuntimeConfig,
  env: Env,
): Promise<Response> {
  if (!store) return jsonResponse({ error: 'File body store not configured' }, 501);
  const bytes = await readBytes(request);
  if (!bytes) return jsonResponse({ error: 'Invalid request body' }, 400);
  if (bytes.byteLength > runtime.maxStoredFileBytes) return jsonResponse({ error: 'Payload too large', limit: runtime.maxStoredFileBytes }, 413);
  const normalized = normalizePath(path);
  const uploadedByDeviceId = String(request.headers.get('X-Interocitor-Device-Id') || '').trim();
  if (!uploadedByDeviceId) return jsonResponse({ error: 'Missing X-Interocitor-Device-Id' }, 401);
  const contentType = request.headers.get('Content-Type') || 'application/octet-stream';
  const taint = String(request.headers.get('X-Interocitor-Taint') || '').trim() || null;
  const plaintextSizeHeader = request.headers.get('X-Interocitor-Plaintext-Size');
  const plaintextSize = plaintextSizeHeader ? Number.parseInt(plaintextSizeHeader, 10) : undefined;
  const existing = await db.first<StoredFileRow>('SELECT size, r2_key AS body_key FROM stored_files WHERE prefix=?1 AND path=?2 LIMIT 1', prefix, normalized);
  const current = await currentStoredBytes(db, prefix);
  const nextTotal = current - Number(existing?.size ?? 0) + bytes.byteLength;
  if (nextTotal > runtime.maxMeshStoredBytes) return jsonResponse({ error: 'Mesh storage quota exceeded', limit: runtime.maxMeshStoredBytes }, 413);
  if (runtime.authorizeFileUpload) {
    const auth = await normalizeAuthorization(await runtime.authorizeFileUpload({
      address: prefix,
      path: normalized,
      uploadedByDeviceId,
      size: bytes.byteLength,
      plaintextSize: Number.isFinite(plaintextSize) ? plaintextSize : undefined,
      contentType,
      taint: taint ?? undefined,
      currentMeshStoredBytes: current,
      maxMeshStoredBytes: runtime.maxMeshStoredBytes,
      request,
    }, env));
    if (!auth.allowed) return jsonResponse({ error: auth.reason || 'Upload rejected' }, auth.status);
  }
  const key = String(existing?.body_key || storedFileKey(prefix, normalized));
  const now = new Date().toISOString();
  await store.put(key, bytes, {
    contentType,
  });
  const etag = crypto.randomUUID();
  await db.run(
    `INSERT INTO stored_files (prefix,path,r2_key,size,plaintext_size,content_type,taint,uploaded_by_device_id,uploaded_at,modified_time,last_accessed_at,use_count,etag)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9,NULL,0,?10)
     ON CONFLICT(prefix,path) DO UPDATE SET
       r2_key=excluded.r2_key, size=excluded.size, plaintext_size=excluded.plaintext_size,
       content_type=excluded.content_type, taint=excluded.taint,
       uploaded_by_device_id=excluded.uploaded_by_device_id,
       uploaded_at=excluded.uploaded_at, modified_time=excluded.modified_time,
       last_accessed_at=NULL, use_count=0, etag=excluded.etag`,
    prefix,
    normalized,
    key,
    bytes.byteLength,
    Number.isFinite(plaintextSize) ? plaintextSize : null,
    contentType,
    taint,
    uploadedByDeviceId,
    now,
    etag,
  );
  const row = await db.first<StoredFileRow>('SELECT * FROM stored_files WHERE prefix=?1 AND path=?2 LIMIT 1', prefix, normalized);
  const status = existing ? 200 : 201;
  await emitAudit(runtime, env, { op: 'stored-file-write', address: prefix, path: normalized, status, outcome: 'ok', bytes: bytes.byteLength, taint: taint ?? undefined, requestId: requestId(request) });
  return jsonResponse({ file: storedFileMetadata(row ?? { path: normalized, size: bytes.byteLength, uploaded_by_device_id: uploadedByDeviceId, uploaded_at: now, modified_time: now, etag, taint }) }, status);
}

async function handleDeleteStoredFile<Env>(db: DatabaseAdapter, store: FileBodyStore | undefined, prefix: string, path: string, request: Request, runtime: ResolvedRuntimeConfig, env: Env): Promise<Response> {
  if (!store) return jsonResponse({ error: 'File body store not configured' }, 501);
  const normalized = normalizePath(path);
  const row = await db.first<StoredFileRow>('SELECT r2_key AS body_key, size, taint FROM stored_files WHERE prefix=?1 AND path=?2 LIMIT 1', prefix, normalized);
  if (!row?.body_key) {
    await emitAudit(runtime, env, { op: 'stored-file-delete', address: prefix, path: normalized, status: 404, outcome: 'not-found', requestId: requestId(request) });
    return emptyResponse(404);
  }
  await store.delete(String(row.body_key));
  await db.run('DELETE FROM stored_files WHERE prefix=?1 AND path=?2', prefix, normalized);
  await emitAudit(runtime, env, { op: 'stored-file-delete', address: prefix, path: normalized, status: 204, outcome: 'ok', bytes: Number(row.size ?? 0), taint: row.taint || undefined, requestId: requestId(request) });
  return emptyResponse(204);
}

async function handleSystemOperation<Env>(
  db: DatabaseAdapter,
  request: Request,
  url: URL,
  runtime: ResolvedRuntimeConfig,
  env: Env,
): Promise<Response> {
  try {
    const meshSecret = runtime.meshSecret;
    const rest = url.pathname.slice(`${SYSTEM_PREFIX}/`.length);
    const prefix = decodeURIComponent(rest.split('/').filter(Boolean)[0] || '');
    const body = await readJsonBody(request);
    const op = String(body?.op || '');
    if (!prefix || !op) return jsonResponse({ error: 'Missing prefix or op' }, 400);
    let storageKey = prefix;
    if (op !== 'issue-mesh-id' && op !== 'validate-mesh-id') {
      const mesh = await resolveMesh(prefix, request, env, runtime);
      if (mesh instanceof Response) return mesh;
      storageKey = mesh;
    }
    if (op === 'reconcile-metrics') {
      const remotePath = normalizePath(String(body?.remotePath || '/'));
      return jsonResponse(await opReconcileMetrics(db.raw, storageKey, remotePath), 200);
    }
    if (op === 'run-maintenance') {
      return jsonResponse(await runMaintenance(db, runtime.pathTtlHours, storageKey), 200);
    }
    if (op === 'maintenance-status') {
      const remotePath = normalizePath(String(body?.remotePath || '/'));
      return jsonResponse(await getMaintenanceStatus(db, storageKey, remotePath), 200);
    }
    if (op === 'issue-mesh-id') {
      const secret = await importMeshSecretKey(meshSecret);
      const id = uuidv7();
      const sig = await crypto.subtle.sign('HMAC', secret, textEncoder.encode(id));
      const tagBytes = new Uint8Array(sig, 0, 8);
      let binary = '';
      for (let i = 0; i < tagBytes.length; i++) binary += String.fromCodePoint(tagBytes[i]);
      const tag = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
      return jsonResponse({ meshId: `${id}.${tag}` });
    }
    if (op === 'validate-mesh-id') {
      const meshId = String(body?.meshId || '');
      if (!meshId) return jsonResponse({ error: 'Missing meshId' }, 400);
      const dot = meshId.lastIndexOf('.');
      if (dot === -1) return jsonResponse({ valid: false });
      const uuid = meshId.slice(0, dot);
      const tag = meshId.slice(dot + 1);
      const secret = await importMeshSecretKey(meshSecret);
      const sig = await crypto.subtle.sign('HMAC', secret, textEncoder.encode(uuid));
      const expectedBytes = new Uint8Array(sig, 0, 8);
      let binary = '';
      for (let i = 0; i < expectedBytes.length; i++) binary += String.fromCodePoint(expectedBytes[i]!);
      const expected = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
      let result = 0;
      if (tag.length !== expected.length) return jsonResponse({ valid: false });
      for (let i = 0; i < tag.length; i++) result |= tag.codePointAt(i)! ^ expected.codePointAt(i)!;
      return jsonResponse({ valid: result === 0 });
    }
    return jsonResponse({ error: 'Unknown op' }, 404);
  } catch (error) {
    wrapSchemaError(error);
  }
}

async function handleWsUpgrade<Env>(
  request: Request,
  env: Env,
  runtime: ResolvedRuntimeConfig,
  _ctx: ExecutionContextLike,
  prefix: string,
  relayGetter?: (env: Env) => DurableObjectNamespace,
): Promise<Response> {
  const mesh = await resolveMesh(prefix, request, env, runtime);
  if (mesh instanceof Response) return mesh;
  return runMeshMiddleware(
    { address: mesh, request, surface: 'notify', access: 'read' },
    env,
    runtime.meshMiddleware,
    async () => {
      const relay = relayGetter ? relayGetter(env) : undefined;
      if (!relay) {
        if (runtime.verbose) console.warn('[interocitor:relay] notify request failed: relay binding not configured', { prefix });
        return new Response('WebSocket relay not configured', { status: 501 });
      }
      const stub = relay.get(relay.idFromName(mesh));
      const url = new URL(request.url);
      if (request.method.toUpperCase() === 'GET' && url.pathname.split('/').filter(Boolean)[2] === 'health') {
        return withCors(await stub.fetch(new Request('https://internal/__status')));
      }
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket upgrade', { status: 426 });
      const connectUrl = new URL(request.url);
      connectUrl.pathname = '/__connect';
      return stub.fetch(new Request(connectUrl.toString(), request));
    },
  );
}

async function handleIoRequest<Env>(
  request: Request,
  env: Env,
  runtime: ResolvedRuntimeConfig,
  ctx: ExecutionContextLike,
  url: URL,
  dbGetter: (env: Env) => D1Database,
  relayGetter?: (env: Env) => DurableObjectNamespace,
  filesGetter?: InterocitorMountOptions<Env>['files'],
): Promise<Response> {
  const method = request.method.toUpperCase();
  const { prefix, op } = parseIo(url);
  const access = ioRequestAccess(op, method);
  if (!access) return withCors(new Response('Not found', { status: 404 }));
  const mesh = await resolveMesh(prefix, request, env, runtime);
  if (mesh instanceof Response) return mesh;
  return runMeshMiddleware(
    { address: mesh, request, surface: 'io', access },
    env,
    runtime.meshMiddleware,
    async () => {
      const db = resolveDatabase(env, dbGetter);
      const relay = relayGetter ? relayGetter(env) : undefined;
      const files = filesGetter ? filesGetter(env, { address: mesh }) : undefined;
      const storageKey = mesh;

  if (op === 'health' && method === 'GET') {
    return withCors(new Response('interocitor cloudflare worker\n', { status: 200 }));
  }
  if (op === 'file') {
    const path = normalizePath(url.searchParams.get('path') || '/');
    if (method === 'GET') return handleGetFile(db, storageKey, path, request, runtime, env);
    if (method === 'PUT') return handleWriteFile(db, storageKey, path, request, runtime, ctx, relay, env, requestId(request));
    if (method === 'DELETE') return handleDelete(db, storageKey, path, ctx, runtime, relay, env, requestId(request));
  }
  if (op === 'metadata' && method === 'POST') {
    const body = await readJsonBody(request);
    return handleMetadata(db, storageKey, String(body?.path || '/'), request, runtime, env);
  }
  if (op === 'stored-file') {
    const path = normalizePath(url.searchParams.get('path') || '/');
    if (method === 'GET') return handleGetStoredFile(db, files, storageKey, path, request, runtime, env);
    if (method === 'PUT') return handlePutStoredFile(db, files, storageKey, path, request, runtime, env);
    if (method === 'DELETE') return handleDeleteStoredFile(db, files, storageKey, path, request, runtime, env);
  }
  if (op === 'stored-file-metadata' && method === 'POST') {
    const body = await readJsonBody(request);
    return handleStoredFileMetadata(db, storageKey, String(body?.path || '/'), request, runtime, env);
  }
  if (op === 'ensure-folder' && method === 'POST') {
    await opListChildren(db.raw, storageKey, normalizePath(String((await readJsonBody(request))?.path || '/'))).catch(() => null);
    return emptyResponse(204);
  }
  if (op === 'list-files' && method === 'POST') {
    return handleListFiles(db, storageKey, await readJsonBody(request), request, runtime, env);
  }
  if (op === 'list-folders' && method === 'POST') {
    return handleListFolders(db, storageKey, await readJsonBody(request), request, runtime, env);
  }
  return withCors(new Response('Not found', { status: 404 }));
    },
  );
}

/**
 * Store opaque recovery wrappers outside mesh-addressed IO. The locator is
 * derived from client-held recovery words; the Worker never receives either
 * the words or the decrypted mesh credentials.
 */
async function handleRecoveryRequest<Env>(
  request: Request,
  env: Env,
  runtime: ResolvedRuntimeConfig,
  db: DatabaseAdapter,
  locator: string,
): Promise<Response> {
  if (!RECOVERY_LOCATOR_RE.test(locator)) return jsonResponse({ error: 'Invalid recovery locator' }, 400);
  const path = `/wrappers/${locator}.json`;
  if (request.method === 'GET') {
    const result = await opGetFile(db.raw, RECOVERY_STORAGE_PREFIX, path, PATH_TYPE.OTHER);
    if (!result.found) {
      await emitAudit(runtime, env, { op: 'recovery-read', path, status: 404, outcome: 'not-found', requestId: requestId(request) });
      return withCors(new Response('Not found', { status: 404 }));
    }
    await emitAudit(runtime, env, { op: 'recovery-read', path, status: 200, outcome: 'ok', bytes: result.size, requestId: requestId(request) });
    return withCors(new Response(result.bytes as unknown as BodyInit, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } }));
  }
  if (request.method === 'PUT') {
    const bytes = await readBytes(request);
    if (!bytes) return jsonResponse({ error: 'Invalid request body' }, 400);
    if (bytes.byteLength > runtime.maxControlBytes) return jsonResponse({ error: 'Payload too large', limit: runtime.maxControlBytes }, 413);
    const result = await opPutImmutable(db.raw, RECOVERY_STORAGE_PREFIX, path, bytes, PATH_TYPE.OTHER, null);
    const status = result.wrote ? 201 : 409;
    await emitAudit(runtime, env, { op: 'recovery-write', path, status, outcome: result.wrote ? 'ok' : 'rejected', bytes: bytes.byteLength, requestId: requestId(request) });
    return emptyResponse(status);
  }
  return withCors(new Response('Method not allowed', { status: 405 }));
}

/**
 * Create a self-contained Interocitor mount that handles IO, notify, and
 * recovery requests under a single URL prefix.
 *
 * Use this when Interocitor should be one routed subsystem inside a larger
 * Worker. The returned object owns path matching plus request handling for the
 * claimed prefix, while your app worker keeps ownership of everything else.
 */
export function createInterocitorMount<Env = unknown>(
  options: InterocitorMountOptions<Env>,
): InterocitorMount<Env> {
  const runtimeOptions = options.runtime;
  const mountPrefix = normalizeMountPrefix(options.mountPrefix ?? '');
  const dbGetter = options.db;
  const relayGetter = options.relay;
  const filesGetter = options.files;
  const healthPath = joinMountPath(mountPrefix, '/health');
  const ioBase = joinMountPath(mountPrefix, IO_PREFIX);
  const notifyBase = joinMountPath(mountPrefix, NOTIFY_PREFIX);
  const recoveryBase = joinMountPath(mountPrefix, RECOVERY_PREFIX);

  function matches(pathname: string): boolean {
    return (
      pathname === healthPath ||
      pathname.startsWith(`${ioBase}/`) ||
      pathname.startsWith(`${notifyBase}/`) ||
      pathname.startsWith(`${recoveryBase}/`) ||
      (!mountPrefix && (pathname === '/' || pathname === '/health'))
    );
  }

  async function fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
    const url = new URL(request.url);
    const strippedPath = stripMountPrefix(url.pathname, mountPrefix);
    if (strippedPath === null) return new Response('Not found', { status: 404 });
    url.pathname = strippedPath;
    return interocitorWorker.fetch(new Request(url.toString(), request), env, ctx, dbGetter, relayGetter, runtimeOptions, filesGetter, options.cors);
  }

  return Object.freeze({ mountPrefix, healthPath, ioBase, notifyBase, recoveryBase, matches, fetch });
}

/**
 * Create an optional route handler for Interocitor maintenance operations.
 *
 * Route this handler from the host Worker after the host's administrative
 * policy. Its `fetch()` method executes matched mesh-ID and maintenance
 * operations.
 */
export function createInterocitorSystemHandler<Env = unknown>(
  options: InterocitorSystemHandlerOptions<Env>,
): InterocitorSystemHandler<Env> {
  const mountPrefix = normalizeMountPrefix(options.mountPrefix ?? '');
  const systemBase = joinMountPath(mountPrefix, SYSTEM_PREFIX);

  function matches(pathname: string): boolean {
    return pathname.startsWith(`${systemBase}/`);
  }

  async function fetch(request: Request, env: Env, _ctx: ExecutionContextLike): Promise<Response> {
    const url = new URL(request.url);
    const strippedPath = stripMountPrefix(url.pathname, mountPrefix);
    if (strippedPath === null || !strippedPath.startsWith(`${SYSTEM_PREFIX}/`)) {
      return new Response('Not found', { status: 404 });
    }
    url.pathname = strippedPath;
    if (request.method.toUpperCase() === 'OPTIONS') return applyConfiguredCors(preflightResponse(), request, env, options.cors);
    const response = await handleSystemOperation(
      resolveDatabase(env, options.db),
      new Request(url.toString(), request),
      url,
      resolveRuntimeConfig(env, options.runtime),
      env,
    );
    return applyConfiguredCors(response, request, env, options.cors);
  }

  return Object.freeze({ systemBase, matches, fetch });
}

/**
 * Options for {@link withInterocitor}.
 *
 * This is the same wiring shape as {@link InterocitorMountOptions}; the helper
 * simply wraps an existing Worker instead of returning a standalone mount.
 */
export interface WithInterocitorOptions<Env = unknown> extends InterocitorMountOptions<Env> {}

const EMPTY_WORKER: WorkerLike = {};

/**
 * Wrap an existing Worker so Interocitor claims one URL prefix and the wrapped
 * app keeps every other route.
 *
 * `fetch()` requests matching the configured mount go to Interocitor first.
 * Non-matching requests fall through to the wrapped worker. When scheduled
 * maintenance is enabled, the wrapped worker's `scheduled()` runs first and
 * Interocitor maintenance runs after it.
 */
export function withInterocitor<Env = unknown>(
  worker: WorkerLike<Env> | undefined,
  options: WithInterocitorOptions<Env>,
): WorkerLike<Env> {
  const { mountPrefix, db, relay, files, runtime } = options;
  const interocitor = createInterocitorMount<Env>({ mountPrefix, db, relay, files, runtime });
  const runtimeOptions = runtime;  
  const baseWorker = worker ?? (EMPTY_WORKER as WorkerLike<Env>);

  return {
    ...baseWorker,
    async fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
      const url = new URL(request.url);
      if (interocitor.matches(url.pathname)) return interocitor.fetch(request, env, ctx);
      if (typeof baseWorker.fetch === 'function') return baseWorker.fetch(request, env, ctx);
      return new Response('Not found', { status: 404 });
    },
    async scheduled(event, env, ctx) {
      if (typeof baseWorker.scheduled === 'function') await baseWorker.scheduled(event, env, ctx);
      const resolvedRuntime = resolveRuntimeConfig(env, runtimeOptions);
      if (resolvedRuntime.enableScheduledMaintenance) {
        await runMaintenance(resolveDatabase(env, db), resolvedRuntime.pathTtlHours, null);
      }
    },
  };
}

const interocitorWorker = {
  async fetch<Env = unknown>(
    request: Request,
    env: Env,
    ctx: ExecutionContextLike,
    dbGetter: (env: Env) => D1Database,
    relayGetter?: (env: Env) => DurableObjectNamespace,
    runtimeOptions?: InterocitorRuntimeOptions<Env>,
    filesGetter?: InterocitorMountOptions<Env>['files'],
    cors?: CorsOptions<Env>,
  ): Promise<Response> {
    const runtime = resolveRuntimeConfig(env, runtimeOptions);
    const db = dbGetter;
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    if (method === 'OPTIONS') return applyConfiguredCors(preflightResponse(), request, env, cors);
    if (url.pathname === '/' || url.pathname === '/health') {
      return applyConfiguredCors(withCors(new Response('interocitor cloudflare worker\n', { status: 200 })), request, env, cors);
    }
    if (url.pathname.startsWith(`${NOTIFY_PREFIX}/`)) {
      const prefix = decodeURIComponent(url.pathname.slice(`${NOTIFY_PREFIX}/`.length).split('/')[0] || '');
      return applyConfiguredCors(await handleWsUpgrade(request, env, runtime, ctx, prefix, relayGetter), request, env, cors);
    }
    if (url.pathname.startsWith(`${IO_PREFIX}/`)) {
      return applyConfiguredCors(await handleIoRequest(request, env, runtime, ctx, url, db, relayGetter, filesGetter), request, env, cors);
    }
    if (url.pathname.startsWith(`${RECOVERY_PREFIX}/`)) {
      const locator = decodeURIComponent(url.pathname.slice(`${RECOVERY_PREFIX}/`.length).split('/')[0] || '');
      return applyConfiguredCors(await handleRecoveryRequest(request, env, runtime, resolveDatabase(env, db), locator), request, env, cors);
    }
    return applyConfiguredCors(withCors(new Response('Not found', { status: 404 })), request, env, cors);
  },
};
