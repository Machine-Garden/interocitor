import { expect, test } from "@playwright/test";

test("S3Adapter signs and runs the storage contract in a browser", async ({ page }) => {
  await page.goto("/packages/core/tests/e2e/fixtures/harness-plain.html");

  const result = await page.evaluate(async () => {
    const { S3Adapter } = await import("/packages/core/dist/adapters/s3.js");
    const objects = new Map<string, Uint8Array>();
    const methods: string[] = [];
    const authorizations: string[] = [];
    const decoder = new TextDecoder();

    const fetcher: typeof fetch = async (input, init = {}) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const method = init.method ?? "GET";
      const headers = new Headers(init.headers);
      const key = decodeURIComponent(url.pathname).replace(/^\/mailbox\/?/, "");
      methods.push(method);
      authorizations.push(headers.get("Authorization") ?? "");

      if (url.searchParams.get("list-type") === "2") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const contents = [...objects.entries()]
          .filter(([objectKey]) => objectKey.startsWith(prefix))
          .map(
            ([objectKey, value]) =>
              `<Contents><Key>${objectKey}</Key><LastModified>2026-09-12T00:00:00Z</LastModified><Size>${value.byteLength}</Size></Contents>`,
          )
          .join("");
        return new Response(
          `<ListBucketResult>${contents}<IsTruncated>false</IsTruncated></ListBucketResult>`,
        );
      }
      if (method === "PUT") {
        objects.set(key, new Uint8Array(await new Response(init.body).arrayBuffer()));
        return new Response(null, { status: 200 });
      }
      if (method === "GET") {
        const value = objects.get(key);
        return value ? new Response(value) : new Response(null, { status: 404 });
      }
      if (method === "HEAD") {
        const value = objects.get(key);
        return value
          ? new Response(null, {
              headers: {
                "Content-Length": String(value.byteLength),
                "Last-Modified": "Sat, 12 Sep 2026 00:00:00 GMT",
              },
            })
          : new Response(null, { status: 404 });
      }
      if (method === "DELETE") {
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 405 });
    };

    const adapter = new S3Adapter({
      bucket: "mailbox",
      region: "local",
      endpoint: "https://objects.example.test",
      keyPrefix: "tenant",
      credentials: async () => ({
        accessKeyId: "temporary-access",
        secretAccessKey: "temporary-secret",
        sessionToken: "temporary-session",
      }),
      fetcher,
    });

    const before = adapter.isAuthenticated();
    await adapter.authenticate();
    await adapter.ensureFolder("/mesh/changes");
    await adapter.writeFile("/mesh/changes/a.json", '{"ok":true}');
    const text = decoder.decode(await adapter.readFile("mesh/changes/a.json"));
    const files = await adapter.listFiles("/mesh/changes");
    const metadata = await adapter.getFileMetadata("/mesh/changes/a.json");
    await adapter.deleteFile("/mesh/changes/a.json");
    const missing = await adapter.getFileMetadata("/mesh/changes/a.json");

    return {
      before,
      after: adapter.isAuthenticated(),
      text,
      files,
      metadata,
      missing,
      methods,
      everyRequestSigned: authorizations.every((value) =>
        value.startsWith("AWS4-HMAC-SHA256 Credential=temporary-access/"),
      ),
    };
  });

  expect(result.before).toBe(false);
  expect(result.after).toBe(true);
  expect(result.text).toBe('{"ok":true}');
  expect(result.files).toEqual([
    {
      name: "a.json",
      path: "/mesh/changes/a.json",
      size: 11,
      modifiedTime: "2026-09-12T00:00:00.000Z",
    },
  ]);
  expect(result.metadata).toMatchObject({ name: "a.json", size: 11 });
  expect(result.missing).toBeNull();
  expect(result.methods).toEqual(["GET", "PUT", "GET", "GET", "HEAD", "DELETE", "HEAD"]);
  expect(result.everyRequestSigned).toBe(true);
});
