import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/packages/interocitor/tests/e2e/fixtures/harness.html');
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
      const { SyncEngine } = await import('/packages/interocitor/dist/index.js');
      const { MemoryAdapter } = await import('/packages/interocitor/dist/adapters/memory.js');

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

    expect(result.manifest?.version).toBe(3);
    expect(result.manifest?.server.managed).toBe(false);
    expect(result.files).toContain('/MeshBoot/manifest.json');
  });

  test('flush writes one file per change and updates head', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { SyncEngine } = await import('/packages/interocitor/dist/index.js');
      const { MemoryAdapter } = await import('/packages/interocitor/dist/adapters/memory.js');

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
        headPath: files.find(path => path.endsWith('/changes/head.json')),
        changeFileCount: files.filter(path => /\/changes\/[^/]+-chg_[^/]+\.json$/.test(path)).length,
      };
    });

    expect(result.headPath).toBeTruthy();
    expect(result.changeFileCount).toBe(2);
  });

  test('two devices converge via change files', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { SyncEngine, readColumn } = await import('/packages/interocitor/dist/index.js');
      const { MemoryAdapter } = await import('/packages/interocitor/dist/adapters/memory.js');

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

  test('supports schema indexes + table.where queries', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { SyncEngine, types } = await import('/packages/interocitor/dist/index.js');
      const { MemoryAdapter } = await import('/packages/interocitor/dist/adapters/memory.js');

      localStorage.setItem('interocitor-device-id', 'dev_where');
      const adapter = new MemoryAdapter();
      const engine = new SyncEngine(adapter, {
        remotePath: '/MeshWhere',
        pollInterval: 600_000,
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
        openTitles: open.map((row: any) => row.title).sort(),
        p2plusTitles: p2plus.map((row: any) => row.title).sort(),
        schemaVersion: manifest?.schema,
      };
    });

    expect(result.openTitles).toEqual(['A', 'C']);
    expect(result.p2plusTitles).toEqual(['B', 'C']);
    expect(result.schemaVersion).toBe(1);
  });

  test('rejects unauthorized server writer in manifest', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { SyncEngine } = await import('/packages/interocitor/dist/index.js');
      const { MemoryAdapter } = await import('/packages/interocitor/dist/adapters/memory.js');

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

  test('encrypted change files are mesh-bound and do not leak plaintext', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { SyncEngine } = await import('/packages/interocitor/dist/index.js');
      const { MemoryAdapter } = await import('/packages/interocitor/dist/adapters/memory.js');
      const { generateKey } = await import('/packages/interocitor/dist/crypto/keys.js');
      const { decryptEntry } = await import('/packages/interocitor/dist/crypto/encryption.js');

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
      const { SyncEngine } = await import('/packages/interocitor/dist/index.js');
      const { MemoryAdapter } = await import('/packages/interocitor/dist/adapters/memory.js');
      const { generateKey } = await import('/packages/interocitor/dist/crypto/keys.js');
      const { decryptEntry } = await import('/packages/interocitor/dist/crypto/encryption.js');

      const key = await generateKey();
      const adapter = new MemoryAdapter();
      localStorage.setItem('interocitor-device-id', 'dev_snapshot_fp');

      const engine = new SyncEngine(adapter, {
        remotePath: '/MeshSnapshotFP',
        dbName: 'mesh-snapshot-fp-db',
        pollInterval: 600_000,
        flushThreshold: 1,
      });
      engine.setEncryptionKey(key);

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
      const { SyncEngine } = await import('/packages/interocitor/dist/index.js');
      const { MemoryAdapter } = await import('/packages/interocitor/dist/adapters/memory.js');
      const { generateKey } = await import('/packages/interocitor/dist/crypto/keys.js');

      const adapter = new MemoryAdapter();
      const key = await generateKey();

      localStorage.setItem('interocitor-device-id', 'dev_snapshot_source');
      const source = new SyncEngine(adapter, {
        remotePath: '/MeshSnapshotSource',
        dbName: 'mesh-snapshot-source-db',
        pollInterval: 600_000,
        flushThreshold: 1,
      });
      source.setEncryptionKey(key);
      await source.init();
      await source.connect();
      await source.put('notes', 'n1', { text: 'source snapshot payload' });
      await source.flush();
      await source.compact();
      await source.disconnect();

      localStorage.setItem('interocitor-device-id', 'dev_snapshot_target_seed');
      const targetSeed = new SyncEngine(adapter, {
        remotePath: '/MeshSnapshotTarget',
        dbName: 'mesh-snapshot-target-seed-db',
        pollInterval: 600_000,
        flushThreshold: 1,
      });
      targetSeed.setEncryptionKey(key);
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

      localStorage.setItem('interocitor-device-id', 'dev_snapshot_target_reader');
      const target = new SyncEngine(adapter, {
        remotePath: '/MeshSnapshotTarget',
        dbName: 'mesh-snapshot-target-reader-db',
        pollInterval: 600_000,
      });
      target.setEncryptionKey(key);
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
      const { SyncEngine } = await import('/packages/interocitor/dist/index.js');
      const { MemoryAdapter } = await import('/packages/interocitor/dist/adapters/memory.js');
      const { generateKey } = await import('/packages/interocitor/dist/crypto/keys.js');

      const adapter = new MemoryAdapter();
      const key = await generateKey();

      localStorage.setItem('interocitor-device-id', 'dev_source');
      const source = new SyncEngine(adapter, {
        remotePath: '/MeshSource',
        dbName: 'mesh-source-db',
        pollInterval: 600_000,
        flushThreshold: 1,
      });
      source.setEncryptionKey(key);
      await source.init();
      await source.connect();
      await source.put('notes', 'n1', { text: 'poison me' });
      await source.flush();
      await source.disconnect();

      localStorage.setItem('interocitor-device-id', 'dev_target_seed');
      const targetSeed = new SyncEngine(adapter, {
        remotePath: '/MeshTarget',
        dbName: 'mesh-target-seed-db',
        pollInterval: 600_000,
      });
      targetSeed.setEncryptionKey(key);
      await targetSeed.init();
      await targetSeed.connect();
      await targetSeed.disconnect();

      const dump = adapter.dump();
      const sourceChange = Object.entries(dump).find(([path]) => path.startsWith('/MeshSource/changes/') && /-chg_[^/]+\.json$/.test(path));
      if (!sourceChange) throw new Error('Source change file not found');
      const poisonedPath = sourceChange[0].replace('/MeshSource/', '/MeshTarget/');
      await adapter.writeFile(poisonedPath, sourceChange[1]);

      localStorage.setItem('interocitor-device-id', 'dev_target_reader');
      const target = new SyncEngine(adapter, {
        remotePath: '/MeshTarget',
        dbName: 'mesh-target-reader-db',
        pollInterval: 600_000,
      });
      target.setEncryptionKey(key);
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
      const { SyncEngine, readColumn } = await import('/packages/interocitor/dist/index.js');
      const { MemoryAdapter } = await import('/packages/interocitor/dist/adapters/memory.js');

      const remote = new MemoryAdapter();

      localStorage.setItem('interocitor-device-id', 'dev_offline');
      const engine = new SyncEngine({
        remotePath: '/MeshLateAttach',
        pollInterval: 600_000,
        flushDebounce: 60_000,
        flushThreshold: 999,
      });

      await engine.init();
      await engine.put('tasks', 'late_1', { title: 'offline first' });
      const beforeSync = await engine.get('tasks', 'late_1');

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

      localStorage.setItem('interocitor-device-id', 'dev_late_reader');
      const reader = new SyncEngine(remote, {
        remotePath: '/MeshLateAttach',
        pollInterval: 600_000,
      });
      await reader.init();
      await reader.connect();
      const synced = await reader.get('tasks', 'late_1');
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
      const { SyncEngine, readColumn } = await import('/packages/interocitor/dist/index.js');
      const { MemoryAdapter } = await import('/packages/interocitor/dist/adapters/memory.js');

      const remoteA = new MemoryAdapter();
      const remoteB = new MemoryAdapter();

      localStorage.setItem('interocitor-device-id', 'dev_primary');
      const engine = new SyncEngine(remoteA, {
        remotePath: '/MeshSwap',
        pollInterval: 600_000,
        flushDebounce: 5,
        flushThreshold: 1,
      });
      await engine.init();
      await engine.connect();
      await engine.put('tasks', 'local_1', { title: 'from primary' });
      await engine.flush();

      localStorage.setItem('interocitor-device-id', 'dev_peer');
      const peer = new SyncEngine(remoteA, {
        remotePath: '/MeshSwap',
        pollInterval: 600_000,
        flushDebounce: 5,
        flushThreshold: 1,
      });
      await peer.init();
      await peer.connect();
      await peer.put('tasks', 'peer_1', { title: 'from peer' });
      await peer.flush();
      await peer.disconnect();

      localStorage.setItem('interocitor-device-id', 'dev_primary');
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

      localStorage.setItem('interocitor-device-id', 'dev_b_reader');
      const reader = new SyncEngine(remoteB, {
        remotePath: '/MeshSwap',
        pollInterval: 600_000,
      });
      await reader.init();
      await reader.connect();
      const localRow = await reader.get('tasks', 'local_1');
      const peerRow = await reader.get('tasks', 'peer_1');
      const switchedRow = await reader.get('tasks', 'after_switch');
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
      const { SyncEngine, readColumn } = await import('/packages/interocitor/dist/index.js');
      const { MemoryAdapter } = await import('/packages/interocitor/dist/adapters/memory.js');

      const adapterA = new MemoryAdapter();
      const adapterB = new MemoryAdapter();

      localStorage.setItem('interocitor-device-id', 'dev_roundtrip_1');
      const clientOne = new SyncEngine({
        remotePath: '/MeshRoundTrip',
        dbName: 'mesh-roundtrip-client-one',
        pollInterval: 600_000,
        flushDebounce: 5,
        flushThreshold: 1,
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

      localStorage.setItem('interocitor-device-id', 'dev_roundtrip_2');
      const clientTwo = new SyncEngine(adapterA, {
        remotePath: '/MeshRoundTrip',
        dbName: 'mesh-roundtrip-client-two',
        pollInterval: 600_000,
        flushDebounce: 5,
        flushThreshold: 1,
      });
      await clientTwo.init();
      await clientTwo.connect();
      await clientTwo.put('tasks', 'from_two', { title: 'from old adapter' });
      await clientTwo.flush();

      localStorage.setItem('interocitor-device-id', 'dev_roundtrip_1');
      await clientOne.put('tasks', 'from_one_late', { title: 'from first while detached' });
      const offlineRow = await clientOne.get('tasks', 'from_one_late');

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
      const { SyncEngine, readColumn } = await import('/packages/interocitor/dist/index.js');
      const { MemoryAdapter } = await import('/packages/interocitor/dist/adapters/memory.js');

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
      const { SyncEngine } = await import('/packages/interocitor/dist/index.js');
      const { MemoryAdapter } = await import('/packages/interocitor/dist/adapters/memory.js');

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

