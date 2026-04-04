import { expect, test } from '@playwright/test';

import { attachWebDavRouteMock, createWebDavRouteState } from './helpers/webdav-route-mock';

async function clearLocalDb(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase('interocitor');
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  });
}

test('two isolated contexts sync via shared WebDAV route mock', async ({ browser, baseURL }) => {
  const sharedCloud = createWebDavRouteState();

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();

  try {
    await attachWebDavRouteMock(contextA, sharedCloud);
    await attachWebDavRouteMock(contextB, sharedCloud);

    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    await pageA.goto(`${baseURL}/tests/e2e/fixtures/harness-plain.html`);
    await pageB.goto(`${baseURL}/tests/e2e/fixtures/harness-plain.html`);

    await clearLocalDb(pageA);
    await clearLocalDb(pageB);

    const written = await pageA.evaluate(async () => {
      const { SyncEngine, readColumn } = await import('/dist/index.js');
      const { WebDAVAdapter } = await import('/dist/adapters/webdav.js');

      localStorage.setItem('interocitor-device-id', 'ctx_a');

      const engine = new SyncEngine(
        new WebDAVAdapter({
          baseUrl: `${location.origin}/__webdav__`,
          auth: { username: 'u', password: 'p' },
        }),
        { rootPath: '/Isolated', pollInterval: 60_000, flushDebounce: 5, flushThreshold: 1 },
      );

      await engine.init();
      await engine.connect();
      await engine.put('tasks', 'task_1', { title: 'from context A' });
      await engine.flush();

      const row = engine.get('tasks', 'task_1');
      await engine.disconnect();

      return row ? readColumn(row, 'title') : null;
    });

    expect(written).toBe('from context A');

    const readOnB = await pageB.evaluate(async () => {
      const { SyncEngine, readColumn } = await import('/dist/index.js');
      const { WebDAVAdapter } = await import('/dist/adapters/webdav.js');

      localStorage.setItem('interocitor-device-id', 'ctx_b');

      const engine = new SyncEngine(
        new WebDAVAdapter({
          baseUrl: `${location.origin}/__webdav__`,
          auth: { username: 'u', password: 'p' },
        }),
        { rootPath: '/Isolated', pollInterval: 60_000, flushDebounce: 5, flushThreshold: 1 },
      );

      await engine.init();
      await engine.connect();

      const row = engine.get('tasks', 'task_1');
      const tableCount = engine.query('tasks').length;
      await engine.disconnect();

      return {
        title: row ? readColumn(row, 'title') : null,
        tableCount,
      };
    });

    expect(readOnB.title).toBe('from context A');
    expect(readOnB.tableCount).toBe(1);
  } finally {
    await contextA.close();
    await contextB.close();
  }
});

