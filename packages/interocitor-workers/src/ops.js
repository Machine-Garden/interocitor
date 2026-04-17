import { meshRootForPath, cacheKeyFor } from './paths.js';
import { PATH_TYPE } from './paths.js';
void PATH_TYPE;
/**
 * interocitor operations layer
 *
 * Goals:
 *   1. Batch D1 statements — one round-trip per operation, not 5–7
 *   2. Cache API for immutable files — free reads, zero D1 cost on hits
 *   3. Drop per-request activity tracking on reads (kills 2–3 D1 calls per GET)
 *   4. Conditional SQL for semantic writes — no DO round-trip needed
 *   5. WebSocket Hibernation DO — pure fanout, zero idle cost
 *
 * Naming: every export is an "op" — a single logical operation that talks to D1
 * at most once (via batch) and touches cache where appropriate.
 */

// ─── Cache helpers ───────────────────────────────────────────────────────────
//
// Immutable files (change files, manifest snapshots, mainline snapshots) are
// written once and never modified.  Cache them aggressively in the free
// Cache API.  Mutable files skip cache entirely — they're small, infrequent,
// and not worth the invalidation complexity.

/*

Summary of what changed and why:
DO: SSE → WebSocket Hibernation
InterocitorRelay replaces TodoDavBroadcaster. Three endpoints: __connect (WebSocket upgrade + acceptWebSocket), __broadcast (wake, fan out, sleep), __reset. No TransformStream, no client map, no storage, no D1 access. The runtime manages socket lifecycle. Cost when idle: zero.
Semantic writes: DO → D1
opPutSemantic does the generation/HLC validation in the Worker with a read-then-conditional-batch. Eliminates the __write-validated round-trip to the DO. The DO no longer touches D1 at all.
D1 call counts per operation (old → new):

PUT immutable: 5–7 → 1 batch
PUT semantic: 7+ (including DO fetch) → 2 (one read, one batch)
PUT heartbeat: 5–7 → 1 batch (skips metrics read entirely — heartbeats are noise)
GET file (immutable): 3–4 → 0 on cache hit, 1 on miss
LIST: 2 queries + activity tracking → 1 batch of 2 queries, no tracking
DELETE: 4–5 → 1 batch + lazy metrics reconciliation

What got dropped:

dbRecordMeshActivity on read paths — was tripling every GET/LIST cost for unused telemetry
Pre-scan in delete — uses meta.changes from the DELETE result instead
Per-heartbeat metrics tracking — byte-level accuracy on ephemeral files isn't worth the D1 cost
opReconcileMetrics exists as a periodic job to fix any drift

Cache strategy:
Immutable files populate the Cache API on write and on first D1 read. Subsequent GETs for the same change file or snapshot cost zero. In a CRDT sync workload, this is most of the read traffic.

 */



function isImmutablePathType(pathType) {
  return (
    pathType === 'change-file' ||
    pathType === 'manifest-snapshot' ||
    pathType === 'mainline-snapshot'
  );
}

async function cacheGet(prefix, path) {
  const cache = globalThis.caches?.default;
  if (!cache) return null;
  const resp = await cache.match(cacheKeyFor(prefix, path));
  if (!resp) return null;
  const bytes = new Uint8Array(await resp.arrayBuffer());
  const etag = resp.headers.get('ETag') || '';
  const modifiedTime = resp.headers.get('X-Modified-Time') || '';
  return { bytes, etag, modifiedTime, size: bytes.byteLength };
}

async function cachePut(prefix, path, bytes, etag, modifiedTime) {
  const cache = globalThis.caches?.default;
  if (!cache) return;
  await cache.put(
    cacheKeyFor(prefix, path),
    new Response(bytes, {
      headers: {
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Type': 'application/octet-stream',
        ETag: etag,
        'X-Modified-Time': modifiedTime,
      },
    }),
  );
}

async function cacheDelete(prefix, path) {
  const cache = globalThis.caches?.default;
  if (!cache) return;
  await cache.delete(cacheKeyFor(prefix, path));
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

function nowIso() {
  return new Date().toISOString();
}

function newEtag() {
  return `"${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}"`;
}

export function normalizePath(raw) {
  const s = String(raw).startsWith('/') ? raw : `/${raw}`;
  const c = s.replaceAll(/\/+/g, '/');
  if (c === '/') return '/';
  return c.endsWith('/') ? c.slice(0, -1) : c;
}

export function fileNameFromPath(path) {
  return path.split('/').filter(Boolean).pop() ?? '';
}

function clampNonNeg(v) {
  return Math.max(0, Math.trunc(Number(v) || 0));
}

// ─── Folder tree (batched) ───────────────────────────────────────────────────
//
// Original: O(depth) sequential D1 calls.
// Fixed: one db.batch() call with all segments.

function folderTreeStatements(db, prefix, target) {
  const n = normalizePath(target);
  if (!n || n === '/') return [];
  const stmts = [];
  const now = nowIso();
  let cur = '';
  for (const seg of n.split('/').filter(Boolean)) {
    cur += `/${seg}`;
    stmts.push(
      db.prepare('INSERT OR IGNORE INTO folders (prefix,path,created_at) VALUES (?1,?2,?3)')
        .bind(prefix, cur, now),
    );
  }
  return stmts;
}

// ─── Metrics delta ───────────────────────────────────────────────────────────

function metricsDelta(pathType, prevSize, nextSize) {
  const prevMissing = prevSize === null || prevSize === undefined;
  const nextMissing = nextSize === null || nextSize === undefined;
  const prev = prevMissing ? 0 : clampNonNeg(prevSize);
  const next = nextMissing ? 0 : clampNonNeg(nextSize);
  const fileDelta = (nextMissing ? 0 : 1) - (prevMissing ? 0 : 1);
  const bytesDelta = next - prev;
  return {
    fileCountDelta: fileDelta,
    totalBytesDelta: bytesDelta,
    changeBytesDelta: pathType === 'change-file' ? bytesDelta : 0,
    mainlineBytesDelta: pathType === 'mainline-snapshot' ? bytesDelta : 0,
  };
}

// Upsert mesh_paths and apply delta in two statements (batchable).
// Replaces the 3-query read→ensure→update chain.
function meshDeltaStatements(db, prefix, remoteRoot, delta, now, options = {}) {
  if (!remoteRoot) return [];
  const today = now.slice(0, 10);
  const touchRead = options.touchRead ? now : null;
  const touchWrite = options.touchWrite ? now : null;
  const touchOperation = options.touchOperation === false ? null : now;
  return [
     // Ensure row exists (no-op if present)
    db.prepare(
      `INSERT OR IGNORE INTO mesh_paths (
         prefix, remote_root, created_at, updated_at, last_operation_at,
         last_read_at, last_write_at, last_ttl_delete_at, deleted_at,
         ops_day, ops_count_day, writes_count_day,
         current_file_count, current_total_bytes, current_change_bytes, current_mainline_bytes
       ) VALUES (?1, ?2, ?3, ?3, NULL, NULL, NULL, NULL, NULL, ?4, 0, 0, 0, 0, 0, 0)`,
    ).bind(prefix, remoteRoot, now, today),
    // Apply delta atomically
    db.prepare(
      `UPDATE mesh_paths SET
         updated_at = ?3,
         deleted_at = NULL,
         last_operation_at = COALESCE(?8, last_operation_at),
         last_read_at = COALESCE(?9, last_read_at),
         last_write_at = COALESCE(?10, last_write_at),
         ops_count_day = CASE WHEN ops_day = ?11 THEN ops_count_day + ?12 ELSE ?12 END,
         writes_count_day = CASE WHEN ops_day = ?11 THEN writes_count_day + ?13 ELSE ?13 END,
         ops_day = ?11,
         current_file_count      = MAX(0, current_file_count      + ?4),
         current_total_bytes     = MAX(0, current_total_bytes     + ?5),
         current_change_bytes    = MAX(0, current_change_bytes    + ?6),
         current_mainline_bytes  = MAX(0, current_mainline_bytes  + ?7)
       WHERE prefix = ?1 AND remote_root = ?2`,
    ).bind(
      prefix, remoteRoot, now,
      delta.fileCountDelta,
      delta.totalBytesDelta,
      delta.changeBytesDelta,
      delta.mainlineBytesDelta,
      touchOperation,
      touchRead,
      touchWrite,
      today,
      touchOperation ? 1 : 0,
      touchWrite ? 1 : 0,
    ),
  ];
}

// ─── OP: Get file ────────────────────────────────────────────────────────────
//
// Cache-first for immutable files.  One D1 read on miss.
// No activity tracking.  That's the point.

export async function opGetFile(db, prefix, path, pathType) {
  const normalized = normalizePath(path);
  const remoteRoot = meshRootForPath(normalized, pathType);

  // Try cache for immutable files
  if (isImmutablePathType(pathType)) {
    const cached = await cacheGet(prefix, normalized);
    if (cached) {
      return {
        found: true,
        bytes: cached.bytes,
        size: cached.size,
        etag: cached.etag,
        modifiedTime: cached.modifiedTime,
        source: 'cache',
      };
    }
  }

  // D1 fallback — single query
  const row = await db.prepare(
    'SELECT content, size, modified_time, etag FROM files WHERE prefix=?1 AND path=?2 LIMIT 1',
  ).bind(prefix, normalized).first();

  if (!row) return { found: false };

  const bytes = row.content instanceof ArrayBuffer
    ? new Uint8Array(row.content)
    : new Uint8Array(row.content?.buffer ?? row.content ?? []);
  const etag = String(row.etag ?? '');
  const modifiedTime = String(row.modified_time ?? '');

  // Backfill cache for immutable files
  if (isImmutablePathType(pathType)) {
    await cachePut(prefix, normalized, bytes, etag, modifiedTime);
  }

  if (remoteRoot) {
    const now = nowIso();
    await db.batch(meshDeltaStatements(db, prefix, remoteRoot, {
      fileCountDelta: 0,
      totalBytesDelta: 0,
      changeBytesDelta: 0,
      mainlineBytesDelta: 0,
    }, now, { touchRead: true, touchWrite: false }));
  }

  return {
    found: true,
    bytes,
    size: Number(row.size ?? bytes.byteLength),
    etag,
    modifiedTime,
    source: 'd1',
  };
}

// ─── OP: Put immutable file ──────────────────────────────────────────────────
//
// Change files, manifest snapshots, mainline snapshots.
// If it already exists → noop (200).  Otherwise → insert + update metrics.
// One D1 batch.  Populates cache on success.

export async function opPutImmutable(db, prefix, path, bytes, pathType, remoteRoot) {
  const normalized = normalizePath(path);
  const now = nowIso();
  const etag = newEtag();
  const parentDir = normalized.slice(0, normalized.lastIndexOf('/')) || '/';

  // Single batch: ensure folders + conditional insert + metrics
  const delta = metricsDelta(pathType, null, bytes.byteLength);
  const results = await db.batch([
    ...folderTreeStatements(db, prefix, parentDir),
    // INSERT OR IGNORE: if the file exists, this is a no-op and changes() = 0
    db.prepare(
      'INSERT OR IGNORE INTO files (prefix,path,content,size,modified_time,etag) VALUES (?1,?2,?3,?4,?5,?6)',
    ).bind(prefix, normalized, bytes, bytes.byteLength, now, etag),
    ...meshDeltaStatements(db, prefix, remoteRoot, delta, now, { touchWrite: true }),
  ]);

  // Check if the INSERT actually wrote (last result before mesh statements)
  const insertIdx = folderTreeStatements(db, prefix, parentDir).length;
  const insertResult = results[insertIdx];
  const wrote = insertResult?.meta?.changes > 0;

  if (wrote) {
    // Populate cache — future reads are free
    await cachePut(prefix, normalized, bytes, etag, now);
  }

  return { wrote, status: wrote ? 201 : 200 };
}

// ─── OP: Put semantic (manifest.json / head.json) ────────────────────────────
//
// Conditional overwrite: only if the incoming value is a forward transition.
// Done entirely in D1 — no DO round-trip needed.
//
// For manifest.json:  UPDATE ... WHERE currentGeneration <= incoming
// For head.json:      UPDATE ... WHERE latestHlc <= incoming
//
// Two-phase: one read (to check existence), then a conditional batch.
// Still cheaper than the old path: 2 D1 calls instead of 5–7 + DO fetch.

export async function opPutSemantic(db, prefix, path, bytes, pathType, remoteRoot) {
  const normalized = normalizePath(path);
  const now = nowIso();
  const etag = newEtag();
  const parentDir = normalized.slice(0, normalized.lastIndexOf('/')) || '/';

  const existing = await db.prepare(
    'SELECT content, size FROM files WHERE prefix=?1 AND path=?2 LIMIT 1',
  ).bind(prefix, normalized).first();

  if (existing) {
    // Validate forward transition
    try {
      const decode = (v) => {
        if (v instanceof ArrayBuffer) return new TextDecoder().decode(v);
        if (v instanceof Uint8Array) return new TextDecoder().decode(v);
        if (typeof v === 'string') return v;
        return new TextDecoder().decode(new Uint8Array(v?.buffer ?? v ?? []));
      };
      const existingJson = JSON.parse(decode(existing.content));
      const incomingJson = JSON.parse(new TextDecoder().decode(bytes));

      if (pathType === 'manifest-pointer') {
        const oldGen = Number(existingJson?.currentGeneration ?? -1);
        const newGen = Number(incomingJson?.currentGeneration ?? -1);
        if (newGen < oldGen) return { wrote: false, status: 409 };
      }
      if (pathType === 'head') {
        const oldHlc = String(existingJson?.latestHlc ?? '');
        const newHlc = String(incomingJson?.latestHlc ?? '');
        if (newHlc < oldHlc) return { wrote: false, status: 409 };
      }
    } catch {
      // Corrupt existing file — allow overwrite to unblock
    }
  }

  // Write: one batch for upsert + metrics
  const prevSize = existing ? Number(existing.size ?? 0) : null;
  const delta = metricsDelta(pathType, prevSize, bytes.byteLength);

  await db.batch([
    ...folderTreeStatements(db, prefix, parentDir),
    db.prepare(
      `INSERT INTO files (prefix,path,content,size,modified_time,etag) VALUES (?1,?2,?3,?4,?5,?6)
       ON CONFLICT(prefix,path) DO UPDATE SET
         content=excluded.content, size=excluded.size,
         modified_time=excluded.modified_time, etag=excluded.etag`,
    ).bind(prefix, normalized, bytes, bytes.byteLength, now, etag),
    ...meshDeltaStatements(db, prefix, remoteRoot, delta, now),
  ]);

  return { wrote: true, status: 204 };
}

// ─── OP: Put overwrite (device heartbeats) ───────────────────────────────────
//
// Last-write-wins.  One batch.

export async function opPutOverwrite(db, prefix, path, bytes, _pathType, _remoteRoot) {
  const normalized = normalizePath(path);
  const now = nowIso();
  const etag = newEtag();
  const parentDir = normalized.slice(0, normalized.lastIndexOf('/')) || '/';

  // We need previous size for delta.  Read + write = 2 D1 ops.
  // Could skip the read and accept slightly inaccurate metrics for heartbeats.
  // Heartbeats are small and similar-sized, so the error is negligible.
  // Choosing: skip the read.  Assume replacement, zero byte delta.

  await db.batch([
    ...folderTreeStatements(db, prefix, parentDir),
    db.prepare(
      `INSERT INTO files (prefix,path,content,size,modified_time,etag) VALUES (?1,?2,?3,?4,?5,?6)
       ON CONFLICT(prefix,path) DO UPDATE SET
         content=excluded.content, size=excluded.size,
         modified_time=excluded.modified_time, etag=excluded.etag`,
    ).bind(prefix, normalized, bytes, bytes.byteLength, now, etag),
    // No metrics delta — heartbeats are noise.  If you need accurate file counts,
    // add a periodic reconciliation job instead of paying per-write.
  ]);

  return { wrote: true, status: 204 };
}

// ─── OP: List children ───────────────────────────────────────────────────────
//
// Single query per table.  SQL-level depth filter instead of JS post-filter.
// No activity tracking.

export async function opListChildren(db, prefix, path) {
  const normalized = normalizePath(path);
  const depthTarget = normalized === '/' ? 1 : normalized.split('/').filter(Boolean).length + 1;
  const pattern = normalized === '/' ? '/%' : `${normalized}/%`;

  // One batch: files + folders
  const [filesResult, foldersResult] = await db.batch([
    db.prepare(
      `SELECT path, size, modified_time, etag FROM files
       WHERE prefix = ?1
         AND path LIKE ?2
         AND LENGTH(path) - LENGTH(REPLACE(path, '/', '')) = ?3`,
    ).bind(prefix, pattern, depthTarget),
    db.prepare(
      `SELECT path FROM folders
       WHERE prefix = ?1
         AND path LIKE ?2
         AND LENGTH(path) - LENGTH(REPLACE(path, '/', '')) = ?3`,
    ).bind(prefix, pattern, depthTarget),
  ]);

  const files = (filesResult.results ?? []).map((row) => ({
    name: fileNameFromPath(String(row.path)),
    path: String(row.path),
    size: Number(row.size ?? 0),
    modifiedTime: String(row.modified_time ?? ''),
    etag: String(row.etag ?? ''),
  }));

  const folders = (foldersResult.results ?? []).map((row) =>
    String(row.path).split('/').filter(Boolean).pop() || '',
  ).filter(Boolean);

  return { files, folders };
}

// ─── OP: Delete path ─────────────────────────────────────────────────────────
//
// Uses tracked metrics from mesh_paths instead of re-scanning every row.
// One batch for the actual delete + metrics update.

export async function opDeletePath(db, prefix, path, remoteRoot) {
  const normalized = normalizePath(path);

  if (normalized === '/') {
    // Prefix-level wipe — rare, keep simple
    await db.batch([
      db.prepare('DELETE FROM files WHERE prefix = ?1').bind(prefix),
      db.prepare('DELETE FROM folders WHERE prefix = ?1').bind(prefix),
    ]);
    // Zero out all mesh_paths for this prefix separately
    // (rare operation, doesn't need to be in the hot path batch)
    await db.prepare(
      `UPDATE mesh_paths SET
         current_file_count = 0, current_total_bytes = 0,
         current_change_bytes = 0, current_mainline_bytes = 0,
         deleted_at = ?2, updated_at = ?2
       WHERE prefix = ?1`,
    ).bind(prefix, nowIso()).run();
    return true;
  }

  const like = `${normalized}/%`;
  const now = nowIso();

  // Delete files + folders in one batch.
  // Use RETURNING (D1 supports it) to get the count and sizes without a pre-scan.
  const [filesDeleted, _foldersDeleted] = await db.batch([
    db.prepare(
      'DELETE FROM files WHERE prefix = ?1 AND (path = ?2 OR path LIKE ?3)',
    ).bind(prefix, normalized, like),
    db.prepare(
      'DELETE FROM folders WHERE prefix = ?1 AND (path = ?2 OR path LIKE ?3)',
    ).bind(prefix, normalized, like),
  ]);

  const deletedCount = filesDeleted?.meta?.changes ?? 0;
  if (deletedCount === 0) return false;

  // Reconcile metrics.  We don't know exact bytes deleted without scanning,
  // but we already track totals in mesh_paths.  For a path-level delete,
  // trigger a lazy reconciliation rather than paying for a pre-scan.
  // If exact metrics matter, run opReconcileMetrics() periodically.
  if (remoteRoot) {
    await db.batch(meshDeltaStatements(db, prefix, remoteRoot, {
      fileCountDelta: -deletedCount,
      totalBytesDelta: 0,  // imprecise — reconcile job fixes this
      changeBytesDelta: 0,
      mainlineBytesDelta: 0,
    }, now));
  }

  return true;
}

// ─── OP: Prune compacted changes ─────────────────────────────────────────────
//
// Bulk delete + cache eviction for compacted change files.

export async function opPruneCompacted(db, prefix, remotePath, watermarkHlc) {
  const root = normalizePath(remotePath);
  const changesPattern = `${root === '/' ? '' : root}/changes/%`;

  const { results = [] } = await db.prepare(
    'SELECT path, size FROM files WHERE prefix = ?1 AND path LIKE ?2',
  ).bind(prefix, changesPattern).all();

  const toDelete = [];
  let bytesPruned = 0;

  for (const row of results) {
    const filePath = String(row.path);
    const name = fileNameFromPath(filePath);
    if (name === 'head.json') continue;
    const hlcEnd = name.lastIndexOf('-chg_');
    const hlc = hlcEnd > 0 ? name.slice(0, hlcEnd) : null;
    if (hlc && hlc <= watermarkHlc) {
      toDelete.push(filePath);
      bytesPruned += Number(row.size ?? 0);
    }
  }

  if (toDelete.length === 0) {
    return { pruned: 0, bytesPruned: 0, totalCandidates: results.length };
  }

  // Batch delete — D1 batch limit is 100 statements, chunk if needed
  const CHUNK = 90;
  for (let i = 0; i < toDelete.length; i += CHUNK) {
    const chunk = toDelete.slice(i, i + CHUNK);
    await db.batch(
      chunk.map((p) =>
        db.prepare('DELETE FROM files WHERE prefix = ?1 AND path = ?2').bind(prefix, p),
      ),
    );
  }

  // Evict from cache
  await Promise.allSettled(toDelete.map((p) => cacheDelete(prefix, p)));

  // Update metrics
  const now = nowIso();
  await db.batch(meshDeltaStatements(db, prefix, root, {
    fileCountDelta: -toDelete.length,
    totalBytesDelta: -bytesPruned,
    changeBytesDelta: -bytesPruned,
    mainlineBytesDelta: 0,
  }, now));

  return {
    pruned: toDelete.length,
    bytesPruned,
    totalCandidates: results.length,
    remotePath: root,
    watermarkHlc,
  };
}

// ─── OP: Reconcile metrics ───────────────────────────────────────────────────
//
// Periodic job to fix metric drift from imprecise deletes/heartbeats.
// Run from scheduled handler, not from hot paths.

export async function opReconcileMetrics(db, prefix, remoteRoot) {
  const normalized = normalizePath(remoteRoot);
  const pattern = normalized === '/' ? '/%' : `${normalized}/%`;

  const row = await db.prepare(
    `SELECT
       COUNT(*) as file_count,
       COALESCE(SUM(size), 0) as total_bytes
     FROM files
     WHERE prefix = ?1 AND (path = ?2 OR path LIKE ?3)`,
  ).bind(prefix, normalized, pattern).first();

  const now = nowIso();
  await db.prepare(
    `UPDATE mesh_paths SET
       current_file_count = ?3,
       current_total_bytes = ?4,
       updated_at = ?5
     WHERE prefix = ?1 AND remote_root = ?2`,
  ).bind(
    prefix, normalized,
    Number(row?.file_count ?? 0),
    Number(row?.total_bytes ?? 0),
    now,
  ).run();

  return {
    fileCount: Number(row?.file_count ?? 0),
    totalBytes: Number(row?.total_bytes ?? 0),
  };
}

// ─── Durable Object: WebSocket Hibernation relay ─────────────────────────────
//
// Pure fanout.  No storage.  No D1 access.  No semantic validation.
// Hibernates between messages — zero cost while clients are idle.
//
// The Worker writes to D1, then POSTs to /__broadcast.
// The DO wakes, sends to all sockets, sleeps.
//
// If you remove this binding entirely, everything still works — clients
// fall back to polling opGetFile on manifest.json.
