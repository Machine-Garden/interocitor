import { createDatabaseAdapter } from './db-adapter.ts';
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
import { getMaintenanceStatus, runMaintenance } from './maintenance.ts';
import type {
  D1Database,
  DatabaseAdapter,
  DurableObjectNamespace,
  ExecutionContextLike,
  InterocitorEnv,
  InterocitorMount,
  InterocitorMountOptions,
  WorkerLike,
} from './types.ts';

const IO_PREFIX = '/io';
const NOTIFY_PREFIX = '/notify';
const SYSTEM_PREFIX = '/__interocitor/system';
const DEFAULT_CONTROL_BYTES = 256 * 1024;
const DEFAULT_CHANGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAINLINE_BYTES = 16 * 1024 * 1024;
const DEFAULT_GENERIC_FILE_BYTES = 8 * 1024 * 1024;

const textEncoder = new TextEncoder();

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function fileSizeLimitForPathType(pathType: string, env: InterocitorEnv): number {
  const parse = (key: keyof InterocitorEnv, fallback: number): number => {
    const value = Number.parseInt(String(env?.[key] ?? ''), 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  if (
    [
      PATH_TYPE.MANIFEST_POINTER,
      PATH_TYPE.MANIFEST_SNAPSHOT,
      PATH_TYPE.HEAD,
      PATH_TYPE.DEVICE_HEARTBEAT,
    ].includes(pathType as never)
  ) {
    return parse('INTEROCITOR_MAX_CONTROL_BYTES', DEFAULT_CONTROL_BYTES);
  }
  if (pathType === PATH_TYPE.CHANGE_FILE) return parse('INTEROCITOR_MAX_CHANGE_BYTES', DEFAULT_CHANGE_BYTES);
  if (pathType === PATH_TYPE.MAINLINE_SNAPSHOT) return parse('INTEROCITOR_MAX_MAINLINE_BYTES', DEFAULT_MAINLINE_BYTES);
  return parse('INTEROCITOR_MAX_GENERIC_FILE_BYTES', DEFAULT_GENERIC_FILE_BYTES);
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

function resolveDatabase(
  env: InterocitorEnv,
  dbGetter?: (env: InterocitorEnv) => D1Database,
): DatabaseAdapter {
  const db = dbGetter ? dbGetter(env) : undefined;
  return db ? createDatabaseAdapter(db) : createDatabaseAdapter(env);
}

async function hasAccess(request: Request, env: InterocitorEnv, prefix: string): Promise<boolean> {
  const accessSecret = env?.INTEROCITOR_ACCESS_TOKEN;
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

function hasSystemAccess(request: Request, env: InterocitorEnv): boolean {
  const expected = String(env?.INTEROCITOR_SYSTEM_TOKEN || '').trim();
  if (!expected) return false;
  const auth = request.headers.get('Authorization') || '';
  const bearerToken = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
  const headerToken = String(request.headers.get('x-interocitor-system-token') || '').trim();
  return bearerToken === expected || headerToken === expected;
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
  env: InterocitorEnv,
): Promise<Response> {
  const bytes = await readBytes(request);
  if (!bytes) return jsonResponse({ error: 'Invalid request body' }, 400);
  const pathType = classifyPath(path);
  const limit = fileSizeLimitForPathType(pathType, env);
  if (bytes.byteLength > limit) return jsonResponse({ error: 'Payload too large', limit }, 413);
  const remoteRoot = meshRootForPath(path, pathType);
  if (pathType === PATH_TYPE.MANIFEST_POINTER || pathType === PATH_TYPE.HEAD) {
    const result = await opPutSemantic(db.raw, prefix, path, bytes, pathType, remoteRoot);
    return withCors(new Response('', { status: result.status }));
  }
  if (pathType === PATH_TYPE.DEVICE_HEARTBEAT) {
    const result = await opPutOverwrite(db.raw, prefix, path, bytes, pathType, remoteRoot);
    return withCors(new Response('', { status: result.status }));
  }
  const result = await opPutImmutable(db.raw, prefix, path, bytes, pathType, remoteRoot);
  return withCors(new Response('', { status: result.status }));
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

async function handleDelete(db: DatabaseAdapter, prefix: string, path: string): Promise<Response> {
  const remoteRoot = meshRootForPath(path);
  const deleted = await opDeletePath(db.raw, prefix, path, remoteRoot);
  return withCors(new Response('', { status: deleted ? 204 : 404 }));
}

async function handleSystem(
  db: DatabaseAdapter,
  request: Request,
  url: URL,
  env: InterocitorEnv,
): Promise<Response> {
  if (!hasSystemAccess(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401);
  const rest = url.pathname.slice(`${SYSTEM_PREFIX}/`.length);
  const prefix = decodeURIComponent(rest.split('/').filter(Boolean)[0] || '');
  const body = await readJsonBody(request);
  const op = String(body?.op || '');
  if (!prefix || !op) return jsonResponse({ error: 'Missing prefix or op' }, 400);
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
    return jsonResponse(await runMaintenance(db, env, prefix), 200);
  }
  if (op === 'maintenance-status') {
    const remotePath = normalizePath(String(body?.remotePath || '/'));
    return jsonResponse(await getMaintenanceStatus(db, prefix, remotePath), 200);
  }
  return jsonResponse({ error: 'Unknown op' }, 404);
}

async function handleWsUpgrade(
  request: Request,
  env: InterocitorEnv,
  _ctx: ExecutionContextLike,
  prefix: string,
  relayGetter?: (env: InterocitorEnv) => DurableObjectNamespace,
): Promise<Response> {
  if (!(await hasAccess(request, env, prefix))) {
    return new Response('Unauthorized', { status: 401 });
  }
  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('Expected WebSocket upgrade', { status: 426 });
  }
  const relay = relayGetter ? relayGetter(env) : undefined;
  if (!relay) return new Response('WebSocket relay not configured', { status: 501 });
  const stub = relay.get(relay.idFromName(prefix));
  const connectUrl = new URL(request.url);
  connectUrl.pathname = '/__connect';
  return stub.fetch(new Request(connectUrl.toString(), request));
}

async function handleIoRequest(
  request: Request,
  env: InterocitorEnv,
  url: URL,
  dbGetter?: (env: InterocitorEnv) => D1Database,
): Promise<Response> {
  const db = resolveDatabase(env, dbGetter);
  const method = request.method.toUpperCase();
  const { prefix, op } = parseIo(url);
  if (!prefix) return jsonResponse({ error: 'Missing prefix' }, 400);
  if (!(await hasAccess(request, env, prefix))) return jsonResponse({ error: 'Unauthorized' }, 401);

  if (op === 'health' && method === 'GET') {
    return withCors(new Response('interocitor cloudflare worker\n', { status: 200 }));
  }
  if (op === 'file') {
    const path = normalizePath(url.searchParams.get('path') || '/');
    if (method === 'GET') return handleGetFile(db, prefix, path);
    if (method === 'PUT') return handleWriteFile(db, prefix, path, request, env);
    if (method === 'DELETE') return handleDelete(db, prefix, path);
  }
  if (op === 'metadata' && method === 'POST') {
    const body = await readJsonBody(request);
    return handleMetadata(db, prefix, String(body?.path || '/'));
  }
  if (op === 'ensure-folder' && method === 'POST') {
    await opListChildren(db.raw, prefix, normalizePath(String((await readJsonBody(request))?.path || '/'))).catch(() => null);
    return withCors(new Response('', { status: 204 }));
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
export function createInterocitorMount<Env extends InterocitorEnv = InterocitorEnv>(
  options: InterocitorMountOptions = {},
): InterocitorMount<Env> {
  const mountPrefix = normalizeMountPrefix(options.mountPrefix ?? '');
  const dbGetter = options.db;
  const relayGetter = options.relay;
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
    return interocitorWorker.fetch(new Request(url.toString(), request), env as InterocitorEnv, ctx, dbGetter, relayGetter);
  }

  return Object.freeze({ mountPrefix, healthPath, ioBase, notifyBase, systemBase, matches, fetch });
}

export interface WithInterocitorOptions {
  mountPrefix: string;
  db?: (env: InterocitorEnv) => D1Database;
  relay?: (env: InterocitorEnv) => DurableObjectNamespace;
}

const EMPTY_WORKER: WorkerLike = {};

export function withInterocitor<Env extends InterocitorEnv = InterocitorEnv>(
  worker: WorkerLike<Env> = EMPTY_WORKER as WorkerLike<Env>,
  options: WithInterocitorOptions,
): WorkerLike<Env> {
  const { mountPrefix, db, relay } = options;
  const interocitor = createInterocitorMount<Env>({ mountPrefix, db, relay });
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
      if ((env as InterocitorEnv)?.INTEROCITOR_ENABLE_SCHEDULED_MAINTENANCE === '1') {
        await runMaintenance(resolveDatabase(env as InterocitorEnv, db), env as InterocitorEnv, null);
      }
    },
  };
}

export const interocitorWorker = {
  async fetch(
    request: Request,
    env: InterocitorEnv,
    ctx: ExecutionContextLike,
    dbGetter?: (env: InterocitorEnv) => D1Database,
    relayGetter?: (env: InterocitorEnv) => DurableObjectNamespace,
  ): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    if (method === 'OPTIONS') return preflightResponse();
    if (url.pathname === '/' || url.pathname === '/health') {
      return withCors(new Response('interocitor cloudflare worker\n', { status: 200 }));
    }
    if (url.pathname.startsWith(`${NOTIFY_PREFIX}/`)) {
      const prefix = decodeURIComponent(url.pathname.slice(`${NOTIFY_PREFIX}/`.length).split('/')[0] || '');
      return handleWsUpgrade(request, env, ctx, prefix, relayGetter);
    }
    if (url.pathname.startsWith(`${IO_PREFIX}/`)) {
      return handleIoRequest(request, env, url, dbGetter);
    }
    if (url.pathname.startsWith(`${SYSTEM_PREFIX}/`)) {
      return handleSystem(resolveDatabase(env, dbGetter), request, url, env);
    }
    return withCors(new Response('Not found', { status: 404 }));
  },
};
