/**
 * interocitor Cloudflare Worker
 *
 * Architecture
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   Browser ──► Worker (stateless) ──► D1  (durable file/folder storage)
 *   Browser ──► Worker ─────────────► DO  (SSE fanout only — optional)
 *   Worker  ──► DO/__broadcast ──────► SSE clients  (fire-and-forget)
 *
 * Why the Durable Object?
 *   D1 is the durable medium. DO holds ZERO persistent state.
 *   Its only job is to keep the in-memory map of live SSE connections and
 *   fan out invalidation messages across multiple Worker invocations.
 *   Without DO, a write on Worker instance A would never notify SSE clients
 *   connected to instance B.
 *   Remove the INTEROCITOR_EVENTS binding entirely to disable SSE
 *   (/events/* → 501); everything else keeps working with polling as fallback.
 *
 * URL layout
 *   GET  /health                                     health check
 *   *    /io/<prefix>/...                            Interocitor-native API (JSON + binary)
 *   GET  /events/<prefix>                            SSE stream (requires DO)
 *   POST /__interocitor/system/<prefix>              token-gated system API
 *
 * Append-only mode  (INTEROCITOR_APPEND_ONLY=1, default ON)
 *   DELETE             → 405
 *   PUT on existing    → 409
 */

const IO_PREFIX = '/io';
const EVENTS_PREFIX = '/events';
const SYSTEM_PREFIX = '/__interocitor/system';
const D1_BINDING_NAME = 'INTEROCITOR_DB';
const EVENTS_BINDING_NAME = 'INTEROCITOR_EVENTS';
const EXECUTE_OP_PRUNE_COMPACTED_CHANGES = 'prune-compacted-changes';
const EXECUTE_OP_COMPACT_LEGACY = 'compact';

const DEFAULT_CONTROL_BYTES = 256 * 1024;
const DEFAULT_CHANGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAINLINE_BYTES = 16 * 1024 * 1024;
const DEFAULT_GENERIC_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_PATH_TTL_HOURS = 7 * 24;
const DEFAULT_MAINTENANCE_MAX_PATHS_PER_RUN = 100;

// ─── CORS ─────────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'OPTIONS, GET, PUT, DELETE, POST',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': 'ETag',
};

const textEncoder = new TextEncoder();

function withCors(response) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function preflightResponse() {
  return new Response('', { status: 200, headers: CORS_HEADERS });
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function sha256Hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function extractPrefixFromPath(pathname) {
  const ioPrefix = `${IO_PREFIX}/`;
  if (pathname.startsWith(ioPrefix)) {
    return decodeURIComponent(pathname.slice(ioPrefix.length)).split('/').filter(Boolean)[0] ?? null;
  }
  const eventsPrefix = `${EVENTS_PREFIX}/`;
  if (pathname.startsWith(eventsPrefix)) {
    return decodeURIComponent(pathname.slice(eventsPrefix.length)).split('/').filter(Boolean)[0] ?? null;
  }
  return null;
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

function getDatabase(env) {
  const db = env?.[D1_BINDING_NAME];
  if (!db) throw new Error(`Missing D1 binding ${D1_BINDING_NAME}`);
  return db;
}

function getEventsBinding(env) {
  return env?.[EVENTS_BINDING_NAME] ?? null;
}

function hasSystemAccess(request, env) {
  const expected = String(env?.INTEROCITOR_SYSTEM_TOKEN || '').trim();
  if (!expected) return false;

  const auth = request.headers.get('Authorization') || '';
  const bearerToken = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
  const headerToken = String(request.headers.get('x-interocitor-system-token') || '').trim();
  return bearerToken === expected || headerToken === expected;
}

// ─── Path helpers ─────────────────────────────────────────────────────────────

function normalizePath(raw) {
  const s = String(raw).startsWith('/') ? raw : `/${raw}`;
  const c = s.replace(/\/+/g, '/');
  if (c === '/') return '/';
  return c.endsWith('/') ? c.slice(0, -1) : c;
}

function parentPath(path) {
  if (path === '/') return null;
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '/' : path.slice(0, idx);
}

function fileNameFromPath(path) {
  return path.split('/').filter(Boolean).pop() ?? '';
}

function topLevelRoot(path) {
  const normalized = normalizePath(path);
  const seg = normalized.split('/').filter(Boolean)[0] ?? '';
  return seg ? `/${seg}` : null;
}

// ─── Path classification ──────────────────────────────────────────────────────
//
// Every path falls into exactly one semantic category that determines write policy.
//
//   manifest-pointer   → /…/manifest.json
//                         Mutable pointer. Overwrite ONLY if new generation ≥ current.
//                         Serialized through DO when available.
//
//   manifest-snapshot  → /…/manifest-<n>.json
//                         Immutable once written. Never overwrite.
//
//   head               → /…/changes/head.json
//                         Mutable HLC cursor. Overwrite ONLY if new latestHlc ≥ current.
//                         Serialized through DO when available.
//
//   change-file        → /…/changes/<hlc>-chg_<id>.json
//                         Immutable. Never overwrite. Core append-only guarantee.
//
//   mainline-snapshot  → /…/mainline/<anything>.json
//                         Immutable once written.
//
//   device-heartbeat   → /…/devices/<deviceId>.json
//                         Always overwrite (last-write-wins heartbeat).
//
//   other              → anything else (e.g. temporary app files)
//                         Respect INTEROCITOR_APPEND_ONLY flag.

const PATH_TYPE = Object.freeze({
  MANIFEST_POINTER: 'manifest-pointer',
  MANIFEST_SNAPSHOT: 'manifest-snapshot',
  HEAD: 'head',
  CHANGE_FILE: 'change-file',
  MAINLINE_SNAPSHOT: 'mainline-snapshot',
  DEVICE_HEARTBEAT: 'device-heartbeat',
  OTHER: 'other',
});

function classifyPath(path) {
  const name = fileNameFromPath(path);
  const parent = parentPath(path) ?? '/';
  const parentName = fileNameFromPath(parent);

  if (name === 'manifest.json') return PATH_TYPE.MANIFEST_POINTER;
  if (/^manifest-\d+\.json$/.test(name)) return PATH_TYPE.MANIFEST_SNAPSHOT;
  if (name === 'head.json' && parentName === 'changes') return PATH_TYPE.HEAD;
  if (/^.+-chg_.+\.json$/.test(name) && parentName === 'changes') return PATH_TYPE.CHANGE_FILE;
  if (parentName === 'mainline') return PATH_TYPE.MAINLINE_SNAPSHOT;
  if (parentName === 'devices') return PATH_TYPE.DEVICE_HEARTBEAT;
  return PATH_TYPE.OTHER;
}

function meshRootForPath(path, pathType = classifyPath(path)) {
  const normalized = normalizePath(path);
  if (normalized === '/') return null;

  if (pathType === PATH_TYPE.MANIFEST_POINTER || pathType === PATH_TYPE.MANIFEST_SNAPSHOT) {
    return parentPath(normalized);
  }

  if (
    pathType === PATH_TYPE.HEAD ||
    pathType === PATH_TYPE.CHANGE_FILE ||
    pathType === PATH_TYPE.MAINLINE_SNAPSHOT ||
    pathType === PATH_TYPE.DEVICE_HEARTBEAT
  ) {
    const parent = parentPath(normalized);
    return parent ? parentPath(parent) : null;
  }

  return topLevelRoot(normalized);
}

function changeHlcFromFileName(name) {
  const idx = name.lastIndexOf('-chg_');
  return idx > 0 ? name.slice(0, idx) : null;
}

function nowIso() { return new Date().toISOString(); }
function newEtag() { return `"${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}"`; }
function encodeSse(type, payload) { return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`; }
function isoDay(value) { return String(value).slice(0, 10); }

function toFiniteNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function clampNonNegativeInteger(value) {
  return Math.max(0, Math.trunc(toFiniteNumber(value, 0)));
}

function parseIntegerEnv(env, key, fallback, min = 0) {
  const value = Number.parseInt(String(env?.[key] ?? ''), 10);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

function getWorkerConfig(env) {
  return {
    pathTtlHours: parseIntegerEnv(env, 'INTEROCITOR_PATH_TTL_HOURS', DEFAULT_PATH_TTL_HOURS, 0),
    maintenanceMaxPathsPerRun: parseIntegerEnv(env, 'INTEROCITOR_MAINTENANCE_MAX_PATHS_PER_RUN', DEFAULT_MAINTENANCE_MAX_PATHS_PER_RUN, 1),
    maxControlBytes: parseIntegerEnv(env, 'INTEROCITOR_MAX_CONTROL_BYTES', DEFAULT_CONTROL_BYTES, 1),
    maxChangeBytes: parseIntegerEnv(env, 'INTEROCITOR_MAX_CHANGE_BYTES', DEFAULT_CHANGE_BYTES, 1),
    maxMainlineBytes: parseIntegerEnv(env, 'INTEROCITOR_MAX_MAINLINE_BYTES', DEFAULT_MAINLINE_BYTES, 1),
    maxGenericFileBytes: parseIntegerEnv(env, 'INTEROCITOR_MAX_GENERIC_FILE_BYTES', DEFAULT_GENERIC_FILE_BYTES, 1),
  };
}

function fileMetricsForPath(path, size) {
  const byteLength = clampNonNegativeInteger(size);
  const pathType = classifyPath(path);
  return {
    fileCount: 1,
    totalBytes: byteLength,
    changeBytes: pathType === PATH_TYPE.CHANGE_FILE ? byteLength : 0,
    mainlineBytes: pathType === PATH_TYPE.MAINLINE_SNAPSHOT ? byteLength : 0,
  };
}

function fileMetricsDeltaForChange(path, previousSize, nextSize) {
  const previous = previousSize == null ? null : fileMetricsForPath(path, previousSize);
  const next = nextSize == null ? null : fileMetricsForPath(path, nextSize);
  return {
    fileCountDelta: (next?.fileCount ?? 0) - (previous?.fileCount ?? 0),
    totalBytesDelta: (next?.totalBytes ?? 0) - (previous?.totalBytes ?? 0),
    changeBytesDelta: (next?.changeBytes ?? 0) - (previous?.changeBytes ?? 0),
    mainlineBytesDelta: (next?.mainlineBytes ?? 0) - (previous?.mainlineBytes ?? 0),
  };
}

function fileSizeLimitForPathType(config, pathType) {
  if (
    pathType === PATH_TYPE.MANIFEST_POINTER ||
    pathType === PATH_TYPE.MANIFEST_SNAPSHOT ||
    pathType === PATH_TYPE.HEAD ||
    pathType === PATH_TYPE.DEVICE_HEARTBEAT
  ) {
    return config.maxControlBytes;
  }
  if (pathType === PATH_TYPE.CHANGE_FILE) return config.maxChangeBytes;
  if (pathType === PATH_TYPE.MAINLINE_SNAPSHOT) return config.maxMainlineBytes;
  return config.maxGenericFileBytes;
}

function parseOptionalIso(value) {
  if (value == null || value === '') return null;
  const millis = Date.parse(String(value));
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

// ─── Logging ──────────────────────────────────────────────────────────────────
//
// Set INTEROCITOR_VERBOSE=1 in wrangler.toml / env vars to enable request-level
// tracing.  Errors are always logged regardless of the flag.

function makeLogger(env) {
  const verbose = String(env?.INTEROCITOR_VERBOSE ?? '0') !== '0';
  return {
    verbose,
    info(...args)  { if (verbose) console.log ('[worker]', nowIso(), ...args); },
    error(...args) {               console.error('[worker]', nowIso(), ...args); },
  };
}

// Wrap a Response and emit a one-line summary to the log.
function logged(log, label, response) {
  const lvl = response.status >= 500 ? 'error' : 'info';
  log[lvl](label, '→', response.status);
  return response;
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return Uint8Array.from(value);
  if (value && typeof value === 'object') {
    if (Array.isArray(value.data)) return Uint8Array.from(value.data);
    if (typeof value.type === 'string' && value.type.toLowerCase() === 'buffer' && Array.isArray(value.data)) {
      return Uint8Array.from(value.data);
    }
  }
  if (typeof value === 'string') return new TextEncoder().encode(value);
  return new Uint8Array();
}

async function dbGetMeshPath(db, prefix, remoteRoot) {
  return await db.prepare(
    `SELECT prefix, remote_root, created_at, updated_at, last_operation_at, last_read_at, last_write_at,
            last_ttl_delete_at, deleted_at, ops_day, ops_count_day, writes_count_day,
            current_file_count, current_total_bytes, current_change_bytes, current_mainline_bytes
       FROM mesh_paths
      WHERE prefix=?1 AND remote_root=?2
      LIMIT 1`,
  ).bind(prefix, remoteRoot).first();
}

async function dbEnsureMeshPath(db, prefix, remoteRoot, now = nowIso()) {
  if (!remoteRoot) return null;
  const existing = await dbGetMeshPath(db, prefix, remoteRoot);
  if (existing) return existing;
  await db.prepare(
    `INSERT OR IGNORE INTO mesh_paths (
       prefix, remote_root, created_at, updated_at, last_operation_at, last_read_at, last_write_at,
       last_ttl_delete_at, deleted_at, ops_day, ops_count_day, writes_count_day,
       current_file_count, current_total_bytes, current_change_bytes, current_mainline_bytes
     ) VALUES (?1, ?2, ?3, ?3, NULL, NULL, NULL, NULL, NULL, ?4, 0, 0, 0, 0, 0, 0)`,
  ).bind(prefix, remoteRoot, now, isoDay(now)).run();
  return await dbGetMeshPath(db, prefix, remoteRoot);
}

async function dbApplyMeshPathDelta(db, prefix, remoteRoot, delta, now = nowIso()) {
  if (!remoteRoot) return;
  const row = await dbEnsureMeshPath(db, prefix, remoteRoot, now);
  const nextFileCount = clampNonNegativeInteger(toFiniteNumber(row?.current_file_count) + toFiniteNumber(delta?.fileCountDelta));
  const nextTotalBytes = clampNonNegativeInteger(toFiniteNumber(row?.current_total_bytes) + toFiniteNumber(delta?.totalBytesDelta));
  const nextChangeBytes = clampNonNegativeInteger(toFiniteNumber(row?.current_change_bytes) + toFiniteNumber(delta?.changeBytesDelta));
  const nextMainlineBytes = clampNonNegativeInteger(toFiniteNumber(row?.current_mainline_bytes) + toFiniteNumber(delta?.mainlineBytesDelta));
  await db.prepare(
    `UPDATE mesh_paths
        SET updated_at=?3,
            deleted_at=NULL,
            current_file_count=?4,
            current_total_bytes=?5,
            current_change_bytes=?6,
            current_mainline_bytes=?7
      WHERE prefix=?1 AND remote_root=?2`,
  ).bind(prefix, remoteRoot, now, nextFileCount, nextTotalBytes, nextChangeBytes, nextMainlineBytes).run();
}

async function dbRecordMeshActivity(db, prefix, remoteRoot, kind, now = nowIso()) {
  if (!remoteRoot) return;
  const row = await dbEnsureMeshPath(db, prefix, remoteRoot, now);
  const today = isoDay(now);
  const sameDay = String(row?.ops_day ?? '') === today;
  const opsCountDay = sameDay ? clampNonNegativeInteger(toFiniteNumber(row?.ops_count_day) + 1) : 1;
  const currentWrites = sameDay ? clampNonNegativeInteger(row?.writes_count_day) : 0;
  const writesCountDay = kind === 'write' ? currentWrites + 1 : currentWrites;
  const lastReadAt = kind === 'read' ? now : (row?.last_read_at == null ? null : String(row.last_read_at));
  const lastWriteAt = kind === 'write' ? now : (row?.last_write_at == null ? null : String(row.last_write_at));
  await db.prepare(
    `UPDATE mesh_paths
        SET updated_at=?3,
            deleted_at=NULL,
            last_operation_at=?3,
            last_read_at=?4,
            last_write_at=?5,
            ops_day=?6,
            ops_count_day=?7,
            writes_count_day=?8
      WHERE prefix=?1 AND remote_root=?2`,
  ).bind(prefix, remoteRoot, now, lastReadAt, lastWriteAt, today, opsCountDay, writesCountDay).run();
}

async function dbMarkMeshPathDeleted(db, prefix, remoteRoot, now = nowIso()) {
  if (!remoteRoot) return;
  await dbEnsureMeshPath(db, prefix, remoteRoot, now);
  await db.prepare(
    `UPDATE mesh_paths
        SET updated_at=?3,
            deleted_at=?3,
            last_ttl_delete_at=?3,
            current_file_count=0,
            current_total_bytes=0,
            current_change_bytes=0,
            current_mainline_bytes=0
      WHERE prefix=?1 AND remote_root=?2`,
  ).bind(prefix, remoteRoot, now).run();
}

async function dbInsertMaintenanceRunStart(db, runId, startedAt, scopePrefix) {
  await db.prepare(
    `INSERT INTO maintenance_runs (run_id, started_at, scope_prefix, ttl_candidates, ttl_deleted, size_rejections, errors)
     VALUES (?1, ?2, ?3, 0, 0, 0, 0)`,
  ).bind(runId, startedAt, scopePrefix ?? null).run();
}

async function dbFinishMaintenanceRun(db, runId, summary) {
  await db.prepare(
    `UPDATE maintenance_runs
        SET finished_at=?2,
            ttl_candidates=?3,
            ttl_deleted=?4,
            size_rejections=?5,
            errors=?6,
            notes=?7
      WHERE run_id=?1`,
  ).bind(
    runId,
    summary.finishedAt,
    summary.ttlCandidates,
    summary.ttlDeleted,
    summary.sizeRejections,
    summary.errors,
    summary.notes ?? null,
  ).run();
}

async function dbInsertMaintenanceAction(db, payload) {
  await db.prepare(
    `INSERT INTO maintenance_actions (id, run_id, prefix, remote_root, action, details_json, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).bind(
    crypto.randomUUID(),
    payload.runId ?? null,
    payload.prefix,
    payload.remoteRoot,
    payload.action,
    JSON.stringify(payload.details ?? {}),
    payload.createdAt ?? nowIso(),
  ).run();
}

async function dbListMeshPathsForPrefix(db, prefix) {
  const { results = [] } = await db.prepare(
    `SELECT prefix, remote_root, created_at, updated_at, last_operation_at, last_read_at, last_write_at,
            last_ttl_delete_at, deleted_at, ops_day, ops_count_day, writes_count_day,
            current_file_count, current_total_bytes, current_change_bytes, current_mainline_bytes
       FROM mesh_paths
      WHERE prefix=?1
      ORDER BY remote_root ASC`,
  ).bind(prefix).all();
  return results;
}

async function dbMeasurePathMetrics(db, prefix, path) {
  const normalized = normalizePath(path);
  const like = normalized === '/' ? '/%' : `${normalized}/%`;
  const { results = [] } = await db.prepare(
    'SELECT path,size FROM files WHERE prefix=?1 AND (path=?2 OR path LIKE ?3)',
  ).bind(prefix, normalized, like).all();
  const totals = {
    fileCount: 0,
    totalBytes: 0,
    changeBytes: 0,
    mainlineBytes: 0,
  };
  for (const row of results) {
    const metrics = fileMetricsForPath(String(row.path), Number(row.size ?? 0));
    totals.fileCount += metrics.fileCount;
    totals.totalBytes += metrics.totalBytes;
    totals.changeBytes += metrics.changeBytes;
    totals.mainlineBytes += metrics.mainlineBytes;
  }
  return totals;
}

async function dbPathExists(db, prefix, path) {
  const normalized = normalizePath(path);
  if (normalized === '/') {
    const file = await db.prepare('SELECT 1 FROM files WHERE prefix=?1 LIMIT 1').bind(prefix).first();
    if (file) return true;
    const folder = await db.prepare('SELECT 1 FROM folders WHERE prefix=?1 LIMIT 1').bind(prefix).first();
    return Boolean(folder);
  }
  const like = `${normalized}/%`;
  const file = await db.prepare(
    'SELECT 1 FROM files WHERE prefix=?1 AND (path=?2 OR path LIKE ?3) LIMIT 1',
  ).bind(prefix, normalized, like).first();
  if (file) return true;
  const folder = await db.prepare(
    'SELECT 1 FROM folders WHERE prefix=?1 AND (path=?2 OR path LIKE ?3) LIMIT 1',
  ).bind(prefix, normalized, like).first();
  return Boolean(folder);
}

async function dbListTtlCandidates(db, olderThanIso, limit, scopePrefix = null) {
  if (scopePrefix) {
    const { results = [] } = await db.prepare(
      `SELECT prefix, remote_root, last_operation_at
         FROM mesh_paths
        WHERE deleted_at IS NULL
          AND prefix=?1
          AND last_operation_at IS NOT NULL
          AND last_operation_at < ?2
        ORDER BY last_operation_at ASC
        LIMIT ?3`,
    ).bind(scopePrefix, olderThanIso, limit).all();
    return results;
  }
  const { results = [] } = await db.prepare(
    `SELECT prefix, remote_root, last_operation_at
       FROM mesh_paths
      WHERE deleted_at IS NULL
        AND last_operation_at IS NOT NULL
        AND last_operation_at < ?1
      ORDER BY last_operation_at ASC
      LIMIT ?2`,
  ).bind(olderThanIso, limit).all();
  return results;
}

async function runMaintenance(env, ctx, log, options = {}) {
  const db = getDatabase(env);
  const config = getWorkerConfig(env);
  const startedAt = options.nowIso ?? nowIso();
  const ttlCutoff = new Date(Date.parse(startedAt) - (config.pathTtlHours * 60 * 60 * 1000)).toISOString();
  const runId = crypto.randomUUID();
  const scopePrefix = options.scopePrefix ?? null;
  await dbInsertMaintenanceRunStart(db, runId, startedAt, scopePrefix);

  let ttlDeleted = 0;
  let errors = 0;
  const ttlCandidates = await dbListTtlCandidates(db, ttlCutoff, config.maintenanceMaxPathsPerRun, scopePrefix);

  for (const candidate of ttlCandidates) {
    const prefix = String(candidate.prefix);
    const remoteRoot = normalizePath(String(candidate.remote_root));
    try {
      const metrics = await dbMeasurePathMetrics(db, prefix, remoteRoot);
      const existed = await dbDeletePath(db, prefix, remoteRoot);
      if (!existed) continue;
      await dbMarkMeshPathDeleted(db, prefix, remoteRoot, startedAt);
      await dbInsertMaintenanceAction(db, {
        runId,
        prefix,
        remoteRoot,
        action: 'ttl-delete',
        details: {
          source: options.source ?? 'scheduled',
          ttlHours: config.pathTtlHours,
          lastOperationAt: candidate.last_operation_at ?? null,
          deletedFileCount: metrics.fileCount,
          deletedTotalBytes: metrics.totalBytes,
          deletedChangeBytes: metrics.changeBytes,
          deletedMainlineBytes: metrics.mainlineBytes,
        },
        createdAt: startedAt,
      });
      ttlDeleted += 1;
      notifyDo(env, ctx, prefix, { type: 'maintenance-delete', path: remoteRoot, ts: Date.now() });
    } catch (error) {
      errors += 1;
      log.error('maintenance ttl delete failed', {
        prefix,
        remoteRoot,
        error: error instanceof Error ? error.message : String(error),
      });
      await dbInsertMaintenanceAction(db, {
        runId,
        prefix,
        remoteRoot,
        action: 'ttl-delete-error',
        details: {
          source: options.source ?? 'scheduled',
          error: error instanceof Error ? error.message : String(error),
        },
        createdAt: startedAt,
      });
    }
  }

  const finishedAt = nowIso();
  const summary = {
    runId,
    startedAt,
    finishedAt,
    scopePrefix,
    ttlHours: config.pathTtlHours,
    ttlCutoff,
    ttlCandidates: ttlCandidates.length,
    ttlDeleted,
    sizeRejections: 0,
    errors,
    notes: `source=${options.source ?? 'scheduled'}`,
  };
  await dbFinishMaintenanceRun(db, runId, summary);
  return summary;
}

// ─── D1 helpers ───────────────────────────────────────────────────────────────

async function dbFolderExists(db, prefix, path) {
  if (path === '/') return true;
  return Boolean(await db.prepare('SELECT 1 FROM folders WHERE prefix=?1 AND path=?2 LIMIT 1').bind(prefix, path).first());
}

async function dbEnsureFolder(db, prefix, path) {
  if (path === '/') return 201;
  if (await dbFolderExists(db, prefix, path)) return 405;
  const parent = parentPath(path);
  if (!parent || !(await dbFolderExists(db, prefix, parent))) return 409;
  await db.prepare('INSERT INTO folders (prefix,path,created_at) VALUES (?1,?2,?3)').bind(prefix, path, nowIso()).run();
  return 201;
}

async function dbEnsureFolderTree(db, prefix, target) {
  const n = normalizePath(target);
  if (!n || n === '/') return;
  let cur = '';
  for (const seg of n.split('/').filter(Boolean)) {
    cur += `/${seg}`;
    await db.prepare('INSERT OR IGNORE INTO folders (prefix,path,created_at) VALUES (?1,?2,?3)').bind(prefix, cur, nowIso()).run();
  }
}

async function dbGetFile(db, prefix, path) {
  return db.prepare('SELECT content,size,modified_time,etag FROM files WHERE prefix=?1 AND path=?2 LIMIT 1').bind(prefix, path).first();
}

async function dbPutFile(db, prefix, path, bytes, allowOverwrite) {
  const existing = await dbGetFile(db, prefix, path);
  if (!allowOverwrite && existing) return 409;
  const now = nowIso();
  await db.prepare(
    `INSERT INTO files (prefix,path,content,size,modified_time,etag) VALUES (?1,?2,?3,?4,?5,?6)
     ON CONFLICT(prefix,path) DO UPDATE SET
       content=excluded.content, size=excluded.size,
       modified_time=excluded.modified_time, etag=excluded.etag`,
  ).bind(prefix, path, bytes, bytes.byteLength, now, newEtag()).run();
  const delta = fileMetricsDeltaForChange(path, existing ? Number(existing.size ?? 0) : null, bytes.byteLength);
  await dbApplyMeshPathDelta(db, prefix, meshRootForPath(path), delta, now);
  return existing ? 204 : 201;
}

async function dbOverwriteFile(db, prefix, path, bytes) {
  const existing = await dbGetFile(db, prefix, path);
  const now = nowIso();
  await db.prepare(
    `INSERT INTO files (prefix,path,content,size,modified_time,etag) VALUES (?1,?2,?3,?4,?5,?6)
     ON CONFLICT(prefix,path) DO UPDATE SET
       content=excluded.content, size=excluded.size,
       modified_time=excluded.modified_time, etag=excluded.etag`,
  ).bind(prefix, path, bytes, bytes.byteLength, now, newEtag()).run();
  const delta = fileMetricsDeltaForChange(path, existing ? Number(existing.size ?? 0) : null, bytes.byteLength);
  await dbApplyMeshPathDelta(db, prefix, meshRootForPath(path), delta, now);
}

async function dbDeletePath(db, prefix, path) {
  const normalized = normalizePath(path);
  if (!(await dbPathExists(db, prefix, normalized))) return false;

  if (normalized === '/') {
    const meshPaths = await dbListMeshPathsForPrefix(db, prefix);
    await db.prepare('DELETE FROM files WHERE prefix=?1').bind(prefix).run();
    await db.prepare('DELETE FROM folders WHERE prefix=?1').bind(prefix).run();
    const now = nowIso();
    for (const row of meshPaths) {
      await dbApplyMeshPathDelta(db, prefix, String(row.remote_root), {
        fileCountDelta: -Number(row.current_file_count ?? 0),
        totalBytesDelta: -Number(row.current_total_bytes ?? 0),
        changeBytesDelta: -Number(row.current_change_bytes ?? 0),
        mainlineBytesDelta: -Number(row.current_mainline_bytes ?? 0),
      }, now);
    }
    return true;
  }

  const metrics = await dbMeasurePathMetrics(db, prefix, normalized);
  const like = `${normalized}/%`;
  await db.prepare('DELETE FROM files WHERE prefix=?1 AND (path=?2 OR path LIKE ?3)').bind(prefix, normalized, like).run();
  await db.prepare('DELETE FROM folders WHERE prefix=?1 AND (path=?2 OR path LIKE ?3)').bind(prefix, normalized, like).run();
  const remoteRoot = topLevelRoot(normalized);
  await dbApplyMeshPathDelta(db, prefix, remoteRoot, {
    fileCountDelta: -metrics.fileCount,
    totalBytesDelta: -metrics.totalBytes,
    changeBytesDelta: -metrics.changeBytes,
    mainlineBytesDelta: -metrics.mainlineBytes,
  });
  return true;
}

async function dbListFiles(db, prefix, path) {
  const pattern = path === '/' ? '/%' : `${path}/%`;
  const { results = [] } = await db
    .prepare('SELECT path,size,modified_time,etag FROM files WHERE prefix=?1 AND path LIKE ?2')
    .bind(prefix, pattern).all();
  const files = [];
  for (const row of results) {
    const fp = String(row.path);
    const rem = fp.slice(path === '/' ? 1 : path.length + 1);
    if (rem.includes('/')) continue;
    files.push({
      name: fileNameFromPath(fp),
      path: fp,
      size: Number(row.size ?? 0),
      modifiedTime: String(row.modified_time ?? nowIso()),
      etag: String(row.etag ?? ''),
    });
  }
  return files;
}

async function dbListFolders(db, prefix, path) {
  const pattern = path === '/' ? '/%' : `${path}/%`;
  const { results = [] } = await db
    .prepare('SELECT path FROM folders WHERE prefix=?1 AND path LIKE ?2')
    .bind(prefix, pattern).all();
  const folders = [];
  for (const row of results) {
    const fp = String(row.path);
    const rem = fp.slice(path === '/' ? 1 : path.length + 1);
    if (!rem || rem.includes('/')) continue;
    folders.push(fp);
  }
  return folders;
}

async function dbPruneCompactedChanges(db, prefix, remotePath, watermarkHlc) {
  const normalizedRoot = normalizePath(remotePath);
  const root = normalizedRoot === '/' ? '' : normalizedRoot;
  const { results = [] } = await db
    .prepare('SELECT path,size FROM files WHERE prefix=?1 AND path LIKE ?2')
    .bind(prefix, `${root}/changes/%`).all();
  const toDelete = [];
  let bytesPruned = 0;
  for (const row of results) {
    const filePath = String(row.path);
    const name = fileNameFromPath(filePath);
    if (name === 'head.json') continue;
    const hlc = changeHlcFromFileName(name);
    if (hlc && hlc <= watermarkHlc) {
      toDelete.push(filePath);
      bytesPruned += Number(row.size ?? 0);
    }
  }
  for (const p of toDelete) {
    await db.prepare('DELETE FROM files WHERE prefix=?1 AND path=?2').bind(prefix, p).run();
  }
  if (toDelete.length) {
    await dbApplyMeshPathDelta(db, prefix, normalizedRoot, {
      fileCountDelta: -toDelete.length,
      totalBytesDelta: -bytesPruned,
      changeBytesDelta: -bytesPruned,
      mainlineBytesDelta: 0,
    });
  }
  return { remotePath: normalizedRoot, watermarkHlc, totalCandidates: results.length, pruned: toDelete.length, bytesPruned };
}

// ─── Execute ──────────────────────────────────────────────────────────────────

async function handleExecute(db, prefix, request, env, ctx, log) {
  const payload = await request.json().catch(() => null);
  if (!payload) return new Response('Invalid JSON body', { status: 400 });

  const op = String(payload.op || '');

  if (op === EXECUTE_OP_PRUNE_COMPACTED_CHANGES || op === EXECUTE_OP_COMPACT_LEGACY) {
    const remotePath = normalizePath(String(payload.remotePath || '/'));
    const watermarkHlc = String(payload.watermarkHlc || '');
    if (!watermarkHlc) return new Response('Missing watermarkHlc', { status: 400 });

    const canonicalOp = EXECUTE_OP_PRUNE_COMPACTED_CHANGES;
    const requestedOp = op;
    log.info('execute prune compacted changes', { prefix, remotePath, watermarkHlc, requestedOp });
    const result = await dbPruneCompactedChanges(db, prefix, remotePath, watermarkHlc);
    log.info('execute prune compacted changes done', { prefix, ...result, requestedOp });

    const root = normalizePath(remotePath) === '/' ? '' : normalizePath(remotePath);
    const receiptDir = `${root}/.interocitor/commands`;
    const receiptPath = `${receiptDir}/prune-${Date.now().toString(36)}.json`;
    const ts = nowIso();
    await dbEnsureFolderTree(db, prefix, receiptDir);
    await dbOverwriteFile(db, prefix, receiptPath,
      textEncoder.encode(JSON.stringify({
        op: canonicalOp,
        requestedOp,
        ...result,
        ts,
      }, null, 2)));
    await dbRecordMeshActivity(db, prefix, remotePath, 'write', ts);

    return jsonResponse({ ok: true, op: canonicalOp, requestedOp, ...result, receiptPath });
  }

  if (op === 'run-maintenance') {
    const nowOverride = parseOptionalIso(payload.nowIso);
    if (payload.nowIso != null && !nowOverride) return new Response('Invalid nowIso', { status: 400 });
    const result = await runMaintenance(env, ctx, log, {
      scopePrefix: prefix,
      nowIso: nowOverride ?? undefined,
      source: 'execute',
    });
    return jsonResponse({ ok: true, ...result });
  }

  if (op === 'maintenance-status') {
    const remotePath = payload.remotePath == null ? null : normalizePath(String(payload.remotePath || '/'));
    const paths = remotePath
      ? [await dbGetMeshPath(db, prefix, remotePath)].filter(Boolean)
      : await dbListMeshPathsForPrefix(db, prefix);
    return jsonResponse({ ok: true, prefix, config: getWorkerConfig(env), paths });
  }

  if (op === 'drop-sse-clients') {
    const eventsBinding = getEventsBinding(env);
    if (!eventsBinding) return new Response(`SSE not configured (${EVENTS_BINDING_NAME} binding missing)`, { status: 400 });
    log.info('execute drop-sse-clients', { prefix });
    const stub = eventsBinding.get(eventsBinding.idFromName(prefix));
    return stub.fetch(new Request('https://internal/__reset-clients', { method: 'POST' }));
  }

  return new Response(`Unsupported op: ${op}`, { status: 400 });
}

async function readJsonBody(request) {
  return request.json().catch(() => null);
}

// ─── Semantic write validation ────────────────────────────────────────────────
//
// Validates that a write to a mutable control file is a legal forward transition:
//   manifest.json  → new currentGeneration must be ≥ existing
//   head.json      → new latestHlc must be ≥ existing (ISO lexicographic order)
//
// Returns true if write was accepted, false if rejected (caller returns 409).

async function semanticWrite(db, prefix, path, pathType, bytes) {
  const existing = await dbGetFile(db, prefix, path);

  if (existing) {
    let existingJson;
    let incomingJson;

    try {
      const decoder = new TextDecoder();
      existingJson = JSON.parse(decoder.decode(toUint8Array(existing.content)));
      incomingJson = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      // If either side is unparseable, allow the write to proceed so a corrupt
      // file doesn't permanently block the mesh.
      await dbOverwriteFile(db, prefix, path, bytes);
      return true;
    }

    if (pathType === PATH_TYPE.MANIFEST_POINTER) {
      const existingGen = Number(existingJson?.currentGeneration ?? -1);
      const incomingGen = Number(incomingJson?.currentGeneration ?? -1);
      if (incomingGen < existingGen) return false;
    }

    if (pathType === PATH_TYPE.HEAD) {
      const existingHlc = String(existingJson?.latestHlc ?? '');
      const incomingHlc = String(incomingJson?.latestHlc ?? '');
      if (incomingHlc < existingHlc) return false;
    }
  }

  await dbOverwriteFile(db, prefix, path, bytes);
  return true;
}

async function handleIoRequest(request, env, ctx, url, log) {
  const method = request.method.toUpperCase();
  const segments = decodeURIComponent(url.pathname.slice(`${IO_PREFIX}/`.length)).split('/').filter(Boolean);
  const prefix = segments[0] ?? '';
  const opPath = `/${segments.slice(1).join('/')}`;

  if (!prefix) return withCors(new Response('Path must start with /io/<prefix>', { status: 400 }));

  let db;
  try {
    db = getDatabase(env);
  } catch (error) {
    return withCors(new Response(String(error?.message || error), { status: 500 }));
  }
  const appendOnly = String(env.INTEROCITOR_APPEND_ONLY ?? '1') !== '0';
  const config = getWorkerConfig(env);

  log.info(method, url.pathname + url.search, { prefix, opPath, appendOnly });

  if (method === 'GET' && opPath === '/health') {
    return withCors(jsonResponse({ ok: true, prefix }));
  }

  if (method === 'POST' && opPath === '/ensure-folder') {
    const payload = await readJsonBody(request);
    const path = normalizePath(String(payload?.path || '/'));
    const status = await dbEnsureFolder(db, prefix, path);
    if (status !== 409) {
      notifyDo(env, ctx, prefix, { type: 'folder', path, ts: Date.now() });
      await dbRecordMeshActivity(db, prefix, topLevelRoot(path), 'write');
    }
    return withCors(new Response('', { status: status === 405 ? 200 : status }));
  }

  if (method === 'POST' && opPath === '/list-files') {
    const payload = await readJsonBody(request);
    const path = normalizePath(String(payload?.path || '/'));
    const files = await dbListFiles(db, prefix, path);
    await dbRecordMeshActivity(db, prefix, topLevelRoot(path), 'read');
    return withCors(jsonResponse({ files }));
  }

  if (method === 'POST' && opPath === '/list-folders') {
    const payload = await readJsonBody(request);
    const path = normalizePath(String(payload?.path || '/'));
    const folders = (await dbListFolders(db, prefix, path))
      .map((p) => p.split('/').filter(Boolean).pop() || '')
      .filter(Boolean);
    await dbRecordMeshActivity(db, prefix, topLevelRoot(path), 'read');
    return withCors(jsonResponse({ folders }));
  }

  if (method === 'POST' && opPath === '/metadata') {
    const payload = await readJsonBody(request);
    const path = normalizePath(String(payload?.path || '/'));
    const file = await dbGetFile(db, prefix, path);
    if (!file) return withCors(new Response('', { status: 404 }));
    await dbRecordMeshActivity(db, prefix, meshRootForPath(path), 'read');
    return withCors(jsonResponse({
      file: {
        name: fileNameFromPath(path),
        path,
        size: Number(file.size),
        modifiedTime: String(file.modified_time),
        etag: String(file.etag),
      },
    }));
  }

  if (opPath === '/file') {
    const path = normalizePath(url.searchParams.get('path') || '/');

    if (method === 'GET') {
      const file = await dbGetFile(db, prefix, path);
      if (!file) return logged(log, `GET ${path}`, withCors(new Response('', { status: 404 })));
      await dbRecordMeshActivity(db, prefix, meshRootForPath(path), 'read');
      return logged(log, `GET ${path}`, withCors(new Response(toUint8Array(file.content), {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream', ETag: String(file.etag) },
      })));
    }

    if (method === 'PUT') {
      const bytes = new Uint8Array(await request.arrayBuffer());
      const pathType = classifyPath(path);
      const remoteRoot = meshRootForPath(path, pathType) ?? topLevelRoot(path) ?? '/';
      const limit = fileSizeLimitForPathType(config, pathType);
      log.info(`PUT ${path}`, { pathType, bytes: bytes.byteLength, limit });

      if (bytes.byteLength > limit) {
        log.error(`PUT ${path} — payload too large`, { pathType, bytes: bytes.byteLength, limit });
        await dbInsertMaintenanceAction(db, {
          prefix,
          remoteRoot,
          action: 'size-reject',
          details: { path, pathType, bytes: bytes.byteLength, limit },
        });
        return logged(log, `PUT ${path}`, withCors(new Response(`Payload too large for ${pathType}: ${bytes.byteLength} > ${limit}`, { status: 413 })));
      }

      if (
        pathType === PATH_TYPE.MANIFEST_SNAPSHOT ||
        pathType === PATH_TYPE.CHANGE_FILE ||
        pathType === PATH_TYPE.MAINLINE_SNAPSHOT
      ) {
        const status = await dbPutFile(db, prefix, path, bytes, false);
        if (status === 201) notifyDo(env, ctx, prefix, { type: 'file', path, ts: Date.now() });
        if (status === 201 || status === 409) await dbRecordMeshActivity(db, prefix, remoteRoot, 'write');
        return logged(log, `PUT ${path}`, withCors(new Response('', { status: status === 409 ? 200 : status })));
      }

      if (pathType === PATH_TYPE.MANIFEST_POINTER || pathType === PATH_TYPE.HEAD) {
        const eventsBinding = getEventsBinding(env);
        if (eventsBinding) {
          const stub = eventsBinding.get(eventsBinding.idFromName(prefix));
          const req = new Request('https://internal/__write-validated', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              'x-prefix': prefix,
              'x-path': path,
              'x-path-type': pathType,
            },
            body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          });
          const result = await stub.fetch(req);
          if (!result.ok) log.error(`PUT ${path} — DO rejected`, { status: result.status, pathType });
          if (result.ok) {
            notifyDo(env, ctx, prefix, { type: 'file', path, ts: Date.now() });
            await dbRecordMeshActivity(db, prefix, remoteRoot, 'write');
          }
          return logged(log, `PUT ${path} (via DO)`, withCors(result));
        }
        const wrote = await semanticWrite(db, prefix, path, pathType, bytes);
        if (!wrote) log.error(`PUT ${path} — semantic validation rejected`, { pathType });
        if (wrote) {
          notifyDo(env, ctx, prefix, { type: 'file', path, ts: Date.now() });
          await dbRecordMeshActivity(db, prefix, remoteRoot, 'write');
        }
        return logged(log, `PUT ${path}`, withCors(new Response(wrote ? null : '', { status: wrote ? 204 : 409 })));
      }

      if (pathType === PATH_TYPE.DEVICE_HEARTBEAT) {
        await dbOverwriteFile(db, prefix, path, bytes);
        notifyDo(env, ctx, prefix, { type: 'file', path, ts: Date.now() });
        await dbRecordMeshActivity(db, prefix, remoteRoot, 'write');
        return logged(log, `PUT ${path}`, withCors(new Response(null, { status: 204 })));
      }

      const status = await dbPutFile(db, prefix, path, bytes, !appendOnly);
      if (status === 201 || status === 204) {
        notifyDo(env, ctx, prefix, { type: 'file', path, ts: Date.now() });
        await dbRecordMeshActivity(db, prefix, remoteRoot, 'write');
      }
      return logged(log, `PUT ${path}`, withCors(new Response('', { status })));
    }

    if (method === 'DELETE') {
      if (appendOnly) {
        return logged(log, `DELETE ${path}`, withCors(new Response('DELETE disabled in append-only mode', { status: 405 })));
      }
      const existed = await dbDeletePath(db, prefix, path);
      if (existed) {
        notifyDo(env, ctx, prefix, { type: 'delete', path, ts: Date.now() });
        await dbRecordMeshActivity(db, prefix, topLevelRoot(path), 'write');
      }
      return logged(log, `DELETE ${path}`, withCors(new Response(existed ? null : '', { status: existed ? 204 : 404 })));
    }
  }

  return withCors(new Response('Not found', { status: 404 }));
}

// ─── DO notifier (fire-and-forget) ───────────────────────────────────────────

function notifyDo(env, ctx, prefix, payload) {
  const eventsBinding = getEventsBinding(env);
  if (!eventsBinding) return;
  const req = new Request('https://internal/__broadcast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const p = eventsBinding.get(eventsBinding.idFromName(prefix)).fetch(req).catch(() => {});
  ctx?.waitUntil?.(p);
}

// ─── Worker ───────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const log = makeLogger(env);

    if (method === 'OPTIONS') return preflightResponse();

    if (url.pathname === '/' || url.pathname === '/health') {
      return withCors(new Response('interocitor cloudflare worker\n', { status: 200 }));
    }

    const accessPrefix = extractPrefixFromPath(url.pathname);
    if (accessPrefix && !(await hasAccess(request, env, accessPrefix))) {
      log.error('Unauthorized', { method, pathname: url.pathname, prefix: accessPrefix });
      return withCors(new Response('Unauthorized', { status: 401 }));
    }

    if (url.pathname.startsWith(`${SYSTEM_PREFIX}/`)) {
      const prefix = decodeURIComponent(url.pathname.slice(`${SYSTEM_PREFIX}/`.length))
        .split('/').filter(Boolean)[0] ?? '';
      if (!prefix) return withCors(new Response('Missing prefix', { status: 400 }));
      if (!hasSystemAccess(request, env)) {
        log.error('System API forbidden', { method, pathname: url.pathname, prefix });
        return withCors(new Response('Forbidden', { status: 403 }));
      }
      let db;
      try {
        db = getDatabase(env);
      } catch (error) {
        return withCors(new Response(String(error?.message || error), { status: 500 }));
      }
      return withCors(await handleExecute(db, prefix, request, env, ctx, log));
    }

    if (url.pathname.startsWith(`${IO_PREFIX}/`)) {
      return handleIoRequest(request, env, ctx, url, log);
    }

    if (url.pathname.startsWith(`${EVENTS_PREFIX}/`)) {
      const eventsBinding = getEventsBinding(env);
      if (!eventsBinding) {
        return withCors(new Response(`SSE not configured (${EVENTS_BINDING_NAME} binding missing)`, { status: 501 }));
      }
      const prefix = decodeURIComponent(url.pathname.slice(`${EVENTS_PREFIX}/`.length))
        .split('/').filter(Boolean)[0] ?? '';
      if (!prefix) return withCors(new Response('Missing prefix', { status: 400 }));
      log.info('SSE subscribe', { prefix });
      const stub = eventsBinding.get(eventsBinding.idFromName(prefix));
      return withCors(await stub.fetch(new Request('https://internal/__events', request)));
    }

    return withCors(new Response('Not found', { status: 404 }));
  },

  async scheduled(_event, env, ctx) {
    const log = makeLogger(env);
    const result = await runMaintenance(env, ctx, log, { source: 'scheduled' });
    log.info('scheduled maintenance done', result);
  },
};

// ─── Durable Object: SSE broadcaster + serialized write validator ─────────────
//
// Two responsibilities:
//   1. SSE fanout: keeps the in-memory map of live EventSource connections.
//   2. Serialized semantic writes: validates and applies manifest.json / head.json
//      writes so concurrent writers can never regress generation or HLC.
//
// All durable data is in D1. On restart, EventSource reconnects automatically.

export class TodoDavBroadcaster {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.clients = new Map();
  }

  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === '/__events') return this.handleSubscribe(request);
    if (pathname === '/__broadcast') return this.handleBroadcast(request);
    if (pathname === '/__write-validated') return this.handleValidatedWrite(request);
    if (pathname === '/__reset-clients') return this.handleResetClients();
    return new Response('Not found', { status: 404 });
  }

  // ── Serialized semantic write (manifest.json / head.json) ──────────────────
  // Runs inside the DO actor — no concurrent execution possible for the same prefix.

  async handleValidatedWrite(request) {
    const prefix = request.headers.get('x-prefix') ?? '';
    const path = request.headers.get('x-path') ?? '';
    const pathType = request.headers.get('x-path-type') ?? '';

    if (!prefix || !path || !pathType) {
      return new Response('Missing required headers', { status: 400 });
    }

    let db;
    try {
      db = getDatabase(this.env);
    } catch (error) {
      return new Response(String(error?.message || error), { status: 500 });
    }

    const bytes = new Uint8Array(await request.arrayBuffer());
    const wrote = await semanticWrite(db, prefix, path, pathType, bytes);
    return new Response(wrote ? null : '', { status: wrote ? 204 : 409 });
  }

  handleSubscribe(request) {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const id = crypto.randomUUID();
    this.clients.set(id, writer);
    writer.write(textEncoder.encode(encodeSse('ready', { ts: Date.now() }))).catch(() => {});
    request.signal.addEventListener('abort', async () => {
      this.clients.delete(id);
      try { await writer.close(); } catch { /* already closed */ }
    });
    return new Response(readable, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  }

  async handleBroadcast(request) {
    const payload = await request.json().catch(() => ({}));
    const message = textEncoder.encode(encodeSse('invalidate', payload));
    const dead = [];
    for (const [id, writer] of this.clients.entries()) {
      try { await writer.write(message); } catch { dead.push(id); }
    }
    for (const id of dead) {
      const w = this.clients.get(id);
      this.clients.delete(id);
      try { await w?.close(); } catch { /* ignore */ }
    }
    return new Response('ok');
  }

  async handleResetClients() {
    const clients = Array.from(this.clients.values());
    this.clients.clear();
    for (const writer of clients) {
      try { await writer.close(); } catch { /* ignore */ }
    }
    return jsonResponse({ ok: true, cleared: clients.length });
  }
}
