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

  // Read budget after recent optimisations:
  //  - 1 read of manifest-pointer (404 on bootstrap path, served by cache after)
  //  - 0 read of manifest-N.json post-bootstrap (createBootstrapManifest now
  //    returns the object; the read-after-write is gone)
  //  - 0 read of device file (bootstrap=true skips the merge GET)
  //  - 1 read of head.json (pull fast-path probe)
  // Total: 2. Bound at 4 to absorb future tweaks; doubled pipeline >=8.
  expect(result.afterConnect.readFile).toBeLessThanOrEqual(4);

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

test('reload + fresh-client read budget: own writes not re-read on reload; fresh client reads files once; fresh-client reload reads manifest/head only', async ({ page }) => {
  // Load-regression: assert exact remote read shape across the
  // "single client writes, reloads, then a wiped peer connects, then
  // peer reloads" lifecycle. Three behavioural contracts:
  //
  //   1. After own put+flush+disconnect, a NEW engine on the SAME
  //      dbName + SAME adapter (page reload) MUST NOT GET the change
  //      files it just wrote — local IDB already has the rows + cursor
  //      that proves head is at-or-before what we wrote.
  //   2. A "wiped" client (different dbName + different deviceId, same
  //      shared adapter) connecting fresh MUST GET both change files
  //      exactly once (initial sync of remote → empty local).
  //   3. After (2), reloading the wiped client (new engine, same dbName,
  //      same adapter) MUST GET the manifest pointer + head probe but
  //      MUST NOT GET the change files again — its cursor is already at
  //      head.
  const result = await page.evaluate(async () => {
    const { Interocitor } = await import('/packages/core/dist/index.js');
    const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

    // One shared "remote" across all phases; two engines never share
    // local state because they use different dbNames or because we
    // wipe the IDB between cycles.
    const inner = new MemoryAdapter();

    // Per-phase reads, keyed by file path. Lets us assert which exact
    // paths were GET'd in each phase (more diagnostic than a count).
    type ReadLog = string[];
    let currentReads: ReadLog = [];
    const counting = new Proxy(inner, {
      get(target, prop, receiver) {
        const original = Reflect.get(target, prop, receiver);
        if (prop === 'readFile' && typeof original === 'function') {
          return (path: string) => {
            currentReads.push(path);
            return (original as (p: string) => Promise<Uint8Array>).apply(target, [path]);
          };
        }
        return original;
      },
    });

    const baseConfig = {
      remotePath: '/Reload',
      pollInterval: 600_000,
      flushDebounce: 600_000,
      flushThreshold: 999,
      encrypted: false,
    } as const;

    // Helper: wipe a named IDB. Mirrors the per-test beforeEach but
    // scoped to whichever dbName we choose to "wipe".
    const wipeIdb = (dbName: string) => new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(dbName);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });

    // ── Phase 1: original client writes 2 entries and flushes. ──────
    await wipeIdb('reload-orig');
    currentReads = [];
    const e1 = new Interocitor(counting as any, {
      ...baseConfig,
      dbName: 'reload-orig',
      deviceId: 'dev_orig',
    });
    await e1.init();
    await e1.connect();
    await e1.put('tasks', 't1', { title: 'one' });
    await e1.put('tasks', 't2', { title: 'two' });
    await e1.flush();
    await e1.disconnect();
    const phase1Reads = [...currentReads];

    // Snapshot the on-disk shape now so we can reference change-file
    // paths in the assertions below.
    const dump = inner.dump();
    const allFiles = Object.keys(dump);
    const changeFiles = allFiles.filter(p => /\/changes\/[^/]+-chg_[^/]+\.json$/.test(p));

    // ── Phase 2: original client RELOADS. Same dbName, same deviceId,
    //    same adapter. Must NOT GET its own change files. ────────────
    currentReads = [];
    const e1Reload = new Interocitor(counting as any, {
      ...baseConfig,
      dbName: 'reload-orig',
      deviceId: 'dev_orig',
    });
    await e1Reload.init();
    await e1Reload.connect();
    const phase2Reads = [...currentReads];
    await e1Reload.disconnect();

    // ── Phase 3: a "wiped" peer with no local memory connects.
    //    Different dbName + different deviceId. Same shared adapter
    //    so the remote is the one we just wrote to. Must read both
    //    change files exactly once. ──────────────────────────────────
    await wipeIdb('reload-peer');
    currentReads = [];
    const e2 = new Interocitor(counting as any, {
      ...baseConfig,
      dbName: 'reload-peer',
      deviceId: 'dev_peer',
    });
    await e2.init();
    await e2.connect();
    const phase3Reads = [...currentReads];
    const peerRowsAfterFirstConnect = await e2.query('tasks');
    await e2.disconnect();

    // ── Phase 4: wiped peer RELOADS. Same dbName, same deviceId,
    //    same adapter. Must read manifest pointer + head probe but
    //    MUST NOT re-read the change files. ──────────────────────────
    currentReads = [];
    const e2Reload = new Interocitor(counting as any, {
      ...baseConfig,
      dbName: 'reload-peer',
      deviceId: 'dev_peer',
    });
    await e2Reload.init();
    await e2Reload.connect();
    const phase4Reads = [...currentReads];
    const peerRowsAfterReload = await e2Reload.query('tasks');
    await e2Reload.disconnect();

    return {
      changeFilePaths: changeFiles.sort(),
      phase1Reads,
      phase2Reads,
      phase3Reads,
      phase4Reads,
      peerRowCountAfterFirstConnect: peerRowsAfterFirstConnect.length,
      peerRowCountAfterReload: peerRowsAfterReload.length,
    };
  });

  // Sanity: 2 puts → 2 change files exist on the remote.
  expect(result.changeFilePaths).toHaveLength(2);

  // Phase 2: reload of the writer. Zero change-file GETs.
  // The writer's IDB already holds its own rows; the remote head must
  // not advance past what it just wrote, so pull's fast-path
  // short-circuits before listing/reading any change file.
  const phase2ChangeReads = result.phase2Reads.filter(p => result.changeFilePaths.includes(p));
  expect(
    phase2ChangeReads,
    'reload of own client must not GET its own change files',
  ).toEqual([]);

  // Phase 3: wiped peer first connect. MUST read both change files
  // exactly once. Anything else means we either over- or under-fetch.
  const phase3ChangeReads = result.phase3Reads.filter(p => result.changeFilePaths.includes(p));
  expect(
    phase3ChangeReads.sort(),
    'fresh peer must GET each change file exactly once',
  ).toEqual(result.changeFilePaths);
  expect(result.peerRowCountAfterFirstConnect).toBe(2);

  // Phase 4: wiped peer reload. MUST NOT re-read any change file.
  // Manifest pointer + head probe are allowed (and expected) — the
  // pull fast-path needs head to decide whether to skip listing.
  const phase4ChangeReads = result.phase4Reads.filter(p => result.changeFilePaths.includes(p));
  expect(
    phase4ChangeReads,
    'wiped peer reload must not re-GET change files',
  ).toEqual([]);
  // Local state must persist across the reload so the rows are still
  // queryable without touching the change files.
  expect(result.peerRowCountAfterReload).toBe(2);

  // Phase 4 sanity: at least one of the manifest/head paths must have
  // been touched. Otherwise the engine isn't probing remote state at
  // all and the assertion above is vacuous.
  const phase4ManifestOrHead = result.phase4Reads.filter(p =>
    p.endsWith('/manifest.json')
    || /\/manifest-\d+\.json$/.test(p)
    || p.endsWith('/changes/head.json'),
  );
  expect(
    phase4ManifestOrHead.length,
    'wiped peer reload must still probe manifest/head',
  ).toBeGreaterThan(0);
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

test('disconnect+reconnect on same adapter: ensureFolder is cached, manifest cache invalidates', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { Interocitor } = await import('/packages/core/dist/index.js');
    const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

    const calls: Record<string, number> = {
      authenticate: 0, ensureFolder: 0, listFiles: 0,
      readFile: 0, writeFile: 0, deleteFile: 0, getFileMetadata: 0,
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
      remotePath: '/Reconnect',
      dbName: 'connect-concurrent-test',
      pollInterval: 600_000,
      flushDebounce: 600_000,
      flushThreshold: 999,
      deviceId: 'dev_reconnect',
      encrypted: false,
    });

    // Helper: snapshot adapter-internal folders Set size. The Memory
    // adapter only adds to `folders` when ensureFolder actually does the
    // work (cache miss). On reconnect with same adapter, we expect the
    // folder set to NOT grow -> every ensureFolder call short-circuited.
    const folderSetSize = () => (inner as any).folders.size as number;
    const ensuredCacheSize = () => (inner as any).ensuredFolders.size as number;

    await engine.init();
    await engine.connect();
    const afterFirstConnect = { ...calls };
    const foldersAfterFirst = folderSetSize();
    const cacheAfterFirst = ensuredCacheSize();

    // Tear down + bring back up on the same adapter. The ensureFolder
    // cache MUST survive (folders did not vanish); the manifest cache MUST
    // be re-validated (`force: true` on connect) so we still get fresh
    // pointer + manifest reads.
    await engine.disconnect();

    await engine.init();
    await engine.connect();
    const afterSecondConnect = { ...calls };
    const foldersAfterSecond = folderSetSize();
    const cacheAfterSecond = ensuredCacheSize();

    await engine.disconnect();

    return {
      first: afterFirstConnect,
      second: afterSecondConnect,
      delta: Object.fromEntries(
        Object.keys(calls).map(k => [k, afterSecondConnect[k] - afterFirstConnect[k]]),
      ),
      foldersAfterFirst,
      foldersAfterSecond,
      cacheAfterFirst,
      cacheAfterSecond,
    };
  });

  // The proxy counts every method invocation, including cache-hit returns,
  // so `delta.ensureFolder` is NOT a useful proxy for "did real work
  // happen". Instead inspect the adapter-internal folder set: on a hit
  // the set does not grow.
  expect(result.cacheAfterFirst, 'first connect populated the cache').toBeGreaterThan(0);
  expect(
    result.foldersAfterSecond,
    'reconnect MUST hit the cache (folders set unchanged)',
  ).toBe(result.foldersAfterFirst);
  expect(
    result.cacheAfterSecond,
    'cache size unchanged on reconnect (no new folders added)',
  ).toBe(result.cacheAfterFirst);

  // Manifest re-validated on reconnect -> some reads expected. Bound at 5
  // to detect any future regression (would jump to >=8 if the bootstrap
  // path were taken twice).
  expect(result.delta.readFile).toBeLessThanOrEqual(5);

  // Reconnect writes: device-metadata only (bootstrap=false on reconnect).
  // Manifest already exists -> no manifest writes.
  expect(result.delta.writeFile).toBeLessThanOrEqual(2);
});
