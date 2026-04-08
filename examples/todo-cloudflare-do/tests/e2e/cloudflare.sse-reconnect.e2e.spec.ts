import { expect, test } from '@playwright/test';

import {
  CF_POLL_INTERVAL_MS,
  CF_SSE_TIMEOUT_MS,
  CF_TESTS_ENABLED,
  accessTokenForNamespace,
  addTask,
  applySession,
  clearEvents,
  connectDemo,
  createSession,
  getTitles,
  makeNamespace,
  newDemoPages,
  resetRealtime,
  waitForAllSseReady,
  waitForEvent,
} from './playwright.helpers';

test.skip(!CF_TESTS_ENABLED, 'Cloudflare example e2e is opt-in; set RUN_CF_EXAMPLE_TESTS=1 to execute it.');

test.describe.configure({ mode: 'serial' });

test('Cloudflare TODO demo reconnects SSE after simulated DO loss and keeps syncing before polling', async ({ browser, baseURL }) => {
  const { context, pages: [tabA, tabB] } = await newDemoPages(browser, baseURL!, 2);

  try {
    const namespace = makeNamespace('team-sse-reconnect');
    const tokenValue = accessTokenForNamespace(namespace);
    const token = await createSession(tabA, {
      namespace,
      token: tokenValue,
      pollInterval: CF_POLL_INTERVAL_MS,
    });

    await applySession(tabB, token, CF_POLL_INTERVAL_MS);
    await connectDemo(tabA);
    await connectDemo(tabB);
    await waitForAllSseReady([tabA, tabB]);

    await clearEvents(tabA);
    await clearEvents(tabB);
    await resetRealtime(namespace);

    await expect.poll(async () => {
      return await Promise.all([
        waitForEvent(tabA, 'sse:ready', 100),
        waitForEvent(tabB, 'sse:ready', 100),
      ]);
    }, {
      timeout: 8_000,
      intervals: [250, 500, 1000],
      message: 'Expected both Cloudflare demo tabs to re-establish SSE after simulated DO loss.',
    }).toEqual([true, true]);

    const title = `after-reconnect-${Date.now()}`;
    await addTask(tabA, title);

    await expect.poll(async () => await getTitles(tabB), {
      timeout: CF_SSE_TIMEOUT_MS,
      intervals: [100, 250, 500],
      message: 'Expected tab B to receive a task after SSE auto-reconnect, before polling interval elapsed.',
    }).toContain(title);
  } finally {
    await context.close();
  }
});
