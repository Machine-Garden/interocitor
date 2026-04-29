import { expect, test } from '@playwright/test';

import {
  CF_TESTS_ENABLED,
  CF_WORKER_BASE_URL,
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

test('request budget: Cloudflare reconnect does not rewrite device metadata', async ({ browser, baseURL }) => {
  const { context, pages: [page] } = await newDemoPages(browser, baseURL!, 1);

  try {
    const namespace = makeNamespace('team-budget-reconnect');
    const tokenValue = accessTokenForNamespace(namespace);
    const token = await createSession(page, { namespace, token: tokenValue, pollInterval: 60_000 });

    await applySession(page, token, 60_000);
    await connectDemo(page);
    await page.evaluate(() => window.__todoDemo.disconnect());

    await page.evaluate(() => window.__todoDemo.resetRequestStats());
    await connectDemo(page);
    const stats = await page.evaluate(() => window.__todoDemo.getRequestStats());

    expect(stats.fetch['PUT file:device'] ?? 0).toBe(0);
    expect(stats.fetch['POST list-files'] ?? 0).toBeLessThanOrEqual(1);
    expect(stats.fetch['GET file:head'] ?? 0).toBeLessThanOrEqual(1);
  } finally {
    await context.close();
  }
});

test('request budget: Cloudflare invalidation delivery stays bounded across two tabs', async ({ browser, baseURL }) => {
  const { context, pages: [tabA, tabB] } = await newDemoPages(browser, baseURL!, 2);

  try {
    const namespace = makeNamespace('team-budget-burst');
    const tokenValue = accessTokenForNamespace(namespace);
    const token = await createSession(tabA, { namespace, token: tokenValue, pollInterval: 60_000 });
    await applySession(tabB, token, 60_000);

    await connectDemo(tabA);
    await connectDemo(tabB);
    await Promise.all([
      tabA.evaluate(() => window.__todoDemo.resetRequestStats()),
      tabB.evaluate(() => window.__todoDemo.resetRequestStats()),
    ]);

    await addTask(tabA, `burst-${Date.now()}`);
    await expect.poll(async () => {
      const stats = await tabB.evaluate(() => window.__todoDemo.getRequestStats());
      return stats.websocket.messages;
    }, { timeout: 15_000 }).toBeGreaterThan(0);
    await tabB.waitForTimeout(1_200);

    const [statsA, statsB] = await Promise.all([
      tabA.evaluate(() => window.__todoDemo.getRequestStats()),
      tabB.evaluate(() => window.__todoDemo.getRequestStats()),
    ]);

    expect(statsA.fetch['PUT file:change'] ?? 0).toBeGreaterThan(0);
    expect(statsA.fetch['PUT file:head'] ?? 0).toBeLessThanOrEqual(1);
    expect(statsA.fetch['PUT file:device'] ?? 0).toBeLessThanOrEqual(1);
    expect(statsB.fetch['POST list-files'] ?? 0).toBeLessThanOrEqual(1);
    expect(statsB.fetch['GET file:head'] ?? 0).toBeLessThanOrEqual(2);
    expect(statsB.fetch['GET file:device'] ?? 0).toBeLessThanOrEqual(1);
    expect(statsB.websocket.messages).toBeLessThanOrEqual(1);
  } finally {
    await context.close();
  }
});

test('request budget: Cloudflare device metadata writes do not wake other tabs', async ({ browser, baseURL }) => {
  const { context, pages: [tabA, tabB] } = await newDemoPages(browser, baseURL!, 2);

  try {
    const namespace = makeNamespace('team-budget-device');
    const tokenValue = accessTokenForNamespace(namespace);
    const token = await createSession(tabA, { namespace, token: tokenValue, pollInterval: 60_000 });
    await applySession(tabB, token, 60_000);

    await connectDemo(tabA);
    await connectDemo(tabB);
    await tabB.waitForTimeout(1_200);
    await Promise.all([
      tabA.evaluate(() => window.__todoDemo.resetRequestStats()),
      tabB.evaluate(() => {
        window.__todoDemo.clearEvents();
        window.__todoDemo.resetRequestStats();
      }),
    ]);

    const session = await tabA.evaluate(() => window.__todoDemo.getSession());
    const response = await tabA.evaluate(async (currentSession) => {
      const encodedNamespace = encodeURIComponent(currentSession.namespace);
      const encodedPath = encodeURIComponent(`${currentSession.remotePath}/devices/manual-heartbeat.json`);
      const res = await fetch(`${currentSession.workerBaseUrl}/io/${encodedNamespace}/file?path=${encodedPath}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: currentSession.token ? `Bearer ${currentSession.token}` : '',
        },
        body: JSON.stringify({ ping: Date.now() }),
      });
      return res.status;
    }, session);
    expect(response).toBe(204);

    await tabB.waitForTimeout(1_200);
    const { statsB, eventsB } = await tabB.evaluate(() => ({
      statsB: window.__todoDemo.getRequestStats(),
      eventsB: window.__todoDemo.getEventTypes(),
    }));

    expect(eventsB.filter((type) => type === 'relay:message')).toEqual([]);
    expect(statsB.fetch['GET file:head'] ?? 0).toBeLessThanOrEqual(1);
    expect(statsB.fetch['POST list-files'] ?? 0).toBeLessThanOrEqual(1);
  } finally {
    await context.close();
  }
});

test('request budget: Cloudflare relay-disabled client falls back to polling without websocket invalidations', async ({ browser, baseURL }) => {
  const { context, pages: [tabA, tabB] } = await newDemoPages(browser, baseURL!, 2);

  try {
    const namespace = makeNamespace('team-budget-relay-off');
    const tokenValue = accessTokenForNamespace(namespace);
    const token = await createSession(tabA, {
      namespace,
      token: tokenValue,
      pollInterval: 200,
      relayEnabled: true,
      relayHealthyPollInterval: 60_000,
    });
    await applySession(tabB, token, 200, false, 60_000);

    await connectDemo(tabA);
    await connectDemo(tabB);
    await Promise.all([
      tabA.evaluate(() => window.__todoDemo.resetRequestStats()),
      tabB.evaluate(() => {
        window.__todoDemo.clearEvents();
        window.__todoDemo.resetRequestStats();
      }),
    ]);

    await tabB.evaluate(() => {
      window.__todoDemo.clearEvents();
      window.__todoDemo.resetRequestStats();
    });

    await addTask(tabA, `relay-off-${Date.now()}`);
    await expect.poll(async () => {
      const titles = await getTitles(tabB);
      return titles.some((title) => title.startsWith('relay-off-'));
    }, { timeout: 10_000 }).toBe(true);

    const { statsB, eventsB } = await tabB.evaluate(() => ({
      statsB: window.__todoDemo.getRequestStats(),
      eventsB: window.__todoDemo.getEventTypes(),
    }));

    expect(eventsB.filter((type) => type === 'relay:message')).toEqual([]);
    expect(statsB.websocket.messages).toBe(0);
    expect(statsB.websocket.opened).toBe(0);
    expect((statsB.fetch['GET file:head'] ?? 0) + (statsB.fetch['POST list-files'] ?? 0)).toBeGreaterThan(0);
  } finally {
    await context.close();
  }
});

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
