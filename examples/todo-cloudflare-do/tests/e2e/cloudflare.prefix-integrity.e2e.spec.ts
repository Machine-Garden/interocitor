import { expect, test } from '@playwright/test';

import {
  CF_TESTS_ENABLED,
  CF_WORKER_BASE_URL,
  meshBearerForNamespace,
  makeNamespace,
  tamperNamespace,
} from './playwright.helpers';

test.skip(!CF_TESTS_ENABLED, 'Cloudflare example e2e is opt-in; set RUN_CF_EXAMPLE_TESTS=1 to execute it.');

/**
 * Strict prefix integrity: the worker fast-fails any request whose `prefix`
 * URL segment is not a valid `<uuidv7>.<hmac-tag>` mesh-id minted with the
 * deployment's mesh secret. Validation runs BEFORE auth, D1, and cache work,
 * so tampered requests cost only an HMAC compute (≈microseconds).
 */
test.describe.configure({ mode: 'serial' });

function listFilesUrl(namespace: string): string {
  return `${CF_WORKER_BASE_URL}/io/${encodeURIComponent(namespace)}/list-files`;
}

async function postListFiles(namespace: string, opts?: { withAuth?: boolean }): Promise<{ status: number; body: string; elapsedMs: number }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' };
  if (opts?.withAuth ?? true) headers.Authorization = `Bearer ${meshBearerForNamespace(namespace)}`;
  // Warm DNS/TCP/TLS by issuing a no-op request first per call site is overkill;
  // serial mode + sample averaging below smooths out per-request noise.
  const t0 = performance.now();
  const res = await fetch(listFilesUrl(namespace), {
    method: 'POST',
    headers,
    body: JSON.stringify({ path: '/' }),
  });
  const body = await res.text();
  return { status: res.status, body, elapsedMs: performance.now() - t0 };
}

/**
 * Average elapsed time over N samples to dampen one-off network noise.
 * The fast-fail signal we want is robustly orders-of-magnitude — averaging is
 * sufficient without resorting to percentile statistics.
 */
async function avgElapsed(fn: () => Promise<{ elapsedMs: number }>, samples = 5): Promise<number> {
  let total = 0;
  for (let i = 0; i < samples; i++) {
    const { elapsedMs } = await fn();
    total += elapsedMs;
  }
  return total / samples;
}

test('valid mesh-id prefix is accepted', async () => {
  const namespace = makeNamespace();
  const { status, body } = await postListFiles(namespace);
  expect(status).toBe(200);
  expect(JSON.parse(body)).toEqual({ files: [] });
});

/**
 * Establish a baseline by measuring the average latency of a *valid* request
 * (which performs HMAC verify + auth check + D1 query + listing-cache logic),
 * then assert that tampered requests are MEANINGFULLY faster — i.e. the
 * integrity short-circuit really skips downstream work.
 *
 * We require tampered ≤ 50% of valid baseline. This is the actual signal we
 * care about: "did the fast-fail skip real work", not "is N ms < some
 * arbitrary number".
 */
test('tampered prefix is meaningfully faster than valid request (skips D1 + auth)', async () => {
  const namespace = makeNamespace();
  const tampered = tamperNamespace(namespace);
  expect(tampered).not.toBe(namespace);

  // Warm up: first request often pays connection setup cost.
  await postListFiles(namespace);

  // Valid baseline: real work happens (auth check + D1 + cache).
  const validAvg = await avgElapsed(() => postListFiles(namespace));
  // Tampered: integrity check should short-circuit before any of that.
  const tamperedAvg = await avgElapsed(() => postListFiles(tampered));

  // Sanity: tampered status is correct.
  const { status, body } = await postListFiles(tampered);
  expect(status).toBe(400);
  expect(JSON.parse(body)).toMatchObject({ error: expect.stringMatching(/invalid prefix/i) });

  // The real assertion: integrity short-circuit skips downstream work.
  // 50% threshold is conservative — typically the difference is much larger
  // (D1 query alone is several ms vs an HMAC compute being ~µs), but local
  // wrangler dev introduces noise.
  expect(
    tamperedAvg,
    `tampered avg=${tamperedAvg.toFixed(2)}ms should be < 50% of valid avg=${validAvg.toFixed(2)}ms`,
  ).toBeLessThan(validAvg * 0.5);
});

test('tampered HMAC tag returns 400 Invalid prefix', async () => {
  const namespace = makeNamespace();
  const tampered = tamperNamespace(namespace);
  const { status, body } = await postListFiles(tampered);
  expect(status).toBe(400);
  expect(JSON.parse(body)).toMatchObject({ error: expect.stringMatching(/invalid prefix/i) });
});

test('tampered UUID character returns 400', async () => {
  const namespace = makeNamespace();
  const dot = namespace.lastIndexOf('.');
  const ch = namespace[0];
  const replacement = ch === '0' ? '1' : '0';
  const tampered = replacement + namespace.slice(1, dot) + namespace.slice(dot);
  expect(tampered).not.toBe(namespace);
  const { status, body } = await postListFiles(tampered);
  expect(status).toBe(400);
  expect(JSON.parse(body)).toMatchObject({ error: expect.stringMatching(/invalid prefix/i) });
});

test('non-mesh-id-shaped prefix (no dot) returns 400', async () => {
  const { status, body } = await postListFiles('team-foo-bar-no-dot', { withAuth: false });
  expect(status).toBe(400);
  expect(JSON.parse(body)).toMatchObject({ error: expect.stringMatching(/invalid prefix/i) });
});

test('mesh-id-shaped prefix with non-uuid first half returns 400', async () => {
  const { status, body } = await postListFiles('not-a-uuid.AAAAAAAAAAA', { withAuth: false });
  expect(status).toBe(400);
  expect(JSON.parse(body)).toMatchObject({ error: expect.stringMatching(/invalid prefix/i) });
});

test('integrity check runs BEFORE auth check', async () => {
  // No Authorization header at all. If integrity check runs first as designed,
  // we get 400 (not 401). This is the ordering invariant we care about.
  const namespace = makeNamespace();
  const tampered = tamperNamespace(namespace);
  const { status } = await postListFiles(tampered, { withAuth: false });
  expect(status).toBe(400);
});
