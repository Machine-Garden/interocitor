import type { DatabaseAdapter, QueryRow } from './types.ts';

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
  last_operation_at?: string | null;
  deleted_at?: string | null;
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
    ? 'SELECT prefix, remote_root, last_operation_at, last_read_at, last_write_at, deleted_at, current_file_count, current_total_bytes, current_change_bytes, current_mainline_bytes FROM mesh_paths WHERE prefix = ? AND remote_root = ? ORDER BY remote_root'
    : 'SELECT prefix, remote_root, last_operation_at, last_read_at, last_write_at, deleted_at, current_file_count, current_total_bytes, current_change_bytes, current_mainline_bytes FROM mesh_paths WHERE prefix = ? ORDER BY remote_root';
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
  /** Reserved for future compaction sweeps. Always `0` currently. */
  pruned: number;
}

/**
 * Run TTL-based maintenance for a prefix (or all prefixes when `prefix` is
 * `null`).
 *
 * A remote root is eligible for deletion when its `last_operation_at`
 * timestamp is older than `pathTtlHours` and it has not already been
 * soft-deleted. A non-positive value disables TTL deletion.
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
    return { ttlCandidates: 0, ttlDeleted: 0, pruned: 0 };
  }

  const threshold = new Date(Date.now() - pathTtlHours * 3600_000).toISOString();
  const rows = prefix
    ? await db.all<MaintenanceSweepRow>('SELECT remote_root, last_operation_at, deleted_at FROM mesh_paths WHERE prefix = ?', prefix)
    : await db.all<MaintenanceSweepRow>('SELECT prefix, remote_root, last_operation_at, deleted_at FROM mesh_paths');

  const candidates = rows.filter(
    (row) => !row.deleted_at && row.last_operation_at && row.last_operation_at <= threshold,
  );

  let deleted = 0;
  for (const row of candidates) {
    const targetPrefix = prefix ?? String(row.prefix ?? '');
    const remoteRoot = String(row.remote_root);
    await db.batch([
      db.prepare('DELETE FROM files WHERE prefix = ? AND (path = ? OR path LIKE ?)').bind(targetPrefix, remoteRoot, `${remoteRoot}/%`),
      db.prepare('DELETE FROM folders WHERE prefix = ? AND (path = ? OR path LIKE ?)').bind(targetPrefix, remoteRoot, `${remoteRoot}/%`),
      db.prepare('UPDATE mesh_paths SET deleted_at = ?, last_ttl_delete_at = ?, current_file_count = 0, current_total_bytes = 0, current_change_bytes = 0, current_mainline_bytes = 0, updated_at = ? WHERE prefix = ? AND remote_root = ?').bind(threshold, threshold, threshold, targetPrefix, remoteRoot),
    ]);
    deleted += 1;
  }

  return { ttlCandidates: candidates.length, ttlDeleted: deleted, pruned: 0 };
}
