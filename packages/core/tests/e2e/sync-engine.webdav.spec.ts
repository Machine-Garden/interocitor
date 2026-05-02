import { expect, test } from '@playwright/test';

/* eslint-disable unicorn/consistent-function-scoping -- Browser-context helpers must be defined inside page.evaluate. */


test.beforeEach(async ({ page }) => {
  await page.goto('/packages/core/tests/e2e/fixtures/harness.html');
  await page.evaluate(async () => {
    localStorage.removeItem('interocitor-device-id');
    await window.__webdavMock.resetIndexedDb();
    window.__webdavMock.resetCloud();
  });
});

test('WebDAV adapter supports authenticate, CRUD, listing, and metadata', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { WebDAVAdapter } = await import('/packages/core/dist/adapters/webdav.js');

    const adapter = new WebDAVAdapter({
      baseUrl: `${location.origin}/__webdav__`,
      auth: { username: 'u', password: 'p' },
    });

    await adapter.authenticate();
    await adapter.ensureFolder('/Interocitor/test');

    await adapter.writeFile('/Interocitor/test/file.json', '{"ok":true}');

    const list = await adapter.listFiles('/Interocitor/test');
    const metadata = await adapter.getFileMetadata('/Interocitor/test/file.json');
    const bytes = await adapter.readFile('/Interocitor/test/file.json');
    const text = new TextDecoder().decode(bytes);

    await adapter.deleteFile('/Interocitor/test/file.json');
    const afterDelete = await adapter.getFileMetadata('/Interocitor/test/file.json');

    return {
      authenticated: adapter.isAuthenticated(),
      listNames: list.map((entry: { name: string }) => entry.name),
      metadataSize: metadata?.size ?? -1,
      text,
      afterDelete,
    };
  });

  expect(result.authenticated).toBe(true);
  expect(result.listNames).toContain('file.json');
  expect(result.metadataSize).toBeGreaterThan(0);
  expect(result.text).toContain('"ok":true');
  expect(result.afterDelete).toBeNull();
});

test('request budget: WebDAV reconnect avoids device rewrite churn', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { Interocitor } = await import('/packages/core/dist/index.js');
    const { WebDAVAdapter } = await import('/packages/core/dist/adapters/webdav.js');

    const makeEngine = () => new Interocitor(
      new WebDAVAdapter({ baseUrl: `${location.origin}/__webdav__`, auth: { username: 'u', password: 'p' } }),
      { deviceId: 'dev_budget', remotePath: '/InterocitorBudget', pollInterval: 60_000, flushDebounce: 5, flushThreshold: 1 },
    );

    const first = makeEngine();
    await first.init();
    await first.connect();
    const beforeReconnectCloud = window.__webdavMock.dumpFiles();
    await first.disconnect();

    window.__webdavMock.resetRequestCounts();

    const second = makeEngine();
    await second.init();
    await second.connect();
    const counts = window.__webdavMock.dumpRequestCounts();
    const cloud = window.__webdavMock.dumpFiles();
    await second.disconnect();

    return { counts, cloud, beforeReconnectCloud };
  });

  expect(result.counts['PUT /InterocitorBudget/devices/dev_budget.json'] ?? 0).toBe(0);
  expect(result.counts['PUT /InterocitorBudget/manifest.json'] ?? 0).toBe(0);
  expect(result.counts['PUT /InterocitorBudget/manifest-1.json'] ?? 0).toBe(0);
  expect(result.counts['PROPFIND /InterocitorBudget/mainline'] ?? 0).toBeLessThanOrEqual(1);
  expect(result.counts['GET /InterocitorBudget/devices/dev_budget.json'] ?? 0).toBeLessThanOrEqual(1);
});

test('request budget: WebDAV repeated pull with no changes does not write', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { Interocitor } = await import('/packages/core/dist/index.js');
    const { WebDAVAdapter } = await import('/packages/core/dist/adapters/webdav.js');

    const engine = new Interocitor(
      new WebDAVAdapter({ baseUrl: `${location.origin}/__webdav__`, auth: { username: 'u', password: 'p' } }),
      { deviceId: 'dev_pull_budget', remotePath: '/InterocitorPullBudget', pollInterval: 60_000, flushDebounce: 5, flushThreshold: 1 },
    );

    await engine.init();
    await engine.connect();
    window.__webdavMock.resetRequestCounts();
    await engine.pull();
    await engine.disconnect();
    return window.__webdavMock.dumpRequestCounts();
  });

  const writeKeys = Object.keys(result).filter(key => key.startsWith('PUT ') || key.startsWith('DELETE ') || key.startsWith('MKCOL '));
  expect(writeKeys).toEqual([]);
  expect(result['PROPFIND /InterocitorPullBudget/mainline'] ?? 0).toBeLessThanOrEqual(1);
});

test('Interocitor writes file-per-change paths and syncs rows through WebDAV', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { Interocitor, rowToPlain, readColumn } = await import('/packages/core/dist/index.js');
    const { WebDAVAdapter } = await import('/packages/core/dist/adapters/webdav.js');

    const makeEngine = (deviceId: string) => {
      const adapter = new WebDAVAdapter({
        baseUrl: `${location.origin}/__webdav__`,
        auth: { username: 'u', password: 'p' },
      });
      return new Interocitor(adapter, {
        deviceId,
        remotePath: '/Interocitor',
        pollInterval: 60_000,
        flushDebounce: 5,
        flushThreshold: 1,
      });
    };

    const eventTypes: string[] = [];

    const engineA = makeEngine('dev_a');
    engineA.on(event => eventTypes.push(`a:${event.type}`));
    await engineA.init();
    await engineA.connect();
    await engineA.put('tasks', 'task_1', {
      title: 'Bootstrap playwright',
      status: 'open',
    });
    await engineA.flush();
    await engineA.disconnect();

    await window.__webdavMock.resetIndexedDb();

    const engineB = makeEngine('dev_b');
    engineB.on(event => eventTypes.push(`b:${event.type}`));
    await engineB.init();
    await engineB.connect();

    const row = await engineB.loadRow({ table: 'tasks', rowId: 'task_1' });
    const plain = row ? rowToPlain(row) : null;
    const title = row ? (readColumn(row, 'title') as string) : null;
    const rowsFromQuery = (await engineB.query('tasks')).length;

    await engineB.disconnect();

    return {
      plain,
      title,
      rowsFromQuery,
      eventTypes,
      cloudFiles: Object.keys(window.__webdavMock.dumpFiles()),
    };
  });

  expect(result.plain).not.toBeNull();
  expect(result.title).toBe('Bootstrap playwright');
  expect(result.rowsFromQuery).toBe(1);
  expect(result.eventTypes).toContain('a:flush:complete');
  expect(result.eventTypes).toContain('b:sync:complete');
  expect(result.cloudFiles.some(path => path.endsWith('/manifest.json'))).toBe(true);
  expect(result.cloudFiles.some(path => /\/changes\/[^/]+-chg_[^/]+\.json$/.test(path))).toBe(true);
  expect(result.cloudFiles.some(path => path.endsWith('/changes/head.json'))).toBe(true);
});

test('rejects unauthorized writer manifests over WebDAV', async ({ page }) => {
  const result = await page.evaluate(async () => {
    async function hashOf(obj: unknown): Promise<string> {
      const json = JSON.stringify(obj);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
      const hex = Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
      return `sha256:${hex}`;
    }
    const { Interocitor } = await import('/packages/core/dist/index.js');
    const { WebDAVAdapter } = await import('/packages/core/dist/adapters/webdav.js');
    const now = new Date().toISOString();

    const adapter = new WebDAVAdapter({
      baseUrl: `${location.origin}/__webdav__`,
      auth: { username: 'u', password: 'p' },
    });
    await adapter.authenticate();


    const globalPayload = {
      generation: 1,
      parentGeneration: 0,
      writtenBy: 'evil_writer',
      writtenAt: now,
      version: 3,
      meshId: 'mesh_bad',
      schema: 1,
      encrypted: false,
      server: { managed: true, relayUrl: null, serverId: 'server_relay_1' },
      createdAt: now,
      epoch: 0,
      watermarkHlc: '',
      snapshotPath: null,
      deltaPath: null,
    };
    await adapter.writeFile('/BadWeb/manifest-1.json', JSON.stringify({
      ...globalPayload,
      contentHash: await hashOf(globalPayload),
    }));
    await adapter.writeFile('/BadWeb/manifest.json', JSON.stringify({ currentGeneration: 1, file: 'manifest-1.json' }));

    const engine = new Interocitor(
      new WebDAVAdapter({ baseUrl: `${location.origin}/__webdav__`, auth: { username: 'u', password: 'p' } }),
      { deviceId: 'dev_bad', remotePath: '/BadWeb', pollInterval: 60_000 }
    );

    await engine.init();
    try {
      await engine.connect();
      return 'no-error';
    } catch (error: any) {
      return String(error?.message ?? error);
    }
  });

  expect(result).toContain('Unauthorized manifest writer');
});

test('encrypted sync over WebDAV keeps cloud payload opaque', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { Interocitor, readColumn } = await import('/packages/core/dist/index.js');
    const { WebDAVAdapter } = await import('/packages/core/dist/adapters/webdav.js');
    const { generateKey, keyToPassphrase } = await import('/packages/core/dist/crypto/keys.js');

    const key = await generateKey();
    const passphrase = await keyToPassphrase(key);

    const makeEngine = (deviceId: string) => {
      const engine = new Interocitor(
        new WebDAVAdapter({ baseUrl: `${location.origin}/__webdav__`, auth: { username: 'u', password: 'p' } }),
        { deviceId, remotePath: '/Encrypted', passphrase, encrypted: true, pollInterval: 60_000, flushDebounce: 5, flushThreshold: 1 },
      );
      return engine;
    };

    const engineA = makeEngine('dev_a');
    await engineA.init();
    await engineA.connect();
    await engineA.put('secrets', 's1', { content: 'top secret' });
    await engineA.flush();
    await engineA.disconnect();

    const cloud = window.__webdavMock.dumpFiles();
    const payload = Object.entries(cloud).find(([path]) => /\/changes\/[^/]+-chg_[^/]+\.json$/.test(path));
    const cloudContainsPlaintext = payload ? payload[1].includes('top secret') : false;

    await window.__webdavMock.resetIndexedDb();

    const engineB = makeEngine('dev_b');
    await engineB.init();
    await engineB.connect();
    const row = await engineB.loadRow({ table: 'secrets', rowId: 's1' });
    await engineB.disconnect();

    return {
      content: row ? readColumn(row, 'content') : null,
      cloudContainsPlaintext,
    };
  });

  expect(result.content).toBe('top secret');
  expect(result.cloudContainsPlaintext).toBe(false);
});

test('direct-cloud compaction over WebDAV restores clients from snapshot', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { Interocitor, readColumn } = await import('/packages/core/dist/index.js');
    const { WebDAVAdapter } = await import('/packages/core/dist/adapters/webdav.js');

    const makeEngine = (deviceId: string) => {
      return new Interocitor(
        new WebDAVAdapter({ baseUrl: `${location.origin}/__webdav__`, auth: { username: 'u', password: 'p' } }),
        { deviceId, remotePath: '/WebCompact', pollInterval: 60_000, flushDebounce: 5, flushThreshold: 1 },
      );
    };

    const serverEngine = makeEngine('dev_compactor');
    await serverEngine.init();
    await serverEngine.connect();
    await serverEngine.put('notes', 'n1', { text: 'server snapshot' });
    await serverEngine.flush();
    await serverEngine.compact();
    await serverEngine.disconnect();

    await window.__webdavMock.resetIndexedDb();

    const clientEngine = makeEngine('dev_client');
    await clientEngine.init();
    await clientEngine.connect();
    const row = await clientEngine.loadRow({ table: 'notes', rowId: 'n1' });
    await clientEngine.disconnect();

    return {
      text: row ? readColumn(row, 'text') : null,
      hasSnapshot: Object.keys(window.__webdavMock.dumpFiles())
        .some(path => path.includes('/WebCompact/mainline/snapshot-1-')),
    };
  });

  expect(result.text).toBe('server snapshot');
  expect(result.hasSnapshot).toBe(true);
});

declare global {
  interface Window {
    __webdavMock: {
      resetCloud(): void;
      resetRequestCounts(): void;
      dumpRequestCounts(): Record<string, number>;
      resetIndexedDb(): Promise<void>;
      dumpFiles(): Record<string, string>;
      hasFile(path: string): boolean;
      originalFetch: typeof fetch;
    };
  }
}
