import { expect, test } from '@playwright/test';

import {
  CF_POLL_INTERVAL_MS,
  CF_SSE_TIMEOUT_MS,
  CF_TESTS_ENABLED,
  accessTokenForNamespace,
  addTask,
  applySession,
  connectDemo,
  createSession,
  getTitles,
  makeNamespace,
  newDemoPages,
  waitForAllSseReady,
} from './playwright.helpers';

test.skip(!CF_TESTS_ENABLED, 'Cloudflare example e2e is opt-in; set RUN_CF_EXAMPLE_TESTS=1 to execute it.');

test.describe.configure({ mode: 'serial' });

test('Cloudflare TODO demo syncs across tabs via SSE before polling can fire', async ({ browser, baseURL }) => {
  const { context, pages: [tabA, tabB] } = await newDemoPages(browser, baseURL!, 2);

  try {
    const namespace = makeNamespace('team-sse');
    const tokenValue = accessTokenForNamespace(namespace);
    const token = await createSession(tabA, {
      namespace,
      token: tokenValue,
      pollInterval: CF_POLL_INTERVAL_MS,
    });

    expect(token).toContain('"namespace"');
    expect(token).toContain('"remotePath"');
    expect(token).toContain('"key"');

    await applySession(tabB, token, CF_POLL_INTERVAL_MS);
    await connectDemo(tabA);
    await connectDemo(tabB);
    await waitForAllSseReady([tabA, tabB]);

    const title = `from-sse-${Date.now()}`;
    const startedAt = Date.now();

    await addTask(tabA, title);

    await expect.poll(async () => await getTitles(tabB), {
      timeout: CF_SSE_TIMEOUT_MS,
      intervals: [100, 250, 500],
      message: 'Expected tab B to receive the new task via Cloudflare SSE invalidation before polling interval elapsed.',
    }).toContain(title);

    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeLessThan(CF_SSE_TIMEOUT_MS);
    expect(elapsedMs).toBeLessThan(CF_POLL_INTERVAL_MS / 100);
  } finally {
    await context.close();
  }
});
