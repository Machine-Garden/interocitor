import { expect, test } from '@playwright/test';

/**
 * WebDAV adapter contract tests.
 *
 * This suite validates only the StorageAdapter behavior exposed by
 * WebDAVAdapter so it can serve as a reference for custom adapter
 * implementations (or alternate local storage strategies).
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/packages/interocitor/tests/e2e/fixtures/harness.html');
  await page.evaluate(async () => {
    await window.__webdavMock.resetIndexedDb();
    window.__webdavMock.resetCloud();
    window.__webdavMock.setUnauthorized(false);
  });
});

test('authenticate sets authenticated state', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { WebDAVAdapter } = await import('/packages/interocitor/dist/adapters/webdav.js');
    const adapter = new WebDAVAdapter({
      baseUrl: `${location.origin}/__webdav__`,
      auth: { username: 'user', password: 'pass' },
    });

    const before = adapter.isAuthenticated();
    await adapter.authenticate();
    const after = adapter.isAuthenticated();

    return { before, after };
  });

  expect(result.before).toBe(false);
  expect(result.after).toBe(true);
});

test('authenticate throws on unauthorized response', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { WebDAVAdapter } = await import('/packages/interocitor/dist/adapters/webdav.js');
    window.__webdavMock.setUnauthorized(true);

    const adapter = new WebDAVAdapter({
      baseUrl: `${location.origin}/__webdav__`,
      auth: { username: 'bad', password: 'bad' },
    });

    try {
      await adapter.authenticate();
      return { threw: false, message: '' };
    } catch (error: any) {
      return { threw: true, message: String(error?.message ?? error) };
    }
  });

  expect(result.threw).toBe(true);
  expect(result.message).toContain('authentication failed');
});

test('ensureFolder is idempotent for existing paths', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { WebDAVAdapter } = await import('/packages/interocitor/dist/adapters/webdav.js');
    const adapter = new WebDAVAdapter({
      baseUrl: `${location.origin}/__webdav__`,
      auth: { username: 'user', password: 'pass' },
    });

    await adapter.authenticate();
    await adapter.ensureFolder('/mesh/changes');
    await adapter.ensureFolder('/mesh/changes');

    await adapter.writeFile('/mesh/changes/a.ndjson', 'line');
    const files = await adapter.listFiles('/mesh/changes');
    return files.map((f: { name: string }) => f.name);
  });

  expect(result).toEqual(['a.ndjson']);
});

test('writeFile/readFile supports string and binary payloads', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { WebDAVAdapter } = await import('/packages/interocitor/dist/adapters/webdav.js');
    const adapter = new WebDAVAdapter({
      baseUrl: `${location.origin}/__webdav__`,
      auth: { username: 'user', password: 'pass' },
    });

    await adapter.authenticate();
    await adapter.ensureFolder('/mesh');

    await adapter.writeFile('/mesh/str.txt', 'hello');
    await adapter.writeFile('/mesh/bin.dat', new Uint8Array([1, 2, 3, 255]));

    const str = new TextDecoder().decode(await adapter.readFile('/mesh/str.txt'));
    const bin = Array.from(await adapter.readFile('/mesh/bin.dat'));

    return { str, bin };
  });

  expect(result.str).toBe('hello');
  expect(result.bin).toEqual([1, 2, 3, 255]);
});

test('writeFile overwrite updates content and metadata size', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { WebDAVAdapter } = await import('/packages/interocitor/dist/adapters/webdav.js');
    const adapter = new WebDAVAdapter({
      baseUrl: `${location.origin}/__webdav__`,
      auth: { username: 'user', password: 'pass' },
    });

    await adapter.authenticate();
    await adapter.ensureFolder('/mesh');

    await adapter.writeFile('/mesh/file.txt', 'abc');
    await adapter.writeFile('/mesh/file.txt', 'abcdef');

    const text = new TextDecoder().decode(await adapter.readFile('/mesh/file.txt'));
    const meta = await adapter.getFileMetadata('/mesh/file.txt');

    return { text, size: meta?.size ?? -1 };
  });

  expect(result.text).toBe('abcdef');
  expect(result.size).toBe(6);
});

test('listFiles returns only direct file children (not subfolders)', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { WebDAVAdapter } = await import('/packages/interocitor/dist/adapters/webdav.js');
    const adapter = new WebDAVAdapter({
      baseUrl: `${location.origin}/__webdav__`,
      auth: { username: 'user', password: 'pass' },
    });

    await adapter.authenticate();
    await adapter.ensureFolder('/mesh/changes');
    await adapter.ensureFolder('/mesh/changes/nested');

    await adapter.writeFile('/mesh/changes/a.ndjson', 'a');
    await adapter.writeFile('/mesh/changes/b.ndjson', 'b');
    await adapter.writeFile('/mesh/changes/nested/c.ndjson', 'c');

    const files = await adapter.listFiles('/mesh/changes');
    return files.map((f: { name: string }) => f.name).toSorted();
  });

  expect(result).toEqual(['a.ndjson', 'b.ndjson']);
});

test('getFileMetadata returns details for existing file and null for missing file', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { WebDAVAdapter } = await import('/packages/interocitor/dist/adapters/webdav.js');
    const adapter = new WebDAVAdapter({
      baseUrl: `${location.origin}/__webdav__`,
      auth: { username: 'user', password: 'pass' },
    });

    await adapter.authenticate();
    await adapter.ensureFolder('/mesh');
    await adapter.writeFile('/mesh/file.txt', 'hello');

    const existing = await adapter.getFileMetadata('/mesh/file.txt');
    const missing = await adapter.getFileMetadata('/mesh/missing.txt');

    return {
      hasExisting: Boolean(existing),
      name: existing?.name,
      size: existing?.size,
      missing,
    };
  });

  expect(result.hasExisting).toBe(true);
  expect(result.name).toBe('file.txt');
  expect(result.size).toBe(5);
  expect(result.missing).toBeNull();
});

test('deleteFile is idempotent (existing and missing file)', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { WebDAVAdapter } = await import('/packages/interocitor/dist/adapters/webdav.js');
    const adapter = new WebDAVAdapter({
      baseUrl: `${location.origin}/__webdav__`,
      auth: { username: 'user', password: 'pass' },
    });

    await adapter.authenticate();
    await adapter.ensureFolder('/mesh');
    await adapter.writeFile('/mesh/file.txt', 'hello');

    await adapter.deleteFile('/mesh/file.txt');
    // Should not throw on second delete
    await adapter.deleteFile('/mesh/file.txt');

    return adapter.getFileMetadata('/mesh/file.txt');
  });

  expect(result).toBeNull();
});

test('path normalization supports leading/trailing slash variants', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { WebDAVAdapter } = await import('/packages/interocitor/dist/adapters/webdav.js');
    const adapter = new WebDAVAdapter({
      baseUrl: `${location.origin}/__webdav__/`,
      auth: { username: 'user', password: 'pass' },
    });

    await adapter.authenticate();
    await adapter.ensureFolder('mesh');
    await adapter.writeFile('mesh/file.txt', 'hello');
    const text = new TextDecoder().decode(await adapter.readFile('/mesh/file.txt'));
    const files = await adapter.listFiles('/mesh');
    return { text, names: files.map((f: { name: string }) => f.name) };
  });

  expect(result.text).toBe('hello');
  expect(result.names).toEqual(['file.txt']);
});

declare global {
  interface Window {
    __webdavMock: {
      resetCloud(): void;
      setUnauthorized(enabled: boolean): void;
      resetIndexedDb(): Promise<void>;
      dumpFiles(): Record<string, string>;
      hasFile(path: string): boolean;
      originalFetch: typeof fetch;
    };
  }
}

