import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";

import { isRemoteAccessError } from "../dist/index.js";
import { S3Adapter } from "../dist/adapters/s3.js";

const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");

function hmac(key, value) {
  return createHmac("sha256", key).update(value).digest();
}

function expectedAuthorization(url, headers, method, payloadHash, credentials, region) {
  const authorization = headers.get("Authorization");
  const signedHeaders = /SignedHeaders=([^,]+)/.exec(authorization)?.[1];
  assert.ok(signedHeaders);
  const names = signedHeaders.split(";");
  const canonicalHeaders = names
    .map(
      (name) =>
        `${name}:${name === "host" ? url.host : headers.get(name)?.trim().replaceAll(/\s+/g, " ")}\n`,
    )
    .join("");
  const canonicalRequest = [
    method,
    url.pathname,
    url.search.slice(1),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const timestamp = headers.get("x-amz-date");
  const datestamp = timestamp.slice(0, 8);
  const scope = `${datestamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    timestamp,
    scope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");
  const dateKey = hmac(`AWS4${credentials.secretAccessKey}`, datestamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, "s3");
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

const credentials = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "example-secret-key",
  sessionToken: "temporary-token",
};

test("S3Adapter is available only from its named adapter entry point", async () => {
  const core = await import("../dist/index.js");
  assert.equal("S3Adapter" in core, false);
  assert.equal(typeof S3Adapter, "function");
});

test("S3Adapter authenticates with a signed, prefix-scoped ListObjectsV2 request", async () => {
  const calls = [];
  let providerCalls = 0;
  const adapter = new S3Adapter({
    bucket: "interocitor-mailbox",
    region: "ap-southeast-2",
    keyPrefix: "/people/alice/",
    credentials: async () => {
      providerCalls++;
      return credentials;
    },
    fetcher: async (input, init) => {
      calls.push({ url: new URL(input), init, headers: new Headers(init.headers) });
      return new Response("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>");
    },
  });

  assert.equal(adapter.isAuthenticated(), false);
  await adapter.authenticate();
  assert.equal(adapter.isAuthenticated(), true);
  assert.equal(providerCalls, 1);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(
    call.url.toString(),
    "https://interocitor-mailbox.s3.ap-southeast-2.amazonaws.com/?list-type=2&max-keys=1&prefix=people%2Falice%2F",
  );
  assert.equal(call.headers.get("x-amz-security-token"), "temporary-token");
  assert.equal(
    call.headers.get("Authorization"),
    expectedAuthorization(
      call.url,
      call.headers,
      "GET",
      EMPTY_SHA256,
      credentials,
      "ap-southeast-2",
    ),
  );
  assert.deepEqual(JSON.parse(adapter.getHandshakeConfig()), {
    bucket: "interocitor-mailbox",
    region: "ap-southeast-2",
    addressingStyle: "virtual",
    keyPrefix: "people/alice",
  });
  assert.doesNotMatch(adapter.getHandshakeConfig(), /AKID|secret|temporary-token/);
});

test("S3Adapter lists direct files and folders across paginated XML responses", async () => {
  const calls = [];
  const firstPage = `<?xml version="1.0"?>
    <ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
      <Contents><Key>tenant/mesh/changes/b.ndjson</Key><LastModified>2026-09-10T01:02:03.000Z</LastModified><ETag>&quot;b-etag&quot;</ETag><Size>7</Size></Contents>
      <Contents><Key>tenant/mesh/changes/nested/ignored.ndjson</Key><Size>8</Size></Contents>
      <CommonPrefixes><Prefix>tenant/mesh/changes/nested/</Prefix></CommonPrefixes>
      <IsTruncated>true</IsTruncated><NextContinuationToken>next+/=</NextContinuationToken>
    </ListBucketResult>`;
  const secondPage = `<ListBucketResult>
      <Contents><Key>tenant/mesh/changes/a.ndjson</Key><LastModified>2026-09-11T01:02:03Z</LastModified><ETag>"a-etag"</ETag><Size>5</Size></Contents>
      <CommonPrefixes><Prefix>tenant/mesh/changes/archive/</Prefix></CommonPrefixes>
      <IsTruncated>false</IsTruncated>
    </ListBucketResult>`;
  const adapter = new S3Adapter({
    bucket: "mailbox",
    region: "auto",
    endpoint: "https://objects.example.test/s3",
    keyPrefix: "tenant",
    credentials,
    fetcher: async (input, init) => {
      const url = new URL(input);
      calls.push({ url, headers: new Headers(init.headers) });
      return new Response(url.searchParams.has("continuation-token") ? secondPage : firstPage);
    },
  });

  const files = await adapter.listFiles("/mesh/changes/");
  const folders = await adapter.listFolders("mesh/changes");

  assert.deepEqual(files, [
    {
      name: "a.ndjson",
      path: "/mesh/changes/a.ndjson",
      size: 5,
      modifiedTime: "2026-09-11T01:02:03.000Z",
      etag: '"a-etag"',
    },
    {
      name: "b.ndjson",
      path: "/mesh/changes/b.ndjson",
      size: 7,
      modifiedTime: "2026-09-10T01:02:03.000Z",
      etag: '"b-etag"',
    },
  ]);
  assert.deepEqual(folders, ["archive", "nested"]);
  assert.equal(calls.length, 4);
  assert.equal(
    calls[0].url.toString(),
    "https://objects.example.test/s3/mailbox/?delimiter=%2F&list-type=2&prefix=tenant%2Fmesh%2Fchanges%2F",
  );
  assert.equal(
    calls[1].url.search,
    "?continuation-token=next%2B%2F%3D&delimiter=%2F&list-type=2&prefix=tenant%2Fmesh%2Fchanges%2F",
  );
  assert.match(calls[1].headers.get("Authorization"), /Credential=AKIDEXAMPLE\//);
});

test("S3Adapter performs exact object CRUD and metadata requests", async () => {
  const calls = [];
  const adapter = new S3Adapter({
    bucket: "mailbox",
    region: "eu-central-1",
    endpoint: "https://storage.example.test/base/",
    credentials,
    fetcher: async (input, init) => {
      const call = { url: new URL(input), init, headers: new Headers(init.headers) };
      calls.push(call);
      if (init.method === "GET") return new Response(new Uint8Array([1, 2, 255]));
      if (init.method === "HEAD") {
        return call.url.pathname.endsWith("missing.txt")
          ? new Response(null, { status: 404 })
          : new Response(null, {
              headers: {
                "Content-Length": "3",
                "Last-Modified": "Fri, 11 Sep 2026 01:02:03 GMT",
                ETag: '"etag"',
              },
            });
      }
      return new Response(null, { status: init.method === "DELETE" ? 204 : 200 });
    },
  });

  await adapter.ensureFolder("/mesh/files");
  await adapter.writeFile("/mesh/files/a b.txt", new Uint8Array([1, 2, 255]));
  assert.deepEqual(await adapter.readFile("mesh/files/a b.txt"), new Uint8Array([1, 2, 255]));
  assert.deepEqual(await adapter.getFileMetadata("/mesh/files/a b.txt"), {
    name: "a b.txt",
    path: "/mesh/files/a b.txt",
    size: 3,
    modifiedTime: "2026-09-11T01:02:03.000Z",
    etag: '"etag"',
  });
  assert.equal(await adapter.getFileMetadata("/mesh/files/missing.txt"), null);
  await adapter.deleteFile("/mesh/files/a b.txt");

  assert.deepEqual(
    calls.map((call) => call.init.method),
    ["PUT", "GET", "HEAD", "HEAD", "DELETE"],
  );
  assert.equal(
    calls[0].url.toString(),
    "https://storage.example.test/base/mailbox/mesh/files/a%20b.txt",
  );
  assert.deepEqual(new Uint8Array(calls[0].init.body), new Uint8Array([1, 2, 255]));
  assert.equal(calls[0].headers.get("Content-Type"), "application/octet-stream");
  const payloadHash = createHash("sha256")
    .update(new Uint8Array([1, 2, 255]))
    .digest("hex");
  assert.equal(calls[0].headers.get("x-amz-content-sha256"), payloadHash);
});

test("S3Adapter supports custom virtual-host addressing and dotted-bucket fallback", async () => {
  const urls = [];
  const fetcher = async (input) => {
    urls.push(String(input));
    return new Response(null, { status: 204 });
  };
  const virtual = new S3Adapter({
    bucket: "mailbox",
    region: "fsn1",
    endpoint: "https://fsn1.objects.example.test",
    addressingStyle: "virtual",
    credentials,
    fetcher,
  });
  const dotted = new S3Adapter({
    bucket: "mailbox.example",
    region: "fsn1",
    endpoint: "https://fsn1.objects.example.test",
    addressingStyle: "virtual",
    credentials,
    fetcher,
  });

  await virtual.deleteFile("mesh/file.txt");
  await dotted.deleteFile("mesh/file.txt");

  assert.equal(urls[0], "https://mailbox.fsn1.objects.example.test/mesh/file.txt");
  assert.equal(urls[1], "https://fsn1.objects.example.test/mailbox.example/mesh/file.txt");
});

test("S3Adapter rotates credentials and preserves typed remote-access failures", async () => {
  const authorizations = [];
  const adapter = new S3Adapter({
    bucket: "mailbox",
    region: "us-east-1",
    credentials: { accessKeyId: "first", secretAccessKey: "first-secret" },
    fetcher: async (_input, init) => {
      authorizations.push(new Headers(init.headers).get("Authorization"));
      return new Response(null, { status: authorizations.length === 1 ? 200 : 403 });
    },
  });

  await adapter.authenticate();
  adapter.setCredentials({ accessKeyId: "second", secretAccessKey: "second-secret" });
  assert.equal(adapter.isAuthenticated(), false);
  await assert.rejects(
    adapter.readFile("mesh/file.txt"),
    (error) => isRemoteAccessError(error) && error.kind === "forbidden" && error.adapter === "s3",
  );
  assert.match(authorizations[0], /Credential=first\//);
  assert.match(authorizations[1], /Credential=second\//);
});

test("S3Adapter rejects unsafe configuration and traversal paths", async () => {
  assert.throws(
    () =>
      new S3Adapter({
        bucket: "mailbox",
        region: "auto",
        credentials,
      }),
    /endpoint is required/,
  );
  assert.throws(
    () =>
      new S3Adapter({
        bucket: "mailbox",
        region: "local",
        endpoint: "http://storage.example.test",
        credentials,
      }),
    /must use HTTPS/,
  );
  const local = new S3Adapter({
    bucket: "mailbox",
    region: "local",
    endpoint: "http://127.0.0.1:9000",
    credentials,
    fetcher: async () => new Response(null, { status: 204 }),
  });
  await assert.rejects(local.ensureFolder("mesh/../secret"), /must not contain/);
  await assert.rejects(local.readFile("mesh/../secret"), /must not contain/);
});

test("S3Adapter aborts a fetch that exceeds its request deadline", async () => {
  const adapter = new S3Adapter({
    bucket: "mailbox",
    region: "local",
    endpoint: "https://objects.example.test",
    credentials,
    requestTimeoutMs: 5,
    fetcher: async (_input, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  });

  await assert.rejects(adapter.readFile("mesh/file.txt"), /timed out after 5ms/);
});
