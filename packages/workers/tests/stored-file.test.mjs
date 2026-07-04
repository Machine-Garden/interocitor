import assert from 'node:assert/strict';
import test from 'node:test';
import { createInterocitorMount } from '../dist/worker.js';

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

async function issueMeshId(mount, env) {
  const response = await mount.fetch(new Request('https://example.test/__interocitor/system/bootstrap', {
    method: 'POST',
    headers: { Authorization: 'Bearer system', 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'issue-mesh-id' }),
  }), env, createCtx());
  assert.equal(response.status, 200);
  return (await response.json()).meshId;
}

function createHarness(runtime = {}) {
  const env = { DB: new MemoryD1(), FILES: new MemoryR2() };
  const mount = createInterocitorMount({
    db: (e) => e.DB,
    files: (e) => e.FILES,
    runtime: {
      systemToken: () => 'system',
      maxStoredFileBytes: () => 10,
      maxMeshStoredBytes: () => 12,
      ...runtime,
    },
  });
  return { env, mount };
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

test('R2 stored files support PUT, GET, metadata, use count, and DELETE', async () => {
  const { env, mount } = createHarness();
  const meshId = await issueMeshId(mount, env);

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

test('worker audit callback receives operation events as a pure callback', async () => {
  const auditEvents = [];
  const { env, mount } = createHarness({ audit: (event) => auditEvents.push(event) });
  const meshId = await issueMeshId(mount, env);

  assert.equal((await upload(mount, env, meshId, '/audit.txt', 'hello', { 'X-Interocitor-Taint': 'group-a' })).status, 201);

  const write = auditEvents.find((event) => event.op === 'stored-file-write' && event.path === '/audit.txt');
  assert.ok(write, 'expected stored-file-write audit event');
  assert.equal(write.event, 'interocitor.audit');
  assert.equal(write.taint, 'group-a');
  assert.equal(write.outcome, 'ok');
  assert.ok(write.at, 'expected timestamp');
});

test('R2 stored files enforce device id, file size, mesh quota, callback rejection, and delete quota recovery', async () => {
  const rejected = [];
  const { env, mount } = createHarness({
    authorizeFileUpload: async (upload) => {
      rejected.push({ path: upload.path, taint: upload.taint });
      if (upload.path.includes('blocked')) return { allowed: false, status: 418, reason: 'blocked' };
      return true;
    },
  });
  const meshId = await issueMeshId(mount, env);

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
