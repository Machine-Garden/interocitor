import { classifyPath, meshRootForPath, cacheKeyFor, listingCacheKeyFor } from './paths.ts';
import type { PathType } from './paths.ts';
import type { D1Database, D1PreparedStatement, QueryRow } from './types.ts';

// ─── ops.ts ──────────────────────────────────────────────────────────────────
//
// Goals:
//   1. Batch D1 statements — one round-trip per operation, not 5–7
//   2. Cache API for immutable files — free reads, zero D1 cost on hits
//   3. Drop per-request activity tracking on reads (kills 2–3 D1 calls per GET)
//   4. Conditional SQL for semantic writes — no DO round-trip needed
//   5. WebSocket Hibernation DO — pure fanout, zero idle cost

// ─── Internal row types ──────────────────────────────────────────────────────

interface FileRow extends QueryRow {
  content: ArrayBuffer | Uint8Array | string | null;
  size: number | null;
  modified_time: string | null;
  etag: string | null;
}

interface FileListRow extends QueryRow {
  path: string;
  size: number | null;
  modified_time: string | null;
  etag: string | null;
}

interface FolderListRow extends QueryRow {
  path: string;
}

interface FileSizeRow extends QueryRow {
  path: string;
  size: number | null;
}

interface MetricsRow extends QueryRow {
  file_count: number | null;
  total_bytes: number | null;
}

// ─── Cache helpers ───────────────────────────────────────────────────────────

interface CacheEntry {
  bytes: Uint8Array;
  etag: string;
  modifiedTime: string;
  size: number;
}

interface CacheNamespace {
  match(input: RequestInfo | URL): Promise<Response | undefined>;
  put(input: RequestInfo | URL, response: Response): Promise<void>;
  delete(input: RequestInfo | URL): Promise<boolean>;
}

interface GlobalCaches {
  default: CacheNamespace;
}

declare const caches: GlobalCaches | undefined;

function getDefaultCache(): CacheNamespace | undefined {
  // biome-ignore lint/suspicious/noExplicitAny: Cloudflare Workers cache API not in DOM lib
  // oxlint-disable-next-line unicorn/no-typeof-undefined -- `caches` may be undeclared outside the Workers runtime.
  const gc = (typeof caches === 'undefined' ? (globalThis as any).caches : caches) as GlobalCaches | undefined;
  return gc?.default;
}

function decodeJsonBuffer(value: ArrayBuffer | Uint8Array | string | null | undefined): string {
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (typeof value === 'string') return value;
  // biome-ignore lint/suspicious/noExplicitAny: runtime-typed D1 binary blob
  const v = value as any;
  return new TextDecoder().decode(new Uint8Array(v?.buffer ?? v ?? []));
}

function isCacheableImmutablePathType(pathType: PathType): boolean {
  // Change files are immutable but deletable after exact snapshot coverage.
  // Cache API entries are per-colo, so they cannot be globally invalidated;
  // always read changes from D1 to make compaction deletion authoritative.
  return pathType === 'manifest-snapshot' || pathType === 'mainline-snapshot';
}

async function cacheGet(prefix: string, path: string): Promise<CacheEntry | null> {
  const cache = getDefaultCache();
  if (!cache) return null;
  const resp = await cache.match(cacheKeyFor(prefix, path));
  if (!resp) return null;
  const bytes = new Uint8Array(await resp.arrayBuffer());
  const etag = resp.headers.get('ETag') ?? '';
  const modifiedTime = resp.headers.get('X-Modified-Time') ?? '';
  return { bytes, etag, modifiedTime, size: bytes.byteLength };
}

async function cachePut(prefix: string, path: string, bytes: Uint8Array, etag: string, modifiedTime: string): Promise<void> {
  const cache = getDefaultCache();
  if (!cache) return;
  await cache.put(
    cacheKeyFor(prefix, path),
    new Response(bytes as unknown as BodyInit, {
      headers: {
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Type': 'application/octet-stream',
        ETag: etag,
        'X-Modified-Time': modifiedTime,
      },
    }),
  );
}

async function cacheDelete(prefix: string, path: string): Promise<void> {
  const cache = getDefaultCache();
  if (!cache) return;
  await cache.delete(cacheKeyFor(prefix, path));
}

// ─── Listing cache helpers ───────────────────────────────────────────────────
//
// `caches.default` lookup keyed by (prefix, folderPath). Used to short-circuit
// `opListChildren` so repeated polls cost nothing in CPU or D1 — only request
// quota. Mutations (put/delete) explicitly invalidate the parent folder
// listing via `listingCacheDelete`.

// Short TTL: `caches.default` is per-colo and we cannot invalidate across
// colos. Keep this low (≈1 min) so cross-colo drift is bounded — the cache
// still absorbs poll bursts within a single colo (DDoS protection) without
// stale reads becoming a problem.
const LISTING_CACHE_TTL_SECONDS = 60;

async function listingCacheGet(prefix: string, path: string): Promise<ListChildrenResult | null> {
  const cache = getDefaultCache();
  if (!cache) return null;
  const resp = await cache.match(listingCacheKeyFor(prefix, path));
  if (!resp) return null;
  try {
    return (await resp.json()) as ListChildrenResult;
  } catch {
    return null;
  }
}

async function listingCachePut(prefix: string, path: string, listing: ListChildrenResult): Promise<void> {
  const cache = getDefaultCache();
  if (!cache) return;
  await cache.put(
    listingCacheKeyFor(prefix, path),
    new Response(JSON.stringify(listing), {
      headers: {
        'Cache-Control': `public, max-age=${LISTING_CACHE_TTL_SECONDS}`,
        'Content-Type': 'application/json',
      },
    }),
  );
}

async function listingCacheDelete(prefix: string, path: string): Promise<void> {
  const cache = getDefaultCache();
  if (!cache) return;
  await cache.delete(listingCacheKeyFor(prefix, path));
}

function parentDirOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '/' : path.slice(0, idx);
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function newEtag(): string {
  return `"${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}"`;
}

export function normalizePath(raw: string): string {
  const s = String(raw).startsWith('/') ? raw : `/${raw}`;
  const c = s.replaceAll(/\/+/g, '/');
  if (c === '/') return '/';
  return c.endsWith('/') ? c.slice(0, -1) : c;
}

export function fileNameFromPath(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? '';
}

function clampNonNeg(v: unknown): number {
  return Math.max(0, Math.trunc(Number(v) || 0));
}

// ─── Folder tree (batched) ───────────────────────────────────────────────────

function folderTreeStatements(db: D1Database, prefix: string, target: string): D1PreparedStatement[] {
  const n = normalizePath(target);
  if (!n || n === '/') return [];
  const stmts: D1PreparedStatement[] = [];
  const now = nowIso();
  let cur = '';
  for (const seg of n.split('/').filter(Boolean)) {
    cur += `/${seg}`;
    stmts.push(db.prepare('INSERT OR IGNORE INTO folders (prefix,path,created_at) VALUES (?1,?2,?3)').bind(prefix, cur, now));
  }
  return stmts;
}

// ─── Metrics delta ───────────────────────────────────────────────────────────

interface MetricsDelta {
  fileCountDelta: number;
  totalBytesDelta: number;
  changeBytesDelta: number;
  mainlineBytesDelta: number;
}

function metricsDelta(pathType: PathType, prevSize: number | null | undefined, nextSize: number | null | undefined): MetricsDelta {
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

interface MeshDeltaOptions {
  touchRead?: boolean;
  touchWrite?: boolean;
  touchOperation?: boolean;
}

function meshDeltaStatements(
  db: D1Database,
  prefix: string,
  remoteRoot: string | null,
  delta: MetricsDelta,
  now: string,
  options: MeshDeltaOptions = {},
): D1PreparedStatement[] {
  if (!remoteRoot) return [];
  const today = now.slice(0, 10);
  const touchRead = options.touchRead ? now : null;
  const touchWrite = options.touchWrite ? now : null;
  const touchOperation = options.touchOperation === false ? null : now;
  return [
    db
      .prepare(
        `INSERT OR IGNORE INTO mesh_paths (
         prefix, remote_root, created_at, updated_at, last_operation_at,
         last_read_at, last_write_at, last_ttl_delete_at, deleted_at,
         ops_day, ops_count_day, writes_count_day,
         current_file_count, current_total_bytes, current_change_bytes, current_mainline_bytes
       ) VALUES (?1, ?2, ?3, ?3, NULL, NULL, NULL, NULL, NULL, ?4, 0, 0, 0, 0, 0, 0)`,
      )
      .bind(prefix, remoteRoot, now, today),
    db
      .prepare(
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
      )
      .bind(
        prefix,
        remoteRoot,
        now,
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

export interface GetFileResult {
  found: boolean;
  bytes?: Uint8Array;
  size?: number;
  etag?: string;
  modifiedTime?: string;
  source?: 'cache' | 'd1';
}

export async function opGetFile(db: D1Database, prefix: string, path: string, pathType: PathType): Promise<GetFileResult> {
  const normalized = normalizePath(path);
  const remoteRoot = meshRootForPath(normalized, pathType);

  if (isCacheableImmutablePathType(pathType)) {
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

  const row = await db
    .prepare('SELECT content, size, modified_time, etag FROM files WHERE prefix=?1 AND path=?2 LIMIT 1')
    .bind(prefix, normalized)
    .first<FileRow>();

  if (!row) return { found: false };

  const raw = row.content;
  const bytes =
    raw instanceof ArrayBuffer
      ? new Uint8Array(raw)
      : raw instanceof Uint8Array
        ? raw
        : // biome-ignore lint/suspicious/noExplicitAny: runtime-typed D1 binary blob
          new Uint8Array((raw as any)?.buffer ?? raw ?? []);
  const etag = String(row.etag ?? '');
  const modifiedTime = String(row.modified_time ?? '');

  if (isCacheableImmutablePathType(pathType)) {
    await cachePut(prefix, normalized, bytes, etag, modifiedTime);
  }

  if (remoteRoot) {
    const now = nowIso();
    await db.batch(
      meshDeltaStatements(
        db,
        prefix,
        remoteRoot,
        {
          fileCountDelta: 0,
          totalBytesDelta: 0,
          changeBytesDelta: 0,
          mainlineBytesDelta: 0,
        },
        now,
        { touchRead: true, touchWrite: false },
      ),
    );
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

export interface PutResult {
  wrote: boolean;
  status: number;
}

export async function opPutImmutable(
  db: D1Database,
  prefix: string,
  path: string,
  bytes: Uint8Array,
  pathType: PathType,
  remoteRoot: string | null,
): Promise<PutResult> {
  const normalized = normalizePath(path);
  const now = nowIso();
  const etag = newEtag();
  const parentDir = normalized.slice(0, normalized.lastIndexOf('/')) || '/';

  const delta = metricsDelta(pathType, null, bytes.byteLength);
  const results = await db.batch([
    ...folderTreeStatements(db, prefix, parentDir),
    db
      .prepare('INSERT OR IGNORE INTO files (prefix,path,content,size,modified_time,etag) VALUES (?1,?2,?3,?4,?5,?6)')
      .bind(prefix, normalized, bytes, bytes.byteLength, now, etag),
    ...meshDeltaStatements(db, prefix, remoteRoot, delta, now, { touchWrite: true }),
  ]);

  const insertIdx = folderTreeStatements(db, prefix, parentDir).length;
  const insertResult = results[insertIdx];
  const wrote = (insertResult?.meta?.changes ?? 0) > 0;

  if (wrote) {
    if (isCacheableImmutablePathType(pathType)) {
      await cachePut(prefix, normalized, bytes, etag, now);
    }
    // Invalidate parent folder listing — new file appeared.
    await listingCacheDelete(prefix, parentDir);
  }

  return { wrote, status: wrote ? 201 : 200 };
}

// ─── OP: Put semantic (manifest.json / head.json) ────────────────────────────

export async function opPutSemantic(
  db: D1Database,
  prefix: string,
  path: string,
  bytes: Uint8Array,
  pathType: PathType,
  remoteRoot: string | null,
): Promise<PutResult> {
  const normalized = normalizePath(path);
  const now = nowIso();
  const etag = newEtag();
  const parentDir = normalized.slice(0, normalized.lastIndexOf('/')) || '/';

  const existing = await db
    .prepare('SELECT content, size FROM files WHERE prefix=?1 AND path=?2 LIMIT 1')
    .bind(prefix, normalized)
    .first<FileRow>();

  if (existing) {
    try {
      const existingJson = JSON.parse(decodeJsonBuffer(existing.content));
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

  const prevSize = existing ? Number(existing.size ?? 0) : null;
  const delta = metricsDelta(pathType, prevSize, bytes.byteLength);

  await db.batch([
    ...folderTreeStatements(db, prefix, parentDir),
    db
      .prepare(
        `INSERT INTO files (prefix,path,content,size,modified_time,etag) VALUES (?1,?2,?3,?4,?5,?6)
       ON CONFLICT(prefix,path) DO UPDATE SET
         content=excluded.content, size=excluded.size,
         modified_time=excluded.modified_time, etag=excluded.etag`,
      )
      .bind(prefix, normalized, bytes, bytes.byteLength, now, etag),
    ...meshDeltaStatements(db, prefix, remoteRoot, delta, now),
  ]);

  // Listing changes whenever etag/mtime change, even on update-not-create.
  await listingCacheDelete(prefix, parentDir);

  return { wrote: true, status: 204 };
}

// ─── OP: Put overwrite (device heartbeats) ───────────────────────────────────

export async function opPutOverwrite(
  db: D1Database,
  prefix: string,
  path: string,
  bytes: Uint8Array,
  _pathType: PathType,
  _remoteRoot: string | null,
): Promise<PutResult> {
  const normalized = normalizePath(path);
  const now = nowIso();
  const etag = newEtag();
  const parentDir = normalized.slice(0, normalized.lastIndexOf('/')) || '/';

  await db.batch([
    ...folderTreeStatements(db, prefix, parentDir),
    db
      .prepare(
        `INSERT INTO files (prefix,path,content,size,modified_time,etag) VALUES (?1,?2,?3,?4,?5,?6)
       ON CONFLICT(prefix,path) DO UPDATE SET
         content=excluded.content, size=excluded.size,
         modified_time=excluded.modified_time, etag=excluded.etag`,
      )
      .bind(prefix, normalized, bytes, bytes.byteLength, now, etag),
  ]);

  await listingCacheDelete(prefix, parentDir);

  return { wrote: true, status: 204 };
}

// ─── OP: List children ───────────────────────────────────────────────────────

export interface FileEntry {
  name: string;
  path: string;
  size: number;
  modifiedTime: string;
  etag: string;
}

export interface ListChildrenResult {
  files: FileEntry[];
  folders: string[];
}

export async function opListChildren(db: D1Database, prefix: string, path: string): Promise<ListChildrenResult> {
  const normalized = normalizePath(path);

  // Cache hit: skip D1 entirely. Cache is invalidated by every op that
  // mutates files/folders under this folder (see listingCacheDelete callers).
  const cached = await listingCacheGet(prefix, normalized);
  if (cached) return cached;

  const pattern = normalized === '/' ? '/%' : `${normalized}/%`;
  const slashCount = normalized === '/' ? 1 : normalized.split('/').filter(Boolean).length + 1;
  const depthTarget = slashCount;

  const [filesResult, foldersResult] = await db.batch([
    db
      .prepare(
        `SELECT path, size, modified_time, etag FROM files
       WHERE prefix = ?1
         AND path LIKE ?2
         AND LENGTH(path) - LENGTH(REPLACE(path, '/', '')) = ?3`,
      )
      .bind(prefix, pattern, depthTarget),
    db
      .prepare(
        `SELECT path FROM folders
       WHERE prefix = ?1
         AND path LIKE ?2
         AND LENGTH(path) - LENGTH(REPLACE(path, '/', '')) = ?3`,
      )
      .bind(prefix, pattern, depthTarget),
  ]);

  const files: FileEntry[] = (filesResult.results ?? []).map((row) => {
    const r = row as FileListRow;
    return {
      name: fileNameFromPath(String(r.path)),
      path: String(r.path),
      size: Number(r.size ?? 0),
      modifiedTime: String(r.modified_time ?? ''),
      etag: String(r.etag ?? ''),
    };
  });

  const folders: string[] = (foldersResult.results ?? [])
    .map((row) => {
      const r = row as FolderListRow;
      return String(r.path).split('/').filter(Boolean).pop() ?? '';
    })
    .filter(Boolean);

  const result: ListChildrenResult = { files, folders };
  await listingCachePut(prefix, normalized, result);
  return result;
}

// ─── OP: Delete path ─────────────────────────────────────────────────────────

export async function opDeletePath(db: D1Database, prefix: string, path: string, remoteRoot: string | null): Promise<boolean> {
  const normalized = normalizePath(path);

  const selected =
    normalized === '/'
      ? await db.prepare('SELECT path, size FROM files WHERE prefix = ?1').bind(prefix).all<FileSizeRow>()
      : await db
          .prepare('SELECT path, size FROM files WHERE prefix = ?1 AND (path = ?2 OR (path >= ?3 AND path < ?4))')
          .bind(prefix, normalized, `${normalized}/`, `${normalized}/\uFFFF`)
          .all<FileSizeRow>();
  const deletedFiles = selected.results ?? [];

  if (normalized === '/') {
    await db.batch([
      db.prepare('DELETE FROM files WHERE prefix = ?1').bind(prefix),
      db.prepare('DELETE FROM folders WHERE prefix = ?1').bind(prefix),
    ]);
    await Promise.allSettled(deletedFiles.map((file) => cacheDelete(prefix, String(file.path))));
    await db
      .prepare(
        `UPDATE mesh_paths SET
         current_file_count = 0, current_total_bytes = 0,
         current_change_bytes = 0, current_mainline_bytes = 0,
         deleted_at = ?2, updated_at = ?2
       WHERE prefix = ?1`,
      )
      .bind(prefix, nowIso())
      .run();
    // Whole-prefix wipe: drop the root listing. Per-folder cache entries are
    // best-effort stale; the TTL bounds their lifetime.
    await listingCacheDelete(prefix, '/');
    return true;
  }

  const subtreeStart = `${normalized}/`;
  const subtreeEnd = `${normalized}/\uFFFF`;
  const now = nowIso();

  // Avoid LIKE/GLOB on long/special paths in D1/SQLite; do a lexical prefix range instead.
  const [filesDeleted] = await db.batch([
    db
      .prepare('DELETE FROM files WHERE prefix = ?1 AND (path = ?2 OR (path >= ?3 AND path < ?4))')
      .bind(prefix, normalized, subtreeStart, subtreeEnd),
    db
      .prepare('DELETE FROM folders WHERE prefix = ?1 AND (path = ?2 OR (path >= ?3 AND path < ?4))')
      .bind(prefix, normalized, subtreeStart, subtreeEnd),
  ]);

  const deletedCount = filesDeleted?.meta?.changes ?? 0;
  if (deletedCount === 0) return false;

  if (remoteRoot) {
    const totals = deletedFiles.reduce(
      (result, file) => {
        const size = Number(file.size ?? 0);
        const pathType = classifyPath(String(file.path));
        result.totalBytes += size;
        if (pathType === 'change-file') result.changeBytes += size;
        if (pathType === 'mainline-snapshot') result.mainlineBytes += size;
        return result;
      },
      { totalBytes: 0, changeBytes: 0, mainlineBytes: 0 },
    );
    await db.batch(
      meshDeltaStatements(
        db,
        prefix,
        remoteRoot,
        {
          fileCountDelta: -deletedCount,
          totalBytesDelta: -totals.totalBytes,
          changeBytesDelta: -totals.changeBytes,
          mainlineBytesDelta: -totals.mainlineBytes,
        },
        now,
      ),
    );
  }

  await Promise.allSettled(deletedFiles.map((file) => cacheDelete(prefix, String(file.path))));

  // Invalidate the parent folder listing of the deleted path. Subtree listings
  // (if any were cached) age out via TTL. Change-file reads always consult D1,
  // so compaction deletion is authoritative across colos.
  await listingCacheDelete(prefix, parentDirOf(normalized));

  return true;
}

// ─── OP: Reconcile metrics ───────────────────────────────────────────────────

export interface ReconcileResult {
  fileCount: number;
  totalBytes: number;
}

export async function opReconcileMetrics(db: D1Database, prefix: string, remoteRoot: string): Promise<ReconcileResult> {
  const normalized = normalizePath(remoteRoot);
  const pattern = normalized === '/' ? '/%' : `${normalized}/%`;

  const row = await db
    .prepare(
      `SELECT
       COUNT(*) as file_count,
       COALESCE(SUM(size), 0) as total_bytes
     FROM files
     WHERE prefix = ?1 AND (path = ?2 OR path LIKE ?3)`,
    )
    .bind(prefix, normalized, pattern)
    .first<MetricsRow>();

  const now = nowIso();
  await db
    .prepare(
      `UPDATE mesh_paths SET
       current_file_count = ?3,
       current_total_bytes = ?4,
       updated_at = ?5
     WHERE prefix = ?1 AND remote_root = ?2`,
    )
    .bind(prefix, normalized, Number(row?.file_count ?? 0), Number(row?.total_bytes ?? 0), now)
    .run();

  return {
    fileCount: Number(row?.file_count ?? 0),
    totalBytes: Number(row?.total_bytes ?? 0),
  };
}
