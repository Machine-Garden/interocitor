import assert from "node:assert/strict";
import test from "node:test";
import {
  checksummedMeshIntegrityGate,
  createInterocitorMount,
  createInterocitorSystemHandler,
  meshInfo,
  provideMeshInfo,
} from "../dist/index.js";

class MemoryStatement {
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
    return { results: [] };
  }

  async run() {
    return this.db.run(this.sql, this.params);
  }
}

class MemoryD1 {
  constructor() {
    this.storedFiles = new Map();
    this.files = new Map();
    this.meshRoots = new Map();
    this.queries = [];
  }

  prepare(sql) {
    return new MemoryStatement(this, sql);
  }

  async batch(statements) {
    return Promise.all(statements.map((statement) => statement.run()));
  }

  key(prefix, path) {
    return `${prefix} ${path}`;
  }

  /** Seed a sync root so MIN(created_at) has something to find. */
  addMeshRoot(prefix, remoteRoot, createdAt) {
    this.meshRoots.set(this.key(prefix, remoteRoot), { prefix, created_at: createdAt });
  }

  /** Seed a device heartbeat object at `<root>/devices/<id>`. */
  addDevice(prefix, path) {
    this.files.set(this.key(prefix, path), { size: 1 });
  }

  first(sql, params) {
    this.queries.push(sql);
    if (sql.includes("MIN(created_at)") && sql.includes("mesh_paths")) {
      const [prefix] = params;
      let min = null;
      for (const row of this.meshRoots.values()) {
        if (row.prefix !== prefix) continue;
        if (min === null || row.created_at < min) min = row.created_at;
      }
      return { created_at: min };
    }
    if (sql.includes("FROM files") && sql.includes("devices")) {
      const [prefix] = params;
      let count = 0;
      for (const key of this.files.keys()) {
        if (!key.startsWith(`${prefix} `)) continue;
        const path = key.slice(prefix.length + 1);
        if (/\/devices\/[^/]+$/.test(path)) count += 1;
      }
      return { count };
    }
    if (sql.includes("COALESCE(SUM(size)")) {
      const [prefix] = params;
      let total = 0;
      let count = 0;
      for (const row of this.storedFiles.values()) {
        if (row.prefix !== prefix) continue;
        total += row.size;
        count += 1;
      }
      return { total, count };
    }
    if (sql.includes("SELECT size, seal_guard, r2_key AS body_key FROM stored_files")) {
      const [prefix, path] = params;
      const row = this.storedFiles.get(this.key(prefix, path));
      return row ? { size: row.size, seal_guard: row.seal_guard, body_key: row.r2_key } : null;
    }
    if (sql.includes("FROM stored_files")) {
      const [prefix, path] = params;
      return this.storedFiles.get(this.key(prefix, path)) ?? null;
    }
    return null;
  }

  all() {
    return [];
  }

  run(sql, params) {
    if (sql.includes("INSERT INTO stored_files")) {
      const [prefix, path, r2_key, size, seal_guard, uploaded_by_device_id, uploaded_at, etag] =
        params;
      this.storedFiles.set(this.key(prefix, path), {
        prefix,
        path,
        r2_key,
        size,
        seal_guard,
        uploaded_by_device_id,
        uploaded_at,
        modified_time: uploaded_at,
        last_accessed_at: null,
        use_count: 0,
        etag,
      });
    }
    return { success: true, meta: { changes: 1 } };
  }
}

class MemoryFileBodyStore {
  constructor() {
    this.objects = new Map();
  }

  async get(key) {
    const object = this.objects.get(key);
    return object
      ? { body: new Blob([object.bytes]).stream(), size: object.bytes.byteLength }
      : null;
  }

  async put(key, value) {
    const bytes =
      typeof value === "string"
        ? new TextEncoder().encode(value)
        : value instanceof Uint8Array
          ? value
          : new Uint8Array(value);
    this.objects.set(key, { bytes });
    return { etag: "etag" };
  }

  async delete(key) {
    this.objects.delete(key);
  }
}

function createCtx() {
  return { waitUntil() {} };
}

function createHarness(runtime = {}) {
  const env = { DB: new MemoryD1(), FILES: new MemoryFileBodyStore() };
  const options = {
    db: (e) => e.DB,
    files: (e) => e.FILES,
    runtime: {
      meshIntegrityGates: [checksummedMeshIntegrityGate],
      maxStoredFileBytes: () => 1024,
      maxMeshStoredBytes: () => 4096,
      ...runtime,
    },
  };
  return {
    env,
    mount: createInterocitorMount(options),
    system: createInterocitorSystemHandler(options),
  };
}

async function issueMeshId(system, env) {
  const response = await system.fetch(
    new Request("https://example.test/__interocitor/system/bootstrap", {
      method: "POST",
      headers: { Authorization: "Bearer system", "Content-Type": "application/json" },
      body: JSON.stringify({ op: "issue-mesh-id" }),
    }),
    env,
    createCtx(),
  );
  assert.equal(response.status, 200);
  return (await response.json()).meshId;
}

async function upload(mount, env, meshId, path, body) {
  return mount.fetch(
    new Request(
      `https://example.test/io/${encodeURIComponent(meshId)}/stored-file?path=${encodeURIComponent(path)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "text/plain", "X-Interocitor-Device-Id": "dev-a" },
        body,
      },
    ),
    env,
    createCtx(),
  );
}

test("meshInfo reports mesh age, announced devices, and stored volume", async () => {
  let observed = null;
  const { env, mount, system } = createHarness({
    authorizeFileUpload: async (request) => {
      observed = await meshInfo(request);
      return true;
    },
  });
  const meshId = await issueMeshId(system, env);
  const createdAt = new Date(Date.now() - 5 * 60_000).toISOString();
  env.DB.addMeshRoot(meshId, "/mesh", createdAt);
  env.DB.addMeshRoot(meshId, "/other", new Date().toISOString());
  env.DB.addDevice(meshId, "/mesh/devices/dev-a");
  env.DB.addDevice(meshId, "/mesh/devices/dev-b");
  env.DB.addDevice(meshId, "/mesh/changes/head.json");

  assert.equal((await upload(mount, env, meshId, "/first.txt", "hello")).status, 201);

  assert.equal(observed.createdAt, Date.parse(createdAt), "earliest root wins");
  assert.ok(observed.ageMs >= 5 * 60_000, "age measured from the earliest root");
  assert.equal(observed.deviceCount, 2, "only devices/<id> objects count");
  assert.equal(observed.storedFileCount, 0, "volume is measured before this write");
  assert.equal(observed.storedBytes, 0);

  assert.equal((await upload(mount, env, meshId, "/second.txt", "hello")).status, 201);
  assert.equal(observed.storedFileCount, 1, "the first upload is now counted");
  assert.equal(observed.storedBytes, 5);
});

test("replacedBytes reports what an overwrite frees", async () => {
  const seen = [];
  const { env, mount, system } = createHarness({
    authorizeFileUpload: (request) => {
      seen.push(request.replacedBytes);
      return true;
    },
  });
  const meshId = await issueMeshId(system, env);

  await upload(mount, env, meshId, "/a.txt", "hello");
  await upload(mount, env, meshId, "/a.txt", "hi");
  await upload(mount, env, meshId, "/b.txt", "hi");

  assert.deepEqual(seen, [0, 5, 0], "only a replacement frees bytes");
});

test("meshInfo reports a null age for an address holding no sync root yet", async () => {
  let observed = null;
  const { env, mount, system } = createHarness({
    authorizeFileUpload: async (request) => {
      observed = await meshInfo(request);
      return true;
    },
  });
  const meshId = await issueMeshId(system, env);

  assert.equal((await upload(mount, env, meshId, "/a.txt", "hi")).status, 201);
  assert.equal(observed.createdAt, null);
  assert.equal(observed.ageMs, null);
  assert.equal(observed.deviceCount, 0);
});

test("meshInfo is memoized per request and unread policies never query", async () => {
  let calls = 0;
  const { env, mount, system } = createHarness({
    authorizeFileUpload: async (request) => {
      calls += 1;
      if (calls === 1) return true;
      const [a, b] = await Promise.all([meshInfo(request), meshInfo(request)]);
      const again = await meshInfo(request);
      assert.equal(a, b, "concurrent reads share one result");
      assert.equal(a, again, "later reads share it too");
      return true;
    },
  });
  const meshId = await issueMeshId(system, env);

  await upload(mount, env, meshId, "/quiet.txt", "hi");
  const quiet = env.DB.queries.filter((sql) => sql.includes("mesh_paths")).length;
  assert.equal(quiet, 0, "a policy that never asks pays nothing");

  await upload(mount, env, meshId, "/loud.txt", "hi");
  const loud = env.DB.queries.filter((sql) => sql.includes("MIN(created_at)")).length;
  assert.equal(loud, 1, "three reads, one query");
});

test("policy rejection based on mesh facts reaches the client", async () => {
  const { env, mount, system } = createHarness({
    authorizeFileUpload: async (request) => {
      const mesh = await meshInfo(request);
      if (mesh.deviceCount < 2)
        return { allowed: false, status: 403, reason: "nobody to share with yet" };
      return true;
    },
  });
  const meshId = await issueMeshId(system, env);

  const lonely = await upload(mount, env, meshId, "/a.txt", "hi");
  assert.equal(lonely.status, 403);
  assert.equal((await lonely.json()).error, "nobody to share with yet");

  env.DB.addDevice(meshId, "/mesh/devices/dev-a");
  env.DB.addDevice(meshId, "/mesh/devices/dev-b");
  assert.equal((await upload(mount, env, meshId, "/a.txt", "hi")).status, 201);
});

test("meshInfo refuses a request the runtime did not supply, and provideMeshInfo seeds one", async () => {
  const handmade = {
    address: "mesh",
    presentedAddress: "mesh",
    canonicalAddress: "mesh",
    path: "/a.txt",
    uploadedByDeviceId: "dev-a",
    size: 2,
    sealed: false,
    overwritesSealed: false,
    currentMeshStoredBytes: 0,
    maxMeshStoredBytes: 4096,
    request: new Request("https://example.test/"),
  };

  assert.throws(() => meshInfo(handmade), TypeError);

  const seeded = {
    createdAt: 1_000,
    ageMs: 90_000,
    deviceCount: 3,
    storedFileCount: 1,
    storedBytes: 10,
  };
  provideMeshInfo(handmade, seeded);
  assert.deepEqual(await meshInfo(handmade), seeded);
});
