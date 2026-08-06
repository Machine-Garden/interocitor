import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checksummedMeshIntegrityGate,
  createInterocitorMount,
  createMeshAuthorizationMiddleware,
  createInterocitorSystemHandler,
  withInterocitor,
} from '../dist/worker.js';

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
    if (sql.includes('SELECT content, size, modified_time, etag FROM files')) {
      const [prefix, path] = params;
      return this.files.get(this.key(prefix, path)) ?? null;
    }
    if (sql.includes('COALESCE(SUM(size)')) {
      const [prefix] = params;
      let total = 0;
      for (const row of this.storedFiles.values()) {
        if (row.prefix === prefix) total += row.size;
      }
      return { total };
    }
    if (sql.includes('SELECT size, r2_key FROM stored_files')) {
      const [prefix, path] = params;
      const row = this.storedFiles.get(this.key(prefix, path));
      return row ? { size: row.size, r2_key: row.r2_key } : null;
    }
    if (sql.includes('SELECT * FROM stored_files')) {
      const [prefix, path] = params;
      return this.storedFiles.get(this.key(prefix, path)) ?? null;
    }
    if (sql.includes('SELECT r2_key') && sql.includes('FROM stored_files')) {
      const [prefix, path] = params;
      const row = this.storedFiles.get(this.key(prefix, path));
      return row ? { r2_key: row.r2_key, size: row.size, taint: row.taint } : null;
    }
    return null;
  }

  all() {
    return [];
  }

  run(sql, params) {
    if (sql.includes('INSERT OR IGNORE INTO folders')) {
      const [prefix, path] = params;
      const key = this.key(prefix, path);
      if (this.folders.has(key)) return { success: true, meta: { changes: 0 } };
      this.folders.add(key);
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes('INSERT OR IGNORE INTO files')) {
      const [prefix, path, content, size, modified_time, etag] = params;
      const key = this.key(prefix, path);
      if (this.files.has(key)) return { success: true, meta: { changes: 0 } };
      this.files.set(key, { content, size, modified_time, etag });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes('mesh_paths')) {
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes('INSERT INTO stored_files')) {
      const [prefix, path, r2_key, size, plaintext_size, content_type, taint, uploaded_by_device_id, uploaded_at, etag] = params;
      this.storedFiles.set(this.key(prefix, path), {
        prefix,
        path,
        r2_key,
        size,
        plaintext_size,
        content_type,
        taint,
        uploaded_by_device_id,
        uploaded_at,
        modified_time: uploaded_at,
        last_accessed_at: null,
        use_count: 0,
        etag,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes('UPDATE stored_files SET last_accessed_at')) {
      const [prefix, path, last_accessed_at] = params;
      const row = this.storedFiles.get(this.key(prefix, path));
      if (row) {
        row.last_accessed_at = last_accessed_at;
        row.use_count += 1;
      }
      return { success: true, meta: { changes: row ? 1 : 0 } };
    }
    if (sql.includes('DELETE FROM stored_files')) {
      const [prefix, path] = params;
      const deleted = this.storedFiles.delete(this.key(prefix, path));
      return { success: true, meta: { changes: deleted ? 1 : 0 } };
    }
    return { success: true, meta: { changes: 0 } };
  }
}

class MemoryR2Object {
  constructor(bytes, contentType, etag) {
    this.bytes = bytes;
    this.size = bytes.byteLength;
    this.etag = etag;
    this.httpEtag = etag;
    this.body = new Blob([bytes]).stream();
    this.contentType = contentType;
  }

  writeHttpMetadata(headers) {
    if (this.contentType) headers.set('Content-Type', this.contentType);
  }
}

class MemoryR2 {
  constructor() {
    this.objects = new Map();
  }

  async get(key) {
    return this.objects.get(key) ?? null;
  }

  async put(key, value, options = {}) {
    let bytes;
    if (value instanceof Uint8Array) bytes = value;
    else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
    else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    else if (value instanceof Blob) bytes = new Uint8Array(await value.arrayBuffer());
    else if (typeof value === 'string') bytes = new TextEncoder().encode(value);
    else bytes = new Uint8Array();
    const etag = `etag-${this.objects.size + 1}`;
    this.objects.set(key, new MemoryR2Object(bytes, options.httpMetadata?.contentType, etag));
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
  const response = await system.fetch(new Request('https://example.test/__interocitor/system/bootstrap', {
    method: 'POST',
    headers: { Authorization: 'Bearer system', 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'issue-mesh-id' }),
  }), env, createCtx());
  assert.equal(response.status, 200);
  return (await response.json()).meshId;
}

function createHarness(runtime = {}) {
  const env = { DB: new MemoryD1(), FILES: new MemoryR2() };
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
  return mount.fetch(new Request(`https://example.test/io/${encodeURIComponent(meshId)}/stored-file?path=${encodeURIComponent(path)}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'text/plain',
      'X-Interocitor-Device-Id': 'dev-a',
      'X-Interocitor-Plaintext-Size': String(body.length),
      ...headers,
    },
    body,
  }), env, createCtx());
}

test('durable-file object stores support PUT, GET, metadata, use count, and DELETE', async () => {
  const { env, mount, system } = createHarness();
  const meshId = await issueMeshId(system, env);

  const put = await upload(mount, env, meshId, '/docs/a.txt', 'hello', { 'X-Interocitor-Taint': 'group1' });
  assert.equal(put.status, 201);
  const putJson = await put.json();
  assert.equal(putJson.file.uploadedByDeviceId, 'dev-a');
  assert.equal(putJson.file.size, 5);
  assert.equal(putJson.file.plaintextSize, 5);
  assert.equal(putJson.file.taint, 'group1');

  const get = await mount.fetch(new Request(`https://example.test/io/${encodeURIComponent(meshId)}/stored-file?path=%2Fdocs%2Fa.txt`), env, createCtx());
  assert.equal(get.status, 200);
  assert.equal(await get.text(), 'hello');

  const metadata = await mount.fetch(new Request(`https://example.test/io/${encodeURIComponent(meshId)}/stored-file-metadata`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '/docs/a.txt' }),
  }), env, createCtx());
  assert.equal(metadata.status, 200);
  const metaJson = await metadata.json();
  assert.equal(metaJson.file.useCount, 1);
  assert.equal(metaJson.file.taint, 'group1');
  assert.ok(metaJson.file.lastAccessedAt);

  const del = await mount.fetch(new Request(`https://example.test/io/${encodeURIComponent(meshId)}/stored-file?path=%2Fdocs%2Fa.txt`, { method: 'DELETE' }), env, createCtx());
  assert.equal(del.status, 204);

  const missing = await mount.fetch(new Request(`https://example.test/io/${encodeURIComponent(meshId)}/stored-file?path=%2Fdocs%2Fa.txt`), env, createCtx());
  assert.equal(missing.status, 404);
});

test('durable-file storage can be selected by accepted mesh address', async () => {
  const env = { DB: new MemoryD1(), FILES: new MemoryR2() };
  const selections = [];
  const mount = createInterocitorMount({
    db: (value) => value.DB,
    files: (value, { address }) => {
      selections.push(address);
      return value.FILES;
    },
    runtime: { meshIntegrityGates: [({ address }) => address === 'sensitive-au'] },
  });

  const put = await upload(mount, env, 'sensitive-au', '/private.txt', 'secret');
  assert.equal(put.status, 201);
  const get = await mount.fetch(
    new Request('https://example.test/io/sensitive-au/stored-file?path=%2Fprivate.txt'),
    env,
    createCtx(),
  );
  assert.equal(get.status, 200);
  assert.equal(await get.text(), 'secret');
  assert.deepEqual(selections, ['sensitive-au', 'sensitive-au']);
});

test('durable-file storage requires the explicit files getter', async () => {
  const env = { DB: new MemoryD1(), INTEROCITOR_FILES: new MemoryR2() };
  const mount = createInterocitorMount({
    db: (value) => value.DB,
    runtime: { meshIntegrityGates: [({ address }) => address === 'main'] },
  });

  const response = await mount.fetch(
    new Request('https://example.test/io/main/stored-file?path=%2Fnote.txt'),
    env,
    createCtx(),
  );
  assert.equal(response.status, 501);
});

test('recovery wrappers live outside mesh-address IO and cannot be overwritten', async () => {
  const { env, mount } = createHarness();
  const locator = 'a'.repeat(43);
  const url = `https://example.test/recovery/${locator}`;
  assert.equal(mount.matches(`/recovery/${locator}`), true);

  const put = await mount.fetch(new Request(url, { method: 'PUT', body: '{"opaque":true}' }), env, createCtx());
  assert.equal(put.status, 201);
  const get = await mount.fetch(new Request(url), env, createCtx());
  assert.equal(get.status, 200);
  assert.equal(await get.text(), '{"opaque":true}');
  const duplicate = await mount.fetch(new Request(url, { method: 'PUT', body: '{"different":true}' }), env, createCtx());
  assert.equal(duplicate.status, 409);
});

test('the mesh authorizer delegates every IO and relay pass check to the application', async () => {
  const { env, mount, system } = createHarness();
  const meshId = await issueMeshId(system, env);
  const authorizerCalls = [];
  const protectedMount = createInterocitorMount({
    db: (e) => e.DB,
    files: (e) => e.FILES,
    runtime: {
      meshIntegrityGates: [checksummedMeshIntegrityGate],
      meshMiddleware: [createMeshAuthorizationMiddleware(({ address, request }) => {
        authorizerCalls.push({ meshId: address, pass: request.headers.get('X-Mesh-Pass') });
        if (address !== meshId) return 'none';
        return request.headers.get('X-Mesh-Pass') === 'allowed' ? 'full' : 'deny';
      })],
    },
  });

  const denied = await protectedMount.fetch(new Request(`https://example.test/io/${encodeURIComponent(meshId)}/stored-file?path=%2Fprivate.txt`), env, createCtx());
  assert.equal(denied.status, 403);

  const allowed = await protectedMount.fetch(new Request(`https://example.test/io/${encodeURIComponent(meshId)}/stored-file?path=%2Fprivate.txt`, {
    headers: { 'X-Mesh-Pass': 'allowed' },
  }), env, createCtx());
  assert.equal(allowed.status, 404);

  const fullWrite = await protectedMount.fetch(new Request(`https://example.test/io/${encodeURIComponent(meshId)}/stored-file?path=%2Fprivate.txt`, {
    method: 'PUT',
    headers: {
      'X-Mesh-Pass': 'allowed',
      'X-Interocitor-Device-Id': 'dev-a',
    },
    body: 'allowed',
  }), env, createCtx());
  assert.equal(fullWrite.status, 201);

  const relayDenied = await protectedMount.fetch(new Request(`https://example.test/notify/${encodeURIComponent(meshId)}/health`), env, createCtx());
  assert.equal(relayDenied.status, 403);
  assert.deepEqual(authorizerCalls, [
    { meshId, pass: null },
    { meshId, pass: 'allowed' },
    { meshId, pass: 'allowed' },
    { meshId, pass: null },
  ]);
});

test('the mesh authorizer can leave a mesh unprotected', async () => {
  const { env, mount, system } = createHarness();
  const meshId = await issueMeshId(system, env);
  let calls = 0;
  const protectedMount = createInterocitorMount({
    db: (e) => e.DB,
    files: (e) => e.FILES,
    runtime: {
      meshIntegrityGates: [checksummedMeshIntegrityGate],
      meshMiddleware: [createMeshAuthorizationMiddleware(() => {
        calls += 1;
        return 'none';
      })],
    },
  });

  const response = await protectedMount.fetch(new Request(`https://example.test/io/${encodeURIComponent(meshId)}/stored-file?path=%2Fpublic.txt`), env, createCtx());
  assert.equal(response.status, 404);
  assert.equal(calls, 1);
});

test('a readonly mesh authorization allows reads and rejects writes', async () => {
  const { env, mount, system } = createHarness();
  const meshId = await issueMeshId(system, env);
  const readonlyMount = createInterocitorMount({
    db: (e) => e.DB,
    files: (e) => e.FILES,
    runtime: { meshIntegrityGates: [checksummedMeshIntegrityGate], meshMiddleware: [createMeshAuthorizationMiddleware(() => 'readonly')] },
  });

  const read = await readonlyMount.fetch(new Request(`https://example.test/io/${encodeURIComponent(meshId)}/stored-file?path=%2Freadonly.txt`), env, createCtx());
  assert.equal(read.status, 404);

  const write = await readonlyMount.fetch(new Request(`https://example.test/io/${encodeURIComponent(meshId)}/stored-file?path=%2Freadonly.txt`, {
    method: 'PUT',
    headers: { 'X-Interocitor-Device-Id': 'dev-a' },
    body: 'blocked',
  }), env, createCtx());
  assert.equal(write.status, 403);
});

test('a denied or unavailable mesh authorizer fails closed', async () => {
  const { env, mount, system } = createHarness();
  const meshId = await issueMeshId(system, env);
  const deniedAuthorizer = createInterocitorMount({
    db: (e) => e.DB,
    files: (e) => e.FILES,
    runtime: {
      meshIntegrityGates: [checksummedMeshIntegrityGate],
      meshMiddleware: [createMeshAuthorizationMiddleware(() => 'deny')],
    },
  });
  const unavailableAuthorizer = createInterocitorMount({
    db: (e) => e.DB,
    files: (e) => e.FILES,
    runtime: {
      meshIntegrityGates: [checksummedMeshIntegrityGate],
      meshMiddleware: [createMeshAuthorizationMiddleware(() => { throw new Error('down'); })],
    },
  });

  assert.equal((await deniedAuthorizer.fetch(new Request(`https://example.test/io/${encodeURIComponent(meshId)}/file?path=%2Fmanifest.json`), env, createCtx())).status, 403);
  assert.equal((await unavailableAuthorizer.fetch(new Request(`https://example.test/io/${encodeURIComponent(meshId)}/file?path=%2Fmanifest.json`), env, createCtx())).status, 503);
});

test('named mesh integrity gates and middleware compose around authorization', async () => {
  const { env } = createHarness();
  const audit = [];
  const mount = createInterocitorMount({
    db: (e) => e.DB,
    files: (e) => e.FILES,
    runtime: {
      meshIntegrityGates: [({ address }) => address === 'main'],
      meshMiddleware: [
        async (context, _env, next) => {
          const response = await next();
          audit.push({ address: context.address, access: context.access, status: response.status });
          return response;
        },
        createMeshAuthorizationMiddleware(({ request }) => request.headers.get('X-Mesh-Pass') === 'allowed' ? 'full' : 'deny'),
      ],
    },
  });

  const denied = await mount.fetch(new Request('https://example.test/io/main/stored-file?path=%2Fnote.txt'), env, createCtx());
  assert.equal(denied.status, 403);

  const written = await mount.fetch(new Request('https://example.test/io/main/stored-file?path=%2Fnote.txt', {
    method: 'PUT',
    headers: { 'X-Mesh-Pass': 'allowed', 'X-Interocitor-Device-Id': 'dev-a' },
    body: 'named mesh',
  }), env, createCtx());
  assert.equal(written.status, 201);
  assert.deepEqual(audit, [
    { address: 'main', access: 'read', status: 403 },
    { address: 'main', access: 'write', status: 201 },
  ]);
});

test('mesh middleware cannot execute downstream more than once', async () => {
  const { env, mount, system } = createHarness();
  const meshId = await issueMeshId(system, env);
  let secondStatus = 0;
  const guardedMount = createInterocitorMount({
    db: (e) => e.DB,
    files: (e) => e.FILES,
    runtime: {
      meshIntegrityGates: [checksummedMeshIntegrityGate],
      meshMiddleware: [async (_context, _env, next) => {
        const first = await next();
        secondStatus = (await next()).status;
        return first;
      }],
    },
  });

  const response = await guardedMount.fetch(new Request(`https://example.test/io/${encodeURIComponent(meshId)}/stored-file?path=%2Fonce.txt`), env, createCtx());
  assert.equal(response.status, 404);
  assert.equal(secondStatus, 500);
});

test('the host owns policy around the optional system route handler', async () => {
  const { env, mount } = createHarness();
  const seen = [];
  const system = createInterocitorSystemHandler({
    db: (e) => e.DB,
    files: (e) => e.FILES,
  });
  assert.equal(mount.matches('/__interocitor/system/bootstrap'), false);
  assert.equal(system.matches('/__interocitor/system/bootstrap'), true);
  async function hostFetch(request) {
    const address = new URL(request.url).pathname.split('/').at(-1);
    if (!system.matches(new URL(request.url).pathname)) return new Response('Not found', { status: 404 });
    if (request.headers.get('Authorization') !== 'Bearer system') {
      seen.push({ address, status: 401 });
      return new Response('Unauthorized', { status: 401 });
    }
    const response = await system.fetch(request, env, createCtx());
    seen.push({ address, status: response.status });
    return response;
  }

  const denied = await hostFetch(new Request('https://example.test/__interocitor/system/bootstrap', {
    method: 'POST',
    body: JSON.stringify({ op: 'issue-mesh-id' }),
  }), env, createCtx());
  assert.equal(denied.status, 401);

  const allowed = await hostFetch(new Request('https://example.test/__interocitor/system/bootstrap', {
    method: 'POST',
    headers: { Authorization: 'Bearer system', 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'issue-mesh-id' }),
  }), env, createCtx());
  assert.equal(allowed.status, 200);
  assert.deepEqual(seen, [
    { address: 'bootstrap', status: 401 },
    { address: 'bootstrap', status: 200 },
  ]);
});

test('worker audit callback receives completed storage-operation events', async () => {
  const auditEvents = [];
  const { env, mount, system } = createHarness({ storageOperationAudit: (event) => auditEvents.push(event) });
  const meshId = await issueMeshId(system, env);

  assert.equal((await upload(mount, env, meshId, '/audit.txt', 'hello', { 'X-Interocitor-Taint': 'group-a' })).status, 201);

  const write = auditEvents.find((event) => event.op === 'stored-file-write' && event.path === '/audit.txt');
  assert.ok(write, 'expected stored-file-write audit event');
  assert.equal(write.event, 'interocitor.audit');
  assert.equal(write.address, meshId);
  assert.equal(write.taint, 'group-a');
  assert.equal(write.outcome, 'ok');
  assert.ok(write.at, 'expected timestamp');
});

test('durable-file stores enforce device id, file size, mesh quota, callback rejection, and delete quota recovery', async () => {
  const rejected = [];
  const { env, mount, system } = createHarness({
    authorizeFileUpload: async (upload) => {
      rejected.push({ path: upload.path, taint: upload.taint });
      if (upload.path.includes('blocked')) return { allowed: false, status: 418, reason: 'blocked' };
      return true;
    },
  });
  const meshId = await issueMeshId(system, env);

  assert.equal((await upload(mount, env, meshId, '/missing-device.txt', 'x', { 'X-Interocitor-Device-Id': '' })).status, 401);
  assert.equal((await upload(mount, env, meshId, '/too-large.txt', '01234567890')).status, 413);
  assert.equal((await upload(mount, env, meshId, '/blocked.txt', 'ok', { 'X-Interocitor-Taint': 'group2' })).status, 418);

  assert.equal((await upload(mount, env, meshId, '/a.txt', '123456')).status, 201);
  assert.equal((await upload(mount, env, meshId, '/b.txt', '123456')).status, 201);
  assert.equal((await upload(mount, env, meshId, '/c.txt', '1')).status, 413);

  const del = await mount.fetch(new Request(`https://example.test/io/${encodeURIComponent(meshId)}/stored-file?path=%2Fa.txt`, { method: 'DELETE' }), env, createCtx());
  assert.equal(del.status, 204);
  assert.equal((await upload(mount, env, meshId, '/c.txt', '1')).status, 201);
  assert.deepEqual(rejected.find((item) => item.path === '/blocked.txt'), { path: '/blocked.txt', taint: 'group2' });
});

test('scheduled maintenance treats an omitted TTL as disabled', async () => {
  let queries = 0;
  let enableCalls = 0;
  const db = {
    prepare() {
      queries += 1;
      throw new Error('maintenance must not query storage when TTL is disabled');
    },
    async batch() {
      throw new Error('maintenance must not delete storage when TTL is disabled');
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

test('scheduled maintenance completes its TTL sweep before returning', async () => {
  let completed = false;
  const statement = {
    bind() { return this; },
    async all() {
      return {
        results: [{
          prefix: 'main',
          remote_root: '/app',
          last_operation_at: '2000-01-01T00:00:00.000Z',
          deleted_at: null,
        }],
      };
    },
    async run() { return { meta: { changes: 1 } }; },
  };
  const db = {
    prepare() { return statement; },
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
