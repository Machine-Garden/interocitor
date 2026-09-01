import { expect, test } from "@playwright/test";

import {
  CF_TESTS_ENABLED,
  CF_WORKER_BASE_URL,
  meshBearerForNamespace,
  makeNamespace,
  tamperNamespace,
} from "./playwright.helpers";

test.skip(
  !CF_TESTS_ENABLED,
  "Cloudflare example e2e is opt-in; set RUN_CF_EXAMPLE_TESTS=1 to execute it.",
);

/**
 * Strict prefix integrity: the worker fast-fails any request whose `prefix`
 * URL segment is not a valid `<uuidv7>.<hmac-tag>` mesh-id minted with the
 * deployment's mesh secret. Validation runs BEFORE auth, D1, and cache work,
 * and conceals rejected addresses behind the runtime's generic 404 response
 * without entering application authorization or storage.
 */
test.describe.configure({ mode: "serial" });

function listFilesUrl(namespace: string): string {
  return `${CF_WORKER_BASE_URL}/io/${encodeURIComponent(namespace)}/list-files`;
}

async function postListFiles(
  namespace: string,
  opts?: { withAuth?: boolean },
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8" };
  if (opts?.withAuth ?? true) headers.Authorization = `Bearer ${meshBearerForNamespace(namespace)}`;
  const res = await fetch(listFilesUrl(namespace), {
    method: "POST",
    headers,
    body: JSON.stringify({ path: "/" }),
  });
  const body = await res.text();
  return { status: res.status, body };
}

test("valid mesh-id prefix is accepted", async () => {
  const namespace = makeNamespace();
  const { status, body } = await postListFiles(namespace);
  expect(status).toBe(200);
  expect(JSON.parse(body)).toEqual({ files: [] });
});

test("tampered prefix is rejected before authorization and D1 listing", async () => {
  const namespace = makeNamespace();
  const tampered = tamperNamespace(namespace);
  expect(tampered).not.toBe(namespace);

  const accepted = await postListFiles(namespace);
  expect(accepted.status).toBe(200);

  // postListFiles derives a valid application bearer for the address it is
  // given. If the integrity gate accepted this tampered address, authorization
  // would therefore pass and the empty D1 listing would return 200 as above.
  const rejected = await postListFiles(tampered);
  expect(rejected.status).toBe(404);
  expect(JSON.parse(rejected.body)).toEqual({ error: "Not found" });
});

test("tampered HMAC tag is concealed as 404 Not found", async () => {
  const namespace = makeNamespace();
  const tampered = tamperNamespace(namespace);
  const { status, body } = await postListFiles(tampered);
  expect(status).toBe(404);
  expect(JSON.parse(body)).toEqual({ error: "Not found" });
});

test("tampered UUID character is concealed as 404", async () => {
  const namespace = makeNamespace();
  const dot = namespace.lastIndexOf(".");
  const ch = namespace[0];
  const replacement = ch === "0" ? "1" : "0";
  const tampered = replacement + namespace.slice(1, dot) + namespace.slice(dot);
  expect(tampered).not.toBe(namespace);
  const { status, body } = await postListFiles(tampered);
  expect(status).toBe(404);
  expect(JSON.parse(body)).toEqual({ error: "Not found" });
});

test("non-mesh-id-shaped prefix (no dot) is concealed as 404", async () => {
  const { status, body } = await postListFiles("team-foo-bar-no-dot", { withAuth: false });
  expect(status).toBe(404);
  expect(JSON.parse(body)).toEqual({ error: "Not found" });
});

test("mesh-id-shaped prefix with non-uuid first half is concealed as 404", async () => {
  const { status, body } = await postListFiles("not-a-uuid.AAAAAAAAAAA", { withAuth: false });
  expect(status).toBe(404);
  expect(JSON.parse(body)).toEqual({ error: "Not found" });
});

test("integrity check runs BEFORE auth check", async () => {
  // No Authorization header at all. If integrity check runs first as designed,
  // we get the integrity gate's concealed 404 (not 403). This is the ordering
  // invariant we care about.
  const namespace = makeNamespace();
  const tampered = tamperNamespace(namespace);
  const { status } = await postListFiles(tampered, { withAuth: false });
  expect(status).toBe(404);
});
