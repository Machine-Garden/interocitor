import assert from "node:assert/strict";
import test from "node:test";
import { R2FileBodyStore } from "../dist/index.js";

test("R2 file-body store translates the generic contract to an R2 binding", async () => {
  const calls = [];
  const bucket = {
    async get(key) {
      calls.push({ op: "get", key });
      return {
        body: new Blob(["stored"]).stream(),
        size: 6,
        etag: "raw-etag",
        httpEtag: '"http-etag"',
      };
    },
    async put(key, value, options) {
      calls.push({ op: "put", key, value, options });
      return { etag: "put-etag" };
    },
    async delete(key) {
      calls.push({ op: "delete", key });
    },
  };
  const store = new R2FileBodyStore(bucket);

  const value = new TextEncoder().encode("stored");
  await store.put("meshes/main/files/report.txt", value, {
    contentType: "text/plain",
  });
  const body = await store.get("meshes/main/files/report.txt");
  assert.ok(body);
  assert.equal(body.size, 6);
  assert.equal(body.etag, '"http-etag"');
  assert.equal(await new Response(body.body).text(), "stored");
  await store.delete("meshes/main/files/report.txt");

  assert.deepEqual(calls[0], {
    op: "put",
    key: "meshes/main/files/report.txt",
    value,
    options: {
      httpMetadata: { contentType: "text/plain" },
    },
  });
  assert.deepEqual(calls.slice(1), [
    { op: "get", key: "meshes/main/files/report.txt" },
    { op: "delete", key: "meshes/main/files/report.txt" },
  ]);
});
