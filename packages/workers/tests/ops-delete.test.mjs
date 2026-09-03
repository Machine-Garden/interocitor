import assert from "node:assert/strict";
import test from "node:test";
import { opDeletePath, opGetFile, opListChildren, opPutImmutable } from "../dist/ops.js";
import { cacheKeyFor, listingCacheKeyFor } from "../dist/paths.js";

class Statement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }

  bind(...params) {
    this.params = params;
    return this;
  }

  async first() {
    return this.db.first(this.sql, this.params);
  }

  async all() {
    return { results: this.db.all(this.sql, this.params) };
  }

  async run() {
    return this.db.run(this.sql, this.params);
  }
}

class MemoryD1 {
  constructor() {
    this.files = new Map();
    this.metricUpdates = [];
  }

  prepare(sql) {
    return new Statement(this, sql);
  }

  async batch(statements) {
    return Promise.all(statements.map((statement) => statement.run()));
  }

  key(prefix, path) {
    return `${prefix}\0${path}`;
  }

  first(sql, params) {
    if (sql.includes("SELECT content, size, modified_time, etag FROM files")) {
      return this.files.get(this.key(params[0], params[1])) ?? null;
    }
    return null;
  }

  all(sql, params) {
    if (!sql.includes("SELECT path, size FROM files")) return [];
    const [prefix, exact, start, end] = params;
    return [...this.files.values()].filter(
      (file) =>
        file.prefix === prefix &&
        (exact === undefined || file.path === exact || (file.path >= start && file.path < end)),
    );
  }

  run(sql, params) {
    if (sql.includes("INSERT OR IGNORE INTO files")) {
      const [prefix, path, content, size, modified_time, etag] = params;
      const key = this.key(prefix, path);
      if (this.files.has(key)) return { success: true, meta: { changes: 0 } };
      this.files.set(key, { prefix, path, content, size, modified_time, etag });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("DELETE FROM files")) {
      const [prefix, exact, start, end] = params;
      let changes = 0;
      for (const [key, file] of this.files) {
        if (
          file.prefix === prefix &&
          (exact === undefined || file.path === exact || (file.path >= start && file.path < end))
        ) {
          this.files.delete(key);
          changes += 1;
        }
      }
      return { success: true, meta: { changes } };
    }
    if (sql.includes("current_file_count") && sql.includes("UPDATE mesh_paths")) {
      this.metricUpdates.push(params);
    }
    return { success: true, meta: { changes: 1 } };
  }
}

class MemoryCache {
  constructor() {
    this.entries = new Map();
  }

  async match(input) {
    return this.entries.get(String(input))?.clone();
  }

  async put(input, response) {
    this.entries.set(String(input), response.clone());
  }

  async delete(input) {
    return this.entries.delete(String(input));
  }
}

test("cache keys keep mesh prefixes and paths as opaque tuple members", () => {
  for (const makeKey of [cacheKeyFor, listingCacheKeyFor]) {
    const traversalKey = new URL(makeKey("attacker", "/../victim/manifest-1.json")).href;
    const victimKey = new URL(makeKey("victim", "/manifest-1.json")).href;
    assert.notEqual(traversalKey, victimKey);

    const queryKey = new URL(makeKey("mesh", "/file.json?variant=attacker")).href;
    const plainKey = new URL(makeKey("mesh", "/file.json")).href;
    assert.notEqual(queryKey, plainKey);
  }

  const dotPrefixFileKey = new URL(cacheKeyFor("..", "/same")).href;
  const dotPrefixListingKey = new URL(listingCacheKeyFor("..", "/same")).href;
  assert.notEqual(dotPrefixFileKey, dotPrefixListingKey);
});

test("compacted changes bypass per-colo cache and deletion decrements byte metrics", async () => {
  const previousCaches = globalThis.caches;
  const cache = new MemoryCache();
  globalThis.caches = { default: cache };

  try {
    const db = new MemoryD1();
    const path = "/mesh/changes/0001-chg_a.json";
    const bytes = new Uint8Array([1, 2, 3]);
    await opPutImmutable(db, "mesh-address", path, bytes, "change-file", "/mesh");
    assert.equal(cache.entries.size, 0);
    assert.equal((await opGetFile(db, "mesh-address", path, "change-file")).source, "d1");
    assert.equal(cache.entries.size, 0);

    assert.equal(await opDeletePath(db, "mesh-address", path, "/mesh"), true);
    assert.equal((await opGetFile(db, "mesh-address", path, "change-file")).found, false);
    assert.equal(cache.entries.size, 0);

    const deletionMetrics = db.metricUpdates.at(-1);
    assert.deepEqual(deletionMetrics.slice(3, 6), [-1, -3, -3]);
    assert.equal(Math.abs(deletionMetrics[6]), 0);
  } finally {
    globalThis.caches = previousCaches;
  }
});

test("superseded mainline snapshots bypass per-colo cache and delete authoritatively", async () => {
  const previousCaches = globalThis.caches;
  const cache = new MemoryCache();
  globalThis.caches = { default: cache };

  try {
    const db = new MemoryD1();
    const path = "/mesh/mainline/snapshot-1-server.json";
    const bytes = new Uint8Array([4, 5, 6, 7]);
    await opPutImmutable(db, "mesh-address", path, bytes, "mainline-snapshot", "/mesh");
    assert.equal(cache.entries.size, 0);
    assert.equal((await opGetFile(db, "mesh-address", path, "mainline-snapshot")).source, "d1");
    assert.equal(cache.entries.size, 0);

    assert.equal(await opDeletePath(db, "mesh-address", path, "/mesh"), true);
    assert.equal((await opGetFile(db, "mesh-address", path, "mainline-snapshot")).found, false);
    assert.equal(cache.entries.size, 0);

    const deletionMetrics = db.metricUpdates.at(-1);
    assert.deepEqual(deletionMetrics.slice(3, 5), [-1, -4]);
    assert.equal(Math.abs(deletionMetrics[5]), 0);
    assert.equal(deletionMetrics[6], -4);
  } finally {
    globalThis.caches = previousCaches;
  }
});

test("compaction folder listings ignore stale per-colo cache entries", async () => {
  const previousCaches = globalThis.caches;
  const cache = new MemoryCache();
  globalThis.caches = { default: cache };

  try {
    const db = new MemoryD1();
    for (const path of ["/mesh/changes", "/mesh/mainline"]) {
      const cacheKey = listingCacheKeyFor("mesh-address", path);
      await cache.put(
        cacheKey,
        new Response(JSON.stringify({ files: [{ name: "stale.json" }], folders: [] })),
      );
      assert.deepEqual(await opListChildren(db, "mesh-address", path), { files: [], folders: [] });
    }
  } finally {
    globalThis.caches = previousCaches;
  }
});
