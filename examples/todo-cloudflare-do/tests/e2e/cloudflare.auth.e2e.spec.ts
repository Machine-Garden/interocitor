import { expect, test } from '@playwright/test';

import {
  CF_TESTS_ENABLED,
  meshBearerForNamespace,
  applySession,
  connectDemo,
  connectDemoExpectError,
  createSession,
  getStatus,
  makeNamespace,
  newDemoPages,
} from './playwright.helpers';

test.skip(!CF_TESTS_ENABLED, 'Cloudflare example e2e is opt-in; set RUN_CF_EXAMPLE_TESTS=1 to execute it.');

test.describe.configure({ mode: 'serial' });

test('Cloudflare TODO demo enforces bearer-protected mode', async ({ browser, baseURL }) => {
  const { context, pages: [tab] } = await newDemoPages(browser, baseURL!, 1);

  try {
    const namespace = makeNamespace();
    const badToken = 'definitely-wrong';

    await createSession(tab, { namespace, token: badToken });

    const connectError = await connectDemoExpectError(tab);
    expect(connectError).toContain('Cloudflare Worker auth failed');

    const goodToken = meshBearerForNamespace(namespace);
    const token = await createSession(tab, { namespace, token: goodToken });
    await applySession(tab, token);
    await connectDemo(tab);

    await expect.poll(async () => await getStatus(tab), {
      timeout: 5_000,
      message: 'Expected authenticated Cloudflare demo session to connect successfully with a valid bearer token.',
    }).toContain(`Connected: ${namespace}/todo-app`);
  } finally {
    await context.close();
  }
});
