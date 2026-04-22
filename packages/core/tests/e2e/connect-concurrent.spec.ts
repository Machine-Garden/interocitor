/**
 * connect-concurrent.spec.ts
 *
 * Regression for the "two changes -> 20 change files; reload -> 400 files"
 * report. Root cause: concurrent connect() calls (React StrictMode double-
 * mount, dual auto-reconnect resolves) both ran the full pipeline before
 * `connected = true` flipped, doubling every flushed change file and
 * stacking polling timers. Same-instance setRemoteStorage was also
 * tearing down the transport and re-flushing the entire dataset.
 *
 * The fix:
 *   - share one in-flight `connectPromise` across concurrent callers
 *   - skip teardown/rebuild when setRemoteStorage receives the same adapter
 *
 * This test wraps MemoryAdapter with a counting proxy so we can assert
 * exact network-call multiplicities, not just "the file count looks ok".
 */
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/packages/core/tests/e2e/fixtures/harness.html');
  await page.evaluate(async () => {
    localStorage.clear();
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase('connect-concurrent-test');
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  });
});

test('concurrent connect() calls run the pipeline once and produce one change file per put', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { Interocitor } = await import('/packages/core/dist/index.js');
    const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

    // Counting proxy. Records every adapter method call so the test can
    // assert exact multiplicities. We do NOT debounce — a single connect()
    // that runs twice will show every method call twice.
    const calls: Record<string, number> = {
      authenticate: 0,
      ensureFolder: 0,
      listFiles: 0,
      readFile: 0,
      writeFile: 0,
      deleteFile: 0,
      getFileMetadata: 0,
    };

    const inner = new MemoryAdapter();
    const counting = new Proxy(inner, {
      get(target, prop, receiver) {
        const original = Reflect.get(target, prop, receiver);
        if (typeof prop === 'string' && prop in calls && typeof original === 'function') {
          return (...args: unknown[]) => {
            calls[prop]++;
            return (original as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return original;
      },
    });

    const engine = new Interocitor(counting as any, {
      remotePath: '/Concurrent',
      dbName: 'connect-concurrent-test',
      pollInterval: 600_000,    // disable polling so it can't skew counts
      flushDebounce: 600_000,   // disable auto-flush; drive flushes explicitly
      flushThreshold: 999,
      deviceId: 'dev_concurrent',
      encrypted: false,
    });

    await engine.init();

    // Fire two connect() in parallel (StrictMode double-mount / dual
    // auto-reconnect). Both must share the same in-flight promise.
    const [a, b] = await Promise.all([engine.connect(), engine.connect()]);

    // Snapshot call counts after the storm settles.
    const afterConnect = { ...calls };

    // Two writes -> one explicit flush. Auto-flush is disabled so the
    // outbox drains exactly once and we can assert exact write counts.
    await engine.put('tasks', 't1', { title: 'one' });
    await engine.put('tasks', 't2', { title: 'two' });
    await engine.flush();

    const afterFlush = { ...calls };

    const dump = inner.dump();
    const allFiles = Object.keys(dump);
    const changeFiles = allFiles.filter(p => /\/changes\/[^/]+-chg_[^/]+\.json$/.test(p));
    const manifestFiles = allFiles.filter(p => /\/manifest-\d+\.json$/.test(p));
    const manifestPointers = allFiles.filter(p => p.endsWith('/manifest.json'));

    await engine.disconnect();

    return {
      afterConnect,
      afterFlush,
      changeFileCount: changeFiles.length,
      manifestFileCount: manifestFiles.length,
      manifestPointerCount: manifestPointers.length,
      allFiles,
      // delta = work done by the two puts + flush (excluding connect setup).
      delta: Object.fromEntries(
        Object.keys(calls).map(k => [k, afterFlush[k] - afterConnect[k]]),
      ),
    };
  });

  // ── Connect phase ────────────────────────────────────────────────
  // Two parallel connect() calls must dedupe to one pipeline.

  // Manifest bootstrap writes 2 files (manifest-1.json + manifest.json).
  // Then connect() writes the device metadata (1 file). Total: 3 writes.
  // A double-pipeline would produce 6.
  expect(result.afterConnect.writeFile).toBe(3);

  // Bound chosen to clearly detect a doubled pipeline. A single connect
  // does ~8 reads (manifest pointer + manifest-N + device metadata +
  // head.json poll-skip check + folder existence checks). A doubled
  // pipeline would push this above 14. Anything <= 10 is single-run.
  expect(result.afterConnect.readFile).toBeLessThanOrEqual(10);

  // listFiles called once during the initial pull (changes folder).
  // Doubled pipeline would call it twice.
  expect(result.afterConnect.listFiles).toBe(1);

  // ensureFolder called for [remotePath, devices, mainline, changes] = 4.
  // Doubled pipeline -> 8.
  expect(result.afterConnect.ensureFolder).toBe(4);

  // ── Write phase ──────────────────────────────────────────────────
  // Two puts, one flush. Drains 2 entries -> 2 change files + head.json +
  // device metadata = 4 writes. A doubled flush pipeline would push >= 8.
  expect(result.delta.writeFile).toBeLessThanOrEqual(5);
  expect(result.delta.writeFile).toBeGreaterThanOrEqual(2);

  // ── On-disk shape ────────────────────────────────────────────────
  expect(result.changeFileCount).toBe(2);          // exactly one file per put
  expect(result.manifestFileCount).toBe(1);        // bootstrap only
  expect(result.manifestPointerCount).toBe(1);     // single pointer
});

test('setRemoteStorage with the same adapter is a no-op (no rebuild, no reflush)', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { Interocitor } = await import('/packages/core/dist/index.js');
    const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

    const calls: Record<string, number> = {
      writeFile: 0, readFile: 0, listFiles: 0, ensureFolder: 0, deleteFile: 0,
    };

    const inner = new MemoryAdapter();
    const counting = new Proxy(inner, {
      get(target, prop, receiver) {
        const original = Reflect.get(target, prop, receiver);
        if (typeof prop === 'string' && prop in calls && typeof original === 'function') {
          return (...args: unknown[]) => {
            calls[prop]++;
            return (original as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return original;
      },
    });

    const engine = new Interocitor(counting as any, {
      remotePath: '/SameAdapter',
      dbName: 'connect-concurrent-test',
      pollInterval: 600_000,
      flushDebounce: 5,
      flushThreshold: 1,
      deviceId: 'dev_same',
      encrypted: false,
    });

    await engine.init();
    await engine.connect();
    await engine.put('tasks', 't1', { title: 'one' });
    await engine.flush();

    const before = { ...calls };
    const filesBefore = Object.keys(inner.dump()).length;

    // Re-attach the same instance, several times. Each call must be a
    // no-op: no teardown, no resetRemoteSyncState, no rebuildOutboxFromLocalState,
    // no reconnect. Without the guard this would re-flush every IDB row
    // as a fresh batch of change files on each call.
    await engine.setRemoteStorage(counting as any);
    await engine.setRemoteStorage(counting as any);
    await engine.setRemoteStorage(counting as any);

    const after = { ...calls };
    const filesAfter = Object.keys(inner.dump()).length;

    await engine.disconnect();

    return {
      writesAdded: after.writeFile - before.writeFile,
      readsAdded: after.readFile - before.readFile,
      listsAdded: after.listFiles - before.listFiles,
      ensureFoldersAdded: after.ensureFolder - before.ensureFolder,
      deletesAdded: after.deleteFile - before.deleteFile,
      filesAdded: filesAfter - filesBefore,
    };
  });

  // Three same-adapter setRemoteStorage calls must touch the network 0 times.
  expect(result.writesAdded).toBe(0);
  expect(result.readsAdded).toBe(0);
  expect(result.listsAdded).toBe(0);
  expect(result.ensureFoldersAdded).toBe(0);
  expect(result.deletesAdded).toBe(0);
  expect(result.filesAdded).toBe(0);
});
