import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/packages/interocitor/tests/e2e/fixtures/harness.html');
  await page.evaluate(async () => {
    localStorage.removeItem('interocitor-device-id');
    await window.__webdavMock.resetIndexedDb();
    window.__webdavMock.resetCloud();
  });
});

test('WebDAV adapter supports authenticate, CRUD, listing, and metadata', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { WebDAVAdapter } = await import('/packages/interocitor/dist/adapters/webdav.js');

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

test('SyncEngine writes file-per-change paths and syncs rows through WebDAV', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { SyncEngine, rowToPlain, readColumn } = await import('/packages/interocitor/dist/index.js');
    const { WebDAVAdapter } = await import('/packages/interocitor/dist/adapters/webdav.js');

    const makeEngine = (deviceId: string) => {
      localStorage.setItem('interocitor-device-id', deviceId);
      const adapter = new WebDAVAdapter({
        baseUrl: `${location.origin}/__webdav__`,
        auth: { username: 'u', password: 'p' },
      });
      return new SyncEngine(adapter, {
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

    const row = await engineB.get('tasks', 'task_1');
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
    const { SyncEngine } = await import('/packages/interocitor/dist/index.js');
    const { WebDAVAdapter } = await import('/packages/interocitor/dist/adapters/webdav.js');
    const now = new Date().toISOString();

    const adapter = new WebDAVAdapter({
      baseUrl: `${location.origin}/__webdav__`,
      auth: { username: 'u', password: 'p' },
    });
    await adapter.authenticate();

    const hashOf = async (obj: unknown) => {
      const json = JSON.stringify(obj);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
      const hex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
      return `sha256:${hex}`;
    };

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

    localStorage.setItem('interocitor-device-id', 'dev_bad');
    const engine = new SyncEngine(
      new WebDAVAdapter({ baseUrl: `${location.origin}/__webdav__`, auth: { username: 'u', password: 'p' } }),
      { remotePath: '/BadWeb', pollInterval: 60_000 }
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
    const { SyncEngine, readColumn } = await import('/packages/interocitor/dist/index.js');
    const { WebDAVAdapter } = await import('/packages/interocitor/dist/adapters/webdav.js');
    const { generateKey } = await import('/packages/interocitor/dist/crypto/keys.js');

    const key = await generateKey();

    const makeEngine = (deviceId: string) => {
      localStorage.setItem('interocitor-device-id', deviceId);
      const engine = new SyncEngine(
        new WebDAVAdapter({ baseUrl: `${location.origin}/__webdav__`, auth: { username: 'u', password: 'p' } }),
        { remotePath: '/Encrypted', pollInterval: 60_000, flushDebounce: 5, flushThreshold: 1 },
      );
      engine.setEncryptionKey(key);
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
    const row = await engineB.get('secrets', 's1');
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
    const { SyncEngine, readColumn } = await import('/packages/interocitor/dist/index.js');
    const { WebDAVAdapter } = await import('/packages/interocitor/dist/adapters/webdav.js');

    const makeEngine = (deviceId: string) => {
      localStorage.setItem('interocitor-device-id', deviceId);
      return new SyncEngine(
        new WebDAVAdapter({ baseUrl: `${location.origin}/__webdav__`, auth: { username: 'u', password: 'p' } }),
        { remotePath: '/WebCompact', pollInterval: 60_000, flushDebounce: 5, flushThreshold: 1 },
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
    const row = await clientEngine.get('notes', 'n1');
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
      resetIndexedDb(): Promise<void>;
      dumpFiles(): Record<string, string>;
      hasFile(path: string): boolean;
      originalFetch: typeof fetch;
    };
  }
}
