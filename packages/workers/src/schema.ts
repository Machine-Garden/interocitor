import type { D1Database } from './types.ts';

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS files (
    prefix         TEXT    NOT NULL,
    path           TEXT    NOT NULL,
    content        BLOB    NOT NULL,
    size           INTEGER NOT NULL,
    modified_time  INTEGER NOT NULL,
    etag           TEXT    NOT NULL,
    PRIMARY KEY (prefix, path)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_files_prefix_path ON files(prefix, path)`,
  `CREATE TABLE IF NOT EXISTS folders (
    prefix      TEXT    NOT NULL,
    path        TEXT    NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (prefix, path)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_folders_prefix_path ON folders(prefix, path)`,
  `CREATE TABLE IF NOT EXISTS stored_files (
    prefix                 TEXT    NOT NULL,
    path                   TEXT    NOT NULL,
    r2_key                 TEXT    NOT NULL,
    size                   INTEGER NOT NULL,
    plaintext_size         INTEGER,
    content_type           TEXT,
    taint                  TEXT,
    uploaded_by_device_id  TEXT    NOT NULL,
    uploaded_at            TEXT    NOT NULL,
    modified_time          TEXT    NOT NULL,
    last_accessed_at       TEXT,
    use_count              INTEGER NOT NULL DEFAULT 0,
    etag                   TEXT,
    PRIMARY KEY (prefix, path)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_stored_files_prefix ON stored_files(prefix)`,
  `CREATE TABLE IF NOT EXISTS mesh_paths (
    prefix                TEXT    NOT NULL,
    remote_root           TEXT    NOT NULL,
    created_at            TEXT    NOT NULL,
    updated_at            TEXT    NOT NULL,
    last_operation_at     TEXT,
    last_read_at          TEXT,
    last_write_at         TEXT,
    last_ttl_delete_at    TEXT,
    deleted_at            TEXT,
    ops_day               TEXT,
    ops_count_day         INTEGER NOT NULL DEFAULT 0,
    writes_count_day      INTEGER NOT NULL DEFAULT 0,
    current_file_count    INTEGER NOT NULL DEFAULT 0,
    current_total_bytes   INTEGER NOT NULL DEFAULT 0,
    current_change_bytes  INTEGER NOT NULL DEFAULT 0,
    current_mainline_bytes INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (prefix, remote_root)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_mesh_paths_prefix_root ON mesh_paths(prefix, remote_root)`,
];

const initialized = new WeakSet<D1Database>();

/**
 * Idempotent schema bootstrap. Called once per DatabaseAdapter instance.
 * Uses CREATE IF NOT EXISTS so safe to run repeatedly across cold starts.
 */
export async function ensureSchema(db: D1Database): Promise<void> {
  if (initialized.has(db)) return;
  await db.batch(SCHEMA_SQL.map((sql) => db.prepare(sql)));
  await ensureStoredFilesTaintColumn(db);
  initialized.add(db);
}

/** Explicit migration entrypoint for ops scripts. */
export async function applySchema(db: D1Database): Promise<void> {
  await db.batch(SCHEMA_SQL.map((sql) => db.prepare(sql)));
  await ensureStoredFilesTaintColumn(db);
}

async function ensureStoredFilesTaintColumn(db: D1Database): Promise<void> {
  const result = await db.prepare('PRAGMA table_info(stored_files)').all<{ name?: string }>();
  const columns = result.results ?? [];
  if (!columns.some((column) => column.name === 'taint')) {
    await db.prepare('ALTER TABLE stored_files ADD COLUMN taint TEXT').run();
  }
}

export const SCHEMA_STATEMENTS: readonly string[] = SCHEMA_SQL;
