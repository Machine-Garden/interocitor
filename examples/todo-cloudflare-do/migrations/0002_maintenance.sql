CREATE TABLE IF NOT EXISTS mesh_paths (
  prefix TEXT NOT NULL,
  remote_root TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_operation_at TEXT,
  last_read_at TEXT,
  last_write_at TEXT,
  last_ttl_delete_at TEXT,
  deleted_at TEXT,
  ops_day TEXT,
  ops_count_day INTEGER NOT NULL DEFAULT 0,
  writes_count_day INTEGER NOT NULL DEFAULT 0,
  current_file_count INTEGER NOT NULL DEFAULT 0,
  current_total_bytes INTEGER NOT NULL DEFAULT 0,
  current_change_bytes INTEGER NOT NULL DEFAULT 0,
  current_mainline_bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (prefix, remote_root)
);

CREATE INDEX IF NOT EXISTS idx_mesh_paths_prefix_last_operation
  ON mesh_paths(prefix, last_operation_at);

CREATE INDEX IF NOT EXISTS idx_mesh_paths_deleted_last_operation
  ON mesh_paths(deleted_at, last_operation_at);

CREATE TABLE IF NOT EXISTS maintenance_runs (
  run_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  scope_prefix TEXT,
  ttl_candidates INTEGER NOT NULL DEFAULT 0,
  ttl_deleted INTEGER NOT NULL DEFAULT 0,
  size_rejections INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS maintenance_actions (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  prefix TEXT NOT NULL,
  remote_root TEXT NOT NULL,
  action TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_maintenance_actions_prefix_root_created
  ON maintenance_actions(prefix, remote_root, created_at);
