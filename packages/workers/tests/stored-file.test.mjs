import assert from "node:assert/strict";
import test from "node:test";
import {
  checksummedMeshIntegrityGate,
  createInterocitorMount,
  createMeshAuthorizationMiddleware,
  createInterocitorSystemHandler,
  withInterocitor,
} from "../dist/worker.js";

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
    return { results: this.db.all(this.sql, this.params) };
  }

  async run() {
    return this.db.run(this.sql, this.params);
  }
}

class MemoryD1 {
  constructor() {
    this.storedFiles = new Map();
    this.files = new Map();
    this.folders = new Set();
  }

  prepare(sql) {
    return new MemoryStatement(this, sql);
  }

  async batch(statements) {
    return Promise.all(statements.map((statement) => statement.run()));
  }

  key(prefix, path) {
    return `${prefix}\u0000${path}`;
  }

  first(sql, params) {
    if (sql.includes("SELECT content, size, modified_time, etag FROM files")) {
      const [prefix, path] = params;
      return this.files.get(this.key(prefix, path)) ?? null;
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
    if (sql.includes("SELECT *, r2_key AS body_key FROM stored_files")) {
      const [prefix, path] = params;
      const row = this.storedFiles.get(this.key(prefix, path));
      return row ? { ...row, body_key: row.r2_key } : null;
    }
    if (sql.includes("SELECT * FROM stored_files")) {
      const [prefix, path] = params;
      return this.storedFiles.get(this.key(prefix, path)) ?? null;
    }
    if (sql.includes("SELECT r2_key AS body_key") && sql.includes("FROM stored_files")) {
      const [prefix, path] = params;
      const row = this.storedFiles.get(this.key(prefix, path));
      return row ? { body_key: row.r2_key, size: row.size, seal_guard: row.seal_guard } : null;
    }
    return null;
  }

  all() {
    return [];
  }

  run(sql, params) {
    if (sql.includes("INSERT OR IGNORE INTO folders")) {
      const [prefix, path] = params;
      const key = this.key(prefix, path);
      if (this.folders.has(key)) return { success: true, meta: { changes: 0 } };
      this.folders.add(key);
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("INSERT OR IGNORE INTO files")) {
      const [prefix, path, content, size, modified_time, etag] = params;
      const key = this.key(prefix, path);
      if (this.files.has(key)) return { success: true, meta: { changes: 0 } };
      this.files.set(key, { content, size, modified_time, etag });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("mesh_paths")) {
      return { success: true, meta: { changes: 1 } };
    }
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
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE stored_files SET last_accessed_at")) {
      const [prefix, path, last_accessed_at] = params;
      const row = this.storedFiles.get(this.key(prefix, path));
      if (row) {
        row.last_accessed_at = last_accessed_at;
        row.use_count += 1;
      }
      return { success: true, meta: { changes: row ? 1 : 0 } };
    }
    if (sql.includes("DELETE FROM stored_files")) {
      const [prefix, path] = params;
      const deleted = this.storedFiles.delete(this.key(prefix, path));
      return { success: true, meta: { changes: deleted ? 1 : 0 } };
    }
    return { success: true, meta: { changes: 0 } };
  }
}

class MemoryFileBodyStore {
  constructor() {
    this.objects = new Map();
  }

  async get(key) {
    const object = this.objects.get(key);
    return object
      ? {
          body: new Blob([object.bytes]).stream(),
          size: object.bytes.byteLength,
          etag: object.etag,
        }
      : null;
  }

  async put(key, value) {
    let bytes;
    if (value instanceof Uint8Array) bytes = value;
    else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
    else if (ArrayBuffer.isView(value))
      bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    else if (value instanceof Blob) bytes = new Uint8Array(await value.arrayBuffer());
    else if (typeof value === "string") bytes = new TextEncoder().encode(value);
    else bytes = new Uint8Array();
    const etag = `etag-${this.objects.size + 1}`;
    this.objects.set(key, { bytes, etag });
    return { etag };
  }

  async delete(key) {
    this.objects.delete(key);
  }
}

function createCtx() {
  return { waitUntil() {} };
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

function createHarness(runtime = {}) {
  const env = { DB: new MemoryD1(), FILES: new MemoryFileBodyStore() };
  const options = {
    db: (e) => e.DB,
    files: (e) => e.FILES,
    runtime: {
      meshIntegrityGates: [checksummedMeshIntegrityGate],
      maxStoredFileBytes: () => 10,
      maxMeshStoredBytes: () => 12,
      ...runtime,
    },
  };
  const mount = createInterocitorMount(options);
  const system = createInterocitorSystemHandler(options);
  return { env, mount, system };
}

async function upload(mount, env, meshId, path, body, headers = {}) {
  return mount.fetch(
    new Request(
      `https://example.test/io/${encodeURIComponent(meshId)}/stored-file?path=${encodeURIComponent(path)}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "text/plain",
          "X-Interocitor-Device-Id": "dev-a",
          ...headers,
        },
        body,
      },
    ),
    env,
    createCtx(),
  );
}

test("durable file-body stores support PUT, GET, metadata, use count, and DELETE", async () => {
  const { env, mount, system } = createHarness();
  const meshId = await issueMeshId(system, env);

  const put = await upload(mount, env, meshId, "/docs/a.txt", "hello");
  assert.equal(put.status, 201);
  const putJson = await put.json();
  assert.equal(putJson.file.uploadedByDeviceId, "dev-a");
  assert.equal(putJson.file.size, 5);
  assert.equal(putJson.file.plaintextSize, undefined);
  assert.equal(putJson.file.contentType, undefined);
  assert.equal(putJson.file.taint, undefined);

  const get = await mount.fetch(
    new Request(
      `https://example.test/io/${encodeURIComponent(meshId)}/stored-file?path=%2Fdocs%2Fa.txt`,
    ),
    env,
    createCtx(),
  );
  assert.equal(get.status, 200);
  assert.equal(await get.text(), "hello");

  const metadata = await mount.fetch(
    new Request(`https://example.test/io/${encodeURIComponent(meshId)}/stored-file-metadata`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/docs/a.txt" }),
    }),
    env,
    createCtx(),
  );
  assert.equal(metadata.status, 200);
  const metaJson = await metadata.json();
  assert.equal(metaJson.file.useCount, 1);
  assert.equal(metaJson.file.taint, undefined);
  assert.ok(metaJson.file.lastAccessedAt);

  const del = await mount.fetch(
    new Request(
      `https://example.test/io/${encodeURIComponent(meshId)}/stored-file?path=%2Fdocs%2Fa.txt`,
      { method: "DELETE" },
    ),
    env,
    createCtx(),
  );
  assert.equal(del.status, 204);

  const missing = await mount.fetch(
    new Request(
      `https://example.test/io/${encodeURIComponent(meshId)}/stored-file?path=%2Fdocs%2Fa.txt`,
    ),
    env,
    createCtx(),
  );
  assert.equal(missing.status, 404);
});

test("durable-file storage can be selected by accepted mesh address", async () => {
  const env = { DB: new MemoryD1(), FILES: new MemoryFileBodyStore() };
  const selections = [];
  const mount = createInterocitorMount({
    db: (value) => value.DB,
    files: (value, { address }) => {
      selections.push(address);
      return value.FILES;
    },
    runtime: { meshIntegrityGates: [({ address }) => address === "sensitive-au"] },
  });

  const put = await upload(mount, env, "sensitive-au", "/private.txt", "secret");
  assert.equal(put.status, 201);
  const get = await mount.fetch(
    new Request("https://example.test/io/sensitive-au/stored-file?path=%2Fprivate.txt"),
    env,
    createCtx(),
  );
  assert.equal(get.status, 200);
  assert.equal(await get.text(), "secret");
  assert.deepEqual(selections, ["sensitive-au", "sensitive-au"]);
});

test("a resolved route stores and audits durable files under only the canonical address", async () => {
  let canonicalAddress = "";
  let uploadContext;
  const auditEvents = [];
  const { env, mount, system } = createHarness({
    resolveMeshRoute: ({ presentedAddress }) =>
      presentedAddress === "public-handle" && canonicalAddress ? { canonicalAddress } : null,
    authorizeFileUpload: (context) => {
      uploadContext = context;
      return true;
    },
    storageOperationAudit: (event) => auditEvents.push(event),
  });
  canonicalAddress = await issueMeshId(system, env);

  const put = await upload(mount, env, "public-handle", "/docs/aliased.txt", "secret");
  assert.equal(put.status, 201);
  assert.equal(env.DB.storedFiles.has(env.DB.key(canonicalAddress, "/docs/aliased.txt")), true);
  assert.equal(env.DB.storedFiles.has(env.DB.key("public-handle", "/docs/aliased.txt")), false);
  assert.deepEqual(
    {
      address: uploadContext.address,
      presentedAddress: uploadContext.presentedAddress,
      canonicalAddress: uploadContext.canonicalAddress,
    },
    {
      address: canonicalAddress,
      presentedAddress: "public-handle",
      canonicalAddress,
    },
  );
  assert.equal(
    [...env.FILES.objects.keys()][0],
    `meshes/${encodeURIComponent(canonicalAddress)}/files/docs%2Faliased.txt`,
  );
  assert.equal(
    auditEvents.find((event) => event.op === "stored-file-write")?.address,
    canonicalAddress,
  );
});

test("durable-file storage requires the explicit files getter", async () => {
  const env = { DB: new MemoryD1(), INTEROCITOR_FILES: new MemoryFileBodyStore() };
  const mount = createInterocitorMount({
    db: (value) => value.DB,
    runtime: { meshIntegrityGates: [({ address }) => address === "main"] },
  });

  const response = await mount.fetch(
    new Request("https://example.test/io/main/stored-file?path=%2Fnote.txt"),
    env,
    createCtx(),
  );
  assert.equal(response.status, 501);
});

test("recovery wrappers live outside mesh-address IO and cannot be overwritten", async () => {
  const { env, mount } = createHarness();
  const locator = "a".repeat(43);
  const url = `https://example.test/recovery/${locator}`;
  assert.equal(mount.matches(`/recovery/${locator}`), true);

  const put = await mount.fetch(
    new Request(url, { method: "PUT", body: '{"opaque":true}' }),
    env,
    createCtx(),
  );
  assert.equal(put.status, 201);
  const get = await mount.fetch(new Request(url), env, createCtx());
  assert.equal(get.status, 200);
  assert.equal(await get.text(), '{"opaque":true}');
  const duplicate = await mount.fetch(
    new Request(url, { method: "PUT", body: '{"different":true}' }),
    env,
    createCtx(),
  );
  assert.equal(duplicate.status, 409);
});

test("the recovery storage namespace cannot be admitted as a public mesh", async () => {
  const env = { DB: new MemoryD1() };
  const locator = "a".repeat(43);
  const recoveryUrl = `https://example.test/recovery/${locator}`;
  const wrapperPath = encodeURIComponent(`/wrappers/${locator}.json`);
  const openMount = createInterocitorMount({
    db: (value) => value.DB,
    runtime: { meshIntegrityGates: [() => true] },
  });

  assert.equal(
    (
      await openMount.fetch(
        new Request(recoveryUrl, { method: "PUT", body: '{"opaque":true}' }),
        env,
        createCtx(),
      )
    ).status,
    201,
  );

  const internalAddress = "__interocitor_recovery__";
  const directUrl = `https://example.test/io/${internalAddress}/file?path=${wrapperPath}`;
  assert.equal((await openMount.fetch(new Request(directUrl), env, createCtx())).status, 404);
  assert.equal(
    (await openMount.fetch(new Request(directUrl, { method: "DELETE" }), env, createCtx())).status,
    404,
  );

  const aliasedMount = createInterocitorMount({
    db: (value) => value.DB,
    runtime: {
      resolveMeshRoute: () => ({ canonicalAddress: internalAddress }),
      meshIntegrityGates: [() => true],
    },
  });
  assert.equal(
    (
      await aliasedMount.fetch(
        new Request("https://example.test/io/public-route/file?path=/anything"),
        env,
        createCtx(),
      )
    ).status,
    503,
  );

  const recovery = await openMount.fetch(new Request(recoveryUrl), env, createCtx());
  assert.equal(recovery.status, 200);
  assert.equal(await recovery.text(), '{"opaque":true}');
});

test("the mesh authorizer delegates every IO and relay pass check to the application", async () => {
  const { env, system } = createHarness();
  const meshId = await issueMeshId(system, env);
  const authorizerCalls = [];
  const protectedMount = createInterocitorMount({
    db: (e) => e.DB,
    files: (e) => e.FILES,
    runtime: {
      meshIntegrityGates: [checksummedMeshIntegrityGate],
      meshMiddleware: [
        createMeshAuthorizationMiddleware(({ address, request }) => {
          authorizerCalls.push({ meshId: address, pass: request.headers.get("X-Mesh-Pass") });
          if (address !== meshId) return "none";
          return request.headers.get("X-Mesh-Pass") === "allowed" ? "full" : "deny";
        }),
      ],
    },
  });

  const denied = await protectedMount.fetch(
    new Request(
      `https://example.test/io/${encodeURIComponent(meshId)}/stored-file?path=%2Fprivate.txt`,
    ),
    env,
    createCtx(),
  );
  assert.equal(denied.status, 403);

  const allowed = await protectedMount.fetch(
    new Request(
      `https://example.test/io/${encodeURIComponent(meshId)}/stored-file?path=%2Fprivate.txt`,
      {
        headers: { "X-Mesh-Pass": "allowed" },
      },
    ),
    env,
    createCtx(),
  );
  assert.equal(allowed.status, 404);

  const fullWrite = await protectedMount.fetch(
    new Request(
      `https://example.test/io/${encodeURIComponent(meshId)}/stored-file?path=%2Fprivate.txt`,
      {
        method: "PUT",
        headers: {
          "X-Mesh-Pass": "allowed",
          "X-Interocitor-Device-Id": "dev-a",
        },
        body: "allowed",
      },
    ),
    env,
    createCtx(),
  );
  assert.equal(fullWrite.status, 201);

  const relayDenied = await protectedMount.fetch(
    new Request(`https://example.test/notify/${encodeURIComponent(meshId)}/health`),
    env,
    createCtx(),
  );
  assert.equal(relayDenied.status, 403);
  assert.deepEqual(authorizerCalls, [
    { meshId, pass: null },
    { meshId, pass: "allowed" },
    { meshId, pass: "allowed" },
    { meshId, pass: null },
  ]);
});

test("the mesh authorizer can leave a mesh unprotected", async () => {
  const { env, system } = createHarness();
  const meshId = await issueMeshId(system, env);
  let calls = 0;
  const protectedMount = createInterocitorMount({
    db: (e) => e.DB,
    files: (e) => e.FILES,
    runtime: {
      meshIntegrityGates: [checksummedMeshIntegrityGate],
      meshMiddleware: [
        createMeshAuthorizationMiddleware(() => {
          calls += 1;
          return "none";
        }),
      ],
    },
  });

  const response = await protectedMount.fetch(
    new Request(
      `https://example.test/io/${encodeURIComponent(meshId)}/stored-file?path=%2Fpublic.txt`,
    ),
    env,
    createCtx(),
  );
  assert.equal(response.status, 404);
  assert.equal(calls, 1);
});

test("a readonly mesh authorization allows reads and rejects writes", async () => {
  const { env, system } = createHarness();
  const meshId = await issueMeshId(system, env);
  const readonlyMount = createInterocitorMount({
    db: (e) => e.DB,
    files: (e) => e.FILES,
    runtime: {
      meshIntegrityGates: [checksummedMeshIntegrityGate],
      meshMiddleware: [createMeshAuthorizationMiddleware(() => "readonly")],
    },
  });

  const read = await readonlyMount.fetch(
    new Request(
      `https://example.test/io/${encodeURIComponent(meshId)}/stored-file?path=%2Freadonly.txt`,
    ),
    env,
    createCtx(),
  );
  assert.equal(read.status, 404);

  const write = await readonlyMount.fetch(
    new Request(
      `https://example.test/io/${encodeURIComponent(meshId)}/stored-file?path=%2Freadonly.txt`,
      {
        method: "PUT",
        headers: { "X-Interocitor-Device-Id": "dev-a" },
        body: "blocked",
      },
    ),
    env,
    createCtx(),
  );
  assert.equal(write.status, 403);
});

test("a denied or unavailable mesh authorizer fails closed", async () => {
  const { env, system } = createHarness();
  const meshId = await issueMeshId(system, env);
  const deniedAuthorizer = createInterocitorMount({
    db: (e) => e.DB,
    files: (e) => e.FILES,
    runtime: {
      meshIntegrityGates: [checksummedMeshIntegrityGate],
      meshMiddleware: [createMeshAuthorizationMiddleware(() => "deny")],
    },
  });
  const unavailableAuthorizer = createInterocitorMount({
    db: (e) => e.DB,
    files: (e) => e.FILES,
    runtime: {
      meshIntegrityGates: [checksummedMeshIntegrityGate],
      meshMiddleware: [
        createMeshAuthorizationMiddleware(() => {
          throw new Error("down");
        }),
      ],
    },
  });

  assert.equal(
    (
      await deniedAuthorizer.fetch(
        new Request(
          `https://example.test/io/${encodeURIComponent(meshId)}/file?path=%2Fmanifest.json`,
        ),
        env,
        createCtx(),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await unavailableAuthorizer.fetch(
        new Request(
          `https://example.test/io/${encodeURIComponent(meshId)}/file?path=%2Fmanifest.json`,
        ),
        env,
        createCtx(),
      )
    ).status,
    503,
  );
});

test("concealed authorization denial is indistinguishable from an invalid mesh address", async () => {
  const { env, system } = createHarness();
  const meshId = await issueMeshId(system, env);
  const mount = createInterocitorMount({
    db: (e) => e.DB,
    runtime: {
      meshIntegrityGates: [checksummedMeshIntegrityGate],
      meshMiddleware: [createMeshAuthorizationMiddleware(() => "deny", { concealDenied: true })],
    },
  });

  const denied = await mount.fetch(
    new Request(`https://example.test/io/${encodeURIComponent(meshId)}/file?path=%2Fmanifest.json`),
    env,
    createCtx(),
  );
  const invalid = await mount.fetch(
    new Request("https://example.test/io/not-a-checksummed-mesh/file?path=%2Fmanifest.json"),
    env,
    createCtx(),
  );

  assert.equal(denied.status, 404);
  assert.equal(await denied.text(), await invalid.text());
});

test("explicit CORS origins replace the default wildcard on all mount responses", async () => {
  const env = { DB: new MemoryD1(), APP_ORIGIN: "https://app.example.test" };
  const mount = createInterocitorMount({
    db: (e) => e.DB,
    cors: { allowedOrigins: (e) => [e.APP_ORIGIN] },
    runtime: { meshIntegrityGates: [({ address }) => address === "main"] },
  });

  const allowed = await mount.fetch(
    new Request("https://example.test/io/main/health", {
      headers: { Origin: env.APP_ORIGIN },
    }),
    env,
    createCtx(),
  );
  assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), env.APP_ORIGIN);
  assert.match(allowed.headers.get("Vary") || "", /Origin/i);

  const disallowed = await mount.fetch(
    new Request("https://example.test/io/main/health", {
      headers: { Origin: "https://other.example.test" },
    }),
    env,
    createCtx(),
  );
  assert.equal(disallowed.headers.get("Access-Control-Allow-Origin"), null);

  const preflight = await mount.fetch(
    new Request("https://example.test/io/main/health", {
      method: "OPTIONS",
      headers: { Origin: env.APP_ORIGIN },
    }),
    env,
    createCtx(),
  );
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), env.APP_ORIGIN);

  const system = createInterocitorSystemHandler({
    db: (e) => e.DB,
    cors: { allowedOrigins: (e) => [e.APP_ORIGIN] },
  });
  const systemPreflight = await system.fetch(
    new Request("https://example.test/__interocitor/system/bootstrap", {
      method: "OPTIONS",
      headers: { Origin: env.APP_ORIGIN },
    }),
    env,
    createCtx(),
  );
  assert.equal(systemPreflight.headers.get("Access-Control-Allow-Origin"), env.APP_ORIGIN);
});

test("withInterocitor forwards explicit CORS origins to its mounted routes", async () => {
  const env = { DB: new MemoryD1(), APP_ORIGIN: "https://app.example.test" };
  const worker = withInterocitor(undefined, {
    db: (e) => e.DB,
    cors: { allowedOrigins: (e) => [e.APP_ORIGIN] },
    runtime: { meshIntegrityGates: [({ address }) => address === "main"] },
  });

  const allowed = await worker.fetch(
    new Request("https://example.test/io/main/health", {
      headers: { Origin: env.APP_ORIGIN },
    }),
    env,
    createCtx(),
  );
  assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), env.APP_ORIGIN);
  assert.match(allowed.headers.get("Vary") || "", /Origin/i);

  const disallowed = await worker.fetch(
    new Request("https://example.test/io/main/health", {
      headers: { Origin: "https://other.example.test" },
    }),
    env,
    createCtx(),
  );
  assert.equal(disallowed.headers.get("Access-Control-Allow-Origin"), null);

  const preflight = await worker.fetch(
    new Request("https://example.test/io/main/health", {
      method: "OPTIONS",
      headers: { Origin: env.APP_ORIGIN },
    }),
    env,
    createCtx(),
  );
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), env.APP_ORIGIN);
});

test("named mesh integrity gates and middleware compose around authorization", async () => {
  const { env } = createHarness();
  const audit = [];
  const mount = createInterocitorMount({
    db: (e) => e.DB,
    files: (e) => e.FILES,
    runtime: {
      meshIntegrityGates: [({ address }) => address === "main"],
      meshMiddleware: [
        async (context, _env, next) => {
          const response = await next();
          audit.push({ address: context.address, access: context.access, status: response.status });
          return response;
        },
        createMeshAuthorizationMiddleware(({ request }) =>
          request.headers.get("X-Mesh-Pass") === "allowed" ? "full" : "deny",
        ),
      ],
    },
  });

  const denied = await mount.fetch(
    new Request("https://example.test/io/main/stored-file?path=%2Fnote.txt"),
    env,
    createCtx(),
  );
  assert.equal(denied.status, 403);

  const written = await mount.fetch(
    new Request("https://example.test/io/main/stored-file?path=%2Fnote.txt", {
      method: "PUT",
      headers: { "X-Mesh-Pass": "allowed", "X-Interocitor-Device-Id": "dev-a" },
      body: "named mesh",
    }),
    env,
    createCtx(),
  );
  assert.equal(written.status, 201);
  assert.deepEqual(audit, [
    { address: "main", access: "read", status: 403 },
    { address: "main", access: "write", status: 201 },
  ]);
});

test("mesh middleware cannot execute downstream more than once", async () => {
  const { env, system } = createHarness();
  const meshId = await issueMeshId(system, env);
  let secondStatus = 0;
  const guardedMount = createInterocitorMount({
    db: (e) => e.DB,
    files: (e) => e.FILES,
    runtime: {
      meshIntegrityGates: [checksummedMeshIntegrityGate],
      meshMiddleware: [
        async (_context, _env, next) => {
          const first = await next();
          secondStatus = (await next()).status;
          return first;
        },
      ],
    },
  });

  const response = await guardedMount.fetch(
    new Request(
      `https://example.test/io/${encodeURIComponent(meshId)}/stored-file?path=%2Fonce.txt`,
    ),
    env,
    createCtx(),
  );
  assert.equal(response.status, 404);
  assert.equal(secondStatus, 500);
});

test("the host owns policy around the optional system route handler", async () => {
  const { env, mount } = createHarness();
  const seen = [];
  const system = createInterocitorSystemHandler({
    db: (e) => e.DB,
    files: (e) => e.FILES,
  });
  assert.equal(mount.matches("/__interocitor/system/bootstrap"), false);
  assert.equal(system.matches("/__interocitor/system/bootstrap"), true);
  async function hostFetch(request) {
    const address = new URL(request.url).pathname.split("/").at(-1);
    if (!system.matches(new URL(request.url).pathname))
      return new Response("Not found", { status: 404 });
    if (request.headers.get("Authorization") !== "Bearer system") {
      seen.push({ address, status: 401 });
      return new Response("Unauthorized", { status: 401 });
    }
    const response = await system.fetch(request, env, createCtx());
    seen.push({ address, status: response.status });
    return response;
  }

  const denied = await hostFetch(
    new Request("https://example.test/__interocitor/system/bootstrap", {
      method: "POST",
      body: JSON.stringify({ op: "issue-mesh-id" }),
    }),
    env,
    createCtx(),
  );
  assert.equal(denied.status, 401);

  const allowed = await hostFetch(
    new Request("https://example.test/__interocitor/system/bootstrap", {
      method: "POST",
      headers: { Authorization: "Bearer system", "Content-Type": "application/json" },
      body: JSON.stringify({ op: "issue-mesh-id" }),
    }),
    env,
    createCtx(),
  );
  assert.equal(allowed.status, 200);
  assert.deepEqual(seen, [
    { address: "bootstrap", status: 401 },
    { address: "bootstrap", status: 200 },
  ]);
});

test("system maintenance operations preserve the JSON body for mesh integrity gates", async () => {
  const env = { DB: new MemoryD1() };
  const inspectedBodies = [];
  const system = createInterocitorSystemHandler({
    db: (e) => e.DB,
    runtime: {
      meshIntegrityGates: [
        async ({ address, request }) => {
          inspectedBodies.push(await request.json());
          return address === "main";
        },
      ],
    },
  });

  const status = await system.fetch(
    new Request("https://example.test/__interocitor/system/main", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "maintenance-status", remotePath: "/app" }),
    }),
    env,
    createCtx(),
  );
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { paths: [] });

  const run = await system.fetch(
    new Request("https://example.test/__interocitor/system/main", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "run-maintenance" }),
    }),
    env,
    createCtx(),
  );
  assert.equal(run.status, 200);
  assert.deepEqual(await run.json(), { ttlCandidates: 0, ttlDeleted: 0 });

  assert.deepEqual(inspectedBodies, [
    { op: "maintenance-status", remotePath: "/app" },
    { op: "run-maintenance" },
  ]);
});

test("a sealed file is replaced or deleted only with its seal guard", async () => {
  const auditEvents = [];
  const seen = [];
  const { env, mount, system } = createHarness({
    storageOperationAudit: (event) => auditEvents.push(event),
    authorizeFileUpload: async ({ sealed, overwritesSealed }) => {
      seen.push({ sealed, overwritesSealed });
      return true;
    },
  });
  const meshId = await issueMeshId(system, env);
  const guard = "ab".repeat(32);
  const other = "cd".repeat(32);
  const url = `https://example.test/io/${encodeURIComponent(meshId)}/stored-file?path=%2Fsealed.bin`;
  const put = (body, headers = {}) => upload(mount, env, meshId, "/sealed.bin", body, headers);
  const del = (headers = {}) =>
    mount.fetch(new Request(url, { method: "DELETE", headers }), env, createCtx());

  assert.equal((await put("v1", { "X-Interocitor-Seal-Guard": "nope" })).status, 400);
  assert.equal((await put("v1", { "X-Interocitor-Seal-Guard": guard })).status, 201);
  assert.equal((await put("v2")).status, 403);
  assert.equal((await put("v2", { "X-Interocitor-Seal-Guard": other })).status, 403);
  assert.equal((await del()).status, 403);
  assert.equal((await put("v2", { "X-Interocitor-Seal-Guard": guard })).status, 200);
  assert.equal((await del({ "X-Interocitor-Seal-Guard": guard })).status, 204);
  assert.equal((await del()).status, 404);

  assert.deepEqual(seen, [
    { sealed: true, overwritesSealed: false },
    { sealed: true, overwritesSealed: true },
  ]);
  const writes = auditEvents.filter(
    (event) => event.op === "stored-file-write" && event.path === "/sealed.bin",
  );
  assert.deepEqual(
    writes.map((event) => event.sealed),
    [true, true],
  );
  const deletes = auditEvents.filter(
    (event) => event.op === "stored-file-delete" && event.outcome === "ok",
  );
  assert.deepEqual(
    deletes.map((event) => event.sealed),
    [true],
  );
  const plain = await upload(mount, env, meshId, "/plain.bin", "x");
  assert.equal(plain.status, 201);
  assert.equal(auditEvents.find((event) => event.path === "/plain.bin").sealed, undefined);
});

test("worker audit callback receives completed storage-operation events", async () => {
  const auditEvents = [];
  const { env, mount, system } = createHarness({
    storageOperationAudit: (event) => auditEvents.push(event),
  });
  const meshId = await issueMeshId(system, env);

  assert.equal((await upload(mount, env, meshId, "/audit.txt", "hello")).status, 201);

  const write = auditEvents.find(
    (event) => event.op === "stored-file-write" && event.path === "/audit.txt",
  );
  assert.ok(write, "expected stored-file-write audit event");
  assert.equal(write.event, "interocitor.audit");
  assert.equal(write.address, meshId);
  assert.equal(write.taint, undefined);
  assert.equal(write.outcome, "ok");
  assert.ok(write.at, "expected timestamp");
});

test("durable-file stores enforce device id, file size, mesh quota, callback rejection, and delete quota recovery", async () => {
  const rejected = [];
  const { env, mount, system } = createHarness({
    authorizeFileUpload: async (uploadRequest) => {
      rejected.push({ path: uploadRequest.path, taint: uploadRequest.taint });
      assert.equal(uploadRequest.contentType, undefined);
      if (uploadRequest.path.includes("blocked"))
        return { allowed: false, status: 418, reason: "blocked" };
      return true;
    },
  });
  const meshId = await issueMeshId(system, env);

  assert.equal(
    (
      await upload(mount, env, meshId, "/missing-device.txt", "x", {
        "X-Interocitor-Device-Id": "",
      })
    ).status,
    401,
  );
  assert.equal((await upload(mount, env, meshId, "/too-large.txt", "01234567890")).status, 413);
  assert.equal((await upload(mount, env, meshId, "/blocked.txt", "ok")).status, 418);

  assert.equal((await upload(mount, env, meshId, "/a.txt", "123456")).status, 201);
  assert.equal((await upload(mount, env, meshId, "/b.txt", "123456")).status, 201);
  assert.equal((await upload(mount, env, meshId, "/c.txt", "1")).status, 413);

  const del = await mount.fetch(
    new Request(`https://example.test/io/${encodeURIComponent(meshId)}/stored-file?path=%2Fa.txt`, {
      method: "DELETE",
    }),
    env,
    createCtx(),
  );
  assert.equal(del.status, 204);
  assert.equal((await upload(mount, env, meshId, "/c.txt", "1")).status, 201);
  assert.deepEqual(
    rejected.find((item) => item.path === "/blocked.txt"),
    { path: "/blocked.txt", taint: undefined },
  );
});

test("malformed durable-file upload policy configuration and results fail closed", async () => {
  const malformedPolicies = [
    false,
    0,
    "",
    null,
    () => ({ allowed: "false" }),
    () => "not a decision",
    () => {
      throw new Error("policy unavailable");
    },
  ];

  for (const authorizeFileUpload of malformedPolicies) {
    const { env, mount, system } = createHarness({ authorizeFileUpload });
    const meshId = await issueMeshId(system, env);
    const response = await upload(mount, env, meshId, "/must-not-write.txt", "safe");
    assert.equal(response.status, 503);
    assert.equal(env.FILES.objects.size, 0);
  }
});

test("scheduled maintenance treats an omitted TTL as disabled", async () => {
  let queries = 0;
  let enableCalls = 0;
  const db = {
    prepare() {
      queries += 1;
      throw new Error("maintenance must not query storage when TTL is disabled");
    },
    async batch() {
      throw new Error("maintenance must not delete storage when TTL is disabled");
    },
  };
  const worker = withInterocitor(undefined, {
    db: () => db,
    runtime: {
      enableScheduledMaintenance: () => {
        enableCalls += 1;
        return true;
      },
    },
  });

  await worker.scheduled({}, {}, createCtx());
  assert.equal(enableCalls, 1);
  assert.equal(queries, 0);
});

test("scheduled maintenance completes its TTL sweep before returning", async () => {
  let completed = false;
  const statement = {
    bind() {
      return this;
    },
    async all() {
      return {
        results: [
          {
            prefix: "main",
            remote_root: "/app",
            last_operation_at: "2000-01-01T00:00:00.000Z",
            deleted_at: null,
          },
        ],
      };
    },
    async run() {
      return { meta: { changes: 1 } };
    },
  };
  const db = {
    prepare() {
      return statement;
    },
    async batch() {
      await Promise.resolve();
      completed = true;
      return [];
    },
  };
  const worker = withInterocitor(undefined, {
    db: () => db,
    runtime: {
      enableScheduledMaintenance: () => true,
      pathTtlHours: () => 24,
    },
  });

  await worker.scheduled({}, {}, createCtx());
  assert.equal(completed, true);
});
