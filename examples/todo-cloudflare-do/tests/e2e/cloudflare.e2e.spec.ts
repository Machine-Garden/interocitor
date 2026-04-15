import { expect, test } from '@playwright/test';

import {
  CF_TESTS_ENABLED,
  accessTokenForNamespace,
  addTask,
  applySession,
  connectDemo,
  createSession,
  getTitles,
  makeNamespace,
  newDemoPages,
} from './playwright.helpers';

test.skip(!CF_TESTS_ENABLED, 'Cloudflare example e2e is opt-in; set RUN_CF_EXAMPLE_TESTS=1 to execute it.');

test.describe.configure({ mode: 'serial' });

test('Cloudflare TODO demo syncs across tabs under prefixed worker routes', async ({ browser, baseURL }) => {
  const { context, pages: [tabA, tabB] } = await newDemoPages(browser, baseURL!, 2);

  try {
    const namespace = makeNamespace('team-sync');
    const tokenValue = accessTokenForNamespace(namespace);
    const token = await createSession(tabA, { namespace, token: tokenValue });

    await applySession(tabB, token);
    await connectDemo(tabA);
    await connectDemo(tabB);

    const title = `from-cloudflare-${Date.now()}`;
    await addTask(tabA, title);

    await expect.poll(async () => await getTitles(tabB), {
      timeout: 15_000,
      intervals: [250, 500, 1000],
      message: 'Expected tab B to receive the new task through the Cloudflare worker-backed adapter.',
    }).toContain(title);
  } finally {
    await context.close();
  }
});
