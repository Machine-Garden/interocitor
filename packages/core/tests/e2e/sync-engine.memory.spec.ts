import { expect, test } from '@playwright/test';

async function hashOf(obj: unknown): Promise<string> {
  const json = JSON.stringify(obj);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
  const hex = Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex}`;
}


test.beforeEach(async ({ page }) => {
  await page.goto('/packages/core/tests/e2e/fixtures/harness.html');
  await page.evaluate(async () => {
    localStorage.removeItem('interocitor-key:interocitor');
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase('interocitor');
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => resolve();
    });
  });
});

test.describe('Interocitor protocol (MemoryAdapter)', () => {
  test('bootstraps manifests and default direct-cloud mode', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

      const adapter = new MemoryAdapter();
      const engine = new Interocitor(adapter, { remotePath: '/MeshBoot', pollInterval: 600_000, deviceId: 'dev_bootstrap' });

      await engine.init();
      await engine.connect();
      const manifest = engine.getManifest();
      await engine.disconnect();

      return {
        manifest,
        files: Object.keys(adapter.dump()),
      };
    });

    expect(result.manifest?.version).toBe(3);
    expect(result.manifest?.server.managed).toBe(false);
    expect(result.files).toContain('/MeshBoot/manifest.json');
  });

  test('flush writes one file per change and updates head', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

      const adapter = new MemoryAdapter();
      const engine = new Interocitor(adapter, {
        remotePath: '/MeshFlush',
        pollInterval: 600_000,
        flushThreshold: 999,
        flushDebounce: 60_000,
        deviceId: 'dev_writer',
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
        headPath: files.find(path => path.endsWith('/changes/head.json')),
        changeFileCount: files.filter(path => /\/changes\/[^/]+-chg_[^/]+\.json$/.test(path)).length,
      };
    });

    expect(result.headPath).toBeTruthy();
    expect(result.changeFileCount).toBe(2);
  });

  test('two devices converge via change files', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor, readColumn } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

      const shared = new MemoryAdapter();

      const engineA = new Interocitor(shared, { remotePath: '/MeshSync', pollInterval: 600_000, flushThreshold: 1, deviceId: 'dev_a' });
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

      const engineB = new Interocitor(shared, { remotePath: '/MeshSync', pollInterval: 600_000, deviceId: 'dev_b' });
      await engineB.init();
      await engineB.connect();
      const row = await engineB.loadRow({ table: 'tasks', rowId: 'r1' });
      await engineB.disconnect();

      return row ? readColumn(row, 'title') : null;
    });

    expect(result).toBe('from a');
  });

  test('supports schema indexes + table.where queries', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor, types } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

      const adapter = new MemoryAdapter();
      const engine = new Interocitor(adapter, {
        remotePath: '/MeshWhere',
        pollInterval: 600_000,
        deviceId: 'dev_where',
        schema: {
          version: 1,
          tables: {
            tasks: {
              fields: {
                status: types.index(types.string),
                priority: types.index(types.number),
              },
            },
          },
        },
      });

      await engine.init();
      await engine.connect();

      const tasks = engine.table('tasks');
      await tasks.put('t1', { title: 'A', status: 'open', priority: 1 } as any);
      await tasks.put('t2', { title: 'B', status: 'done', priority: 3 } as any);
      await tasks.put('t3', { title: 'C', status: 'open', priority: 2 } as any);

      const open = await tasks.where('status').equals('open' as any);
      const p2plus = await tasks.where('priority').aboveOrEqual(2 as any);
      const manifest = engine.getManifest();

      await engine.disconnect();
      return {
        openTitles: open.map((row: any) => row.title).toSorted(),
        p2plusTitles: p2plus.map((row: any) => row.title).toSorted(),
        schemaVersion: manifest?.schema,
      };
    });

    expect(result.openTitles).toEqual(['A', 'C']);
    expect(result.p2plusTitles).toEqual(['B', 'C']);
    expect(result.schemaVersion).toBe(1);
  });

  test('rejects unauthorized server writer in manifest', async ({ page }) => {
    const result = await page.evaluate(async () => {
      async function hashOf(obj: unknown): Promise<string> {
        const json = JSON.stringify(obj);
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
        const hex = Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
        return `sha256:${hex}`;
      }
      const { Interocitor } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

      const adapter = new MemoryAdapter();
      const now = new Date().toISOString();


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
      const globalManifest = { ...globalPayload, contentHash: await hashOf(globalPayload) };

      await adapter.writeFile('/Bad/manifest-1.json', JSON.stringify(globalManifest));
      await adapter.writeFile('/Bad/manifest.json', JSON.stringify({ currentGeneration: 1, file: 'manifest-1.json' }));

      const engine = new Interocitor(adapter, {
        remotePath: '/Bad',
        pollInterval: 600_000,
        serverId: 'server_relay_1',
        deviceId: 'dev_bad',
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

  test('encrypted change files are mesh-bound and do not leak plaintext', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');
      const { generateKey, keyToPassphrase } = await import('/packages/core/dist/crypto/keys.js');
      const { decryptEntry } = await import('/packages/core/dist/crypto/encryption.js');

      const key = await generateKey();
      const passphrase = await keyToPassphrase(key);
      const adapter = new MemoryAdapter();
      const engine = new Interocitor(adapter, {
        remotePath: '/MeshEnc',
        pollInterval: 600_000,
        flushThreshold: 1,
        deviceId: 'dev_enc',
        passphrase,
      });

      await engine.init();
      await engine.connect();
      await engine.put('secrets', 's1', { text: 'classified' });
      await engine.flush();
      const meshId = engine.getMeshId();
      await engine.disconnect();

      const dump = adapter.dump();
      const payload = Object.entries(dump).find(([path]) => /\/changes\/[^/]+-chg_[^/]+\.json$/.test(path));
      if (!payload) {
        return { ciphertext: '', meshId: null, kind: null, decrypted: null };
      }

      const ciphertext = payload[1];
      const decrypted = JSON.parse(await decryptEntry(key, ciphertext));
      return {
        ciphertext,
        meshId,
        kind: decrypted.kind,
        decryptedMeshId: decrypted.meshId,
        opsCount: Array.isArray(decrypted.entry?.ops) ? decrypted.entry.ops.length : 0,
        leakedPlaintext: ciphertext.includes('classified'),
      };
    });

    expect(result.leakedPlaintext).toBe(false);
    expect(result.kind).toBe('change');
    expect(result.decryptedMeshId).toBe(result.meshId);
    expect(result.opsCount).toBe(1);
  });

  test('encrypted snapshots are mesh-bound and do not leak plaintext', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');
      const { generateKey, keyToPassphrase } = await import('/packages/core/dist/crypto/keys.js');
      const { decryptEntry } = await import('/packages/core/dist/crypto/encryption.js');

      const key = await generateKey();
      const passphrase = await keyToPassphrase(key);
      const adapter = new MemoryAdapter();

      const engine = new Interocitor(adapter, {
        remotePath: '/MeshSnapshotFP',
        dbName: 'mesh-snapshot-fp-db',
        pollInterval: 600_000,
        flushThreshold: 1,
        deviceId: 'dev_snapshot_fp',
        passphrase,
      });

      await engine.init();
      await engine.connect();
      await engine.put('notes', 'n1', { text: 'classified snapshot' });
      await engine.flush();
      await engine.compact();
      const meshId = engine.getMeshId();
      await engine.disconnect();

      const dump = adapter.dump();
      const payload = Object.entries(dump).find(([path]) => path.includes('/mainline/snapshot-1-'));
      if (!payload) {
        return { ciphertext: '', meshId: null, kind: null, snapshotMeshId: null, leakedPlaintext: true };
      }

      const ciphertext = payload[1];
      const decrypted = JSON.parse(await decryptEntry(key, ciphertext));
      return {
        meshId,
        kind: decrypted.kind,
        snapshotMeshId: decrypted.meshId,
        tables: Object.keys(decrypted.snapshot?.tables ?? {}),
        leakedPlaintext: ciphertext.includes('classified snapshot'),
      };
    });

    expect(result.leakedPlaintext).toBe(false);
    expect(result.kind).toBe('snapshot');
    expect(result.snapshotMeshId).toBe(result.meshId);
    expect(result.tables).toContain('notes');
  });

  test('encrypted wrong-mesh snapshot data poisons the remote and cuts off sync', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');
      const { generateKey, keyToPassphrase } = await import('/packages/core/dist/crypto/keys.js');

      const adapter = new MemoryAdapter();
      const key = await generateKey();
      const passphrase = await keyToPassphrase(key);

      const source = new Interocitor(adapter, {
        remotePath: '/MeshSnapshotSource',
        dbName: 'mesh-snapshot-source-db',
        pollInterval: 600_000,
        flushThreshold: 1,
        deviceId: 'dev_snapshot_source',
        passphrase,
      });
      await source.init();
      await source.connect();
      await source.put('notes', 'n1', { text: 'source snapshot payload' });
      await source.flush();
      await source.compact();
      await source.disconnect();

      const targetSeed = new Interocitor(adapter, {
        remotePath: '/MeshSnapshotTarget',
        dbName: 'mesh-snapshot-target-seed-db',
        pollInterval: 600_000,
        flushThreshold: 1,
        deviceId: 'dev_snapshot_target_seed',
        passphrase,
      });
      await targetSeed.init();
      await targetSeed.connect();
      await targetSeed.put('notes', 'n1', { text: 'target snapshot payload' });
      await targetSeed.flush();
      await targetSeed.compact();
      await targetSeed.disconnect();

      const dump = adapter.dump();
      const sourceSnapshot = Object.entries(dump).find(([path]) => path.startsWith('/MeshSnapshotSource/mainline/snapshot-1-'));
      const targetSnapshot = Object.entries(dump).find(([path]) => path.startsWith('/MeshSnapshotTarget/mainline/snapshot-1-'));
      if (!sourceSnapshot || !targetSnapshot) throw new Error('Snapshot file not found');
      await adapter.writeFile(targetSnapshot[0], sourceSnapshot[1]);

      await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase('interocitor');
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      });

      const target = new Interocitor(adapter, {
        remotePath: '/MeshSnapshotTarget',
        dbName: 'mesh-snapshot-target-reader-db',
        pollInterval: 600_000,
        deviceId: 'dev_snapshot_target_reader',
        passphrase,
      });
      await target.init();

      const events: Array<{ type: string; path?: string; message?: string }> = [];
      target.on((event) => {
        if (event.type === 'remote:poisoned') {
          events.push({ type: event.type, path: event.path, message: event.error.message });
        }
      });

      let connectError = 'no-error';
      try {
        await target.connect();
      } catch (error: any) {
        connectError = String(error?.message ?? error);
      }

      let followupRehydrateError = 'no-error';
      try {
        await target.rehydrate();
      } catch (error: any) {
        followupRehydrateError = String(error?.message ?? error);
      }

      return {
        connectError,
        followupRehydrateError,
        poisonEventCount: events.length,
        poisonPath: events[0]?.path ?? null,
        poisonMessage: events[0]?.message ?? null,
      };
    });

    expect(result.connectError).toContain('Remote mesh mismatch');
    expect(result.followupRehydrateError).toContain('Remote mesh mismatch');
    expect(result.poisonEventCount).toBeGreaterThan(0);
    expect(result.poisonPath).toContain('/MeshSnapshotTarget/mainline/snapshot-1-');
    expect(result.poisonMessage).toContain('Remote mesh mismatch');
  });

  test('encrypted wrong-mesh data poisons the remote and cuts off sync', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');
      const { generateKey, keyToPassphrase } = await import('/packages/core/dist/crypto/keys.js');

      const adapter = new MemoryAdapter();
      const key = await generateKey();
      const passphrase = await keyToPassphrase(key);

      const source = new Interocitor(adapter, {
        remotePath: '/MeshSource',
        dbName: 'mesh-source-db',
        pollInterval: 600_000,
        flushThreshold: 999,
        flushDebounce: 60_000,
        deviceId: 'dev_source',
        passphrase,
      });
      await source.init();
      await source.connect();
      await source.put('notes', 'n1', { text: 'poison me' });
      await source.flush();
      await source.disconnect();

      const targetSeed = new Interocitor(adapter, {
        remotePath: '/MeshTarget',
        dbName: 'mesh-target-seed-db',
        pollInterval: 600_000,
        deviceId: 'dev_target_seed',
        passphrase,
      });
      await targetSeed.init();
      await targetSeed.connect();
      await targetSeed.disconnect();

      const dump = adapter.dump();
      const sourceChange = Object.entries(dump).find(([path]) => path.startsWith('/MeshSource/changes/') && /-chg_[^/]+\.json$/.test(path));
      if (!sourceChange) throw new Error('Source change file not found');
      const poisonedPath = sourceChange[0].replace('/MeshSource/', '/MeshTarget/');
      await adapter.writeFile(poisonedPath, sourceChange[1]);

      const target = new Interocitor(adapter, {
        remotePath: '/MeshTarget',
        dbName: 'mesh-target-reader-db',
        pollInterval: 600_000,
        deviceId: 'dev_target_reader',
        passphrase,
      });
      await target.init();

      const events: Array<{ type: string; path?: string; message?: string }> = [];
      target.on((event) => {
        if (event.type === 'remote:poisoned') {
          events.push({ type: event.type, path: event.path, message: event.error.message });
        }
      });

      let connectError = 'no-error';
      try {
        await target.connect();
      } catch (error: any) {
        connectError = String(error?.message ?? error);
      }

      let followupPullError = 'no-error';
      try {
        await target.pull();
      } catch (error: any) {
        followupPullError = String(error?.message ?? error);
      }

      return {
        connectError,
        followupPullError,
        poisonEventCount: events.length,
        poisonPath: events[0]?.path ?? null,
        poisonMessage: events[0]?.message ?? null,
      };
    });

    expect(result.connectError).toContain('Remote mesh mismatch');
    expect(result.followupPullError).toContain('Remote mesh mismatch');
    expect(result.poisonEventCount).toBeGreaterThan(0);
    expect(result.poisonPath).toContain('/MeshTarget/changes/');
    expect(result.poisonMessage).toContain('Remote mesh mismatch');
  });

  test('can start without a remote adapter and sync later', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor, readColumn } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

      const remote = new MemoryAdapter();

      const engine = new Interocitor({
        remotePath: '/MeshLateAttach',
        pollInterval: 600_000,
        flushDebounce: 60_000,
        flushThreshold: 999,
        deviceId: 'dev_offline',
      });

      await engine.init();
      await engine.put('tasks', 'late_1', { title: 'offline first' });
      const beforeSync = await engine.loadRow({ table: 'tasks', rowId: 'late_1' });

      let connectError = '';
      try {
        await engine.connect();
      } catch (error: any) {
        connectError = String(error?.message ?? error);
      }

      await engine.setRemoteStorage(remote);
      await engine.connect();
      await engine.flush();
      await engine.disconnect();

      await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase('interocitor');
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      });

      const reader = new Interocitor(remote, {
        remotePath: '/MeshLateAttach',
        pollInterval: 600_000,
        deviceId: 'dev_late_reader',
      });
      await reader.init();
      await reader.connect();
      const synced = await reader.loadRow({ table: 'tasks', rowId: 'late_1' });
      const dump = remote.dump();
      await reader.disconnect();

      return {
        beforeSync: beforeSync ? readColumn(beforeSync, 'title') : null,
        connectError,
        synced: synced ? readColumn(synced, 'title') : null,
        changeFileCount: Object.keys(dump).filter(path => /\/changes\/[^/]+-chg_[^/]+\.json$/.test(path)).length,
      };
    });

    expect(result.beforeSync).toBe('offline first');
    expect(result.connectError).toContain('No remote storage adapter configured');
    expect(result.synced).toBe('offline first');
    expect(result.changeFileCount).toBeGreaterThan(0);
  });

  test('setRemoteStorage migrates full local state to a new backend at runtime', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor, readColumn } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

      const remoteA = new MemoryAdapter();
      const remoteB = new MemoryAdapter();

      const engine = new Interocitor(remoteA, {
        remotePath: '/MeshSwap',
        pollInterval: 600_000,
        flushDebounce: 5,
        flushThreshold: 1,
        deviceId: 'dev_primary',
      });
      await engine.init();
      await engine.connect();
      await engine.put('tasks', 'local_1', { title: 'from primary' });
      await engine.flush();

      const peer = new Interocitor(remoteA, {
        remotePath: '/MeshSwap',
        pollInterval: 600_000,
        flushDebounce: 5,
        flushThreshold: 1,
        deviceId: 'dev_peer',
      });
      await peer.init();
      await peer.connect();
      await peer.put('tasks', 'peer_1', { title: 'from peer' });
      await peer.flush();
      await peer.disconnect();

      await engine.pull();
      await engine.setRemoteStorage(remoteB);
      await engine.put('tasks', 'after_switch', { title: 'after switch' });
      await engine.flush();
      await engine.disconnect();

      await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase('interocitor');
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      });

      const reader = new Interocitor(remoteB, {
        remotePath: '/MeshSwap',
        pollInterval: 600_000,
        deviceId: 'dev_b_reader',
      });
      await reader.init();
      await reader.connect();
      const localRow = await reader.loadRow({ table: 'tasks', rowId: 'local_1' });
      const peerRow = await reader.loadRow({ table: 'tasks', rowId: 'peer_1' });
      const switchedRow = await reader.loadRow({ table: 'tasks', rowId: 'after_switch' });
      await reader.disconnect();

      const dumpA = remoteA.dump();
      const dumpB = remoteB.dump();

      return {
        localTitle: localRow ? readColumn(localRow, 'title') : null,
        peerTitle: peerRow ? readColumn(peerRow, 'title') : null,
        switchedTitle: switchedRow ? readColumn(switchedRow, 'title') : null,
        remoteAHasSwitchWrite: Object.values(dumpA).some(value => value.includes('after switch')),
        remoteBChangeFileCount: Object.keys(dumpB).filter(path => /\/changes\/[^/]+-chg_[^/]+\.json$/.test(path)).length,
      };
    });

    expect(result.localTitle).toBe('from primary');
    expect(result.peerTitle).toBe('from peer');
    expect(result.switchedTitle).toBe('after switch');
    expect(result.remoteAHasSwitchWrite).toBe(false);
    expect(result.remoteBChangeFileCount).toBeGreaterThanOrEqual(3);
  });

  test('can detach from multiple adapters and later rejoin the old adapter with concurrent changes', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor, readColumn } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

      const adapterA = new MemoryAdapter();
      const adapterB = new MemoryAdapter();

      const clientOne = new Interocitor({
        remotePath: '/MeshRoundTrip',
        dbName: 'mesh-roundtrip-client-one',
        pollInterval: 600_000,
        flushDebounce: 5,
        flushThreshold: 1,
        deviceId: 'dev_roundtrip_1',
        encrypted: false,
      });
      await clientOne.init();
      await clientOne.put('tasks', 'seed', { title: 'seed offline' });

      await clientOne.setRemoteStorage(adapterA);
      await clientOne.connect();
      await clientOne.flush();
      await clientOne.setRemoteStorage(null);

      await clientOne.setRemoteStorage(adapterB);
      await clientOne.connect();
      await clientOne.flush();
      const dumpBAfterAttach = adapterB.dump();
      await clientOne.setRemoteStorage(null);

      const clientTwo = new Interocitor(adapterA, {
        remotePath: '/MeshRoundTrip',
        dbName: 'mesh-roundtrip-client-two',
        pollInterval: 600_000,
        flushDebounce: 5,
        flushThreshold: 1,
        deviceId: 'dev_roundtrip_2',
        encrypted: false,
      });
      await clientTwo.init();
      await clientTwo.connect();
      await clientTwo.put('tasks', 'from_two', { title: 'from old adapter' });
      await clientTwo.flush();

      await clientOne.put('tasks', 'from_one_late', { title: 'from first while detached' });
      const offlineRow = await clientOne.loadRow({ table: 'tasks', rowId: 'from_one_late' });

      await clientOne.setRemoteStorage(adapterA);
      await clientOne.connect();
      await clientOne.flush();
      await clientTwo.pull();

      const clientOneRows = await clientOne.query('tasks');
      const clientTwoRows = await clientTwo.query('tasks');
      const dumpA = adapterA.dump();
      const dumpBFinal = adapterB.dump();

      await clientTwo.disconnect();
      await clientOne.disconnect();

      const titles = (rows: any[]) => rows
        .map((row) => readColumn(row, 'title'))
        .filter(Boolean)
        .sort();

      return {
        offlineTitle: offlineRow ? readColumn(offlineRow, 'title') : null,
        clientOneTitles: titles(clientOneRows),
        clientTwoTitles: titles(clientTwoRows),
        adapterBHasSeed: Object.values(dumpBAfterAttach).some(value => value.includes('seed offline')),
        adapterAHasMergedState: Object.values(dumpA).some(value => value.includes('from old adapter'))
          && Object.values(dumpA).some(value => value.includes('from first while detached')),
        adapterBStayedDetached: !Object.values(dumpBFinal).some(value => value.includes('from old adapter'))
          && !Object.values(dumpBFinal).some(value => value.includes('from first while detached')),
      };
    });

    expect(result.offlineTitle).toBe('from first while detached');
    expect(result.clientOneTitles).toEqual(['from first while detached', 'from old adapter', 'seed offline']);
    expect(result.clientTwoTitles).toEqual(['from first while detached', 'from old adapter', 'seed offline']);
    expect(result.adapterBHasSeed).toBe(true);
    expect(result.adapterAHasMergedState).toBe(true);
    expect(result.adapterBStayedDetached).toBe(true);
  });

  test('direct-cloud compaction works and clients rehydrate from snapshot', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor, readColumn } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

      const shared = new MemoryAdapter();

      const serverEngine = new Interocitor(shared, {
        remotePath: '/MeshCompact',
        pollInterval: 600_000,
        flushThreshold: 1,
        deviceId: 'dev_compactor',
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

      const clientEngine = new Interocitor(shared, {
        remotePath: '/MeshCompact',
        pollInterval: 600_000,
        deviceId: 'dev_client',
      });
      await clientEngine.init();
      await clientEngine.connect();
      const row = await clientEngine.loadRow({ table: 'notes', rowId: 'n1' });
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
      const { Interocitor } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

      const engine = new Interocitor(new MemoryAdapter(), {
        remotePath: '/MeshCompactReject',
        serverManaged: true,
        serverId: 'server_relay_1',
        pollInterval: 600_000,
        deviceId: 'dev_not_server',
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

  test('constructor stays uninitialized until init/connect and lazy mesh config wins', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor, rowToPlain } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

      const adapter = new MemoryAdapter();
      const engine = new Interocitor(adapter, {
        dbName: 'lazy-config-db',
        appName: 'Test App',
        encrypted: false,
        logLevel: 'debug',
      });

      const dumpBeforeInit = Object.keys(adapter.dump());
      engine.configureMesh({ remotePath: '/LazyMesh', encrypted: false, deviceId: 'dev_lazy' });
      await engine.connect();
      await engine.put('tasks', 'lazy_1', { title: 'configured before connect' });
      await engine.flush();
      const row = await engine.loadRow({ table: 'tasks', rowId: 'lazy_1' });
      const deviceId = engine.getDeviceId();
      await engine.disconnect();

      return {
        dumpBeforeInit,
        dumpAfterConnect: Object.keys(adapter.dump()),
        deviceId,
        title: row ? rowToPlain(row).title : null,
      };
    });

    expect(result.dumpBeforeInit).toEqual([]);
    expect(result.dumpAfterConnect).toContain('/LazyMesh/manifest.json');
    expect(result.deviceId).toBe('dev_lazy');
    expect(result.title).toBe('configured before connect');
  });

  test('resolveInitialState can supply mesh settings before first connect', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor, rowToPlain } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

      const adapter = new MemoryAdapter();
      let calls = 0;
      const engine = new Interocitor(adapter, {
        dbName: 'resolve-initial-db',
        appName: 'Test App',
        logLevel: 'debug',
        resolveInitialState: async () => {
          calls += 1;
          return { remotePath: '/ResolvedMesh', encrypted: false, deviceId: 'dev_resolved' };
        },
      });

      await engine.connect();
      await engine.put('tasks', 'resolved_1', { title: 'resolved config' });
      await engine.flush();
      const row = await engine.loadRow({ table: 'tasks', rowId: 'resolved_1' });
      await engine.disconnect();

      return {
        calls,
        files: Object.keys(adapter.dump()),
        deviceId: engine.getDeviceId(),
        title: row ? rowToPlain(row).title : null,
      };
    });

    expect(result.calls).toBe(1);
    expect(result.files).toContain('/ResolvedMesh/manifest.json');
    expect(result.deviceId).toBe('dev_resolved');
    expect(result.title).toBe('resolved config');
  });

  test('configureMesh after init is rejected to prevent stale pairing state', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

      const engine = new Interocitor(new MemoryAdapter(), {
        remotePath: '/FixedMesh',
        dbName: 'fixed-mesh-db',
        appName: 'Test App',
        encrypted: false,
      });

      await engine.init();
      try {
        engine.configureMesh({ remotePath: '/OtherMesh', encrypted: false });
        return 'no-error';
      } catch (error: any) {
        return String(error?.message ?? error);
      } finally {
        await engine.disconnect();
      }
    });

    expect(result).toContain('Cannot configure mesh after init()');
  });
});

