import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/e2e/fixtures/harness.html');
  await page.evaluate(async () => {
    localStorage.removeItem('interocitor-device-id');
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase('interocitor');
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => resolve();
    });
  });
});

test.describe('SyncEngine protocol (MemoryAdapter)', () => {
  test('bootstraps manifests and default direct-cloud mode', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { SyncEngine } = await import('/dist/index.js');
      const { MemoryAdapter } = await import('/dist/adapters/memory.js');

      localStorage.setItem('interocitor-device-id', 'dev_bootstrap');
      const adapter = new MemoryAdapter();
      const engine = new SyncEngine(adapter, { remotePath: '/MeshBoot', pollInterval: 600_000 });

      await engine.init();
      await engine.connect();
      const manifest = engine.getManifest();
      await engine.disconnect();

      return {
        manifest,
        files: Object.keys(adapter.dump()),
      };
    });

    expect(result.manifest?.version).toBe(2);
    expect(result.manifest?.server.managed).toBe(false);
    expect(result.files).toContain('/MeshBoot/manifest.json');
    expect(result.files).toContain('/MeshBoot/c1/channel.json');
  });

  test('flush writes one file per change and updates head', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { SyncEngine } = await import('/dist/index.js');
      const { MemoryAdapter } = await import('/dist/adapters/memory.js');

      localStorage.setItem('interocitor-device-id', 'dev_writer');
      const adapter = new MemoryAdapter();
      const engine = new SyncEngine(adapter, {
        remotePath: '/MeshFlush',
        pollInterval: 600_000,
        flushThreshold: 999,
        flushDebounce: 60_000,
      });

      await engine.init();
      await engine.connect();
      await engine.put('tasks', 't1', { title: 'one' });
      await engine.put('tasks', 't2', { title: 'two' });
      await engine.flush();
      await engine.disconnect();

      const dump = adapter.dump();
      const files = Object.keys(dump);
      return {
        files,
        headPath: files.find(path => path.endsWith('/c1/clients/dev_writer/head.json')),
        changeFileCount: files.filter(path => /\/c1\/clients\/dev_writer\/\d{4}-\d{2}-\d{2}\/.+\.json$/.test(path)).length,
      };
    });

    expect(result.headPath).toBeTruthy();
    expect(result.changeFileCount).toBe(2);
    expect(result.files.some(path => path.includes('/changes/'))).toBe(false);
  });

  test('two devices converge via channelized change files', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { SyncEngine, readColumn } = await import('/dist/index.js');
      const { MemoryAdapter } = await import('/dist/adapters/memory.js');

      const shared = new MemoryAdapter();

      localStorage.setItem('interocitor-device-id', 'dev_a');
      const engineA = new SyncEngine(shared, { remotePath: '/MeshSync', pollInterval: 600_000, flushThreshold: 1 });
      await engineA.init();
      await engineA.connect();
      await engineA.put('tasks', 'r1', { title: 'from a' });
      await engineA.flush();
      await engineA.disconnect();

      await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase('interocitor');
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      });

      localStorage.setItem('interocitor-device-id', 'dev_b');
      const engineB = new SyncEngine(shared, { remotePath: '/MeshSync', pollInterval: 600_000 });
      await engineB.init();
      await engineB.connect();
      const row = await engineB.get('tasks', 'r1');
      await engineB.disconnect();

      return row ? readColumn(row, 'title') : null;
    });

    expect(result).toBe('from a');
  });

  test('rejects unauthorized server writer in manifest', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { SyncEngine } = await import('/dist/index.js');
      const { MemoryAdapter } = await import('/dist/adapters/memory.js');

      const adapter = new MemoryAdapter();
      const now = new Date().toISOString();

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
        version: 2,
        meshId: 'mesh_bad',
        schema: 1,
        lensVersion: 1,
        encrypted: false,
        channels: ['c1'],
        channelNames: { c1: 'default' },
        defaultChannel: 'c1',
        server: { managed: true, relayUrl: null, serverId: 'server_relay_1' },
        createdAt: now,
      };
      const globalManifest = { ...globalPayload, contentHash: await hashOf(globalPayload) };

      const channelPayload = {
        generation: 1,
        parentGeneration: 0,
        writtenBy: 'evil_writer',
        writtenAt: now,
        channelId: 'c1',
        epoch: 0,
        watermarkHlc: '',
        snapshotPath: null,
        deltaPath: null,
      };
      const channelManifest = { ...channelPayload, contentHash: await hashOf(channelPayload) };

      await adapter.writeFile('/Bad/manifest-1.json', JSON.stringify(globalManifest));
      await adapter.writeFile('/Bad/manifest.json', JSON.stringify({ currentGeneration: 1, file: 'manifest-1.json' }));
      await adapter.writeFile('/Bad/c1/channel-manifest-1-server_relay_1.json', JSON.stringify(channelManifest));
      await adapter.writeFile('/Bad/c1/channel.json', JSON.stringify({
        currentGeneration: 1,
        file: 'channel-manifest-1-server_relay_1.json',
      }));

      localStorage.setItem('interocitor-device-id', 'dev_bad');
      const engine = new SyncEngine(adapter, {
        remotePath: '/Bad',
        pollInterval: 600_000,
        serverId: 'server_relay_1',
      });

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

  test('encrypted change files do not leak plaintext', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { SyncEngine } = await import('/dist/index.js');
      const { MemoryAdapter } = await import('/dist/adapters/memory.js');
      const { generateKey } = await import('/dist/crypto/keys.js');

      const key = await generateKey();
      localStorage.setItem('interocitor-device-id', 'dev_enc');
      const adapter = new MemoryAdapter();
      const engine = new SyncEngine(adapter, {
        remotePath: '/MeshEnc',
        pollInterval: 600_000,
        flushThreshold: 1,
      });
      engine.setEncryptionKey(key);

      await engine.init();
      await engine.connect();
      await engine.put('secrets', 's1', { text: 'classified' });
      await engine.flush();
      await engine.disconnect();

      const dump = adapter.dump();
      const payload = Object.entries(dump).find(([path]) => /\/c1\/clients\/dev_enc\/.+\.json$/.test(path));
      return payload ? payload[1] : '';
    });

    expect(result.includes('classified')).toBe(false);
  });

  test('direct-cloud compaction works and clients rehydrate from snapshot', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { SyncEngine, readColumn } = await import('/dist/index.js');
      const { MemoryAdapter } = await import('/dist/adapters/memory.js');

      const shared = new MemoryAdapter();

      localStorage.setItem('interocitor-device-id', 'dev_compactor');
      const serverEngine = new SyncEngine(shared, {
        remotePath: '/MeshCompact',
        pollInterval: 600_000,
        flushThreshold: 1,
      });
      await serverEngine.init();
      await serverEngine.connect();
      await serverEngine.put('notes', 'n1', { text: 'from snapshot' });
      await serverEngine.flush();
      await serverEngine.compact();
      await serverEngine.disconnect();

      await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase('interocitor');
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      });

      localStorage.setItem('interocitor-device-id', 'dev_client');
      const clientEngine = new SyncEngine(shared, {
        remotePath: '/MeshCompact',
        pollInterval: 600_000,
      });
      await clientEngine.init();
      await clientEngine.connect();
      const row = await clientEngine.get('notes', 'n1');
      const dump = shared.dump();
      await clientEngine.disconnect();

      return {
        text: row ? readColumn(row, 'text') : null,
        hasSnapshot: Object.keys(dump).some(path => path.includes('/mainline/snapshot-1-')),
      };
    });

    expect(result.text).toBe('from snapshot');
    expect(result.hasSnapshot).toBe(true);
  });

  test('non-authorized client compaction is rejected in server-managed mode', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { SyncEngine } = await import('/dist/index.js');
      const { MemoryAdapter } = await import('/dist/adapters/memory.js');

      localStorage.setItem('interocitor-device-id', 'dev_not_server');
      const engine = new SyncEngine(new MemoryAdapter(), {
        remotePath: '/MeshCompactReject',
        serverManaged: true,
        serverId: 'server_relay_1',
        pollInterval: 600_000,
      });

      await engine.init();
      await engine.connect();
      try {
        await engine.compact();
        return 'no-error';
      } catch (error: any) {
        return String(error?.message ?? error);
      } finally {
        await engine.disconnect();
      }
    });

    expect(result).toContain('authorized server writer');
  });
});

