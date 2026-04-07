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
 *   Remove TODO_DAV binding entirely to disable SSE (/events/* → 501);
 *   everything else keeps working with polling as fallback.
 *
 * URL layout
 *   GET  /health                                     health check
 *   *    /io/<prefix>/...                            Interocitor-native API (JSON + binary)
 *   GET  /events/<prefix>                            SSE stream (requires DO)
 *   POST /io/<prefix>/__interocitor__/execute        privileged compact
 *
 * Append-only mode  (INTEROCITOR_APPEND_ONLY=1, default ON)
 *   DELETE             → 405
 *   PUT on existing    → 409
 *   Compact via /execute is the only way to prune.
 *
 */

const IO_PREFIX = '/io';
const EVENTS_PREFIX = '/events';
const EXECUTE_SUFFIX = '/__interocitor__/execute';

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

function changeHlcFromFileName(name) {
  const idx = name.lastIndexOf('-chg_');
  return idx > 0 ? name.slice(0, idx) : null;
}

function nowIso() { return new Date().toISOString(); }
function newEtag() { return `"${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}"`; }
function encodeSse(type, payload) { return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`; }

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
  const existed = Boolean(await db.prepare('SELECT 1 FROM files WHERE prefix=?1 AND path=?2 LIMIT 1').bind(prefix, path).first());
  if (!allowOverwrite && existed) return 409;
  await db.prepare(
    `INSERT INTO files (prefix,path,content,size,modified_time,etag) VALUES (?1,?2,?3,?4,?5,?6)
     ON CONFLICT(prefix,path) DO UPDATE SET
       content=excluded.content, size=excluded.size,
       modified_time=excluded.modified_time, etag=excluded.etag`,
  ).bind(prefix, path, bytes, bytes.byteLength, nowIso(), newEtag()).run();
  return existed ? 204 : 201;
}

async function dbOverwriteFile(db, prefix, path, bytes) {
  await db.prepare(
    `INSERT INTO files (prefix,path,content,size,modified_time,etag) VALUES (?1,?2,?3,?4,?5,?6)
     ON CONFLICT(prefix,path) DO UPDATE SET
       content=excluded.content, size=excluded.size,
       modified_time=excluded.modified_time, etag=excluded.etag`,
  ).bind(prefix, path, bytes, bytes.byteLength, nowIso(), newEtag()).run();
}

async function dbDeletePath(db, prefix, path) {
  if (path === '/') {
    await db.prepare('DELETE FROM files WHERE prefix=?1').bind(prefix).run();
    await db.prepare('DELETE FROM folders WHERE prefix=?1').bind(prefix).run();
    return true;
  }
  const file = await dbGetFile(db, prefix, path);
  if (file) {
    await db.prepare('DELETE FROM files WHERE prefix=?1 AND path=?2').bind(prefix, path).run();
    return true;
  }
  if (!(await dbFolderExists(db, prefix, path))) return false;
  const like = `${path}/%`;
  await db.prepare('DELETE FROM files WHERE prefix=?1 AND (path=?2 OR path LIKE ?3)').bind(prefix, path, like).run();
  await db.prepare('DELETE FROM folders WHERE prefix=?1 AND (path=?2 OR path LIKE ?3)').bind(prefix, path, like).run();
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

async function dbCompact(db, prefix, remotePath, watermarkHlc) {
  const root = normalizePath(remotePath) === '/' ? '' : normalizePath(remotePath);
  const { results = [] } = await db
    .prepare('SELECT path FROM files WHERE prefix=?1 AND path LIKE ?2')
    .bind(prefix, `${root}/changes/%`).all();
  const toDelete = [];
  for (const row of results) {
    const name = fileNameFromPath(String(row.path));
    if (name === 'head.json') continue;
    const hlc = changeHlcFromFileName(name);
    if (hlc && hlc <= watermarkHlc) toDelete.push(String(row.path));
  }
  for (const p of toDelete) {
    await db.prepare('DELETE FROM files WHERE prefix=?1 AND path=?2').bind(prefix, p).run();
  }
  return { remotePath, watermarkHlc, totalCandidates: results.length, pruned: toDelete.length };
}

// ─── Execute ──────────────────────────────────────────────────────────────────

async function handleExecute(db, prefix, request, env, log) {
  const expected = env?.INTEROCITOR_EXEC_TOKEN;
  if (expected && (request.headers.get('x-interocitor-token') || '') !== expected) {
    log.error('execute forbidden — bad x-interocitor-token', { prefix });
    return new Response('Forbidden', { status: 403 });
  }

  const payload = await request.json().catch(() => null);
  if (!payload) return new Response('Invalid JSON body', { status: 400 });

  const op = String(payload.op || '');

  if (op === 'compact') {
    const remotePath = normalizePath(String(payload.remotePath || '/'));
    const watermarkHlc = String(payload.watermarkHlc || '');
    if (!watermarkHlc) return new Response('Missing watermarkHlc', { status: 400 });

    log.info('execute compact', { prefix, remotePath, watermarkHlc });
    const result = await dbCompact(db, prefix, remotePath, watermarkHlc);
    log.info('execute compact done', { prefix, ...result });

    // Write an immutable compact receipt to the audit log.
    const root = normalizePath(remotePath) === '/' ? '' : normalizePath(remotePath);
    const receiptDir = `${root}/.interocitor/commands`;
    const receiptPath = `${receiptDir}/compact-${Date.now().toString(36)}.json`;
    await dbEnsureFolderTree(db, prefix, receiptDir);
    await dbOverwriteFile(db, prefix, receiptPath,
      textEncoder.encode(JSON.stringify({ op: 'compact', ...result, ts: nowIso() }, null, 2)));

    return jsonResponse({ ok: true, ...result, receiptPath });
  }

  if (op === 'drop-sse-clients') {
    if (!env?.TODO_DAV) return new Response('SSE not configured (TODO_DAV binding missing)', { status: 400 });
    log.info('execute drop-sse-clients', { prefix });
    const stub = env.TODO_DAV.get(env.TODO_DAV.idFromName(prefix));
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
  if (!env.TODO_DB) return withCors(new Response('Missing D1 binding TODO_DB', { status: 500 }));

  const db = env.TODO_DB;
  const appendOnly = String(env.INTEROCITOR_APPEND_ONLY ?? '1') !== '0';

  log.info(method, url.pathname + url.search, { prefix, opPath, appendOnly });


  if (method === 'GET' && opPath === '/health') {
    return withCors(jsonResponse({ ok: true, prefix }));
  }

  if (method === 'POST' && opPath === '/ensure-folder') {
    const payload = await readJsonBody(request);
    const path = normalizePath(String(payload?.path || '/'));
    const status = await dbEnsureFolder(db, prefix, path);
    if (status !== 409) notifyDo(env, ctx, prefix, { type: 'folder', path, ts: Date.now() });
    // 405 = already exists → idempotent success for the client.
    return withCors(new Response('', { status: status === 405 ? 200 : status }));
  }

  if (method === 'POST' && opPath === '/list-files') {
    const payload = await readJsonBody(request);
    const path = normalizePath(String(payload?.path || '/'));
    const files = await dbListFiles(db, prefix, path);
    return withCors(jsonResponse({ files }));
  }

  if (method === 'POST' && opPath === '/list-folders') {
    const payload = await readJsonBody(request);
    const path = normalizePath(String(payload?.path || '/'));
    const folders = (await dbListFolders(db, prefix, path))
      .map((p) => p.split('/').filter(Boolean).pop() || '')
      .filter(Boolean);
    return withCors(jsonResponse({ folders }));
  }

  if (method === 'POST' && opPath === '/metadata') {
    const payload = await readJsonBody(request);
    const path = normalizePath(String(payload?.path || '/'));
    const file = await dbGetFile(db, prefix, path);
    if (!file) return withCors(new Response('', { status: 404 }));
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

  if (method === 'POST' && opPath === EXECUTE_SUFFIX) {
    return withCors(await handleExecute(db, prefix, request, env, log));
  }

  if (opPath === '/file') {
    const path = normalizePath(url.searchParams.get('path') || '/');

    if (method === 'GET') {
      const file = await dbGetFile(db, prefix, path);
      if (!file) return logged(log, `GET ${path}`, withCors(new Response('', { status: 404 })));
      return logged(log, `GET ${path}`, withCors(new Response(toUint8Array(file.content), {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream', ETag: String(file.etag) },
      })));
    }

    if (method === 'PUT') {
      const bytes = new Uint8Array(await request.arrayBuffer());
      const pathType = classifyPath(path);
      log.info(`PUT ${path}`, { pathType, bytes: bytes.byteLength });

      // ── Truly immutable: never overwrite ──────────────────────────────────
      // A second PUT of the same immutable file is idempotent: the content
      // cannot have changed, so "already exists" is 200, not 409.
      // This lets a client recover from a partial bootstrap (manifest-N.json
      // written, manifest.json pointer not yet written) without getting stuck.
      if (
        pathType === PATH_TYPE.MANIFEST_SNAPSHOT ||
        pathType === PATH_TYPE.CHANGE_FILE ||
        pathType === PATH_TYPE.MAINLINE_SNAPSHOT
      ) {
        const status = await dbPutFile(db, prefix, path, bytes, false);
        if (status === 201) notifyDo(env, ctx, prefix, { type: 'file', path, ts: Date.now() });
        // 409 → 200: already exists is a success for immutable content.
        return logged(log, `PUT ${path}`, withCors(new Response('', { status: status === 409 ? 200 : status })));
      }

      // ── Semantically validated overwrites ─────────────────────────────────
      // Serialized through DO when available; inline fallback otherwise.
      if (
        pathType === PATH_TYPE.MANIFEST_POINTER ||
        pathType === PATH_TYPE.HEAD
      ) {
        if (env.TODO_DAV) {
          const stub = env.TODO_DAV.get(env.TODO_DAV.idFromName(prefix));
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
          if (result.ok) notifyDo(env, ctx, prefix, { type: 'file', path, ts: Date.now() });
          return logged(log, `PUT ${path} (via DO)`, withCors(result));
        }
        // No DO: inline semantic validation (single-writer assumption).
        const wrote = await semanticWrite(db, prefix, path, pathType, bytes);
        if (!wrote) log.error(`PUT ${path} — semantic validation rejected`, { pathType });
        if (wrote) notifyDo(env, ctx, prefix, { type: 'file', path, ts: Date.now() });
        return logged(log, `PUT ${path}`, withCors(new Response(wrote ? null : '', { status: wrote ? 204 : 409 })));
      }

      // ── Device heartbeat: always overwrite ────────────────────────────────
      if (pathType === PATH_TYPE.DEVICE_HEARTBEAT) {
        await dbOverwriteFile(db, prefix, path, bytes);
        notifyDo(env, ctx, prefix, { type: 'file', path, ts: Date.now() });
        return logged(log, `PUT ${path}`, withCors(new Response(null, { status: 204 })));
      }

      // ── Other paths: respect append-only flag ─────────────────────────────
      const status = await dbPutFile(db, prefix, path, bytes, !appendOnly);
      if (status === 201 || status === 204) notifyDo(env, ctx, prefix, { type: 'file', path, ts: Date.now() });
      return logged(log, `PUT ${path}`, withCors(new Response('', { status })));
    }

    if (method === 'DELETE') {
      if (appendOnly) {
        return logged(log, `DELETE ${path}`, withCors(new Response('DELETE disabled in append-only mode', { status: 405 })));
      }
      const existed = await dbDeletePath(db, prefix, path);
      if (existed) notifyDo(env, ctx, prefix, { type: 'delete', path, ts: Date.now() });
      return logged(log, `DELETE ${path}`, withCors(new Response(existed ? null : '', { status: existed ? 204 : 404 })));
    }
  }

  return withCors(new Response('Not found', { status: 404 }));
}

// ─── DO notifier (fire-and-forget) ───────────────────────────────────────────

function notifyDo(env, ctx, prefix, payload) {
  if (!env?.TODO_DAV) return;
  const req = new Request('https://internal/__broadcast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const p = env.TODO_DAV.get(env.TODO_DAV.idFromName(prefix)).fetch(req).catch(() => {});
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

    if (url.pathname.startsWith(`${IO_PREFIX}/`)) {
      return handleIoRequest(request, env, ctx, url, log);
    }

    // SSE — route to DO broadcaster
    if (url.pathname.startsWith(`${EVENTS_PREFIX}/`)) {
      if (!env.TODO_DAV) {
        return withCors(new Response('SSE not configured (TODO_DAV binding missing)', { status: 501 }));
      }
      const prefix = decodeURIComponent(url.pathname.slice(`${EVENTS_PREFIX}/`.length))
        .split('/').filter(Boolean)[0] ?? '';
      if (!prefix) return withCors(new Response('Missing prefix', { status: 400 }));
      log.info('SSE subscribe', { prefix });
      const stub = env.TODO_DAV.get(env.TODO_DAV.idFromName(prefix));
      return withCors(await stub.fetch(new Request('https://internal/__events', request)));
    }

    return withCors(new Response('Not found', { status: 404 }));
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

    const db = this.env?.TODO_DB;
    if (!db) return new Response('Missing D1 binding TODO_DB', { status: 500 });

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
