CREATE TABLE IF NOT EXISTS folders (
  prefix TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (prefix, path)
);

CREATE TABLE IF NOT EXISTS files (
  prefix TEXT NOT NULL,
  path TEXT NOT NULL,
  content BLOB NOT NULL,
  size INTEGER NOT NULL,
  modified_time TEXT NOT NULL,
  etag TEXT NOT NULL,
  PRIMARY KEY (prefix, path)
);

CREATE INDEX IF NOT EXISTS idx_files_prefix_path ON files(prefix, path);
CREATE INDEX IF NOT EXISTS idx_folders_prefix_path ON folders(prefix, path);

