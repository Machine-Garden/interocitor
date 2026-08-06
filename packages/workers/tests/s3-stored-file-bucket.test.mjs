import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import { S3StoredFileBucket } from "../dist/index.js";

function hmac(key, value) {
  return createHmac("sha256", key).update(value).digest();
}

function expectedAuthorization(
  url,
  headers,
  method,
  payloadHash,
  accessKeyId,
  secretAccessKey,
  region,
) {
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
    "",
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
  const dateKey = hmac(`AWS4${secretAccessKey}`, datestamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, "s3");
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

test("S3 durable-file bucket signs regional PUT, GET, and DELETE requests", async () => {
  const calls = [];
  const fetcher = async (input, init) => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    calls.push({ url, init, headers });
    if (init.method === "GET") {
      return new Response("classified", {
        status: 200,
        headers: {
          "Content-Length": "10",
          "Content-Type": "application/octet-stream",
          ETag: '"stored-etag"',
        },
      });
    }
    if (init.method === "PUT")
      return new Response(null, { status: 200, headers: { ETag: '"put-etag"' } });
    return new Response(null, { status: 204 });
  };
  const accessKeyId = "AKIDEXAMPLE";
  const secretAccessKey = "example-secret-key";
  const bucket = new S3StoredFileBucket({
    bucket: "interocitor-sensitive-files",
    region: "ap-southeast-2",
    accessKeyId,
    secretAccessKey,
    sessionToken: "temporary-token",
    keyPrefix: "/production/",
    kmsKeyId: "arn:aws:kms:ap-southeast-2:123456789012:key/example",
    fetcher,
  });

  const bytes = new TextEncoder().encode("classified");
  const put = await bucket.put("meshes/main/files/report.txt", bytes, {
    httpMetadata: { contentType: "application/octet-stream" },
  });
  assert.equal(put.etag, '"put-etag"');

  const object = await bucket.get("meshes/main/files/report.txt");
  assert.ok(object);
  assert.equal(object.size, 10);
  assert.equal(object.etag, "stored-etag");
  assert.equal(await new Response(object.body).text(), "classified");
  await bucket.delete("meshes/main/files/report.txt");

  assert.equal(calls.length, 3);
  const putCall = calls[0];
  assert.equal(
    putCall.url.toString(),
    "https://interocitor-sensitive-files.s3.ap-southeast-2.amazonaws.com/production/meshes/main/files/report.txt",
  );
  assert.equal(putCall.init.redirect, "error");
  assert.deepEqual(new Uint8Array(putCall.init.body), bytes);
  assert.match(putCall.headers.get("x-amz-date"), /^\d{8}T\d{6}Z$/);
  assert.equal(putCall.headers.get("x-amz-security-token"), "temporary-token");
  assert.equal(putCall.headers.get("x-amz-server-side-encryption"), "aws:kms");
  assert.equal(
    putCall.headers.get("x-amz-server-side-encryption-aws-kms-key-id"),
    "arn:aws:kms:ap-southeast-2:123456789012:key/example",
  );
  const payloadHash = createHash("sha256").update(bytes).digest("hex");
  assert.equal(putCall.headers.get("x-amz-content-sha256"), payloadHash);
  assert.equal(
    putCall.headers.get("Authorization"),
    expectedAuthorization(
      putCall.url,
      putCall.headers,
      "PUT",
      payloadHash,
      accessKeyId,
      secretAccessKey,
      "ap-southeast-2",
    ),
  );
  assert.match(
    calls[1].headers.get("Authorization"),
    /Credential=AKIDEXAMPLE\/\d{8}\/ap-southeast-2\/s3\/aws4_request/,
  );
  assert.equal(calls[2].init.method, "DELETE");
});

test("S3 durable-file bucket uses a regional path-style URL for dotted bucket names", async () => {
  const calls = [];
  const bucket = new S3StoredFileBucket({
    bucket: "sensitive.files.example",
    region: "eu-central-1",
    accessKeyId: "access",
    secretAccessKey: "secret",
    fetcher: async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(null, { status: 404 });
    },
  });

  assert.equal(await bucket.get("meshes/eu/files/a b.txt"), null);
  assert.equal(
    calls[0].url,
    "https://s3.eu-central-1.amazonaws.com/sensitive.files.example/meshes/eu/files/a%20b.txt",
  );
});

test("S3 durable-file bucket reports regional storage failures without response bodies", async () => {
  const bucket = new S3StoredFileBucket({
    bucket: "interocitor-sensitive-files",
    region: "eu-west-1",
    accessKeyId: "access",
    secretAccessKey: "secret",
    fetcher: async () =>
      new Response("<Error>sensitive detail</Error>", {
        status: 403,
        headers: { "x-amz-request-id": "request-123" },
      }),
  });

  await assert.rejects(
    bucket.put("meshes/main/files/blocked.txt", "blocked"),
    /S3 PUT failed: HTTP 403 \(request request-123\)/,
  );
});

test("S3 durable-file bucket requires an explicit valid region", () => {
  assert.throws(
    () =>
      new S3StoredFileBucket({
        bucket: "interocitor-sensitive-files",
        region: "auto",
        accessKeyId: "access",
        secretAccessKey: "secret",
      }),
    /explicit AWS region/,
  );
});

test("S3 durable-file bucket rejects a KMS key from another region", () => {
  assert.throws(
    () =>
      new S3StoredFileBucket({
        bucket: "interocitor-sensitive-files",
        region: "ap-southeast-2",
        accessKeyId: "access",
        secretAccessKey: "secret",
        kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/example",
      }),
    /kmsKeyId must belong to the configured AWS region/,
  );
});
