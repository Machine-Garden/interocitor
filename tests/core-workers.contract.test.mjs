import assert from "node:assert/strict";
import test from "node:test";

import { isValidMeshId, issueMeshId, parseMeshId } from "@interocitor/core";
import { CloudflareAdapter } from "@interocitor/core/adapters/cloudflare";
import {
  checksummedMeshIntegrityGate,
  createInterocitorMount,
  createInterocitorSystemHandler,
} from "@interocitor/workers";

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
    if (/^\s*SELECT\b/i.test(this.sql)) {
      return {
        success: true,
        results: this.db.all(this.sql, this.params),
        meta: { changes: 0 },
      };
    }
    return this.db.run(this.sql, this.params);
  }
}

class MemoryD1 {
  constructor() {
    this.files = new Map();
    this.folders = new Map();
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
    if (sql.includes("FROM files WHERE prefix=?1 AND path=?2")) {
      const row = this.files.get(this.key(params[0], params[1]));
      return row ? { ...row, content: row.content.slice() } : null;
    }
    return null;
  }

  all(sql, params) {
    if (sql.includes("SELECT path, size, modified_time, etag FROM files")) {
      const [prefix, pattern] = params;
      const parent = pattern === "/%" ? "/" : pattern.slice(0, -2);
      return [...this.files.values()]
        .filter((row) => row.prefix === prefix && isDirectChild(parent, row.path))
        .map(({ path, size, modified_time, etag }) => ({ path, size, modified_time, etag }));
    }

    if (sql.includes("SELECT path FROM folders")) {
      const [prefix, pattern] = params;
      const parent = pattern === "/%" ? "/" : pattern.slice(0, -2);
      return [...this.folders.values()]
        .filter((row) => row.prefix === prefix && isDirectChild(parent, row.path))
        .map(({ path }) => ({ path }));
    }

    if (sql.includes("SELECT path, size FROM files")) {
      const [prefix, exact, start, end] = params;
      return [...this.files.values()]
        .filter(
          (row) =>
            row.prefix === prefix &&
            (exact === undefined || row.path === exact || (row.path >= start && row.path < end)),
        )
        .map(({ path, size }) => ({ path, size }));
    }

    return [];
  }

  run(sql, params) {
    if (sql.includes("INSERT OR IGNORE INTO folders")) {
      const [prefix, path, created_at] = params;
      const key = this.key(prefix, path);
      if (this.folders.has(key)) return d1Result(0);
      this.folders.set(key, { prefix, path, created_at });
      return d1Result(1);
    }

    if (sql.includes("INSERT OR IGNORE INTO files")) {
      const [prefix, path, content, size, modified_time, etag] = params;
      const key = this.key(prefix, path);
      if (this.files.has(key)) return d1Result(0);
      this.files.set(key, fileRow(prefix, path, content, size, modified_time, etag));
      return d1Result(1);
    }

    if (sql.includes("INSERT INTO files")) {
      const [prefix, path, content, size, modified_time, etag] = params;
      this.files.set(
        this.key(prefix, path),
        fileRow(prefix, path, content, size, modified_time, etag),
      );
      return d1Result(1);
    }

    if (sql.includes("DELETE FROM files")) {
      return d1Result(deleteRows(this.files, params));
    }

    if (sql.includes("DELETE FROM folders")) {
      return d1Result(deleteRows(this.folders, params));
    }

    return d1Result(sql.includes("mesh_paths") ? 1 : 0);
  }
}

class MemoryFileBodyStore {
  constructor() {
    this.objects = new Map();
  }

  async get(key) {
    const value = this.objects.get(key);
    return value
      ? {
          body: new Blob([value.bytes]).stream(),
          size: value.bytes.byteLength,
          etag: value.etag,
        }
      : null;
  }

  async put(key, value) {
    const bytes = await toBytes(value);
    const etag = `memory-${this.objects.size + 1}`;
    this.objects.set(key, { bytes, etag });
    return { etag };
  }

  async delete(key) {
    this.objects.delete(key);
  }
}

function d1Result(changes) {
  return { success: true, results: [], meta: { changes } };
}

function fileRow(prefix, path, content, size, modified_time, etag) {
  const bytes = content instanceof Uint8Array ? content.slice() : new Uint8Array(content);
  return { prefix, path, content: bytes, size, modified_time, etag };
}

function isDirectChild(parent, path) {
  const childPrefix = parent === "/" ? "/" : `${parent}/`;
  if (!path.startsWith(childPrefix)) return false;
  const rest = path.slice(childPrefix.length);
  return rest.length > 0 && !rest.includes("/");
}

function deleteRows(rows, params) {
  const [prefix, exact, start, end] = params;
  let changes = 0;
  for (const [key, row] of rows) {
    const selected =
      row.prefix === prefix &&
      (exact === undefined || row.path === exact || (row.path >= start && row.path < end));
    if (selected) {
      rows.delete(key);
      changes += 1;
    }
  }
  return changes;
}

async function toBytes(value) {
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  return new TextEncoder().encode(String(value));
}

function executionContext() {
  return { waitUntil() {} };
}

function systemRequest(mountPrefix, anchor, body) {
  return new Request(`https://worker.test${mountPrefix}/__interocitor/system/${anchor}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function importMeshSecret(value) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(value),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

test("Core public surfaces conform to the public Workers mount and system handler", async (t) => {
  const mountPrefix = "/sync";
  const meshSecretValue = "core-workers-contract-secret";
  const env = {
    DB: new MemoryD1(),
    FILES: new MemoryFileBodyStore(),
    MESH_SECRET: meshSecretValue,
  };
  const options = {
    mountPrefix,
    db: (value) => value.DB,
    files: (value) => value.FILES,
    runtime: {
      meshIntegrityGates: [checksummedMeshIntegrityGate],
      meshSecret: (value) => value.MESH_SECRET,
    },
  };
  const mount = createInterocitorMount(options);
  const system = createInterocitorSystemHandler(options);
  const meshSecret = await importMeshSecret(meshSecretValue);

  assert.equal(mount.matches(`${mountPrefix}/io/example/health`), true);
  assert.equal(system.matches(`${mountPrefix}/__interocitor/system/provision`), true);

  const coreMeshId = await issueMeshId(meshSecret);
  const workerValidation = await system.fetch(
    systemRequest(mountPrefix, "validate", {
      op: "validate-mesh-id",
      meshId: coreMeshId,
    }),
    env,
    executionContext(),
  );
  assert.equal(workerValidation.status, 200);
  assert.deepEqual(await workerValidation.json(), { valid: true });

  const workerIssue = await system.fetch(
    systemRequest(mountPrefix, "provision", { op: "issue-mesh-id" }),
    env,
    executionContext(),
  );
  assert.equal(workerIssue.status, 200);
  const workerIssuePayload = await workerIssue.json();
  assert.deepEqual(Object.keys(workerIssuePayload), ["meshId"]);
  assert.ok(parseMeshId(workerIssuePayload.meshId));
  assert.equal(await isValidMeshId(workerIssuePayload.meshId, meshSecret), true);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const request =
      input instanceof Request && init === undefined ? input : new Request(input, init);
    return mount.fetch(request, env, executionContext());
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const adapter = new CloudflareAdapter({
    baseUrl: `https://worker.test${mountPrefix}/io/${encodeURIComponent(coreMeshId)}`,
    relayEnabled: false,
  });
  await adapter.authenticate();

  const folder = "/Contract/changes";
  const path = `${folder}/000000000000001-0000-contract-chg_bridge.json`;
  const bytes = new TextEncoder().encode('{"contract":"core-workers"}');
  await adapter.ensureFolder(folder);
  await adapter.writeFile(path, bytes);

  const listed = await adapter.listFiles(folder);
  assert.equal(listed.length, 1);
  assert.deepEqual(
    new Set(Object.keys(listed[0])),
    new Set(["etag", "modifiedTime", "name", "path", "size"]),
  );
  assert.equal(listed[0].name, path.split("/").at(-1));
  assert.equal(listed[0].path, path);
  assert.equal(listed[0].size, bytes.byteLength);
  assert.match(listed[0].modifiedTime, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(typeof listed[0].etag, "string");

  const metadata = await adapter.getFileMetadata(path);
  assert.deepEqual(metadata, listed[0]);
  assert.deepEqual(await adapter.readFile(path), bytes);

  await adapter.deleteFile(path);
  assert.deepEqual(await adapter.listFiles(folder), []);
  assert.equal(await adapter.getFileMetadata(path), null);
  await assert.rejects(adapter.readFile(path), /HTTP 404/);

  const manifestPath = "/Contract/manifest.json";
  const generationTwo = JSON.stringify({ currentGeneration: 2, file: "manifest-2.json" });
  await adapter.writeFile(manifestPath, generationTwo);
  await assert.rejects(
    adapter.writeFile(
      manifestPath,
      JSON.stringify({ currentGeneration: 1, file: "manifest-1.json" }),
    ),
    /HTTP 409/,
  );
  assert.deepEqual(
    JSON.parse(new TextDecoder().decode(await adapter.readFile(manifestPath))),
    JSON.parse(generationTwo),
  );

  const headPath = "/Contract/changes/head.json";
  const laterHead = JSON.stringify({ latestHlc: "999999999999999-0000-contract" });
  await adapter.writeFile(headPath, laterHead);
  await assert.rejects(
    adapter.writeFile(headPath, JSON.stringify({ latestHlc: "000000000000001-0000-contract" })),
    /HTTP 409/,
  );
  assert.deepEqual(
    JSON.parse(new TextDecoder().decode(await adapter.readFile(headPath))),
    JSON.parse(laterHead),
  );
});
