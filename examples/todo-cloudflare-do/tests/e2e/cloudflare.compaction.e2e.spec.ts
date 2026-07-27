import { expect, test } from '@playwright/test';

import {
  CF_TESTS_ENABLED,
  meshBearerForNamespace,
  addTask,
  applySession,
  compactDemo,
  connectDemo,
  createSession,
  getTitles,
  makeNamespace,
  newDemoPages,
  waitForEvent,
} from './playwright.helpers';

test.skip(!CF_TESTS_ENABLED, 'Cloudflare example e2e is opt-in; set RUN_CF_EXAMPLE_TESTS=1 to execute it.');

test.describe.configure({ mode: 'serial' });

test('Cloudflare TODO demo rehydrates a fresh tab from the compacted mainline snapshot', async ({ browser, baseURL }) => {
  const { context, pages: [writer, reader] } = await newDemoPages(browser, baseURL!, 2);

  try {
    const namespace = makeNamespace();
    const tokenValue = meshBearerForNamespace(namespace);

    const joinToken = await createSession(writer, { namespace, token: tokenValue });
    await applySession(reader, joinToken);

    await connectDemo(writer);
    await addTask(writer, 'before compact');
    await compactDemo(writer);

    await connectDemo(reader);
    const rehydrated = await waitForEvent(reader, 'rehydrate:complete', 5_000);
    expect(rehydrated).toBe(true);

    await expect.poll(async () => await getTitles(reader), {
      timeout: 5_000,
      message: 'Expected a fresh Cloudflare demo tab to see compacted tasks after rehydrating from mainline.',
    }).toContain('before compact');
  } finally {
    await context.close();
  }
});
