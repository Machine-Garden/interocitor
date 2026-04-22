import { expect, test } from '@playwright/test';

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

test.describe('Interocitor query cache', () => {
  test('lazy: building a query does not fetch and cache stays empty', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

      const engine = new Interocitor(new MemoryAdapter(), {
        remotePath: '/QC1', pollInterval: 600_000, deviceId: 'dev',
      });
      await engine.init();
      await engine.connect();
      await engine.put('tasks', 't1', { title: 'a' });

      const q = engine.table('tasks').query();
      const snapBefore = engine.readQueryCache(q.descriptor);

      await engine.disconnect();
      return {
        cacheKey: q.cacheKey,
        statusBefore: snapBefore.status,
        rowsBefore: snapBefore.rows ?? null,
      };
    });

    expect(result.statusBefore).toBe('empty');
    expect(result.rowsBefore).toBeNull();
    expect(result.cacheKey).toBe('t=tasks');
  });

  test('then-driven load populates cache snapshot', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

      const engine = new Interocitor(new MemoryAdapter(), {
        remotePath: '/QC2', pollInterval: 600_000, deviceId: 'dev',
      });
      await engine.init();
      await engine.connect();
      await engine.put('tasks', 't1', { title: 'a' });
      await engine.put('tasks', 't2', { title: 'b' });

      const q = engine.table('tasks').query();
      const rows = await q;
      const snap = engine.readQueryCache(q.descriptor);

      await engine.disconnect();
      return {
        rowCount: rows.length,
        status: snap.status,
        cachedRowCount: snap.rows?.length ?? 0,
      };
    });

    expect(result.rowCount).toBe(2);
    expect(result.status).toBe('ready');
    expect(result.cachedRowCount).toBe(2);
  });

  test('parallel loads dedupe to a single in-flight promise', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

      const engine = new Interocitor(new MemoryAdapter(), {
        remotePath: '/QC3', pollInterval: 600_000, deviceId: 'dev',
      });
      await engine.init();
      await engine.connect();
      await engine.put('tasks', 't1', { title: 'a' });

      // Hit the engine cache directly so we can compare promise identity.
      // QueryResult.load() wraps the engine promise to apply sync transforms,
      // so two QueryResult.load() calls return distinct outer promises by
      // design. Dedupe must hold at the engine cache layer.
      const q1 = engine.table('tasks').query();
      const q2 = engine.table('tasks').query();
      const p1 = engine.loadQueryRows(q1.descriptor);
      const p2 = engine.loadQueryRows(q2.descriptor);

      const snapWhilePending = engine.readQueryCache(q1.descriptor);
      const samePromise = p1 === p2 && snapWhilePending.promise === p1;

      const [r1, r2] = await Promise.all([p1, p2]);
      await engine.disconnect();
      return {
        sameKey: q1.cacheKey === q2.cacheKey,
        statusWhilePending: snapWhilePending.status,
        sharedInFlight: samePromise,
        rowsEqual: r1.length === r2.length,
      };
    });

    expect(result.sameKey).toBe(true);
    expect(result.statusWhilePending).toBe('pending');
    expect(result.sharedInFlight).toBe(true);
    expect(result.rowsEqual).toBe(true);
  });

  test('mutation triggers stale-while-revalidate: old rows visible while pending, then refresh', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

      const engine = new Interocitor(new MemoryAdapter(), {
        remotePath: '/QC4', pollInterval: 600_000, deviceId: 'dev',
      });
      await engine.init();
      await engine.connect();
      await engine.put('tasks', 't1', { title: 'a' });

      const q = engine.table('tasks').query();
      await q;
      const snapAfterFirstLoad = engine.readQueryCache(q.descriptor);
      const initialCount = snapAfterFirstLoad.rows?.length ?? -1;

      // Mutation triggers invalidation through emit().
      await engine.put('tasks', 't2', { title: 'b' });
      const snapDuringRevalidate = engine.readQueryCache(q.descriptor);

      // Wait for revalidation to settle.
      await snapDuringRevalidate.promise;
      const snapAfterRevalidate = engine.readQueryCache(q.descriptor);

      await engine.disconnect();
      return {
        statusInitial: snapAfterFirstLoad.status,
        initialCount,
        statusDuring: snapDuringRevalidate.status,
        rowsDuring: snapDuringRevalidate.rows?.length ?? -1,
        statusAfter: snapAfterRevalidate.status,
        rowsAfter: snapAfterRevalidate.rows?.length ?? -1,
      };
    });

    expect(result.statusInitial).toBe('ready');
    expect(result.initialCount).toBe(1);
    expect(result.statusDuring).toBe('pending');
    // Stale rows must still be present so consumers don't flash empty.
    expect(result.rowsDuring).toBe(1);
    expect(result.statusAfter).toBe('ready');
    expect(result.rowsAfter).toBe(2);
  });

  test('cacheKey is stable per descriptor and indifferent to sort()', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor, types } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

      const engine = new Interocitor(new MemoryAdapter(), {
        remotePath: '/QC5', pollInterval: 600_000, deviceId: 'dev',
        schema: {
          version: 1,
          tables: {
            tasks: {
              fields: {
                weekId: types.index(types.string),
              },
            },
          },
        },
      });
      await engine.init();
      await engine.connect();

      const a1 = engine.table('tasks').where('weekId').equals('w1');
      const a2 = engine.table('tasks').where('weekId').equals('w1');
      const b = engine.table('tasks').where('weekId').equals('w2');
      const sorted = a1.sort((x: any, y: any) => x.title.localeCompare(y.title));
      const allA = engine.table('tasks').query();

      await engine.disconnect();
      return {
        sameClauseSameKey: a1.cacheKey === a2.cacheKey,
        differentClauseDifferentKey: a1.cacheKey !== b.cacheKey,
        sortDoesNotChangeKey: sorted.cacheKey === a1.cacheKey,
        plainQueryKey: allA.cacheKey,
      };
    });

    expect(result.sameClauseSameKey).toBe(true);
    expect(result.differentClauseDifferentKey).toBe(true);
    expect(result.sortDoesNotChangeKey).toBe(true);
    expect(result.plainQueryKey).toBe('t=tasks');
  });

  test('orderBy participates in cacheKey and yields ordered cached rows', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

      const engine = new Interocitor(new MemoryAdapter(), {
        remotePath: '/QC7', pollInterval: 600_000, deviceId: 'dev',
      });
      await engine.init();
      await engine.connect();
      await engine.put('tasks', 't1', { title: 'b' });
      await engine.put('tasks', 't2', { title: 'a' });
      await engine.put('tasks', 't3', { title: 'c' });

      const plain = engine.table('tasks').query();
      const asc = engine.table('tasks').query().orderBy('title', 'asc');
      const desc = engine.table('tasks').query().orderBy('title', 'desc');
      const ascAgain = engine.table('tasks').query().orderBy('title', 'asc');

      const ascRows = await asc;
      const descRows = await desc;

      await engine.disconnect();
      return {
        plainKey: plain.cacheKey,
        ascKey: asc.cacheKey,
        descKey: desc.cacheKey,
        ascSameAsAscAgain: asc.cacheKey === ascAgain.cacheKey,
        ascDistinctFromPlain: asc.cacheKey !== plain.cacheKey,
        ascDistinctFromDesc: asc.cacheKey !== desc.cacheKey,
        ascTitles: ascRows.map((r: any) => r.title),
        descTitles: descRows.map((r: any) => r.title),
      };
    });

    expect(result.plainKey).toBe('t=tasks');
    expect(result.ascKey).toBe('t=tasks|o=title:asc');
    expect(result.descKey).toBe('t=tasks|o=title:desc');
    expect(result.ascSameAsAscAgain).toBe(true);
    expect(result.ascDistinctFromPlain).toBe(true);
    expect(result.ascDistinctFromDesc).toBe(true);
    expect(result.ascTitles).toEqual(['a', 'b', 'c']);
    expect(result.descTitles).toEqual(['c', 'b', 'a']);
  });

  test('row cache: lazy build, then-driven load, dedupe, stale-while-revalidate, deletion', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

      const engine = new Interocitor(new MemoryAdapter(), {
        remotePath: '/RC1', pollInterval: 600_000, deviceId: 'dev',
      });
      await engine.init();
      await engine.connect();
      await engine.put('tasks', 't1', { title: 'a' });

      const r1 = engine.table('tasks').row('t1');
      const r1b = engine.table('tasks').row('t1');
      const r2 = engine.table('tasks').row('t2');

      const sameKey = r1.cacheKey === r1b.cacheKey;
      const distinctKey = r1.cacheKey !== r2.cacheKey;
      const empty = engine.readRowCache(r1.descriptor).status;

      // Parallel load dedupe at engine cache layer.
      const p1 = engine.loadRow(r1.descriptor);
      const p2 = engine.loadRow(r1.descriptor);
      const sharedInFlight = p1 === p2;
      const pendingSnap = engine.readRowCache(r1.descriptor);
      await Promise.all([p1, p2]);
      const ready = engine.readRowCache(r1.descriptor);

      // Stale-while-revalidate: mutating row keeps prior visible.
      await engine.put('tasks', 't1', { title: 'b' });
      const duringRevalidate = engine.readRowCache(r1.descriptor);
      await duringRevalidate.promise;
      const afterRevalidate = engine.readRowCache(r1.descriptor);

      // Delete: cache resolves to null (loaded-but-absent).
      await engine.delete('tasks', 't1');
      const afterDeletePending = engine.readRowCache(r1.descriptor);
      await afterDeletePending.promise;
      const afterDelete = engine.readRowCache(r1.descriptor);

      // Missing row: thenable resolves undefined and cache stores null.
      const missing = await r2;

      await engine.disconnect();
      return {
        sameKey,
        distinctKey,
        empty,
        sharedInFlight,
        statusWhilePending: pendingSnap.status,
        statusReady: ready.status,
        readyTitle: (ready.row as any)?.payload?.title?.value ?? null,
        statusDuring: duringRevalidate.status,
        duringTitle: (duringRevalidate.row as any)?.payload?.title?.value ?? null,
        afterRevalidateTitle: (afterRevalidate.row as any)?.payload?.title?.value ?? null,
        statusAfterDelete: afterDelete.status,
        rowAfterDelete: afterDelete.row ?? null,
        missingResolvedToUndefined: missing === undefined,
      };
    });

    expect(result.sameKey).toBe(true);
    expect(result.distinctKey).toBe(true);
    expect(result.empty).toBe('empty');
    expect(result.sharedInFlight).toBe(true);
    expect(result.statusWhilePending).toBe('pending');
    expect(result.statusReady).toBe('ready');
    expect(result.readyTitle).toBe('a');
    expect(result.statusDuring).toBe('pending');
    // Stale row still visible while refresh runs.
    expect(result.duringTitle).toBe('a');
    expect(result.afterRevalidateTitle).toBe('b');
    expect(result.statusAfterDelete).toBe('ready');
    expect(result.rowAfterDelete).toBeNull();
    expect(result.missingResolvedToUndefined).toBe(true);
  });

  test('bypassCache forces a fresh load even when ready', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

      const engine = new Interocitor(new MemoryAdapter(), {
        remotePath: '/QC6', pollInterval: 600_000, deviceId: 'dev',
      });
      await engine.init();
      await engine.connect();
      await engine.put('tasks', 't1', { title: 'a' });

      const q = engine.table('tasks').query();
      await q;
      const cachedPromise = engine.readQueryCache(q.descriptor).promise;

      const fresh = q.load({ bypassCache: true });
      const snapDuring = engine.readQueryCache(q.descriptor);
      const newPromise = snapDuring.promise;
      await fresh;

      await engine.disconnect();
      return {
        statusDuring: snapDuring.status,
        promiseChanged: cachedPromise !== newPromise,
      };
    });

    expect(result.statusDuring).toBe('pending');
    expect(result.promiseChanged).toBe(true);
  });

  test('QueryResult.peekCache returns a stable reference until cache changes', async ({ page }) => {
    // Regression: peekCache used to project (map + sort) on every call,
    // returning a fresh array each time. useSyncExternalStore consumers
    // would treat this as constant change and loop. Identity must be
    // stable as long as the engine's raw rows reference is unchanged.
    const result = await page.evaluate(async () => {
      const { Interocitor } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

      const engine = new Interocitor(new MemoryAdapter(), {
        remotePath: '/QC8', pollInterval: 600_000, deviceId: 'dev',
      });
      await engine.init();
      await engine.connect();
      await engine.put('tasks', 't1', { title: 'a' });
      await engine.put('tasks', 't2', { title: 'b' });

      const q = engine.table('tasks').query();
      await q.load();

      const a = q.peekCache();
      const b = q.peekCache();
      const c = q.peekCache();
      const sortedAsc = engine.table('tasks').query().orderBy('title', 'asc');
      await sortedAsc.load();
      const s1 = sortedAsc.peekCache();
      const s2 = sortedAsc.peekCache();

      // Mutate → engine swaps in fresh raw rows → projection reference
      // must change to a new array. Old reference must NOT linger.
      await engine.put('tasks', 't3', { title: 'c' });
      await q.load(); // ensure cache is back to ready
      const d = q.peekCache();

      await engine.disconnect();
      return {
        peekStableSameInstance: a === b && b === c && a !== undefined,
        peekStableForOrderBy: s1 === s2 && s1 !== undefined,
        peekChangedAfterMutation: d !== a && Array.isArray(d) && d!.length === 3,
      };
    });

    expect(result.peekStableSameInstance).toBe(true);
    expect(result.peekStableForOrderBy).toBe(true);
    expect(result.peekChangedAfterMutation).toBe(true);
  });

  test('RowResult.peekCache returns a stable reference until cache changes', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor } = await import('/packages/core/dist/index.js');
      const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');

      const engine = new Interocitor(new MemoryAdapter(), {
        remotePath: '/RC2', pollInterval: 600_000, deviceId: 'dev',
      });
      await engine.init();
      await engine.connect();
      await engine.put('tasks', 't1', { title: 'a' });

      const r = engine.table('tasks').row('t1');
      await r.load();
      const a = r.peekCache();
      const b = r.peekCache();
      const c = r.peekCache();

      // Mutation → fresh raw row ref → fresh projected typed row ref.
      await engine.put('tasks', 't1', { title: 'b' });
      await r.load();
      const d = r.peekCache();

      await engine.disconnect();
      return {
        peekStable: a === b && b === c && a !== undefined,
        peekChangedAfterMutation: d !== a && (d as any)?.title === 'b',
      };
    });

    expect(result.peekStable).toBe(true);
    expect(result.peekChangedAfterMutation).toBe(true);
  });
});
