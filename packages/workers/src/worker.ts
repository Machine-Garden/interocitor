import { createDatabaseAdapter } from './db-adapter.ts';
import { uuidv7 } from './ids.ts';
import {
  fileNameFromPath,
  normalizePath,
  opDeletePath,
  opGetFile,
  opListChildren,
  opPruneCompacted,
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
  InterocitorEnv,
  InterocitorMount,
  InterocitorMountOptions,
  InterocitorRuntimeOptions,
  WorkerLike,
  R2Bucket,
  FileUploadAuthorizationResult,
} from './types.ts';
export type { InterocitorEnv, InterocitorMountOptions, InterocitorRuntimeOptions } from './types.ts';

interface MaintenanceEnv {
  INTEROCITOR_PATH_TTL_HOURS?: string | number;
}

function toMaintenanceEnv(runtime: ResolvedRuntimeConfig): MaintenanceEnv {
  return { INTEROCITOR_PATH_TTL_HOURS: runtime.pathTtlHours };
} 

const IO_PREFIX = '/io';
const NOTIFY_PREFIX = '/notify';
const SYSTEM_PREFIX = '/__interocitor/system';
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
  accessToken?: string;
  systemToken?: string;
  enableScheduledMaintenance: boolean;
  pathTtlHours: number;
  maxControlBytes: number;
  maxChangeBytes: number;
  maxMainlineBytes: number;
  maxGenericFileBytes: number;
  maxStoredFileBytes: number;
  maxMeshStoredBytes: number;
  authorizeFileUpload?: InterocitorRuntimeOptions<unknown>['authorizeFileUpload'];
  meshSecret: string;
  verbose: boolean;
}

function parsePositiveInt(value: string | number | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveRuntimeConfig<Env>(env: Env, runtime?: InterocitorRuntimeOptions<Env>): ResolvedRuntimeConfig {
  return {
    accessToken: runtime?.accessToken?.(env),
    systemToken: runtime?.systemToken?.(env),
    enableScheduledMaintenance: runtime?.enableScheduledMaintenance?.(env) === true || runtime?.enableScheduledMaintenance?.(env) === '1' || runtime?.enableScheduledMaintenance?.(env) === 1,
    pathTtlHours: parsePositiveInt(runtime?.pathTtlHours?.(env), 0),
    maxControlBytes: parsePositiveInt(runtime?.maxControlBytes?.(env), DEFAULT_CONTROL_BYTES),
    maxChangeBytes: parsePositiveInt(runtime?.maxChangeBytes?.(env), DEFAULT_CHANGE_BYTES),
    maxMainlineBytes: parsePositiveInt(runtime?.maxMainlineBytes?.(env), DEFAULT_MAINLINE_BYTES),
    maxGenericFileBytes: parsePositiveInt(runtime?.maxGenericFileBytes?.(env), DEFAULT_GENERIC_FILE_BYTES),
    maxStoredFileBytes: parsePositiveInt(runtime?.maxStoredFileBytes?.(env), DEFAULT_STORED_FILE_BYTES),
    maxMeshStoredBytes: parsePositiveInt(runtime?.maxMeshStoredBytes?.(env), DEFAULT_MESH_STORED_BYTES),
    authorizeFileUpload: runtime?.authorizeFileUpload as InterocitorRuntimeOptions<unknown>['authorizeFileUpload'],
    meshSecret: runtime?.meshSecret?.(env) || DEFAULT_MESH_SECRET,
    verbose: runtime?.verbose?.(env) === true || runtime?.verbose?.(env) === '1' || runtime?.verbose?.(env) === 1,
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

/**
 * Strict validation of a request prefix. Returns null on success, or a 400
 * Response on failure. Fast-fails before D1, cache, or auth work happens.
 *
 * Format: `<uuidv7>.<base64url-tag>` where the tag is HMAC-SHA256(uuid, meshSecret)
 * truncated to 8 bytes. Anything else — wrong shape, bad UUID, or tag mismatch —
 * yields 400 Invalid prefix.
 */
async function validateMeshPrefix(prefix: string, runtime: ResolvedRuntimeConfig): Promise<Response | null> {
  if (!prefix) return jsonResponse({ error: 'Missing prefix' }, 400);
  const dot = prefix.lastIndexOf('.');
  if (dot === -1) return jsonResponse({ error: 'Invalid prefix' }, 400);
  const uuid = prefix.slice(0, dot);
  const tag = prefix.slice(dot + 1);
  if (!MESH_UUID_RE.test(uuid) || !tag) return jsonResponse({ error: 'Invalid prefix' }, 400);
  const secret = await importMeshSecretKey(runtime.meshSecret);
  const expected = await computeMeshTag(uuid, secret);
  // Constant-time compare.
  if (tag.length !== expected.length) return jsonResponse({ error: 'Invalid prefix' }, 400);
  let result = 0;
  for (let i = 0; i < tag.length; i++) result |= tag.codePointAt(i)! ^ expected.codePointAt(i)!;
  if (result !== 0) return jsonResponse({ error: 'Invalid prefix' }, 400);
  return null;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

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

async function hasAccess(request: Request, runtime: ResolvedRuntimeConfig, prefix: string): Promise<boolean> {
  const accessSecret = runtime.accessToken;
  if (!accessSecret) return true;
  if (!prefix) return false;
  const auth = request.headers.get('Authorization') || '';
  const bearerToken = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
  const url = new URL(request.url);
  const queryToken = url.searchParams.get('access_token') || '';
  const token = bearerToken || queryToken;
  if (!token) return false;
  const expected = await sha256Hex(`${prefix}${accessSecret}`);
  return token === expected;
}

function hasSystemAccess(request: Request, runtime: ResolvedRuntimeConfig): boolean {
  const expected = String(runtime.systemToken || '').trim();
  if (!expected) return false;
  const auth = request.headers.get('Authorization') || '';
  const bearerToken = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
  const headerToken = String(request.headers.get('x-interocitor-system-token') || '').trim();
  return bearerToken === expected || headerToken === expected;
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

async function handleGetFile(db: DatabaseAdapter, prefix: string, path: string): Promise<Response> {
  const pathType = classifyPath(path);
  const result = await opGetFile(db.raw, prefix, path, pathType);
  if (!result.found) return withCors(new Response('Not found', { status: 404 }));
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

async function handleMetadata(db: DatabaseAdapter, prefix: string, path: string): Promise<Response> {
  const pathType = classifyPath(path);
  const result = await opGetFile(db.raw, prefix, path, pathType);
  if (!result.found) return jsonResponse({ file: null }, 404);
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

async function handleWriteFile(
  db: DatabaseAdapter,
  prefix: string,
  path: string,
  request: Request,
  runtime: ResolvedRuntimeConfig,
  ctx: ExecutionContextLike,
  relay?: DurableObjectNamespace,
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
  const notify = (status: number): Response => {
    if (shouldBroadcast && status >= 200 && status < 300) {
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

async function handleListFiles(db: DatabaseAdapter, prefix: string, body: Record<string, unknown>): Promise<Response> {
  const path = normalizePath(String(body?.path || '/'));
  const listing = await opListChildren(db.raw, prefix, path);
  return jsonResponse({ files: listing.files }, 200);
}

async function handleListFolders(db: DatabaseAdapter, prefix: string, body: Record<string, unknown>): Promise<Response> {
  const path = normalizePath(String(body?.path || '/'));
  const listing = await opListChildren(db.raw, prefix, path);
  return jsonResponse({ folders: listing.folders }, 200);
}

async function handleDelete(
  db: DatabaseAdapter,
  prefix: string,
  path: string,
  ctx: ExecutionContextLike,
  runtime: ResolvedRuntimeConfig,
  relay?: DurableObjectNamespace,
): Promise<Response> {
  const remoteRoot = meshRootForPath(path);
  const deleted = await opDeletePath(db.raw, prefix, path, remoteRoot);
  if (deleted) {
    broadcast(relay, ctx, prefix, { type: 'invalidation', op: 'delete', path: normalizePath(path), ts: Date.now() }, { verbose: runtime.verbose });
  }
  return emptyResponse(deleted ? 204 : 404);
}

interface StoredFileRow {
  [key: string]: unknown;
  prefix?: string;
  path?: string;
  r2_key?: string;
  size?: number;
  plaintext_size?: number | null;
  content_type?: string | null;
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
  };
}

async function currentStoredBytes(db: DatabaseAdapter, prefix: string): Promise<number> {
  const row = await db.first<{ total?: number }>('SELECT COALESCE(SUM(size), 0) AS total FROM stored_files WHERE prefix=?1', prefix);
  return Number(row?.total ?? 0);
}

async function handleStoredFileMetadata(db: DatabaseAdapter, prefix: string, path: string): Promise<Response> {
  const normalized = normalizePath(path);
  const row = await db.first<StoredFileRow>('SELECT * FROM stored_files WHERE prefix=?1 AND path=?2 LIMIT 1', prefix, normalized);
  if (!row) return jsonResponse({ file: null }, 404);
  return jsonResponse({ file: storedFileMetadata(row) }, 200);
}

async function handleGetStoredFile(db: DatabaseAdapter, bucket: R2Bucket | undefined, prefix: string, path: string): Promise<Response> {
  if (!bucket) return jsonResponse({ error: 'File storage bucket not configured' }, 501);
  const normalized = normalizePath(path);
  const row = await db.first<StoredFileRow>('SELECT * FROM stored_files WHERE prefix=?1 AND path=?2 LIMIT 1', prefix, normalized);
  if (!row?.r2_key) return withCors(new Response('Not found', { status: 404 }));
  const object = await bucket.get(String(row.r2_key));
  if (!object) return withCors(new Response('Not found', { status: 404 }));
  const now = new Date().toISOString();
  await db.run('UPDATE stored_files SET last_accessed_at=?3, use_count=use_count+1 WHERE prefix=?1 AND path=?2', prefix, normalized, now);
  const headers = new Headers({
    'Content-Type': String(row.content_type || 'application/octet-stream'),
    'Content-Length': String(object.size),
  });
  if (object.httpEtag || object.etag || row.etag) headers.set('ETag', String(object.httpEtag || object.etag || row.etag));
  return withCors(new Response(object.body, { status: 200, headers }));
}

async function normalizeAuthorization(result: FileUploadAuthorizationResult): Promise<{ allowed: boolean; reason?: string; status: number }> {
  if (typeof result === 'boolean') return { allowed: result, status: result ? 200 : 403 };
  return { allowed: result.allowed, reason: result.reason, status: result.status ?? (result.allowed ? 200 : 403) };
}

async function handlePutStoredFile<Env>(
  db: DatabaseAdapter,
  bucket: R2Bucket | undefined,
  prefix: string,
  path: string,
  request: Request,
  runtime: ResolvedRuntimeConfig,
  env: Env,
): Promise<Response> {
  if (!bucket) return jsonResponse({ error: 'File storage bucket not configured' }, 501);
  const bytes = await readBytes(request);
  if (!bytes) return jsonResponse({ error: 'Invalid request body' }, 400);
  if (bytes.byteLength > runtime.maxStoredFileBytes) return jsonResponse({ error: 'Payload too large', limit: runtime.maxStoredFileBytes }, 413);
  const normalized = normalizePath(path);
  const uploadedByDeviceId = String(request.headers.get('X-Interocitor-Device-Id') || '').trim();
  if (!uploadedByDeviceId) return jsonResponse({ error: 'Missing X-Interocitor-Device-Id' }, 401);
  const contentType = request.headers.get('Content-Type') || 'application/octet-stream';
  const plaintextSizeHeader = request.headers.get('X-Interocitor-Plaintext-Size');
  const plaintextSize = plaintextSizeHeader ? Number.parseInt(plaintextSizeHeader, 10) : undefined;
  const existing = await db.first<StoredFileRow>('SELECT size, r2_key FROM stored_files WHERE prefix=?1 AND path=?2 LIMIT 1', prefix, normalized);
  const current = await currentStoredBytes(db, prefix);
  const nextTotal = current - Number(existing?.size ?? 0) + bytes.byteLength;
  if (nextTotal > runtime.maxMeshStoredBytes) return jsonResponse({ error: 'Mesh storage quota exceeded', limit: runtime.maxMeshStoredBytes }, 413);
  if (runtime.authorizeFileUpload) {
    const auth = await normalizeAuthorization(await runtime.authorizeFileUpload({
      prefix,
      path: normalized,
      uploadedByDeviceId,
      size: bytes.byteLength,
      plaintextSize: Number.isFinite(plaintextSize) ? plaintextSize : undefined,
      contentType,
      currentMeshStoredBytes: current,
      maxMeshStoredBytes: runtime.maxMeshStoredBytes,
      request,
    }, env));
    if (!auth.allowed) return jsonResponse({ error: auth.reason || 'Upload rejected' }, auth.status);
  }
  const key = String(existing?.r2_key || storedFileKey(prefix, normalized));
  const now = new Date().toISOString();
  await bucket.put(key, bytes, {
    httpMetadata: { contentType },
    customMetadata: { prefix, path: normalized, uploadedByDeviceId },
  });
  const etag = crypto.randomUUID();
  await db.run(
    `INSERT INTO stored_files (prefix,path,r2_key,size,plaintext_size,content_type,uploaded_by_device_id,uploaded_at,modified_time,last_accessed_at,use_count,etag)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?8,NULL,0,?9)
     ON CONFLICT(prefix,path) DO UPDATE SET
       r2_key=excluded.r2_key, size=excluded.size, plaintext_size=excluded.plaintext_size,
       content_type=excluded.content_type, uploaded_by_device_id=excluded.uploaded_by_device_id,
       uploaded_at=excluded.uploaded_at, modified_time=excluded.modified_time,
       last_accessed_at=NULL, use_count=0, etag=excluded.etag`,
    prefix,
    normalized,
    key,
    bytes.byteLength,
    Number.isFinite(plaintextSize) ? plaintextSize : null,
    contentType,
    uploadedByDeviceId,
    now,
    etag,
  );
  const row = await db.first<StoredFileRow>('SELECT * FROM stored_files WHERE prefix=?1 AND path=?2 LIMIT 1', prefix, normalized);
  return jsonResponse({ file: storedFileMetadata(row ?? { path: normalized, size: bytes.byteLength, uploaded_by_device_id: uploadedByDeviceId, uploaded_at: now, modified_time: now, etag }) }, existing ? 200 : 201);
}

async function handleDeleteStoredFile(db: DatabaseAdapter, bucket: R2Bucket | undefined, prefix: string, path: string): Promise<Response> {
  if (!bucket) return jsonResponse({ error: 'File storage bucket not configured' }, 501);
  const normalized = normalizePath(path);
  const row = await db.first<StoredFileRow>('SELECT r2_key FROM stored_files WHERE prefix=?1 AND path=?2 LIMIT 1', prefix, normalized);
  if (!row?.r2_key) return emptyResponse(404);
  await bucket.delete(String(row.r2_key));
  await db.run('DELETE FROM stored_files WHERE prefix=?1 AND path=?2', prefix, normalized);
  return emptyResponse(204);
}

async function handleSystem(
  db: DatabaseAdapter,
  request: Request,
  url: URL,
  runtime: ResolvedRuntimeConfig,
): Promise<Response> {
  try {
    if (!hasSystemAccess(request, runtime)) return jsonResponse({ error: 'Unauthorized' }, 401);
    const maintenanceEnv = toMaintenanceEnv(runtime) as InterocitorEnv;
    const meshSecret = runtime.meshSecret;
    const rest = url.pathname.slice(`${SYSTEM_PREFIX}/`.length);
    const prefix = decodeURIComponent(rest.split('/').filter(Boolean)[0] || '');
    const body = await readJsonBody(request);
    const op = String(body?.op || '');
    if (!prefix || !op) return jsonResponse({ error: 'Missing prefix or op' }, 400);
    // System ops other than `issue-mesh-id` operate against an existing mesh —
    // validate the prefix integrity. `issue-mesh-id` itself receives an
    // arbitrary placeholder prefix (not yet minted), so it's exempt.
    if (op !== 'issue-mesh-id') {
      const prefixError = await validateMeshPrefix(prefix, runtime);
      if (prefixError) return prefixError;
    }
    if (op === 'prune-compacted-changes' || op === 'compact') {
      const remotePath = normalizePath(String(body?.remotePath || '/'));
      const watermarkHlc = String(body?.watermarkHlc || '');
      return jsonResponse(await opPruneCompacted(db.raw, prefix, remotePath, watermarkHlc), 200);
    }
    if (op === 'reconcile-metrics') {
      const remotePath = normalizePath(String(body?.remotePath || '/'));
      return jsonResponse(await opReconcileMetrics(db.raw, prefix, remotePath), 200);
    }
    if (op === 'run-maintenance') {
      return jsonResponse(await runMaintenance(db, maintenanceEnv, prefix), 200);
    }
    if (op === 'maintenance-status') {
      const remotePath = normalizePath(String(body?.remotePath || '/'));
      return jsonResponse(await getMaintenanceStatus(db, prefix, remotePath), 200);
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
  const prefixError = await validateMeshPrefix(prefix, runtime);
  if (prefixError) return prefixError;
  if (!(await hasAccess(request, runtime, prefix))) {
    if (runtime.verbose) console.warn('[interocitor:relay] unauthorized notify request', { prefix });
    return new Response('Unauthorized', { status: 401 });
  }
  const relay = relayGetter ? relayGetter(env) : undefined;
  if (!relay) {
    if (runtime.verbose) console.warn('[interocitor:relay] notify request failed: relay binding not configured', { prefix });
    return new Response('WebSocket relay not configured', { status: 501 });
  }
  const stub = relay.get(relay.idFromName(prefix));
  const url = new URL(request.url);
  if (request.method.toUpperCase() === 'GET' && url.pathname.split('/').filter(Boolean)[2] === 'health') {
    const response = await stub.fetch(new Request('https://internal/__status'));
    return withCors(response);
  }
  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('Expected WebSocket upgrade', { status: 426 });
  }
  if (runtime.verbose) console.debug('[interocitor:relay] websocket connect forwarded', { prefix });
  const connectUrl = new URL(request.url);
  connectUrl.pathname = '/__connect';
  return stub.fetch(new Request(connectUrl.toString(), request));
}

async function handleIoRequest<Env>(
  request: Request,
  env: Env,
  runtime: ResolvedRuntimeConfig,
  ctx: ExecutionContextLike,
  url: URL,
  dbGetter: (env: Env) => D1Database,
  relayGetter?: (env: Env) => DurableObjectNamespace,
  filesGetter?: (env: Env) => R2Bucket | undefined,
): Promise<Response> {
  const method = request.method.toUpperCase();
  const { prefix, op } = parseIo(url);
  // Strict prefix integrity check — fast-fail BEFORE any D1/auth/cache work.
  // A tampered prefix never reaches the database or the auth path.
  const prefixError = await validateMeshPrefix(prefix, runtime);
  if (prefixError) return prefixError;
  const db = resolveDatabase(env, dbGetter);
  const relay = relayGetter ? relayGetter(env) : undefined;
  const files = filesGetter ? filesGetter(env) : undefined;
  if (!(await hasAccess(request, runtime, prefix))) return jsonResponse({ error: 'Unauthorized' }, 401);

  if (op === 'health' && method === 'GET') {
    return withCors(new Response('interocitor cloudflare worker\n', { status: 200 }));
  }
  if (op === 'file') {
    const path = normalizePath(url.searchParams.get('path') || '/');
    if (method === 'GET') return handleGetFile(db, prefix, path);
    if (method === 'PUT') return handleWriteFile(db, prefix, path, request, runtime, ctx, relay);
    if (method === 'DELETE') return handleDelete(db, prefix, path, ctx, runtime, relay);
  }
  if (op === 'metadata' && method === 'POST') {
    const body = await readJsonBody(request);
    return handleMetadata(db, prefix, String(body?.path || '/'));
  }
  if (op === 'stored-file') {
    const path = normalizePath(url.searchParams.get('path') || '/');
    if (method === 'GET') return handleGetStoredFile(db, files, prefix, path);
    if (method === 'PUT') return handlePutStoredFile(db, files, prefix, path, request, runtime, env);
    if (method === 'DELETE') return handleDeleteStoredFile(db, files, prefix, path);
  }
  if (op === 'stored-file-metadata' && method === 'POST') {
    const body = await readJsonBody(request);
    return handleStoredFileMetadata(db, prefix, String(body?.path || '/'));
  }
  if (op === 'ensure-folder' && method === 'POST') {
    await opListChildren(db.raw, prefix, normalizePath(String((await readJsonBody(request))?.path || '/'))).catch(() => null);
    return emptyResponse(204);
  }
  if (op === 'list-files' && method === 'POST') {
    return handleListFiles(db, prefix, await readJsonBody(request));
  }
  if (op === 'list-folders' && method === 'POST') {
    return handleListFolders(db, prefix, await readJsonBody(request));
  }
  return withCors(new Response('Not found', { status: 404 }));
}

/**
 * Create a self-contained Interocitor mount that handles all IO, notify, and
 * system requests under a single URL prefix.
 */
export function createInterocitorMount<Env = unknown>(
  options: InterocitorMountOptions<Env>,
): InterocitorMount<Env> {
  const runtimeOptions = options.runtime;
  const mountPrefix = normalizeMountPrefix(options.mountPrefix ?? '');
  const dbGetter = options.db;
  const relayGetter = options.relay;
  const filesGetter = options.files ?? ((env: Env) => (env as InterocitorEnv).INTEROCITOR_FILES);
  const healthPath = joinMountPath(mountPrefix, '/health');
  const ioBase = joinMountPath(mountPrefix, IO_PREFIX);
  const notifyBase = joinMountPath(mountPrefix, NOTIFY_PREFIX);
  const systemBase = joinMountPath(mountPrefix, '/__interocitor');

  function matches(pathname: string): boolean {
    return (
      pathname === healthPath ||
      pathname.startsWith(`${ioBase}/`) ||
      pathname.startsWith(`${notifyBase}/`) ||
      pathname.startsWith(`${systemBase}/`) ||
      (!mountPrefix && (pathname === '/' || pathname === '/health'))
    );
  }

  async function fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
    const url = new URL(request.url);
    const strippedPath = stripMountPrefix(url.pathname, mountPrefix);
    if (strippedPath === null) return new Response('Not found', { status: 404 });
    url.pathname = strippedPath;
    return interocitorWorker.fetch(new Request(url.toString(), request), env, ctx, dbGetter, relayGetter, runtimeOptions, filesGetter);
  }

  return Object.freeze({ mountPrefix, healthPath, ioBase, notifyBase, systemBase, matches, fetch });
}

export interface WithInterocitorOptions<Env = unknown> extends InterocitorMountOptions<Env> {}

const EMPTY_WORKER: WorkerLike = {};

export function withInterocitor<Env = unknown>(
  worker: WorkerLike<Env> = EMPTY_WORKER as WorkerLike<Env>,
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
        runMaintenance(resolveDatabase(env, db), toMaintenanceEnv(resolvedRuntime) as InterocitorEnv, null);
      }
    },
  };
}

export const interocitorWorker = {
  async fetch<Env = unknown>(
    request: Request,
    env: Env,
    ctx: ExecutionContextLike,
    dbGetter: (env: Env) => D1Database,
    relayGetter?: (env: Env) => DurableObjectNamespace,
    runtimeOptions?: InterocitorRuntimeOptions<Env>,
    filesGetter?: (env: Env) => R2Bucket | undefined,
  ): Promise<Response> {
    const runtime = resolveRuntimeConfig(env, runtimeOptions);
    const db = dbGetter;
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    if (method === 'OPTIONS') return preflightResponse();
    if (url.pathname === '/' || url.pathname === '/health') {
      return withCors(new Response('interocitor cloudflare worker\n', { status: 200 }));
    }
    if (url.pathname.startsWith(`${NOTIFY_PREFIX}/`)) {
      const prefix = decodeURIComponent(url.pathname.slice(`${NOTIFY_PREFIX}/`.length).split('/')[0] || '');
      return handleWsUpgrade(request, env, runtime, ctx, prefix, relayGetter);
    }
    if (url.pathname.startsWith(`${IO_PREFIX}/`)) {
      return handleIoRequest(request, env, runtime, ctx, url, db, relayGetter, filesGetter ?? ((e: Env) => (e as InterocitorEnv).INTEROCITOR_FILES));
    }
    if (url.pathname.startsWith(`${SYSTEM_PREFIX}/`)) {
      return handleSystem(resolveDatabase(env, db), request, url, runtime);
    }
    return withCors(new Response('Not found', { status: 404 }));
  },
};
