export async function getMaintenanceStatus(db, prefix, remoteRoot = null) {
  const sql = remoteRoot
    ? `SELECT prefix, remote_root, last_operation_at, last_read_at, last_write_at, deleted_at, current_file_count, current_total_bytes, current_change_bytes, current_mainline_bytes FROM mesh_paths WHERE prefix = ? AND remote_root = ? ORDER BY remote_root`
    : `SELECT prefix, remote_root, last_operation_at, last_read_at, last_write_at, deleted_at, current_file_count, current_total_bytes, current_change_bytes, current_mainline_bytes FROM mesh_paths WHERE prefix = ? ORDER BY remote_root`;
  const rows = remoteRoot ? await db.all(sql, prefix, remoteRoot) : await db.all(sql, prefix);
  return { paths: rows };
}

export async function runMaintenance(db, env, prefix = null) {
  const ttlHours = Number.parseFloat(String(env?.INTEROCITOR_PATH_TTL_HOURS ?? '0'));
  if (!(Number.isFinite(ttlHours) && ttlHours >= 0)) {
    return { ttlCandidates: 0, ttlDeleted: 0, pruned: 0 };
  }

  const threshold = new Date(Date.now() - ttlHours * 3600_000).toISOString();
  const rows = prefix
    ? await db.all(`SELECT remote_root, last_operation_at, deleted_at FROM mesh_paths WHERE prefix = ?`, prefix)
    : await db.all(`SELECT prefix, remote_root, last_operation_at, deleted_at FROM mesh_paths`);

  const candidates = rows.filter((row) => !row.deleted_at && row.last_operation_at && row.last_operation_at <= threshold);
  let deleted = 0;
  for (const row of candidates) {
    const targetPrefix = prefix ?? row.prefix;
    const remoteRoot = row.remote_root;
    await db.batch([
      db.prepare(`DELETE FROM files WHERE prefix = ? AND (path = ? OR path LIKE ?)`).bind(targetPrefix, remoteRoot, `${remoteRoot}/%`),
      db.prepare(`DELETE FROM folders WHERE prefix = ? AND (path = ? OR path LIKE ?)`).bind(targetPrefix, remoteRoot, `${remoteRoot}/%`),
      db.prepare(`UPDATE mesh_paths SET deleted_at = ?, last_ttl_delete_at = ?, current_file_count = 0, current_total_bytes = 0, current_change_bytes = 0, current_mainline_bytes = 0, updated_at = ? WHERE prefix = ? AND remote_root = ?`).bind(threshold, threshold, threshold, targetPrefix, remoteRoot),
    ]);
    deleted += 1;
  }
  return { ttlCandidates: candidates.length, ttlDeleted: deleted, pruned: 0 };
}
