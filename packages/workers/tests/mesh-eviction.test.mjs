import assert from "node:assert/strict";
import test from "node:test";
import { getMaintenanceStatus, readEvictionRecord, runMaintenance } from "../dist/maintenance.js";
import { PATH_TYPE, classifyPath, meshRootForPath } from "../dist/paths.js";

const PREFIX = "main";
const HOUR = 3600_000;

function iso(msAgo) {
  return new Date(Date.now() - msAgo).toISOString();
}

/**
 * Minimal `mesh_paths` stand-in. It understands only the statements the
 * maintenance module issues, which is enough to pin the eviction clock.
 */
class MemoryMeshPaths {
  constructor(rows) {
    this.rows = rows.map((row) => ({
      prefix: PREFIX,
      created_at: iso(0),
      updated_at: iso(0),
      last_operation_at: null,
      last_read_at: null,
      last_write_at: null,
      last_ttl_delete_at: null,
      deleted_at: null,
      current_file_count: 0,
      current_total_bytes: 0,
      current_change_bytes: 0,
      current_mainline_bytes: 0,
      ...row,
    }));
    this.deletedPaths = [];
  }

  prepare(sql) {
    return {
      sql,
      params: [],
      bind(...params) {
        this.params = params;
        return this;
      },
    };
  }

  async batch(statements) {
    for (const statement of statements) this.apply(statement.sql, statement.params);
    return statements.map(() => ({}));
  }

  apply(sql, params) {
    if (sql.startsWith("DELETE FROM files") || sql.startsWith("DELETE FROM folders")) {
      this.deletedPaths.push(params[1]);
      return;
    }
    if (sql.startsWith("UPDATE mesh_paths SET deleted_at")) {
      const [deletedAt, ttlAt, updatedAt, prefix, remoteRoot] = params;
      const row = this.rows.find((r) => r.prefix === prefix && r.remote_root === remoteRoot);
      if (row) {
        row.deleted_at = deletedAt;
        row.last_ttl_delete_at = ttlAt;
        row.updated_at = updatedAt;
        row.current_file_count = 0;
        row.current_total_bytes = 0;
        row.current_change_bytes = 0;
        row.current_mainline_bytes = 0;
      }
      return;
    }
    throw new Error(`unsupported statement: ${sql}`);
  }

  async all(sql, ...params) {
    const prefix = sql.includes("WHERE prefix = ?") ? params[0] : null;
    const rows = prefix ? this.rows.filter((row) => row.prefix === prefix) : this.rows;
    return rows.map((row) => ({ ...row }));
  }

  async first(_sql, ...params) {
    const [prefix, remoteRoot] = params;
    const row = this.rows.find((r) => r.prefix === prefix && r.remote_root === remoteRoot);
    return row ? { ...row } : null;
  }

  async run() {
    return {};
  }
}

test("a mesh read every day but never written is still evicted", async () => {
  const db = new MemoryMeshPaths([
    {
      remote_root: "/main",
      created_at: iso(400 * 24 * HOUR),
      last_write_at: iso(400 * 24 * HOUR),
      last_read_at: iso(HOUR),
      last_operation_at: iso(HOUR),
    },
  ]);

  const result = await runMaintenance(db, 8760, PREFIX);

  assert.equal(result.ttlCandidates, 1);
  assert.equal(result.ttlDeleted, 1);
  assert.ok(db.rows[0].deleted_at, "mesh row survives eviction carrying the flag");
});

test("a mesh written inside the window survives even when nothing reads it", async () => {
  const db = new MemoryMeshPaths([
    {
      remote_root: "/main",
      created_at: iso(400 * 24 * HOUR),
      last_write_at: iso(24 * HOUR),
      last_read_at: iso(400 * 24 * HOUR),
      last_operation_at: iso(24 * HOUR),
    },
  ]);

  const result = await runMaintenance(db, 8760, PREFIX);

  assert.equal(result.ttlCandidates, 0);
  assert.equal(db.rows[0].deleted_at, null);
});

test("a mesh that was never written counts idleness from path creation", async () => {
  const fresh = new MemoryMeshPaths([{ remote_root: "/main", created_at: iso(24 * HOUR) }]);
  const stale = new MemoryMeshPaths([{ remote_root: "/main", created_at: iso(400 * 24 * HOUR) }]);

  assert.equal((await runMaintenance(fresh, 8760, PREFIX)).ttlDeleted, 0);
  assert.equal((await runMaintenance(stale, 8760, PREFIX)).ttlDeleted, 1);
});

test("eviction is stamped with the time it happened, not the idle threshold", async () => {
  const db = new MemoryMeshPaths([
    { remote_root: "/main", created_at: iso(400 * 24 * HOUR), last_write_at: iso(400 * 24 * HOUR) },
  ]);
  const before = Date.now();

  await runMaintenance(db, 8760, PREFIX);

  const evictedAt = Date.parse(db.rows[0].deleted_at);
  assert.ok(evictedAt >= before, "deleted_at records the sweep, not the threshold it compared to");
  assert.ok(evictedAt <= Date.now());
});

test("a disabled TTL evicts nothing", async () => {
  const db = new MemoryMeshPaths([
    { remote_root: "/main", created_at: iso(400 * 24 * HOUR), last_write_at: iso(400 * 24 * HOUR) },
  ]);

  for (const hours of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(await runMaintenance(db, hours, PREFIX), {
      ttlCandidates: 0,
      ttlDeleted: 0,
    });
  }
});

test("the eviction record is absent until the mesh is evicted", async () => {
  const idleSince = iso(400 * 24 * HOUR);
  const db = new MemoryMeshPaths([
    { remote_root: "/main", created_at: idleSince, last_write_at: idleSince },
  ]);

  assert.equal(await readEvictionRecord(db, PREFIX, "/main"), null);

  await runMaintenance(db, 8760, PREFIX);
  const record = await readEvictionRecord(db, PREFIX, "/main");

  assert.deepEqual(record, {
    evicted: true,
    meshAddress: PREFIX,
    remotePath: "/main",
    evictedAt: db.rows[0].deleted_at,
    reason: "idle",
    idleSince,
    fileBodiesRetained: true,
  });
});

test("an unknown mesh has no eviction record", async () => {
  const db = new MemoryMeshPaths([]);
  assert.equal(await readEvictionRecord(db, PREFIX, "/absent"), null);
});

test("a host wipe is reported as an operator eviction, not an idle one", async () => {
  const db = new MemoryMeshPaths([
    { remote_root: "/main", created_at: iso(HOUR), deleted_at: iso(0), last_ttl_delete_at: null },
  ]);

  const record = await readEvictionRecord(db, PREFIX, "/main");

  assert.equal(record.reason, "operator");
});

test("the evicted mesh keeps its row and reports zeroed counters", async () => {
  const db = new MemoryMeshPaths([
    {
      remote_root: "/main",
      created_at: iso(400 * 24 * HOUR),
      last_write_at: iso(400 * 24 * HOUR),
      current_file_count: 12,
      current_total_bytes: 900,
    },
  ]);

  await runMaintenance(db, 8760, PREFIX);
  const { paths } = await getMaintenanceStatus(db, PREFIX, "/main");

  assert.equal(paths.length, 1, "the mesh address stays connectable after eviction");
  assert.equal(paths[0].current_file_count, 0);
  assert.equal(paths[0].current_total_bytes, 0);
});

test("evicted.json is a mesh-root path of its own type", () => {
  assert.equal(classifyPath("/main/evicted.json"), PATH_TYPE.EVICTION_RECORD);
  assert.equal(meshRootForPath("/main/evicted.json"), "/main");
  assert.equal(classifyPath("/main/changes/evicted.json"), PATH_TYPE.EVICTION_RECORD);
  assert.equal(classifyPath("/main/manifest.json"), PATH_TYPE.MANIFEST_POINTER);
});
