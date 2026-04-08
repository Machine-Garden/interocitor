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

    await pageA.goto(`${baseURL}/packages/interocitor/tests/e2e/fixtures/harness-plain.html`);
    await pageB.goto(`${baseURL}/packages/interocitor/tests/e2e/fixtures/harness-plain.html`);

    await clearLocalDb(pageA);
    await clearLocalDb(pageB);

    const written = await pageA.evaluate(async () => {
      const { SyncEngine, readColumn } = await import('/packages/interocitor/dist/index.js');
      const { WebDAVAdapter } = await import('/packages/interocitor/dist/adapters/webdav.js');

      localStorage.setItem('interocitor-device-id', 'ctx_a');

      const engine = new SyncEngine(
        new WebDAVAdapter({
          baseUrl: `${location.origin}/__webdav__`,
          auth: { username: 'u', password: 'p' },
        }),
        { remotePath: '/Isolated', pollInterval: 60_000, flushDebounce: 5, flushThreshold: 1 },
      );

      await engine.init();
      await engine.connect();
      await engine.put('tasks', 'task_1', { title: 'from context A' });
      await engine.flush();

      const row = await engine.get('tasks', 'task_1');
      await engine.disconnect();

      return row ? readColumn(row, 'title') : null;
    });

    expect(written).toBe('from context A');

    const readOnB = await pageB.evaluate(async () => {
      const { SyncEngine, readColumn } = await import('/packages/interocitor/dist/index.js');
      const { WebDAVAdapter } = await import('/packages/interocitor/dist/adapters/webdav.js');

      localStorage.setItem('interocitor-device-id', 'ctx_b');

      const engine = new SyncEngine(
        new WebDAVAdapter({
          baseUrl: `${location.origin}/__webdav__`,
          auth: { username: 'u', password: 'p' },
        }),
        { remotePath: '/Isolated', pollInterval: 60_000, flushDebounce: 5, flushThreshold: 1 },
      );

      await engine.init();
      await engine.connect();

      const row = await engine.get('tasks', 'task_1');
      const tableCount = (await engine.query('tasks')).length;
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

test('isolated contexts can detach, switch WebDAV backends, and later rejoin the old backend', async ({ browser, baseURL }) => {
  const cloudA = createWebDavRouteState();
  const cloudB = createWebDavRouteState();
  const decoder = new TextDecoder();

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();

  try {
    await attachWebDavRouteMock(contextA, cloudA, '/__webdav_a__');
    await attachWebDavRouteMock(contextA, cloudB, '/__webdav_b__');
    await attachWebDavRouteMock(contextB, cloudA, '/__webdav_a__');
    await attachWebDavRouteMock(contextB, cloudB, '/__webdav_b__');

    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    await pageA.goto(`${baseURL}/packages/interocitor/tests/e2e/fixtures/harness-plain.html`);
    await pageB.goto(`${baseURL}/packages/interocitor/tests/e2e/fixtures/harness-plain.html`);

    await clearLocalDb(pageA);
    await clearLocalDb(pageB);

    const firstPhase = await pageA.evaluate(async () => {
      const { SyncEngine, readColumn } = await import('/packages/interocitor/dist/index.js');
      const { WebDAVAdapter } = await import('/packages/interocitor/dist/adapters/webdav.js');

      localStorage.setItem('interocitor-device-id', 'ctx_roundtrip_a');
      const engine = new SyncEngine({
        remotePath: '/RoundTrip',
        dbName: 'roundtrip-a',
        pollInterval: 60_000,
        flushDebounce: 5,
        flushThreshold: 1,
      });

      await engine.init();
      await engine.put('tasks', 'seed', { title: 'seed offline' });

      await engine.setRemoteStorage(new WebDAVAdapter({
        baseUrl: `${location.origin}/__webdav_a__`,
        auth: { username: 'u', password: 'p' },
      }));
      await engine.connect();
      await engine.flush();
      await engine.setRemoteStorage(null);

      await engine.setRemoteStorage(new WebDAVAdapter({
        baseUrl: `${location.origin}/__webdav_b__`,
        auth: { username: 'u', password: 'p' },
      }));
      await engine.connect();
      await engine.flush();
      await engine.setRemoteStorage(null);

      const row = await engine.get('tasks', 'seed');
      await engine.disconnect();
      return row ? readColumn(row, 'title') : null;
    });

    expect(firstPhase).toBe('seed offline');

    const secondClientWrite = await pageB.evaluate(async () => {
      const { SyncEngine, readColumn } = await import('/packages/interocitor/dist/index.js');
      const { WebDAVAdapter } = await import('/packages/interocitor/dist/adapters/webdav.js');

      localStorage.setItem('interocitor-device-id', 'ctx_roundtrip_b');
      const engine = new SyncEngine(
        new WebDAVAdapter({
          baseUrl: `${location.origin}/__webdav_a__`,
          auth: { username: 'u', password: 'p' },
        }),
        {
          remotePath: '/RoundTrip',
          dbName: 'roundtrip-b',
          pollInterval: 60_000,
          flushDebounce: 5,
          flushThreshold: 1,
        },
      );

      await engine.init();
      await engine.connect();
      await engine.put('tasks', 'from_two', { title: 'from old adapter' });
      await engine.flush();
      const row = await engine.get('tasks', 'from_two');
      await engine.disconnect();
      return row ? readColumn(row, 'title') : null;
    });

    expect(secondClientWrite).toBe('from old adapter');

    const clientOneAfterRejoin = await pageA.evaluate(async () => {
      const { SyncEngine, readColumn } = await import('/packages/interocitor/dist/index.js');
      const { WebDAVAdapter } = await import('/packages/interocitor/dist/adapters/webdav.js');

      localStorage.setItem('interocitor-device-id', 'ctx_roundtrip_a');
      const engine = new SyncEngine({
        remotePath: '/RoundTrip',
        dbName: 'roundtrip-a',
        pollInterval: 60_000,
        flushDebounce: 5,
        flushThreshold: 1,
      });

      await engine.init();
      await engine.put('tasks', 'from_one_late', { title: 'from first while detached' });
      await engine.setRemoteStorage(new WebDAVAdapter({
        baseUrl: `${location.origin}/__webdav_a__`,
        auth: { username: 'u', password: 'p' },
      }));
      await engine.connect();
      await engine.flush();
      const titles = (await engine.query('tasks'))
        .map((row) => readColumn(row, 'title'))
        .filter(Boolean)
        .sort();
      await engine.disconnect();
      return titles;
    });

    const clientTwoAfterPull = await pageB.evaluate(async () => {
      const { SyncEngine, readColumn } = await import('/packages/interocitor/dist/index.js');
      const { WebDAVAdapter } = await import('/packages/interocitor/dist/adapters/webdav.js');

      localStorage.setItem('interocitor-device-id', 'ctx_roundtrip_b');
      const engine = new SyncEngine(
        new WebDAVAdapter({
          baseUrl: `${location.origin}/__webdav_a__`,
          auth: { username: 'u', password: 'p' },
        }),
        {
          remotePath: '/RoundTrip',
          dbName: 'roundtrip-b',
          pollInterval: 60_000,
          flushDebounce: 5,
          flushThreshold: 1,
        },
      );

      await engine.init();
      await engine.connect();
      await engine.pull();
      const titles = (await engine.query('tasks'))
        .map((row) => readColumn(row, 'title'))
        .filter(Boolean)
        .sort();
      await engine.disconnect();
      return titles;
    });

    const dumpB = [...cloudB.files.values()].map(file => decoder.decode(file.data)).join('\n');
    const dumpA = [...cloudA.files.values()].map(file => decoder.decode(file.data)).join('\n');

    expect(clientOneAfterRejoin).toEqual(['from first while detached', 'from old adapter', 'seed offline']);
    expect(clientTwoAfterPull).toEqual(['from first while detached', 'from old adapter', 'seed offline']);
    expect(dumpB).toContain('seed offline');
    expect(dumpB).not.toContain('from old adapter');
    expect(dumpB).not.toContain('from first while detached');
    expect(dumpA).toContain('from old adapter');
    expect(dumpA).toContain('from first while detached');
  } finally {
    await contextA.close();
    await contextB.close();
  }
});
