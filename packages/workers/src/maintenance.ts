// compass: interocitor.mailbox-host.maintenance

import type { DatabaseAdapter, QueryRow } from "./types.ts";

// ─── Internal row types ──────────────────────────────────────────────────────

interface MaintenanceStatusRow extends QueryRow {
  prefix: string;
  remote_root: string;
  last_operation_at?: string | null;
  last_read_at?: string | null;
  last_write_at?: string | null;
  deleted_at?: string | null;
  current_file_count?: number;
  current_total_bytes?: number;
  current_change_bytes?: number;
  current_mainline_bytes?: number;
}

interface MaintenanceSweepRow extends QueryRow {
  prefix?: string;
  remote_root: string;
  created_at?: string | null;
  last_write_at?: string | null;
  deleted_at?: string | null;
}

interface EvictionRow extends QueryRow {
  created_at?: string | null;
  last_write_at?: string | null;
  last_ttl_delete_at?: string | null;
  deleted_at?: string | null;
}

/**
 * The instant from which a mesh has been idle.
 *
 * Idleness is measured in writes, not operations. A mesh that is read every
 * day but never written is idle, because no device has produced a record that
 * the host is the only holder of. A mesh that has never been written is idle
 * from the moment its path was created.
 */
function idleSince(row: {
  created_at?: string | null;
  last_write_at?: string | null;
}): string | null {
  return row.last_write_at ?? row.created_at ?? null;
}

// ─── getMaintenanceStatus ────────────────────────────────────────────────────

/** Per-path status row returned by {@link getMaintenanceStatus}. */
export interface MaintenancePathStatus {
  prefix: string;
  remote_root: string;
  last_operation_at?: string | null;
  last_read_at?: string | null;
  last_write_at?: string | null;
  deleted_at?: string | null;
  current_file_count?: number;
  current_total_bytes?: number;
  current_change_bytes?: number;
  current_mainline_bytes?: number;
}

/**
 * Fetch current mesh path statistics for a prefix (and optionally a single
 * remote root).
 *
 * @param db - Database adapter.
 * @param prefix - Interocitor mount prefix to inspect.
 * @param remoteRoot - When provided, narrows the result to one remote root.
 */
export async function getMaintenanceStatus(
  db: DatabaseAdapter,
  prefix: string,
  remoteRoot: string | null = null,
): Promise<{ paths: MaintenancePathStatus[] }> {
  const sql = remoteRoot
    ? "SELECT prefix, remote_root, last_operation_at, last_read_at, last_write_at, deleted_at, current_file_count, current_total_bytes, current_change_bytes, current_mainline_bytes FROM mesh_paths WHERE prefix = ? AND remote_root = ? ORDER BY remote_root"
    : "SELECT prefix, remote_root, last_operation_at, last_read_at, last_write_at, deleted_at, current_file_count, current_total_bytes, current_change_bytes, current_mainline_bytes FROM mesh_paths WHERE prefix = ? ORDER BY remote_root";
  const rows = remoteRoot
    ? await db.all<MaintenanceStatusRow>(sql, prefix, remoteRoot)
    : await db.all<MaintenanceStatusRow>(sql, prefix);
  return { paths: rows };
}

// ─── runMaintenance ──────────────────────────────────────────────────────────

/** Summary returned by {@link runMaintenance}. */
export interface MaintenanceResult {
  /** Number of remote roots that were eligible for TTL deletion. */
  ttlCandidates: number;
  /** Number of remote roots whose files were actually deleted. */
  ttlDeleted: number;
}

/**
 * Run TTL-based maintenance for a prefix (or all prefixes when `prefix` is
 * `null`).
 *
 * A remote root is eligible for eviction when it has not been written for
 * longer than `pathTtlHours` and has not already been evicted. Reads do not
 * hold a mesh alive; a mesh that was never written counts from the creation
 * of its path. A non-positive value disables TTL deletion.
 *
 * @param db - Database adapter.
 * @param pathTtlHours - Positive number of inactive hours before deletion.
 * @param prefix - Scope maintenance to a single prefix, or `null` for all.
 */
export async function runMaintenance(
  db: DatabaseAdapter,
  pathTtlHours: number,
  prefix: string | null = null,
): Promise<MaintenanceResult> {
  if (!(Number.isFinite(pathTtlHours) && pathTtlHours > 0)) {
    return { ttlCandidates: 0, ttlDeleted: 0 };
  }

  const now = new Date().toISOString();
  const threshold = new Date(Date.now() - pathTtlHours * 3600_000).toISOString();
  const rows = prefix
    ? await db.all<MaintenanceSweepRow>(
        "SELECT remote_root, created_at, last_write_at, deleted_at FROM mesh_paths WHERE prefix = ?",
        prefix,
      )
    : await db.all<MaintenanceSweepRow>(
        "SELECT prefix, remote_root, created_at, last_write_at, deleted_at FROM mesh_paths",
      );

  const candidates = rows.filter((row) => {
    if (row.deleted_at) return false;
    const since = idleSince(row);
    return Boolean(since && since <= threshold);
  });

  let deleted = 0;
  for (const row of candidates) {
    const targetPrefix = prefix ?? String(row.prefix ?? "");
    const remoteRoot = String(row.remote_root);
    await db.batch([
      db
        .prepare("DELETE FROM files WHERE prefix = ? AND (path = ? OR path LIKE ?)")
        .bind(targetPrefix, remoteRoot, `${remoteRoot}/%`),
      db
        .prepare("DELETE FROM folders WHERE prefix = ? AND (path = ? OR path LIKE ?)")
        .bind(targetPrefix, remoteRoot, `${remoteRoot}/%`),
      db
        .prepare(
          "UPDATE mesh_paths SET deleted_at = ?, last_ttl_delete_at = ?, current_file_count = 0, current_total_bytes = 0, current_change_bytes = 0, current_mainline_bytes = 0, updated_at = ? WHERE prefix = ? AND remote_root = ?",
        )
        .bind(now, now, now, targetPrefix, remoteRoot),
    ]);
    deleted += 1;
  }

  return { ttlCandidates: candidates.length, ttlDeleted: deleted };
}

// ─── readEvictionRecord ──────────────────────────────────────────────────────

/**
 * Why a mesh was evicted. `idle` is the TTL sweep; `operator` is any other
 * host-initiated reclamation, such as a whole-prefix wipe.
 */
export type EvictionReason = "idle" | "operator";

/** Eviction record served at `<remoteRoot>/evicted.json`. */
export interface EvictionRecord {
  evicted: true;
  meshAddress: string;
  remotePath: string;
  evictedAt: string;
  reason: EvictionReason;
  idleSince: string | null;
  fileBodiesRetained: true;
}

/**
 * Synthesize the eviction record for a mesh root, or `null` when the mesh has
 * not been evicted.
 *
 * The record is derived from the surviving `mesh_paths` row at read time. It
 * is never stored as an object, so serving it neither creates a write nor
 * resets the idle clock it describes, and clearing it requires nothing beyond
 * the next write to the mesh.
 *
 * @param db - Database adapter.
 * @param prefix - Interocitor mount prefix, which is the mesh address.
 * @param remoteRoot - Mesh root the record describes.
 */
export async function readEvictionRecord(
  db: DatabaseAdapter,
  prefix: string,
  remoteRoot: string,
): Promise<EvictionRecord | null> {
  const row = await db.first<EvictionRow>(
    "SELECT created_at, last_write_at, last_ttl_delete_at, deleted_at FROM mesh_paths WHERE prefix = ? AND remote_root = ?",
    prefix,
    remoteRoot,
  );
  if (!row?.deleted_at) return null;
  return {
    evicted: true,
    meshAddress: prefix,
    remotePath: remoteRoot,
    evictedAt: String(row.deleted_at),
    reason: row.last_ttl_delete_at === row.deleted_at ? "idle" : "operator",
    idleSince: idleSince(row),
    fileBodiesRetained: true,
  };
}
