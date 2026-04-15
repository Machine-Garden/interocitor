import { createDatabaseAdapter } from './db-adapter.js';
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
} from './ops.js';
import { PATH_TYPE, classifyPath, meshRootForPath } from './paths.js';
import { getMaintenanceStatus, runMaintenance } from './maintenance.js';

const runMaintenanceOp = (db, env, prefix) => runMaintenance(db, env, prefix);
const getMaintenanceStatusOp = (db, prefix, remotePath) => getMaintenanceStatus(db, prefix, remotePath);

const IO_PREFIX = '/io';
const NOTIFY_PREFIX = '/notify';
const SYSTEM_PREFIX = '/__interocitor/system';
const DEFAULT_CONTROL_BYTES = 256 * 1024;
const DEFAULT_CHANGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAINLINE_BYTES = 16 * 1024 * 1024;
const DEFAULT_GENERIC_FILE_BYTES = 8 * 1024 * 1024;


const textEncoder = new TextEncoder();

async function sha256Hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}




function fileSizeLimitForPathType(pathType, env) {
  const parse = (key, fallback) => {
    const value = Number.parseInt(String(env?.[key] ?? ''), 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  if ([PATH_TYPE.MANIFEST_POINTER, PATH_TYPE.MANIFEST_SNAPSHOT, PATH_TYPE.HEAD, PATH_TYPE.DEVICE_HEARTBEAT].includes(pathType)) {
    return parse('INTEROCITOR_MAX_CONTROL_BYTES', DEFAULT_CONTROL_BYTES);
  }
  if (pathType === PATH_TYPE.CHANGE_FILE) return parse('INTEROCITOR_MAX_CHANGE_BYTES', DEFAULT_CHANGE_BYTES);
  if (pathType === PATH_TYPE.MAINLINE_SNAPSHOT) return parse('INTEROCITOR_MAX_MAINLINE_BYTES', DEFAULT_MAINLINE_BYTES);
  return parse('INTEROCITOR_MAX_GENERIC_FILE_BYTES', DEFAULT_GENERIC_FILE_BYTES);
}

function normalizeMountPrefix(prefix = '') {
  const trimmed = String(prefix || '').trim();
  if (!trimmed || trimmed === '/') return '';
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`;
}

function joinMountPath(prefix, path) {
  const mountPrefix = normalizeMountPrefix(prefix);
  return mountPrefix ? `${mountPrefix}${path}` : path;
}

function stripMountPrefix(pathname, mountPrefix = '') {
  const normalized = normalizeMountPrefix(mountPrefix);
  if (!normalized) return pathname;
  if (pathname === normalized) return '/';
  if (pathname.startsWith(`${normalized}/`)) return pathname.slice(normalized.length) || '/';
  return null;
}

function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'OPTIONS, GET, PUT, DELETE, POST');
  headers.set('Access-Control-Allow-Headers', '*');
  headers.set('Access-Control-Expose-Headers', 'ETag');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function preflightResponse() {
  return withCors(new Response('', { status: 200 }));
}

function jsonResponse(payload, status = 200) {
  return withCors(new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  }));
}

function parseIo(url) {
  const rest = url.pathname.slice(`${IO_PREFIX}/`.length);
  const parts = rest.split('/').filter(Boolean);
  const prefix = decodeURIComponent(parts.shift() || '');
  const op = decodeURIComponent(parts.shift() || '');
  return { prefix, op };
}

async function readJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function readBytes(request) {
  try {
    return new Uint8Array(await request.arrayBuffer());
  } catch {
    return null;
  }
}

function getDatabase(env) {
  return createDatabaseAdapter(env);
}

async function hasAccess(request, env, prefix) {
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

function hasSystemAccess(request, env) {
  const expected = String(env?.INTEROCITOR_SYSTEM_TOKEN || '').trim();
  if (!expected) return false;
  const auth = request.headers.get('Authorization') || '';
  const bearerToken = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
  const headerToken = String(request.headers.get('x-interocitor-system-token') || '').trim();
  return bearerToken === expected || headerToken === expected;
}

async function handleHealth(request, env, prefix = 'health') {
  if (!(await hasAccess(request, env, prefix))) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }
  return withCors(new Response('interocitor cloudflare worker\n', { status: 200 }));
}

async function handleGetFile(db, prefix, path) {
  const pathType = classifyPath(path);
  const result = await opGetFile(db.raw, prefix, path, pathType);
  if (!result.found) return withCors(new Response('Not found', { status: 404 }));
  return withCors(new Response(result.bytes, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(result.size),
      ETag: result.etag,
      'Last-Modified': result.modifiedTime,
    },
  }));
}

async function handleMetadata(db, prefix, path) {
  const pathType = classifyPath(path);
  const result = await opGetFile(db.raw, prefix, path, pathType);
  if (!result.found) return jsonResponse({ file: null }, 404);
  return jsonResponse({ file: { name: fileNameFromPath(path), path: normalizePath(path), size: result.size, modifiedTime: result.modifiedTime, etag: result.etag } }, 200);
}

async function handleWriteFile(db, prefix, path, request, env) {
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

async function handleEnsureFolder(db, prefix, body) {
  const path = normalizePath(body?.path || '/');
  await opListChildren(db.raw, prefix, path).catch(() => ({ files: [], folders: [] }));
  return withCors(new Response('', { status: 204 }));
}

async function handleListFiles(db, prefix, body) {
  const path = normalizePath(body?.path || '/');
  const listing = await opListChildren(db.raw, prefix, path);
  return jsonResponse({ files: listing.files }, 200);
}

async function handleListFolders(db, prefix, body) {
  const path = normalizePath(body?.path || '/');
  const listing = await opListChildren(db.raw, prefix, path);
  return jsonResponse({ folders: listing.folders }, 200);
}

async function handleDelete(db, prefix, path) {
  const remoteRoot = meshRootForPath(path);
  const deleted = await opDeletePath(db.raw, prefix, path, remoteRoot);
  return withCors(new Response('', { status: deleted ? 204 : 404 }));
}

async function handleSystem(db, request, url, env) {
  if (!hasSystemAccess(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401);
  const rest = url.pathname.slice(`${SYSTEM_PREFIX}/`.length);
  const prefix = decodeURIComponent(rest.split('/').filter(Boolean)[0] || '');
  const body = await readJsonBody(request);
  const op = String(body?.op || '');
  if (!prefix || !op) return jsonResponse({ error: 'Missing prefix or op' }, 400);
  if (op === 'prune-compacted-changes' || op === 'compact') {
    const remotePath = normalizePath(body?.remotePath || '/');
    const watermarkHlc = String(body?.watermarkHlc || '');
    return jsonResponse(await opPruneCompacted(db.raw, prefix, remotePath, watermarkHlc), 200);
  }
  if (op === 'reconcile-metrics') {
    const remotePath = normalizePath(body?.remotePath || '/');
    return jsonResponse(await opReconcileMetrics(db.raw, prefix, remotePath), 200);
  }
  if (op === 'run-maintenance') {
    return jsonResponse(await runMaintenanceOp(db, env, prefix), 200);
  }
  if (op === 'maintenance-status') {
    const remotePath = normalizePath(body?.remotePath || '/');
    return jsonResponse(await getMaintenanceStatusOp(db, prefix, remotePath), 200);
  }
  return jsonResponse({ error: 'Unknown op' }, 404);
}

async function handleWsUpgrade(request, env, ctx, prefix) {
  if (!(await hasAccess(request, env, prefix))) {
    return new Response('Unauthorized', { status: 401 });
  }
  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('Expected WebSocket upgrade', { status: 426 });
  }
  const relay = env?.INTEROCITOR_RELAY;
  if (!relay) {
    return new Response('WebSocket relay not configured', { status: 501 });
  }
  const stub = relay.get(relay.idFromName(prefix));
  const connectUrl = new URL(request.url);
  connectUrl.pathname = '/__connect';
  return stub.fetch(new Request(connectUrl.toString(), request), env, ctx);
}

async function handleIoRequest(request, env, url) {
  const db = getDatabase(env);
  const method = request.method.toUpperCase();
  const { prefix, op } = parseIo(url);
  if (!prefix) return jsonResponse({ error: 'Missing prefix' }, 400);
  if (!(await hasAccess(request, env, prefix))) return jsonResponse({ error: 'Unauthorized' }, 401);

  if (op === 'health' && method === 'GET') return handleHealth(request, env, prefix);
  if (op === 'file') {
    const path = normalizePath(url.searchParams.get('path') || '/');
    if (method === 'GET') return handleGetFile(db, prefix, path);
    if (method === 'PUT') return handleWriteFile(db, prefix, path, request, env);
    if (method === 'DELETE') return handleDelete(db, prefix, path);
  }
  if (op === 'metadata' && method === 'POST') {
    const body = await readJsonBody(request);
    return handleMetadata(db, prefix, body?.path || '/');
  }
  if (op === 'ensure-folder' && method === 'POST') {
    const body = await readJsonBody(request);
    return handleEnsureFolder(db, prefix, body);
  }
  if (op === 'list-files' && method === 'POST') {
    const body = await readJsonBody(request);
    return handleListFiles(db, prefix, body);
  }
  if (op === 'list-folders' && method === 'POST') {
    const body = await readJsonBody(request);
    return handleListFolders(db, prefix, body);
  }
  return withCors(new Response('Not found', { status: 404 }));
}

export function createInterocitorMount(options = {}) {
  const mountPrefix = normalizeMountPrefix(options.mountPrefix);
  const healthPath = joinMountPath(mountPrefix, '/health');
  const ioBase = joinMountPath(mountPrefix, IO_PREFIX);
  const notifyBase = joinMountPath(mountPrefix, NOTIFY_PREFIX);
  const systemBase = joinMountPath(mountPrefix, '/__interocitor');
  function matches(pathname) {
    if (!mountPrefix) return false;
    return pathname === mountPrefix || pathname === healthPath || pathname.startsWith(`${ioBase}/`) || pathname.startsWith(`${notifyBase}/`) || pathname.startsWith(`${systemBase}/`);
  }
  async function fetch(request, env, ctx) {
    const url = new URL(request.url);
    const strippedPath = stripMountPrefix(url.pathname, mountPrefix);
    if (strippedPath == null) return new Response('Not found', { status: 404 });
    url.pathname = strippedPath;
    return interocitorWorker.fetch(new Request(url.toString(), request), env, ctx);
  }
  return Object.freeze({ mountPrefix, healthPath, ioBase, systemBase, matches, fetch });
}

export function withInterocitor(mountPrefix, worker = {}) {
  const interocitor = createInterocitorMount({ mountPrefix });
  const baseWorker = worker ?? {};
  return {
    ...baseWorker,
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (interocitor.matches(url.pathname)) return interocitor.fetch(request, env, ctx);
      if (typeof baseWorker.fetch === 'function') return baseWorker.fetch(request, env, ctx);
      return new Response('Not found', { status: 404 });
    },
    async scheduled(event, env, ctx) {
      if (typeof baseWorker.scheduled === 'function') await baseWorker.scheduled(event, env, ctx);
      if (env?.INTEROCITOR_ENABLE_SCHEDULED_MAINTENANCE === '1') {
        return runMaintenance(createDatabaseAdapter(env), env, null);
      }
    },
  };
}

export const withInterocitorWorker = withInterocitor;

export const interocitorWorker = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    if (method === 'OPTIONS') return preflightResponse();
    if (url.pathname === '/' || url.pathname === '/health') return withCors(new Response('interocitor cloudflare worker\n', { status: 200 }));
    if (url.pathname.startsWith(`${NOTIFY_PREFIX}/`)) {
      const prefix = decodeURIComponent(url.pathname.slice(`${NOTIFY_PREFIX}/`.length).split('/')[0] || '');
      return handleWsUpgrade(request, env, ctx, prefix);
    }
    if (url.pathname.startsWith(`${IO_PREFIX}/`)) return handleIoRequest(request, env, url);
    if (url.pathname.startsWith(`${SYSTEM_PREFIX}/`)) return handleSystem(getDatabase(env), request, url, env);
    return withCors(new Response('Not found', { status: 404 }));
  },
};
