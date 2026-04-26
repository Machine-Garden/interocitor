/**
 * Tracing test for head + manifest IO.
 *
 * Goal: prove the engine emits structured trace events that let a developer
 * answer "why is my head/manifest being rewritten when it should be read?".
 *
 * Asserted invariants:
 *  1. Bootstrap: ONE bootstrap-create event + TWO writes (manifest-N +
 *     pointer). NO read of manifest-N after bootstrap-write.
 *  2. Steady-state flush: manifest is served from cache. Zero `op: 'read'`
 *     trace events with reason='flush'. One `op: 'cache-hit'` per flush.
 *  3. Head writes are strictly forward-monotonic. Every `trace:head { op:
 *     'write' }` has nextHlc > priorHlc. No `regressed: true`.
 *  4. Idle flush (no entries): writes nothing — `flushToAdapter` is not
 *     even called by `doFlush` because the outbox is empty.
 *  5. If head.json is force-overwritten with a future HLC, the next flush
 *     emits `op: 'skip-no-change'` and DOES NOT call writeFile on head.
 */

import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/packages/core/tests/e2e/fixtures/harness.html');
  await page.evaluate(async () => {
    localStorage.clear();
    for (const dbName of ['trace-head-manifest', 'trace-retry']) {
      await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase(dbName);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      });
    }
  });
});

test('trace events explain head + manifest IO and prove no redundant rewrites', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { Interocitor } = await import('/packages/core/dist/index.js');
    const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');
    const adapter = new MemoryAdapter();
    const traces: any[] = [];

    const engine = new Interocitor(adapter as any, {
      batchWindowMs: 0, remotePath: '/Trace',
      dbName: 'trace-head-manifest',
      pollInterval: 600_000,
      flushDebounce: 600_000,
      flushThreshold: 999,
      deviceId: 'dev_trace',
      encrypted: false,
    });
    engine.on((e: any) => {
      if (e.type === 'trace:manifest' || e.type === 'trace:head') {
        // Strip non-serialisable fields for transport across page.evaluate.
        traces.push({ ...e });
      }
    });

    await engine.init();
    await engine.connect();

    const bootstrapTraces = traces.slice();

    // Phase 2: first flush
    traces.length = 0;
    await engine.put('items', 'a', { v: 1 });
    await engine.flush();
    const flush1 = traces.slice();

    // Phase 3: second flush
    traces.length = 0;
    await engine.put('items', 'b', { v: 2 });
    await engine.flush();
    const flush2 = traces.slice();

    // Phase 4: idle flush
    traces.length = 0;
    await engine.flush();
    const flush3 = traces.slice();

    await engine.disconnect();
    return { bootstrapTraces, flush1, flush2, flush3 };
  });

  // ── Phase 1: bootstrap ───────────────────────────────────────────
  const bootstrapManifest = result.bootstrapTraces.filter(t => t.type === 'trace:manifest');
  const bootstrapHead = result.bootstrapTraces.filter(t => t.type === 'trace:head');

  const bootstrapCreates = bootstrapManifest.filter(t => t.op === 'bootstrap-create');
  const bootstrapWrites = bootstrapManifest.filter(t => t.op === 'write');
  const bootstrapReads = bootstrapManifest.filter(t => t.op === 'read');

  expect(bootstrapCreates, 'one bootstrap-create event').toHaveLength(1);
  expect(bootstrapWrites.map(w => w.reason).sort(), 'two writes: manifest + pointer')
    .toEqual(['bootstrap', 'bootstrap-pointer']);
  expect(
    bootstrapReads.filter(r => r.path?.endsWith('manifest-1.json')),
    'NO read of manifest-1.json after bootstrap (read-after-write eliminated)',
  ).toHaveLength(0);
  expect(
    bootstrapReads.length,
    'only the pointer existence probe; no other manifest reads',
  ).toBeLessThanOrEqual(2);
  expect(
    bootstrapHead.filter(h => h.op === 'write'),
    'no head writes during bootstrap (no entries flushed yet)',
  ).toHaveLength(0);

  // ── Phase 2: first flush ─────────────────────────────────────────
  const f1Manifest = result.flush1.filter(t => t.type === 'trace:manifest');
  const f1Head = result.flush1.filter(t => t.type === 'trace:head');

  expect(f1Manifest.filter(m => m.op === 'read'), 'flush MUST NOT re-read manifest from disk').toHaveLength(0);
  expect(f1Manifest.filter(m => m.op === 'cache-hit'), 'manifest served from cache').toHaveLength(1);
  expect(f1Manifest[0].reason).toBe('flush');

  const f1Reads = f1Head.filter(h => h.op === 'read');
  const f1Writes = f1Head.filter(h => h.op === 'write');
  expect(f1Reads, 'one head read').toHaveLength(1);
  expect(f1Writes, 'one head write').toHaveLength(1);
  expect(f1Writes[0].priorHlc, 'first flush sees no prior head').toBeNull();
  expect(f1Writes[0].nextHlc, 'next HLC set').toBeTruthy();
  expect(f1Writes[0].regressed, 'never regressed').toBe(false);

  const firstHeadHlc = f1Writes[0].nextHlc as string;

  // ── Phase 3: second flush, monotonic head ────────────────────────
  const f2Manifest = result.flush2.filter(t => t.type === 'trace:manifest');
  const f2Head = result.flush2.filter(t => t.type === 'trace:head');

  expect(f2Manifest.filter(m => m.op === 'read')).toHaveLength(0);
  expect(f2Manifest.filter(m => m.op === 'cache-hit')).toHaveLength(1);

  const f2Writes = f2Head.filter(h => h.op === 'write');
  expect(f2Writes).toHaveLength(1);
  expect(f2Writes[0].priorHlc, 'prior head is the previous write').toBe(firstHeadHlc);
  expect(f2Writes[0].nextHlc as string > firstHeadHlc, 'head moves strictly forward').toBe(true);
  expect(f2Writes[0].regressed).toBe(false);

  // ── Phase 4: idle flush ──────────────────────────────────────────
  expect(
    result.flush3,
    'idle flush has no entries -> doFlush returns before flushToAdapter -> no traces',
  ).toHaveLength(0);

  // ── Cross-phase: never regressed ────────────────────────────────
  for (const ev of [...result.flush1, ...result.flush2]) {
    if (ev.type === 'trace:head' && ev.op === 'write') {
      expect(ev.regressed, `head must never regress (prior=${ev.priorHlc} next=${ev.nextHlc})`).toBe(false);
    }
  }
});

test('trace head: future-prior HLC short-circuits via skip-no-change (no regression write)', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { Interocitor } = await import('/packages/core/dist/index.js');
    const { MemoryAdapter } = await import('/packages/core/dist/adapters/memory.js');
    const adapter = new MemoryAdapter();
    const headEvents: any[] = [];

    const engine = new Interocitor(adapter as any, {
      batchWindowMs: 0, remotePath: '/TraceRetry',
      dbName: 'trace-retry',
      pollInterval: 600_000,
      flushDebounce: 600_000,
      flushThreshold: 999,
      deviceId: 'dev_retry',
      encrypted: false,
    });
    engine.on((e: any) => { if (e.type === 'trace:head') headEvents.push({ ...e }); });

    await engine.init();
    await engine.connect();
    await engine.put('items', 'a', { v: 1 });
    await engine.flush();

    // Force-overwrite head.json with a far-future HLC.
    const headPath = '/TraceRetry/changes/head.json';
    // Far-future HLC. Format: `<msPadded16>-<counter4>-<nodeId>`. Use a
    // ms value that comfortably exceeds Date.now() (~1.7e12 today) for
    // the foreseeable future.
    const futureHlc = '9999999999999-9999-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
    await adapter.writeFile(
      headPath,
      new TextEncoder().encode(JSON.stringify({ latestHlc: futureHlc })),
    );

    headEvents.length = 0;
    await engine.put('items', 'b', { v: 2 });
    await engine.flush();

    const headOnDisk = JSON.parse(new TextDecoder().decode(await adapter.readFile(headPath)));
    await engine.disconnect();
    return { headEvents, headOnDisk, futureHlc };
  });

  const reads  = result.headEvents.filter(h => h.op === 'read');
  const skips  = result.headEvents.filter(h => h.op === 'skip-no-change');
  const writes = result.headEvents.filter(h => h.op === 'write');

  expect(reads, 'reads prior head').toHaveLength(1);
  expect(reads[0].priorHlc).toBe(result.futureHlc);
  expect(skips, 'skip-no-change because prior >= next').toHaveLength(1);
  expect(writes, 'no write attempted (would have been a regression)').toHaveLength(0);

  expect(result.headOnDisk.latestHlc, 'head on disk preserved at future HLC').toBe(result.futureHlc);
});
