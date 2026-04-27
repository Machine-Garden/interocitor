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
    const notifyHttpUrl = `${CF_WORKER_BASE_URL}/notify/${encodeURIComponent(namespace)}/health?access_token=${token}`;
    const health = await page.request.get(notifyHttpUrl);
    expect(health.ok()).toBe(true);
    expect(health.headers()['content-type']).toContain('application/json');
    expect(await health.json()).toMatchObject({ ok: true });

    const notifyUrl = `${CF_WORKER_BASE_URL.replace(/^http/, 'ws')}/notify/${encodeURIComponent(namespace)}?access_token=${token}`;
    const writeUrl = `${CF_WORKER_BASE_URL}/io/${encodeURIComponent(namespace)}/file?path=${encodeURIComponent('/relay-proof.txt')}&access_token=${token}`;

    const outcome = await page.evaluate(async ({ notifyUrl, writeUrl }) => {
      return await new Promise<string>((resolve) => {
        const ws = new WebSocket(notifyUrl);
        const timeout = window.setTimeout(() => {
          ws.close();
          resolve('timeout');
        }, 5_000);

        ws.onopen = () => {
          void fetch(writeUrl, { method: 'PUT', body: 'relay-proof' }).catch(() => resolve('write-error'));
        };
        ws.onmessage = (event) => {
          window.clearTimeout(timeout);
          ws.close(1000, 'proof-complete');
          resolve(String(event.data));
        };
        ws.onerror = () => {
          window.clearTimeout(timeout);
          resolve('socket-error');
        };
      });
    }, { notifyUrl, writeUrl });

    expect(JSON.parse(outcome)).toMatchObject({ type: 'invalidation', op: 'write', path: '/relay-proof.txt' });
  } finally {
    await context.close();
  }
});
