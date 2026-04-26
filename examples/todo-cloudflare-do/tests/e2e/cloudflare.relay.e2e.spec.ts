import { expect, test } from '@playwright/test';

import {
  CF_TESTS_ENABLED,
  CF_WORKER_BASE_URL,
  accessTokenForNamespace,
  makeNamespace,
  newDemoPages,
} from './playwright.helpers';

test.skip(!CF_TESTS_ENABLED, 'Cloudflare example e2e is opt-in; set RUN_CF_EXAMPLE_TESTS=1 to execute it.');

test.describe.configure({ mode: 'serial' });

test('Cloudflare TODO worker exposes InterocitorRelayDurableObject on /notify/<prefix>', async ({ browser, baseURL }) => {
  const { context, pages: [page] } = await newDemoPages(browser, baseURL!, 1);

  try {
    const namespace = makeNamespace('team-relay');
    const token = accessTokenForNamespace(namespace);
    const notifyUrl = `${CF_WORKER_BASE_URL.replace(/^http/, 'ws')}/notify/${encodeURIComponent(namespace)}?access_token=${token}`;

    const outcome = await page.evaluate(async (url) => {
      return await new Promise<string>((resolve) => {
        const ws = new WebSocket(url);
        const timeout = window.setTimeout(() => {
          ws.close();
          resolve('timeout');
        }, 5_000);

        ws.onopen = () => {
          window.clearTimeout(timeout);
          ws.close(1000, 'proof-complete');
          resolve('open');
        };
        ws.onerror = () => {
          window.clearTimeout(timeout);
          resolve('error');
        };
      });
    }, notifyUrl);

    expect(outcome).toBe('open');
  } finally {
    await context.close();
  }
});
