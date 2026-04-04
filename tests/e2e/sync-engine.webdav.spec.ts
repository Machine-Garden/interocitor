import { expect, test } from '@playwright/test';

type ScenarioResult = {
  plain: Record<string, unknown> | null;
  title: string | null;
  rowsFromQuery: number;
  eventTypes: string[];
  cloudFiles: string[];
};

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/e2e/fixtures/harness.html');
  await page.evaluate(async () => {
    localStorage.removeItem('interocitor-device-id');
    await window.__webdavMock.resetIndexedDb();
    window.__webdavMock.resetCloud();
  });
});

test('WebDAV adapter supports authenticate, CRUD, listing, and metadata', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { WebDAVAdapter } = await import('/dist/adapters/webdav.js');

    const adapter = new WebDAVAdapter({
      baseUrl: `${location.origin}/__webdav__`,
      auth: { username: 'u', password: 'p' },
    });

    await adapter.authenticate();
    await adapter.ensureFolder('/Interocitor/changes');

    await adapter.writeFile('/Interocitor/changes/device_a.ndjson', 'line_1\nline_2\n');

    const list = await adapter.listFiles('/Interocitor/changes');
    const metadata = await adapter.getFileMetadata('/Interocitor/changes/device_a.ndjson');
    const bytes = await adapter.readFile('/Interocitor/changes/device_a.ndjson');
    const text = new TextDecoder().decode(bytes);

    await adapter.deleteFile('/Interocitor/changes/device_a.ndjson');
    const afterDelete = await adapter.getFileMetadata('/Interocitor/changes/device_a.ndjson');

    return {
      authenticated: adapter.isAuthenticated(),
      listNames: list.map((entry: { name: string }) => entry.name),
      metadataSize: metadata?.size ?? -1,
      text,
      afterDelete,
    };
  });

  expect(result.authenticated).toBe(true);
  expect(result.listNames).toContain('device_a.ndjson');
  expect(result.metadataSize).toBeGreaterThan(0);
  expect(result.text).toContain('line_1');
  expect(result.afterDelete).toBeNull();
});

test('SyncEngine syncs rows through WebDAV and uses IndexedDB cache', async ({ page }) => {
  const result = await page.evaluate(async (): Promise<ScenarioResult> => {
    const { SyncEngine, rowToPlain, readColumn } = await import('/dist/index.js');
    const { WebDAVAdapter } = await import('/dist/adapters/webdav.js');

    const makeEngine = (deviceId: string) => {
      localStorage.setItem('interocitor-device-id', deviceId);
      const adapter = new WebDAVAdapter({
        baseUrl: `${location.origin}/__webdav__`,
        auth: { username: 'u', password: 'p' },
      });
      return new SyncEngine(adapter, {
        rootPath: '/Interocitor',
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

    const row = engineB.get('tasks', 'task_1');
    const plain = row ? rowToPlain(row) : null;
    const title = row ? (readColumn(row, 'title') as string) : null;
    const rowsFromQuery = engineB.query('tasks').length;

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
  expect(result.cloudFiles.some(path => path.endsWith('/changes/dev_a.ndjson'))).toBe(true);
});

test('rehydrate restores snapshot state when logs were compacted', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { SyncEngine, readColumn } = await import('/dist/index.js');
    const { WebDAVAdapter } = await import('/dist/adapters/webdav.js');

    const makeEngine = (deviceId: string) => {
      localStorage.setItem('interocitor-device-id', deviceId);
      const adapter = new WebDAVAdapter({
        baseUrl: `${location.origin}/__webdav__`,
        auth: { username: 'u', password: 'p' },
      });
      return new SyncEngine(adapter, {
        rootPath: '/Interocitor',
        pollInterval: 60_000,
        flushDebounce: 5,
        flushThreshold: 1,
      });
    };

    const engineA = makeEngine('dev_a');
    await engineA.init();
    await engineA.connect();
    await engineA.put('notes', 'note_1', { text: 'from snapshot' });
    await engineA.flush();
    await engineA.compact();
    await engineA.disconnect();

    await window.__webdavMock.resetIndexedDb();

    const engineB = makeEngine('dev_b');
    await engineB.init();
    await engineB.connect();

    const before = engineB.query('notes').length;
    await engineB.rehydrate();
    const restored = engineB.get('notes', 'note_1');
    const text = restored ? readColumn(restored, 'text') : null;

    await engineB.disconnect();

    return {
      before,
      after: engineB.query('notes').length,
      text,
      hasSnapshot: window.__webdavMock.hasFile('/Interocitor/snapshots/latest.json'),
      hasChanges: window.__webdavMock.hasFile('/Interocitor/changes/dev_a.ndjson'),
    };
  });

  expect(result.before).toBe(1);
  expect(result.after).toBe(1);
  expect(result.text).toBe('from snapshot');
  expect(result.hasSnapshot).toBe(true);
  expect(result.hasChanges).toBe(false);
});

test('stale local epoch rehydrates after remote compaction', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { SyncEngine, readColumn } = await import('/dist/index.js');
    const { WebDAVAdapter } = await import('/dist/adapters/webdav.js');
    const { LocalStore } = await import('/dist/storage/local-store.js');

    const makeEngine = (deviceId: string) => {
      localStorage.setItem('interocitor-device-id', deviceId);
      return new SyncEngine(
        new WebDAVAdapter({ baseUrl: `${location.origin}/__webdav__`, auth: { username: 'u', password: 'p' } }),
        { rootPath: '/Epoch', pollInterval: 60_000, flushDebounce: 5, flushThreshold: 1 },
      );
    };

    // Device A writes old schema row then compacts with migration (epoch + schema bump).
    const engineA = makeEngine('dev_epoch_a');
    await engineA.init();
    await engineA.connect();
    await engineA.put('tasks', 't1', { status_code: 'open' });
    await engineA.flush();
    await engineA.compact((table, row) => {
      if (table === 'tasks' && row.status_code) {
        row.status = row.status_code;
        delete row.status_code;
      }
      return row;
    });
    await engineA.disconnect();

    // Simulate stale local state on device B (old row + old epoch meta).
    const staleStore = new LocalStore();
    await staleStore.open();
    await staleStore.putRow({
      _table: 'tasks',
      _rowId: 't1',
      _deleted: false,
      _schemaVersion: 1,
      status_code: { value: 'stale', hlc: '000001000000000000-0000-dev_epoch_b' },
    } as any);
    await staleStore.setMeta('epoch', 0);
    staleStore.close();

    const engineB = makeEngine('dev_epoch_b');
    await engineB.init();
    await engineB.connect();
    const row = engineB.get('tasks', 't1');
    const manifestEpoch = engineB.getManifest()?.epoch ?? -1;
    const manifestSchema = engineB.getManifest()?.schema ?? -1;
    await engineB.disconnect();

    return {
      status: row ? readColumn(row, 'status') : null,
      oldStatusCode: row ? readColumn(row, 'status_code') : null,
      manifestEpoch,
      manifestSchema,
    };
  });

  expect(result.manifestEpoch).toBeGreaterThan(0);
  expect(result.manifestSchema).toBeGreaterThan(1);
  expect(result.status).toBe('open');
  expect(result.oldStatusCode).toBeUndefined();
});

test('delete on device A is visible to device B after sync', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { SyncEngine, readColumn } = await import('/dist/index.js');
    const { WebDAVAdapter } = await import('/dist/adapters/webdav.js');

    const makeEngine = (deviceId: string) => {
      localStorage.setItem('interocitor-device-id', deviceId);
      return new SyncEngine(
        new WebDAVAdapter({ baseUrl: `${location.origin}/__webdav__`, auth: { username: 'u', password: 'p' } }),
        { rootPath: '/Interocitor', pollInterval: 60_000, flushDebounce: 5, flushThreshold: 1 },
      );
    };

    // A: create + delete
    const engineA = makeEngine('dev_a');
    await engineA.init();
    await engineA.connect();
    await engineA.put('items', 'i1', { name: 'keep' });
    await engineA.put('items', 'i2', { name: 'discard' });
    await engineA.flush();
    await engineA.delete('items', 'i2');
    await engineA.flush();
    await engineA.disconnect();

    await window.__webdavMock.resetIndexedDb();

    // B: pull
    const engineB = makeEngine('dev_b');
    await engineB.init();
    await engineB.connect();

    const kept = engineB.get('items', 'i1');
    const removed = engineB.get('items', 'i2');
    const all = engineB.query('items');
    await engineB.disconnect();

    return {
      keptName: kept ? readColumn(kept, 'name') : null,
      removedExists: removed != null,
      queryCount: all.length,
    };
  });

  expect(result.keptName).toBe('keep');
  expect(result.removedExists).toBe(false);
  expect(result.queryCount).toBe(1);
});

test('encrypted sync over WebDAV — cloud only has ciphertext', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { SyncEngine, readColumn } = await import('/dist/index.js');
    const { WebDAVAdapter } = await import('/dist/adapters/webdav.js');
    const { generateKey } = await import('/dist/crypto/keys.js');

    const key = await generateKey();

    const makeEngine = (deviceId: string) => {
      localStorage.setItem('interocitor-device-id', deviceId);
      const engine = new SyncEngine(
        new WebDAVAdapter({ baseUrl: `${location.origin}/__webdav__`, auth: { username: 'u', password: 'p' } }),
        { rootPath: '/Encrypted', pollInterval: 60_000, flushDebounce: 5, flushThreshold: 1 },
      );
      engine.setEncryptionKey(key);
      return engine;
    };

    // A writes encrypted data
    const engineA = makeEngine('dev_a');
    await engineA.init();
    await engineA.connect();
    await engineA.put('secrets', 's1', { content: 'top secret' });
    await engineA.flush();
    await engineA.disconnect();

    // Inspect cloud — should NOT contain plaintext
    const cloud = window.__webdavMock.dumpFiles();
    const changeEntry = Object.entries(cloud).find(([k]) => k.includes('changes/dev_a'));
    const cloudContainsPlaintext = changeEntry ? changeEntry[1].includes('top secret') : false;

    await window.__webdavMock.resetIndexedDb();

    // B reads with same key
    const engineB = makeEngine('dev_b');
    await engineB.init();
    await engineB.connect();
    const row = engineB.get('secrets', 's1');
    await engineB.disconnect();

    return {
      content: row ? readColumn(row, 'content') : null,
      cloudContainsPlaintext,
    };
  });

  expect(result.content).toBe('top secret');
  expect(result.cloudContainsPlaintext).toBe(false); // cloud only has ciphertext
});

test('multiple puts batch into a single change log entry', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { SyncEngine } = await import('/dist/index.js');
    const { WebDAVAdapter } = await import('/dist/adapters/webdav.js');

    localStorage.setItem('interocitor-device-id', 'dev_batch');
    const engine = new SyncEngine(
      new WebDAVAdapter({ baseUrl: `${location.origin}/__webdav__`, auth: { username: 'u', password: 'p' } }),
      { rootPath: '/Batch', pollInterval: 60_000, flushDebounce: 100, flushThreshold: 999 },
    );
    await engine.init();
    await engine.connect();

    // Write several rows before flush fires
    await engine.put('t', 'r1', { x: 1 });
    await engine.put('t', 'r2', { x: 2 });
    await engine.put('t', 'r3', { x: 3 });
    await engine.flush();

    const cloud = window.__webdavMock.dumpFiles();
    const logEntry = Object.entries(cloud).find(([k]) => k.includes('changes/dev_batch'));
    const lineCount = logEntry ? logEntry[1].split('\n').filter((l: string) => l.trim()).length : 0;
    const queryCount = engine.query('t').length;

    await engine.disconnect();
    return { lineCount, queryCount };
  });

  expect(result.queryCount).toBe(3);
  // Each put creates its own change entry, so we expect 3 lines
  expect(result.lineCount).toBe(3);
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

