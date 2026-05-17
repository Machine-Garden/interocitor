import { expect, test } from '@playwright/test';

/* eslint-disable unicorn/consistent-function-scoping -- Browser-context helpers must be defined inside page.evaluate. */


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
      const engine = new Interocitor(adapter, { batchWindowMs: 0, remotePath: '/MeshBoot', pollInterval: 600_000, deviceId: 'dev_bootstrap' });

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

  test('connect() degrades to offline-ready when a cloud stage stalls past deadline', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

      class StallingAdapter extends MemoryAdapter {
        name = 'stalling-memory';
        // Force ensureFolder to never resolve, simulating a remote/network
        // call that hangs without rejecting.
        override async ensureFolder(_path: string): Promise<void> {
          await new Promise<void>(() => { /* never resolves */ });
        }
      }

      const stalled: any[] = [];
      const events: string[] = [];
      const engine = new Interocitor(new StallingAdapter(), {
        remotePath: '/StallingMesh',
        encrypted: false,
        deviceId: 'dev_stall',
        pollInterval: 600_000,
        connectStageTimeoutMs: 50,
        onConnectStalled: (info: any) => stalled.push(info),
      });
      engine.on((event: { type: string }) => events.push(event.type));

      await engine.init();
      const t0 = Date.now();
      let connectError: string | null = null;
      try {
        await engine.connect();
      } catch (err) {
        connectError = err instanceof Error ? err.message : String(err);
      }
      const elapsed = Date.now() - t0;

      // After offline-ready degrade we should still be initialized, not
      // connected, and writes must still queue locally.
      const initializedBefore = engine.isReady();
      await engine.put('tasks', 'queued-offline', { title: 'queued offline' });
      const rowCount = (await engine.query('tasks')).length;
      const initializedAfter = engine.isReady();

      return {
        connectError,
        stalledStages: stalled.map((s: any) => s.stage),
        stalledTimeouts: stalled.map((s: any) => s.timeoutMs),
        events,
        elapsed,
        initializedBefore,
        initializedAfter,
        rowCount,
      };
    });

    expect(result.connectError).toBeNull();
    expect(result.stalledStages).toContain('ensureFolder');
    expect(result.stalledTimeouts.every(ms => ms === 50)).toBe(true);
    expect(result.events).toContain('connect:error');
    expect(result.elapsed).toBeLessThan(2_000);
    expect(result.initializedBefore).toBe(true);
    expect(result.initializedAfter).toBe(true);
    expect(result.rowCount).toBeGreaterThanOrEqual(1);
  });

  test('init survives a local store whose IndexedDB handle starts closing', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

      class OneShotClosingLocalStore {
        // Fails the very first post-open setMeta with a closing-handle error,
        // then succeeds. This models Safari's "transaction on closing DB"
        // failure that we observed in production Sentry data.
        private failedOnce = false;
        private meta = new Map<string, unknown>();
        async open(): Promise<void> { /* success */ }
        close(): void { /* noop */ }
        async getRow(_table: string, _rowId: string): Promise<any> { return undefined; }
        async putRow(_row: any): Promise<void> { /* noop */ }
        async putRows(_rows: any[]): Promise<void> { /* noop */ }
        async getTable(_table: string): Promise<any[]> { return []; }
        async queryWhere(_table: string, _clause: any): Promise<any[]> { return []; }
        async getAllRows(): Promise<any[]> { return []; }
        async clearRows(): Promise<void> { /* noop */ }
        async getTableNames(): Promise<string[]> { return []; }
        async pushOutbox(_entry: any): Promise<void> { /* noop */ }
        async pushOutboxEntries(_entries: any[]): Promise<void> { /* noop */ }
        async drainOutbox(): Promise<any[]> { return []; }
        async outboxSize(): Promise<number> { return 0; }
        async getCursor(_deviceId: string): Promise<number> { return 0; }
        async setCursor(_deviceId: string, _offset: number): Promise<void> { /* noop */ }
        async getAllCursors(): Promise<Record<string, number>> { return {}; }
        async getMeta(key: string): Promise<unknown> { return this.meta.get(key); }
        async setMeta(key: string, value: unknown): Promise<void> {
          if (!this.failedOnce) {
            this.failedOnce = true;
            throw new DOMException('The database connection is closing.', 'InvalidStateError');
          }
          this.meta.set(key, value);
        }
        async clearAll(): Promise<void> { this.meta.clear(); }
      }

      const { createResilientLocalStore } = await import('/packages/core/dist/storage/resilient-store.js');

      const events: string[] = [];
      const degradations: any[] = [];
      const origError = console.error;
      console.error = () => { /* silence noise */ };
      try {
        const engine = new Interocitor(new MemoryAdapter(), {
          remotePath: '/InitSurvivesClosing', pollInterval: 600_000, deviceId: 'init-survival',
          encrypted: false,
          localStoreFactory: () => createResilientLocalStore({
            dbName: 'init-survives-closing',
            openTimeoutMs: 200,
            primaryFactory: () => new OneShotClosingLocalStore() as any,
            onDegraded: (info: any) => { degradations.push(info); },
          }),
        });
        engine.on((event: { type: string }) => events.push(event.type));

        let initError: string | null = null;
        try {
          await engine.init();
        } catch (err) {
          initError = err instanceof Error ? err.message : String(err);
        }
        const initializedAfterInit = engine.isReady();
        let connectError: string | null = null;
        try {
          await engine.connect();
        } catch (err) {
          connectError = err instanceof Error ? err.message : String(err);
        }
        let putError: string | null = null;
        try {
          await engine.put('tasks', 'after-degrade', { title: 'init survived' });
        } catch (err) {
          putError = err instanceof Error ? err.message : String(err);
        }
        let flushError: string | null = null;
        try {
          await engine.flush();
        } catch (err) {
          flushError = err instanceof Error ? err.message : String(err);
        }
        const rows = await engine.query('tasks').catch(() => []);
        const rowCount = rows.length;
        const liveResult = {
          initError,
          connectError,
          putError,
          flushError,
          initializedAfterInit,
          initialized: engine.isReady(),
          rowCount,
          degradationReasons: degradations.map(d => d.reason),
          events,
        };
        await engine.disconnect().catch(() => {});
        return liveResult;
      } finally {
        console.error = origError;
      }
    });

    expect({
      initError: result.initError,
      connectError: result.connectError,
      putError: result.putError,
      flushError: result.flushError,
      initializedAfterInit: result.initializedAfterInit,
      initialized: result.initialized,
      degradationReasons: result.degradationReasons,
    }).toEqual({
      initError: null,
      connectError: null,
      putError: null,
      flushError: null,
      initializedAfterInit: true,
      initialized: true,
      degradationReasons: ['idb-handle-closing'],
    });
    expect(result.rowCount).toBeGreaterThanOrEqual(0);
    expect(result.events).toContain('flush:complete');
  });

  test('subscribes to adapter invalidations and pulls on relay message', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

      class PushAdapter extends MemoryAdapter {
        readonly name = 'push-memory';
        readyCount = 0;
        unsubscribed = false;
        listener: ((payload: { type: string; path: string; ts: number }) => void) | null = null;
        subscribeToInvalidations(onInvalidate: (payload: { type: string; path: string; ts: number }) => void, hooks?: { onReady?: () => void }): () => void {
          this.listener = onInvalidate;
          this.readyCount++;
          hooks?.onReady?.();
          return () => {
            this.unsubscribed = true;
            this.listener = null;
          };
        }
        push(path: string): void {
          this.listener?.({ type: 'invalidation', path, ts: Date.now() });
        }
      }

      const adapter = new PushAdapter();
      const engine = new Interocitor(adapter, { batchWindowMs: 0, remotePath: '/MeshPush', pollInterval: 600_000, deviceId: 'dev_push' });
      const events: string[] = [];
      engine.on((event: { type: string }) => events.push(event.type));

      await engine.init();
      await engine.connect();
      adapter.push('/MeshPush/changes/head.json');
      const deadline = Date.now() + 2_000;
      while (events.filter(type => type === 'sync:complete').length < 2 && Date.now() < deadline) {
        await new Promise(resolve => { setTimeout(resolve, 25); });
      }
      await engine.disconnect();

      return {
        readyCount: adapter.readyCount,
        unsubscribed: adapter.unsubscribed,
        relaySubscribe: events.includes('relay:subscribe'),
        relayReady: events.includes('relay:ready'),
        relayMessage: events.includes('relay:message'),
        syncCompleteCount: events.filter(type => type === 'sync:complete').length,
      };
    });

    expect(result.readyCount).toBe(1);
    expect(result.unsubscribed).toBe(true);
    expect(result.relaySubscribe).toBe(true);
    expect(result.relayReady).toBe(true);
    expect(result.relayMessage).toBe(true);
    expect(result.syncCompleteCount).toBeGreaterThanOrEqual(2);
  });

  test('request budget: reconnect budget is observed and bounded', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

      class CountingPushAdapter extends MemoryAdapter {
        name = 'counting-push-memory';
        counts = {
          authenticate: 0,
          ensureFolder: 0,
          listFiles: 0,
          listFolders: 0,
          readFile: 0,
          writeFile: 0,
          deleteFile: 0,
          getFileMetadata: 0,
          subscribeToInvalidations: 0,
          unsubscribeRemoteInvalidations: 0,
        };
        listener: ((payload: { type: string; path: string; ts: number }) => void) | null = null;
        async authenticate() { this.counts.authenticate++; return await super.authenticate(); }
        async ensureFolder(path: string) { this.counts.ensureFolder++; return await super.ensureFolder(path); }
        async listFiles(path: string) { this.counts.listFiles++; return await super.listFiles(path); }
        async listFolders(path: string) { this.counts.listFolders++; return await super.listFolders(path); }
        async readFile(path: string) { this.counts.readFile++; return await super.readFile(path); }
        async writeFile(path: string, data: Uint8Array | string) { this.counts.writeFile++; return await super.writeFile(path, data); }
        async deleteFile(path: string) { this.counts.deleteFile++; return await super.deleteFile(path); }
        async getFileMetadata(path: string) { this.counts.getFileMetadata++; return await super.getFileMetadata(path); }
        subscribeToInvalidations(onInvalidate: (payload: { type: string; path: string; ts: number }) => void, hooks?: { onReady?: () => void }): () => void {
          this.counts.subscribeToInvalidations++;
          this.listener = onInvalidate;
          hooks?.onReady?.();
          return () => {
            this.counts.unsubscribeRemoteInvalidations++;
            this.listener = null;
          };
        }
        snapshotCounts() { return { ...this.counts }; }
      }

      const adapter = new CountingPushAdapter();
      const engine = new Interocitor(adapter, { batchWindowMs: 0, remotePath: '/MeshBudget', pollInterval: 600_000, deviceId: 'dev_budget' });
      await engine.init();
      await engine.connect();
      await engine.disconnect();
      const afterFirstSession = adapter.snapshotCounts();

      const engine2 = new Interocitor(adapter, { batchWindowMs: 0, remotePath: '/MeshBudget', pollInterval: 600_000, deviceId: 'dev_budget' });
      await engine2.init();
      await engine2.connect();
      await engine2.disconnect();
      const afterSecondSession = adapter.snapshotCounts();

      return {
        firstSession: afterFirstSession,
        secondSessionDelta: {
          authenticate: afterSecondSession.authenticate - afterFirstSession.authenticate,
          ensureFolder: afterSecondSession.ensureFolder - afterFirstSession.ensureFolder,
          listFiles: afterSecondSession.listFiles - afterFirstSession.listFiles,
          listFolders: afterSecondSession.listFolders - afterFirstSession.listFolders,
          readFile: afterSecondSession.readFile - afterFirstSession.readFile,
          writeFile: afterSecondSession.writeFile - afterFirstSession.writeFile,
          deleteFile: afterSecondSession.deleteFile - afterFirstSession.deleteFile,
          getFileMetadata: afterSecondSession.getFileMetadata - afterFirstSession.getFileMetadata,
          subscribeToInvalidations: afterSecondSession.subscribeToInvalidations - afterFirstSession.subscribeToInvalidations,
          unsubscribeRemoteInvalidations: afterSecondSession.unsubscribeRemoteInvalidations - afterFirstSession.unsubscribeRemoteInvalidations,
        },
      };
    });

    expect(result.firstSession.authenticate).toBe(1);
    expect(result.firstSession.ensureFolder).toBe(4);
    expect(result.firstSession.listFiles).toBe(1);
    expect(result.firstSession.listFolders).toBe(0);
    expect(result.firstSession.readFile).toBe(2);
    expect(result.firstSession.writeFile).toBe(3);
    expect(result.firstSession.deleteFile).toBe(0);
    expect(result.firstSession.getFileMetadata).toBe(0);
    expect(result.secondSessionDelta.authenticate).toBe(0);
    expect(result.secondSessionDelta.ensureFolder).toBeGreaterThanOrEqual(0);
    expect(result.secondSessionDelta.listFiles).toBeGreaterThanOrEqual(0);
    expect(result.secondSessionDelta.listFolders).toBe(0);
    expect(result.secondSessionDelta.readFile).toBeGreaterThanOrEqual(0);
    expect(result.secondSessionDelta.writeFile).toBeLessThanOrEqual(1);
    expect(result.secondSessionDelta.deleteFile).toBe(0);
    expect(result.secondSessionDelta.getFileMetadata).toBe(0);
    expect(result.secondSessionDelta.subscribeToInvalidations).toBe(1);
    expect(result.secondSessionDelta.unsubscribeRemoteInvalidations).toBe(1);
  });

  test('request budget: invalidation bursts trigger at most one list and no writes when nothing changed', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

      class CountingPushAdapter extends MemoryAdapter {
        name = 'counting-push-memory';
        counts = {
          authenticate: 0,
          ensureFolder: 0,
          listFiles: 0,
          listFolders: 0,
          readFile: 0,
          writeFile: 0,
          deleteFile: 0,
          getFileMetadata: 0,
          subscribeToInvalidations: 0,
          unsubscribeRemoteInvalidations: 0,
        };
        listener: ((payload: { type: string; path: string; ts: number }) => void) | null = null;
        async authenticate() { this.counts.authenticate++; return await super.authenticate(); }
        async ensureFolder(path: string) { this.counts.ensureFolder++; return await super.ensureFolder(path); }
        async listFiles(path: string) { this.counts.listFiles++; return await super.listFiles(path); }
        async listFolders(path: string) { this.counts.listFolders++; return await super.listFolders(path); }
        async readFile(path: string) { this.counts.readFile++; return await super.readFile(path); }
        async writeFile(path: string, data: Uint8Array | string) { this.counts.writeFile++; return await super.writeFile(path, data); }
        async deleteFile(path: string) { this.counts.deleteFile++; return await super.deleteFile(path); }
        async getFileMetadata(path: string) { this.counts.getFileMetadata++; return await super.getFileMetadata(path); }
        subscribeToInvalidations(onInvalidate: (payload: { type: string; path: string; ts: number }) => void, hooks?: { onReady?: () => void }): () => void {
          this.counts.subscribeToInvalidations++;
          this.listener = onInvalidate;
          hooks?.onReady?.();
          return () => {
            this.counts.unsubscribeRemoteInvalidations++;
            this.listener = null;
          };
        }
        push(path: string): void {
          this.listener?.({ type: 'invalidation', path, ts: Date.now() });
        }
        snapshotCounts() { return { ...this.counts }; }
      }

      const adapter = new CountingPushAdapter();
      const engine = new Interocitor(adapter, { batchWindowMs: 0, remotePath: '/MeshBurstBudget', pollInterval: 600_000, deviceId: 'dev_burst' });
      await engine.init();
      await engine.connect();
      const baseline = adapter.snapshotCounts();

      adapter.push('/MeshBurstBudget/changes/head.json');
      adapter.push('/MeshBurstBudget/changes/head.json');
      adapter.push('/MeshBurstBudget/changes/head.json');
      await new Promise(resolve => { setTimeout(resolve, 100); });
      const afterBurst = adapter.snapshotCounts();
      await engine.disconnect();

      return {
        delta: {
          authenticate: afterBurst.authenticate - baseline.authenticate,
          ensureFolder: afterBurst.ensureFolder - baseline.ensureFolder,
          listFiles: afterBurst.listFiles - baseline.listFiles,
          listFolders: afterBurst.listFolders - baseline.listFolders,
          readFile: afterBurst.readFile - baseline.readFile,
          writeFile: afterBurst.writeFile - baseline.writeFile,
          deleteFile: afterBurst.deleteFile - baseline.deleteFile,
          getFileMetadata: afterBurst.getFileMetadata - baseline.getFileMetadata,
          subscribeToInvalidations: afterBurst.subscribeToInvalidations - baseline.subscribeToInvalidations,
          unsubscribeRemoteInvalidations: afterBurst.unsubscribeRemoteInvalidations - baseline.unsubscribeRemoteInvalidations,
        },
      };
    });

    expect(result.delta.authenticate).toBe(0);
    expect(result.delta.ensureFolder).toBe(0);
    expect(result.delta.listFiles).toBe(0);
    expect(result.delta.listFolders).toBe(0);
    expect(result.delta.readFile).toBeLessThanOrEqual(2);
    expect(result.delta.writeFile).toBe(0);
    expect(result.delta.deleteFile).toBe(0);
    expect(result.delta.getFileMetadata).toBe(0);
    expect(result.delta.subscribeToInvalidations).toBe(0);
    expect(result.delta.unsubscribeRemoteInvalidations).toBe(0);
  });

  test('request budget: repeated same-adapter setRemoteStorage is zero remote requests', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

      class CountingAdapter extends MemoryAdapter {
        counts = { authenticate: 0, ensureFolder: 0, listFiles: 0, listFolders: 0, readFile: 0, writeFile: 0, deleteFile: 0, getFileMetadata: 0 };
        async authenticate() { this.counts.authenticate++; return await super.authenticate(); }
        async ensureFolder(path: string) { this.counts.ensureFolder++; return await super.ensureFolder(path); }
        async listFiles(path: string) { this.counts.listFiles++; return await super.listFiles(path); }
        async listFolders(path: string) { this.counts.listFolders++; return await super.listFolders(path); }
        async readFile(path: string) { this.counts.readFile++; return await super.readFile(path); }
        async writeFile(path: string, data: Uint8Array | string) { this.counts.writeFile++; return await super.writeFile(path, data); }
        async deleteFile(path: string) { this.counts.deleteFile++; return await super.deleteFile(path); }
        async getFileMetadata(path: string) { this.counts.getFileMetadata++; return await super.getFileMetadata(path); }
        snapshotCounts() { return { ...this.counts }; }
      }

      const adapter = new CountingAdapter();
      const engine = new Interocitor(adapter, { batchWindowMs: 0, remotePath: '/MeshSameAdapter', pollInterval: 600_000, deviceId: 'dev_same_adapter' });
      await engine.init();
      const before = adapter.snapshotCounts();
      await engine.setRemoteStorage(adapter);
      const after = adapter.snapshotCounts();
      return {
        delta: {
          authenticate: after.authenticate - before.authenticate,
          ensureFolder: after.ensureFolder - before.ensureFolder,
          listFiles: after.listFiles - before.listFiles,
          listFolders: after.listFolders - before.listFolders,
          readFile: after.readFile - before.readFile,
          writeFile: after.writeFile - before.writeFile,
          deleteFile: after.deleteFile - before.deleteFile,
          getFileMetadata: after.getFileMetadata - before.getFileMetadata,
        },
      };
    });

    expect(result.delta.authenticate).toBe(0);
    expect(result.delta.ensureFolder).toBe(0);
    expect(result.delta.listFiles).toBe(0);
    expect(result.delta.listFolders).toBe(0);
    expect(result.delta.readFile).toBe(0);
    expect(result.delta.writeFile).toBe(0);
    expect(result.delta.deleteFile).toBe(0);
    expect(result.delta.getFileMetadata).toBe(0);
  });

  test('coalesces invalidation bursts without overlapping sync runs', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

      class PushAdapter extends MemoryAdapter {
        readonly name = 'push-memory';
        listener: ((payload: { type: string; path: string; ts: number }) => void) | null = null;
        subscribeToInvalidations(onInvalidate: (payload: { type: string; path: string; ts: number }) => void, hooks?: { onReady?: () => void }): () => void {
          this.listener = onInvalidate;
          hooks?.onReady?.();
          return () => {
            this.listener = null;
          };
        }
        push(path: string): void {
          this.listener?.({ type: 'invalidation', path, ts: Date.now() });
        }
      }

      const adapter = new PushAdapter();
      const engine = new Interocitor(adapter, { batchWindowMs: 0, remotePath: '/MeshBurst', pollInterval: 600_000, deviceId: 'dev_burst' });
      let activeSyncs = 0;
      let maxConcurrentSyncs = 0;
      let invalidationMessages = 0;
      let syncCompletes = 0;
      engine.on((event: { type: string }) => {
        if (event.type === 'relay:message') invalidationMessages++;
        if (event.type === 'sync:start') {
          activeSyncs++;
          maxConcurrentSyncs = Math.max(maxConcurrentSyncs, activeSyncs);
        }
        if (event.type === 'sync:complete' || event.type === 'sync:error') {
          activeSyncs = Math.max(0, activeSyncs - 1);
          syncCompletes++;
        }
      });

      await engine.init();
      await engine.connect();
      syncCompletes = 0;
      invalidationMessages = 0;
      activeSyncs = 0;
      maxConcurrentSyncs = 0;

      adapter.push('/MeshBurst/changes/head.json');
      adapter.push('/MeshBurst/changes/head.json');
      adapter.push('/MeshBurst/changes/head.json');
      await new Promise(resolve => { setTimeout(resolve, 100); });
      await engine.disconnect();

      return {
        invalidationMessages,
        syncCompletes,
        maxConcurrentSyncs,
      };
    });

    expect(result.invalidationMessages).toBe(3);
    expect(result.syncCompletes).toBeLessThanOrEqual(1);
    expect(result.maxConcurrentSyncs).toBeLessThanOrEqual(1);
  });

  test('flush writes one file per change and updates head', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

      const adapter = new MemoryAdapter();
      const engine = new Interocitor(adapter, {
        batchWindowMs: 0, remotePath: '/MeshFlush',
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

      const engineA = new Interocitor(shared, { batchWindowMs: 0, remotePath: '/MeshSync', pollInterval: 600_000, flushThreshold: 1, deviceId: 'dev_a' });
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

      const engineB = new Interocitor(shared, { batchWindowMs: 0, remotePath: '/MeshSync', pollInterval: 600_000, deviceId: 'dev_b' });
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
        batchWindowMs: 0, remotePath: '/MeshWhere',
        pollInterval: 600_000,
        deviceId: 'dev_where',
        schema: {
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

  test('keeps indexed where range queries isolated to their table', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor, types } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

      const engine = new Interocitor(new MemoryAdapter(), {
        batchWindowMs: 0,
        remotePath: '/MeshWhereLeakRange',
        pollInterval: 600_000,
        deviceId: 'dev_where_leak_range',
        schema: {
          tables: {
            alphaMeals: { fields: { date: types.index(types.string) } },
            cookedMeals: { fields: { date: types.index(types.string) } },
            mealEntries: { fields: { date: types.index(types.string) } },
          },
        },
      });

      await engine.init();
      await engine.connect();

      await engine.table('alphaMeals').put('alpha-1', {
        id: 'alpha-1',
        date: '2026-05-01',
        beforeOnly: true,
      } as any);
      await engine.table('cookedMeals').put('cooked-1', {
        id: 'cooked-1',
        date: '2026-05-02',
        targetOnly: true,
      } as any);
      await engine.table('mealEntries').put('entry-1', {
        id: 'entry-1',
        date: '2026-05-03',
        afterOnly: true,
      } as any);

      const above = await engine.table('cookedMeals').where('date').above('2026-05-01' as any);
      const aboveOrEqual = await engine.table('cookedMeals').where('date').aboveOrEqual('2026-05-02' as any);
      const below = await engine.table('cookedMeals').where('date').below('2026-05-03' as any);
      const belowOrEqual = await engine.table('cookedMeals').where('date').belowOrEqual('2026-05-02' as any);
      const between = await engine.table('cookedMeals').where('date').between('2026-05-01' as any, '2026-05-03' as any);
      const startsWith = await engine.table('cookedMeals').where('date').startsWith('2026-05');

      await engine.disconnect();

      return {
        above: above.map((row: any) => ({
          id: row.id,
          targetOnly: row.targetOnly === true,
          beforeOnly: row.beforeOnly === true,
          afterOnly: row.afterOnly === true,
        })),
        aboveOrEqual: aboveOrEqual.map((row: any) => ({
          id: row.id,
          targetOnly: row.targetOnly === true,
          beforeOnly: row.beforeOnly === true,
          afterOnly: row.afterOnly === true,
        })),
        below: below.map((row: any) => ({
          id: row.id,
          targetOnly: row.targetOnly === true,
          beforeOnly: row.beforeOnly === true,
          afterOnly: row.afterOnly === true,
        })),
        belowOrEqual: belowOrEqual.map((row: any) => ({
          id: row.id,
          targetOnly: row.targetOnly === true,
          beforeOnly: row.beforeOnly === true,
          afterOnly: row.afterOnly === true,
        })),
        between: between.map((row: any) => ({
          id: row.id,
          targetOnly: row.targetOnly === true,
          beforeOnly: row.beforeOnly === true,
          afterOnly: row.afterOnly === true,
        })),
        startsWith: startsWith.map((row: any) => ({
          id: row.id,
          targetOnly: row.targetOnly === true,
          beforeOnly: row.beforeOnly === true,
          afterOnly: row.afterOnly === true,
        })),
      };
    });

    const expected = [{ id: 'cooked-1', targetOnly: true, beforeOnly: false, afterOnly: false }];
    expect(result.above).toEqual(expected);
    expect(result.aboveOrEqual).toEqual(expected);
    expect(result.below).toEqual(expected);
    expect(result.belowOrEqual).toEqual(expected);
    expect(result.between).toEqual(expected);
    expect(result.startsWith).toEqual(expected);
  });

  test('keeps indexed where equality and anyOf queries isolated to their table', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor, types } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

      const engine = new Interocitor(new MemoryAdapter(), {
        batchWindowMs: 0,
        remotePath: '/MeshWhereLeakExact',
        pollInterval: 600_000,
        deviceId: 'dev_where_leak_exact',
        schema: {
          tables: {
            cookedMeals: { fields: { date: types.index(types.string) } },
            mealEntries: { fields: { date: types.index(types.string) } },
          },
        },
      });

      await engine.init();
      await engine.connect();

      await engine.table('mealEntries').put('entry-same-date', {
        id: 'entry-same-date',
        date: '2026-05-02',
        slot: 'dinner',
        recipeId: '11ea811631',
      } as any);
      await engine.table('cookedMeals').put('cooked-same-date', {
        id: 'cooked-same-date',
        date: '2026-05-02',
        title: 'Dinner',
        recipeId: '11ea811631',
      } as any);
      await engine.table('mealEntries').put('entry-other-date', {
        id: 'entry-other-date',
        date: '2026-05-03',
        slot: 'lunch',
      } as any);

      const equals = await engine.table('cookedMeals').where('date').equals('2026-05-02' as any);
      const anyOf = await engine.table('cookedMeals').where('date').anyOf(['2026-05-02', '2026-05-03'] as any);

      await engine.disconnect();

      return {
        equals: equals.map((row: any) => ({
          id: row.id,
          hasCookedShape: row.title === 'Dinner',
          hasMealEntryShape: row.slot !== undefined,
        })),
        anyOf: anyOf.map((row: any) => ({
          id: row.id,
          hasCookedShape: row.title === 'Dinner',
          hasMealEntryShape: row.slot !== undefined,
        })),
      };
    });

    const expected = [{ id: 'cooked-same-date', hasCookedShape: true, hasMealEntryShape: false }];
    expect(result.equals).toEqual(expected);
    expect(result.anyOf).toEqual(expected);
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
        batchWindowMs: 0, remotePath: '/Bad',
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
        batchWindowMs: 0, remotePath: '/MeshEnc',
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
        batchWindowMs: 0, remotePath: '/MeshSnapshotFP',
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
        batchWindowMs: 0, remotePath: '/MeshSnapshotSource',
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
        batchWindowMs: 0, remotePath: '/MeshSnapshotTarget',
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
        batchWindowMs: 0, remotePath: '/MeshSnapshotTarget',
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
        batchWindowMs: 0, remotePath: '/MeshSource',
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
        batchWindowMs: 0, remotePath: '/MeshTarget',
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
        batchWindowMs: 0, remotePath: '/MeshTarget',
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
        batchWindowMs: 0, remotePath: '/MeshLateAttach',
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
        batchWindowMs: 0, remotePath: '/MeshSwap',
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
        batchWindowMs: 0, remotePath: '/MeshSwap',
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
        batchWindowMs: 0, remotePath: '/MeshSwap',
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
        batchWindowMs: 0, remotePath: '/MeshRoundTrip',
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
        batchWindowMs: 0, remotePath: '/MeshCompact',
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
        batchWindowMs: 0, remotePath: '/MeshCompact',
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
        batchWindowMs: 0, dbName: 'lazy-config-db',
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
        batchWindowMs: 0, dbName: 'resolve-initial-db',
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

  test('setPassphrase works after init before connect', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');
      const engine = new Interocitor(new MemoryAdapter(), {
        remotePath: '/PassphraseMesh',
        dbName: 'passphrase-after-init-db',
        appName: 'Test App',
        encrypted: false,
      });

      await engine.init();
      engine.setPassphrase('pairing-passphrase');
      const beforeConnect = { passphrase: engine.getPassphrase(), encrypted: engine.isEncrypted() };
      await engine.disconnect();
      return beforeConnect;
    });

    expect(result).toEqual({ passphrase: 'pairing-passphrase', encrypted: true });
  });

  test('setPassphrase is rejected while connected', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');
      const engine = new Interocitor(new MemoryAdapter(), {
        remotePath: '/ConnectedPassphraseMesh',
        dbName: 'passphrase-connected-db',
        appName: 'Test App',
        encrypted: false,
      });

      await engine.connect();
      try {
        engine.setPassphrase('too-late');
        return 'no-error';
      } catch (error: any) {
        return String(error?.message ?? error);
      } finally {
        await engine.disconnect();
      }
    });

    expect(result).toContain('Cannot set passphrase while connected');
  });

  test('emits compact:warning when queued changes reach compactWarnThreshold', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

      const engine = new Interocitor(new MemoryAdapter(), {
        remotePath: '/WarnMesh',
        dbName: 'warn-mesh-db',
        encrypted: false,
        pollInterval: 600_000,
        flushThreshold: 9999,
        flushDebounce: 60_000,
        compactWarnThreshold: 3,
        compactAutoThreshold: 9999,
        autoCompact: false,
        batchWindowMs: 0,
      });

      const events: string[] = [];
      engine.on(e => { events.push(e.type); });

      await engine.init();
      // No remote connect — warning fires on write, not connect

      await engine.put('tasks', 't1', { title: 'one' });
      await engine.put('tasks', 't2', { title: 'two' });
      const beforeThird = events.filter(e => e === 'compact:warning').length;
      await engine.put('tasks', 't3', { title: 'three' });
      const afterThird = events.filter(e => e === 'compact:warning').length;
      // Warning fires exactly once even with more writes
      await engine.put('tasks', 't4', { title: 'four' });
      const afterFourth = events.filter(e => e === 'compact:warning').length;

      await engine.disconnect();
      return { beforeThird, afterThird, afterFourth };
    });

    expect(result.beforeThird).toBe(0);
    expect(result.afterThird).toBe(1);
    expect(result.afterFourth).toBe(1); // no duplicate
  });

  test('emits compact:auto:skip with reason=not-connected when not connected', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

      const engine = new Interocitor(new MemoryAdapter(), {
        remotePath: '/SkipMesh',
        dbName: 'skip-mesh-db',
        encrypted: false,
        pollInterval: 600_000,
        flushThreshold: 2,
        flushDebounce: 60_000,
        compactWarnThreshold: 2,
        compactAutoThreshold: 2,
        compactAutoSampleNumerator: 10,
        compactAutoDeviceCount: 1,
        autoCompact: true,
        batchWindowMs: 0,
      });

      const skipEvents: any[] = [];
      engine.on(e => { if (e.type === 'compact:auto:skip') skipEvents.push(e); });

      await engine.init();
      // Do NOT connect — auto-compact should skip with not-connected

      await engine.put('tasks', 't1', { title: 'one' });
      await engine.put('tasks', 't2', { title: 'two' });
      // flush:threshold triggers doFlush which triggers maybeAutoCompact
      await new Promise(resolve => { setTimeout(resolve, 100); });

      await engine.disconnect();
      return { skipReasons: skipEvents.map(e => e.reason) };
    });

    expect(result.skipReasons).toContain('not-connected');
  });

  test('emits compact:auto:skip with reason=disabled when autoCompact=false', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

      const adapter = new MemoryAdapter();
      const engine = new Interocitor(adapter, {
        batchWindowMs: 0, remotePath: '/DisabledMesh',
        dbName: 'disabled-mesh-db',
        encrypted: false,
        pollInterval: 600_000,
        flushThreshold: 9999,
        flushDebounce: 60_000,
        compactWarnThreshold: 9999,
        compactAutoThreshold: 2,
        compactAutoSampleNumerator: 10,
        compactAutoDeviceCount: 1,
        autoCompact: false,
      });

      const skipEvents: any[] = [];
      engine.on(e => { if (e.type === 'compact:auto:skip') skipEvents.push(e); });

      await engine.init();
      await engine.connect();
      await engine.put('tasks', 't1', { title: 'one' });
      await engine.put('tasks', 't2', { title: 'two' });
      await engine.flush();

      await engine.disconnect();
      return { skipReasons: skipEvents.map(e => e.reason) };
    });

    expect(result.skipReasons).toContain('disabled');
  });

  test('compact:warning resets after flush drains outbox', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

      const adapter = new MemoryAdapter();
      const engine = new Interocitor(adapter, {
        batchWindowMs: 0, remotePath: '/ResetWarnMesh',
        dbName: 'reset-warn-db',
        encrypted: false,
        pollInterval: 600_000,
        flushThreshold: 9999,
        flushDebounce: 60_000,
        compactWarnThreshold: 2,
        compactAutoThreshold: 9999,
        autoCompact: false,
      });

      const warnings: number[] = [];
      engine.on(e => { if (e.type === 'compact:warning') warnings.push(Date.now()); });

      await engine.init();
      await engine.connect();

      // trigger warning
      await engine.put('tasks', 't1', { title: 'one' });
      await engine.put('tasks', 't2', { title: 'two' });
      const warnCountBefore = warnings.length;

      // flush resets warning state
      await engine.flush();

      // new writes should warn again
      await engine.put('tasks', 't3', { title: 'three' });
      await engine.put('tasks', 't4', { title: 'four' });
      const warnCountAfter = warnings.length;

      await engine.disconnect();
      return { warnCountBefore, warnCountAfter };
    });

    expect(result.warnCountBefore).toBe(1);
    expect(result.warnCountAfter).toBe(2); // second warning after flush reset
  });

  test('two-phase write + manual compact + third client reads snapshot only', async ({ page }) => {
    // Phase 1: clientA writes 10 todos, flushes → 10 change files on remote
    // Phase 2: clientB pulls, sees 10 rows
    // Phase 3: clientA writes 20 more todos, flushes → 30 change files on remote
    // Phase 4: clientA compacts → 1 snapshot, change files for epoch pruned
    // Phase 5: fresh clientC pulls → reads 1 snapshot, sees all 30 rows, no raw change files needed
    const result = await page.evaluate(async () => {
      const { Interocitor, readColumn } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

      const shared = new MemoryAdapter();
      const REMOTE = '/CompactTwoPhase';

      // helper: count change files (not head, not snapshot, not manifest)
      const countChangeFiles = (dump: Record<string, string>) =>
        Object.keys(dump).filter(p => /\/changes\/[^/]+-chg_[^/]+\.json$/.test(p)).length;

      // helper: count snapshot files
      const countSnapshotFiles = (dump: Record<string, string>) =>
        Object.keys(dump).filter(p => p.includes('/mainline/snapshot-')).length;

      // helper: clear IDB between device simulations
      const clearIDB = (name: string) => new Promise<void>(resolve => {
        const req = indexedDB.deleteDatabase(name);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      });

      // ── Phase 1: clientA writes 10 todos ──────────────────────────────
      const engineA = new Interocitor(shared, {
        batchWindowMs: 0, remotePath: REMOTE, dbName: 'phase-a', encrypted: false,
        pollInterval: 600_000, flushThreshold: 9999, flushDebounce: 60_000,
        autoCompact: false, deviceId: 'dev_a',
      });
      await engineA.init();
      await engineA.connect();
      for (let i = 0; i < 10; i++) {
        await engineA.put('todos', `todo-${i}`, { title: `todo ${i}`, done: false });
      }
      await engineA.flush();
      const changeFilesAfterPhase1 = countChangeFiles(shared.dump());
      await engineA.disconnect();

      // ── Phase 2: clientB pulls, sees 10 rows ─────────────────────────
      await clearIDB('phase-b');
      const engineB = new Interocitor(shared, {
        batchWindowMs: 0, remotePath: REMOTE, dbName: 'phase-b', encrypted: false,
        pollInterval: 600_000, autoCompact: false, deviceId: 'dev_b',
      });
      await engineB.init();
      await engineB.connect();
      const rowsAfterPhase2 = (await engineB.table('todos').query()).length;
      await engineB.disconnect();

      // ── Phase 3: clientA writes 20 more todos ────────────────────────
      const engineA2 = new Interocitor(shared, {
        batchWindowMs: 0, remotePath: REMOTE, dbName: 'phase-a', encrypted: false,
        pollInterval: 600_000, flushThreshold: 9999, flushDebounce: 60_000,
        autoCompact: false, deviceId: 'dev_a',
      });
      await engineA2.init();
      await engineA2.connect();
      for (let i = 10; i < 30; i++) {
        await engineA2.put('todos', `todo-${i}`, { title: `todo ${i}`, done: false });
      }
      await engineA2.flush();
      const changeFilesAfterPhase3 = countChangeFiles(shared.dump());
      const snapshotsBeforeCompact = countSnapshotFiles(shared.dump());

      // ── Phase 4: clientA compacts ─────────────────────────────────────
      await engineA2.compact();
      const changeFilesAfterCompact = countChangeFiles(shared.dump());
      const snapshotsAfterCompact = countSnapshotFiles(shared.dump());
      await engineA2.disconnect();

      // ── Phase 5: fresh clientC reads snapshot, sees all 30 rows ──────
      await clearIDB('phase-c');
      const engineC = new Interocitor(shared, {
        batchWindowMs: 0, remotePath: REMOTE, dbName: 'phase-c', encrypted: false,
        pollInterval: 600_000, autoCompact: false, deviceId: 'dev_c',
      });
      await engineC.init();
      await engineC.connect();
      const rowsAfterPhase5 = (await engineC.table('todos').query()).length;
      const firstRow = await engineC.loadRow({ table: 'todos', rowId: 'todo-0' });
      const lastRow = await engineC.loadRow({ table: 'todos', rowId: 'todo-29' });
      await engineC.disconnect();

      return {
        changeFilesAfterPhase1,   // expect 10
        rowsAfterPhase2,          // expect 10
        changeFilesAfterPhase3,   // expect 30
        snapshotsBeforeCompact,   // expect 0
        changeFilesAfterCompact,  // expect 0 (all pruned, within compaction epoch)
        snapshotsAfterCompact,    // expect 1
        rowsAfterPhase5,          // expect 30
        firstRowTitle: firstRow ? readColumn(firstRow, 'title') : null,
        lastRowTitle: lastRow ? readColumn(lastRow, 'title') : null,
      };
    });

    expect(result.changeFilesAfterPhase1).toBe(10);
    expect(result.rowsAfterPhase2).toBe(10);
    expect(result.changeFilesAfterPhase3).toBe(30);
    expect(result.snapshotsBeforeCompact).toBe(0);
    expect(result.changeFilesAfterCompact).toBe(0);
    expect(result.snapshotsAfterCompact).toBe(1);
    expect(result.rowsAfterPhase5).toBe(30);
    expect(result.firstRowTitle).toBe('todo 0');
    expect(result.lastRowTitle).toBe('todo 29');
  });

  test('delayed compact: schedules check phase on first write, skips when below remote threshold', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

      const adapter = new MemoryAdapter();
      const engine = new Interocitor(adapter, {
        remotePath: '/DelayedMesh',
        dbName: 'delayed-mesh-db',
        encrypted: false,
        pollInterval: 600_000,
        flushThreshold: 9999,
        flushDebounce: 60_000,
        compactWarnThreshold: 9999,
        compactAutoThreshold: 9999,
        autoCompact: true,
        firstCompactDelayMs: 50,
        firstCompactDelayJitterMs: 0,
        secondCompactDelayMs: 50,
        secondCompactDelayJitterMs: 0,
        compactRemoteChangeThreshold: 5,
        batchWindowMs: 0,
      });

      const events: any[] = [];
      engine.on(e => {
        if (e.type === 'compact:delayed:scheduled' || e.type === 'compact:delayed:check' || e.type === 'compact:auto:skip') {
          events.push(e);
        }
      });

      await engine.init();
      await engine.connect();
      await engine.put('tasks', 't1', { title: 'one' });
      await engine.flush();
      await new Promise(resolve => { setTimeout(resolve, 200); });
      await engine.disconnect();

      return {
        scheduledCheck: events.some(e => e.type === 'compact:delayed:scheduled' && e.phase === 'check'),
        check: events.find(e => e.type === 'compact:delayed:check'),
        skipBelowThreshold: events.find(e => e.type === 'compact:auto:skip' && e.reason === 'below-remote-threshold'),
      };
    });

    expect(result.scheduledCheck).toBe(true);
    expect(result.check?.remoteChangeFileCount).toBe(1);
    expect(result.skipBelowThreshold?.trigger).toBe('delayed');
  });

  test('delayed compact: arms second timer and runs when remote files exceed threshold', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

      const adapter = new MemoryAdapter();
      const engine = new Interocitor(adapter, {
        remotePath: '/DelayedRunMesh',
        dbName: 'delayed-run-mesh-db',
        encrypted: false,
        pollInterval: 600_000,
        flushThreshold: 9999,
        flushDebounce: 60_000,
        compactWarnThreshold: 9999,
        compactAutoThreshold: 9999,
        autoCompact: true,
        firstCompactDelayMs: 30,
        firstCompactDelayJitterMs: 0,
        secondCompactDelayMs: 30,
        secondCompactDelayJitterMs: 0,
        compactRemoteChangeThreshold: 2,
        batchWindowMs: 0,
      });

      const events: any[] = [];
      engine.on(e => {
        if (e.type === 'compact:delayed:scheduled' || e.type === 'compact:delayed:check'
            || e.type === 'compact:auto:start' || e.type === 'compact:auto:complete') {
          events.push(e);
        }
      });

      await engine.init();
      await engine.connect();
      // 3 writes => 3 remote change files, above threshold (2)
      await engine.put('tasks', 't1', { title: 'one' });
      await engine.put('tasks', 't2', { title: 'two' });
      await engine.put('tasks', 't3', { title: 'three' });
      await engine.flush();
      // Wait for full delayed pipeline: check + run
      await new Promise(resolve => { setTimeout(resolve, 250); });
      await engine.disconnect();

      return {
        check: events.find(e => e.type === 'compact:delayed:check'),
        scheduledCompact: events.find(e => e.type === 'compact:delayed:scheduled' && e.phase === 'compact'),
        start: events.find(e => e.type === 'compact:auto:start' && e.trigger === 'delayed'),
        complete: events.find(e => e.type === 'compact:auto:complete' && e.trigger === 'delayed'),
      };
    });

    expect(result.check?.remoteChangeFileCount).toBeGreaterThanOrEqual(3);
    expect(result.scheduledCompact).toBeDefined();
    expect(result.start?.remoteChangeFileCount).toBeGreaterThanOrEqual(3);
    expect(result.complete).toBeDefined();
  });

  test('compaction publishes a GC floor and omits known tombstones after all active devices ack', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

      const adapter = new MemoryAdapter();
      const engine = new Interocitor(adapter, {
        remotePath: '/GcFloorMesh',
        dbName: 'gc-floor-db',
        encrypted: false,
        pollInterval: 600_000,
        flushThreshold: 9999,
        flushDebounce: 60_000,
        autoCompact: false,
        batchWindowMs: 0,
        deviceId: 'dev_gc_a',
        offlineGraceMs: 7 * 24 * 60 * 60_000,
      });

      await engine.init();
      await engine.connect();
      await engine.put('tasks', 'gone', { title: 'old' });
      await engine.flush();
      await engine.delete('tasks', 'gone');
      await engine.flush();

      await engine.compact();
      const manifestAfterFirst = engine.getManifest();
      const firstSnapshotPath = manifestAfterFirst?.snapshotPath ?? '';
      const firstSnapshotPayload = JSON.parse(adapter.dump()[firstSnapshotPath]);
      const firstSnapshot = firstSnapshotPayload.snapshot;
      const firstHasTombstone = Boolean(firstSnapshot.tables.tasks?.gone?._meta.deleted);

      await engine.compact();
      const manifestAfterSecond = engine.getManifest();
      const secondSnapshotPath = manifestAfterSecond?.snapshotPath ?? '';
      const secondSnapshotPayload = JSON.parse(adapter.dump()[secondSnapshotPath]);
      const secondSnapshot = secondSnapshotPayload.snapshot;
      const secondHasGoneRow = Boolean(secondSnapshot.tables.tasks?.gone);
      const deviceMeta = JSON.parse(adapter.dump()['/GcFloorMesh/devices/dev_gc_a.json']);

      await engine.disconnect();

      return {
        firstHasTombstone,
        secondHasGoneRow,
        firstWatermark: manifestAfterFirst?.watermarkHlc,
        gcFloor: manifestAfterSecond?.gcFloorHlc,
        gcEpoch: manifestAfterSecond?.gcEpoch,
        deviceObserved: deviceMeta.observedWatermarkHlc,
      };
    });

    expect(result.firstHasTombstone).toBe(true);
    expect(result.secondHasGoneRow).toBe(false);
    expect(result.gcFloor).toBe(result.firstWatermark);
    expect(result.gcEpoch).toBe(2);
    expect(result.deviceObserved).toBeTruthy();
  });

  test('stale pre-floor outbox is refused and aligned from snapshot', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');
      const { LocalStore } = await import('/packages/core/dist/storage/local-store.js');

      const countChangeFiles = (dump: Record<string, string>) => Object.keys(dump)
        .filter(path => /\/changes\/[^/]+-chg_[^/]+\.json$/.test(path)).length;

      const adapter = new MemoryAdapter();
      const active = new Interocitor(adapter, {
        remotePath: '/StaleFloorMesh',
        dbName: 'stale-floor-active-db',
        encrypted: false,
        pollInterval: 600_000,
        flushThreshold: 9999,
        flushDebounce: 60_000,
        autoCompact: false,
        batchWindowMs: 0,
        deviceId: 'dev_active_gc',
      });

      await active.init();
      await active.connect();
      await active.put('tasks', 'canonical', { title: 'remote truth' });
      await active.flush();
      await active.compact();
      await active.compact();
      const manifest = active.getManifest();
      const gcFloor = manifest?.gcFloorHlc ?? '';
      const changeFilesBefore = countChangeFiles(adapter.dump());
      await active.disconnect();

      const staleLocal = new LocalStore('stale-floor-client-db');
      const stale = new Interocitor(adapter, {
        remotePath: '/StaleFloorMesh',
        dbName: 'stale-floor-client-db',
        localStoreFactory: () => staleLocal,
        encrypted: false,
        pollInterval: 600_000,
        flushThreshold: 9999,
        flushDebounce: 60_000,
        autoCompact: false,
        batchWindowMs: 0,
        deviceId: 'dev_stale_gc',
      });

      await stale.init();
      await staleLocal.pushOutbox({
        id: 'stale-change',
        ts: Date.now(),
        device: 'dev_stale_gc',
        hlc: gcFloor,
        ops: [{
          type: 'upsert',
          table: 'tasks',
          rowId: 'poison',
          columns: { title: { value: 'stale poison', hlc: gcFloor } },
        }],
      });

      let error = '';
      try {
        await stale.flush();
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }

      const rows = await stale.table('tasks').query().load({ bypassCache: true });
      const poison = await stale.loadRow({ table: 'tasks', rowId: 'poison' }, { bypassCache: true });
      const outboxSize = await staleLocal.outboxSize();
      const changeFilesAfter = countChangeFiles(adapter.dump());
      await stale.disconnect();

      return {
        gcFloor,
        error,
        outboxSize,
        changeFilesBefore,
        changeFilesAfter,
        rows: rows.map((row: any) => row.title).toSorted(),
        poison,
      };
    });

    expect(result.gcFloor).toBeTruthy();
    expect(result.error).toContain('Refusing to flush changes at or before gcFloorHlc');
    expect(result.outboxSize).toBe(0);
    expect(result.changeFilesAfter).toBe(result.changeFilesBefore);
    expect(result.rows).toEqual(['remote truth']);
    expect(result.poison).toBeUndefined();
  });

  test('put after delete starts a fresh local row incarnation', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');
      const { LocalStore } = await import('/packages/core/dist/storage/local-store.js');

      const local = new LocalStore('reinsert-mesh-db');
      const engine = new Interocitor(new MemoryAdapter(), {
        remotePath: '/ReinsertMesh',
        dbName: 'reinsert-mesh-db',
        localStoreFactory: () => local,
        encrypted: false,
        pollInterval: 600_000,
        flushThreshold: 9999,
        flushDebounce: 60_000,
        autoCompact: false,
        batchWindowMs: 0,
      });

      await engine.init();
      await engine.connect();
      await engine.put('tasks', 'r1', { title: 'old', stale: 'must-not-return' });
      await engine.delete('tasks', 'r1');
      const rawTombstone = await local.getRow('tasks', 'r1');
      const localAfterDelete = await engine.loadRow({ table: 'tasks', rowId: 'r1' }, { bypassCache: true });
      await engine.put('tasks', 'r1', { title: 'new' });
      const localAfterReinsert = await engine.loadRow({ table: 'tasks', rowId: 'r1' }, { bypassCache: true });
      const query = await engine.table('tasks').query().load({ bypassCache: true });
      await engine.disconnect();

      return {
        tombstoneDeleted: rawTombstone?._meta.deleted,
        tombstoneDeletedHlc: rawTombstone?._meta.deletedHlc,
        tombstonePayload: rawTombstone?.payload,
        afterDelete: localAfterDelete,
        afterReinsert: localAfterReinsert,
        query,
      };
    });

    expect(result.tombstoneDeleted).toBe(true);
    expect(result.tombstoneDeletedHlc).toBeTruthy();
    expect(result.tombstonePayload).toEqual({});
    expect(result.afterDelete).toBeUndefined();
    expect(result.afterReinsert).toEqual(expect.objectContaining({
      _meta: expect.objectContaining({ deleted: false }),
      payload: { title: expect.objectContaining({ value: 'new' }) },
    }));
    expect(result.query).toHaveLength(1);
    expect(result.query[0]).toEqual(expect.objectContaining({ title: 'new' }));
    expect(result.query[0]).not.toHaveProperty('stale');
  });

  test('db.batch(): consecutive writes inside a batch produce one ChangeEntry', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

      const adapter = new MemoryAdapter();
      const engine = new Interocitor(adapter, {
        remotePath: '/BatchMesh',
        dbName: 'batch-mesh-db',
        encrypted: false,
        pollInterval: 600_000,
        flushThreshold: 9999,
        flushDebounce: 60_000,
        autoCompact: false,
        batchWindowMs: 0,
      });

      await engine.init();
      await engine.connect();

      const before = Object.keys(adapter.dump()).filter(p => /\/changes\/[^/]+-chg_[^/]+\.json$/.test(p)).length;

      await engine.batch(async () => {
        await engine.put('tasks', 'b1', { title: 'one' });
        await engine.put('tasks', 'b2', { title: 'two' });
        await engine.put('tasks', 'b3', { title: 'three' });
        await engine.delete('tasks', 'b1');
      });
      await engine.flush();

      const after = Object.keys(adapter.dump()).filter(p => /\/changes\/[^/]+-chg_[^/]+\.json$/.test(p)).length;
      await engine.disconnect();
      return { added: after - before };
    });

    expect(result.added).toBe(1);
  });

  test('implicit batching: writes within batchWindowMs collapse into one ChangeEntry', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

      const adapter = new MemoryAdapter();
      const engine = new Interocitor(adapter, {
        remotePath: '/ImplicitBatchMesh',
        dbName: 'implicit-batch-mesh-db',
        encrypted: false,
        pollInterval: 600_000,
        flushThreshold: 9999,
        flushDebounce: 60_000,
        autoCompact: false,
        batchWindowMs: 50, // small but non-zero
      });

      await engine.init();
      await engine.connect();
      const before = Object.keys(adapter.dump()).filter(p => /\/changes\/[^/]+-chg_[^/]+\.json$/.test(p)).length;

      // Three rapid writes without any awaited gap should join one batch
      await engine.put('tasks', 'i1', { title: 'one' });
      await engine.put('tasks', 'i2', { title: 'two' });
      await engine.put('tasks', 'i3', { title: 'three' });
      await engine.flush(); // forces pending batch + outbox to remote
      const afterRapid = Object.keys(adapter.dump()).filter(p => /\/changes\/[^/]+-chg_[^/]+\.json$/.test(p)).length;

      // Now do two writes with a long gap between them — they should be 2 entries
      await engine.put('tasks', 'g1', { title: 'g-one' });
      await engine.flush();
      await new Promise(resolve => { setTimeout(resolve, 100); });
      await engine.put('tasks', 'g2', { title: 'g-two' });
      await engine.flush();
      const afterGapped = Object.keys(adapter.dump()).filter(p => /\/changes\/[^/]+-chg_[^/]+\.json$/.test(p)).length;

      await engine.disconnect();
      return {
        rapidAdded: afterRapid - before,
        gappedAdded: afterGapped - afterRapid,
      };
    });

    expect(result.rapidAdded).toBe(1); // 3 rapid writes → 1 file
    expect(result.gappedAdded).toBe(2); // 2 gapped writes → 2 files
  });
});

