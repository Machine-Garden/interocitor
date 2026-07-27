import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/packages/core/tests/e2e/fixtures/harness.html');
});

test.describe('hlcInit', () => {
  test('creates a clock seeded from wall time', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { hlcInit } = await import('/packages/core/dist/core/hlc.js');
      const before = Date.now();
      const hlc = hlcInit('dev_test');
      const after = Date.now();
      return { ts: hlc.ts, counter: hlc.counter, nodeId: hlc.nodeId, before, after };
    });

    expect(result.ts).toBeGreaterThanOrEqual(result.before);
    expect(result.ts).toBeLessThanOrEqual(result.after);
    expect(result.counter).toBe(0);
    expect(result.nodeId).toBe('dev_test');
  });
});

test.describe('hlcNow', () => {
  test('advances wall time when clock moves forward', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { hlcInit, hlcNow } = await import('/packages/core/dist/core/hlc.js');
      const h0 = hlcInit('dev_a');
      // Force clock into the past so wall time will be ahead
      h0.ts = h0.ts - 1000;
      const h1 = hlcNow(h0);
      return { oldTs: h0.ts, newTs: h1.ts, counter: h1.counter };
    });

    expect(result.newTs).toBeGreaterThan(result.oldTs);
    expect(result.counter).toBe(0); // counter resets on new wall time
  });

  test('increments counter when wall time has not advanced', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { hlcNow } = await import('/packages/core/dist/core/hlc.js');
      // Set ts far in the future so Date.now() won't catch up
      const h0 = { ts: Date.now() + 1_000_000, counter: 3, nodeId: 'dev_a' };
      const h1 = hlcNow(h0);
      return { ts: h1.ts, counter: h1.counter };
    });

    expect(result.counter).toBe(4);
  });
});

test.describe('hlcReceive', () => {
  test('advances to remote ts when remote is ahead', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { hlcReceive } = await import('/packages/core/dist/core/hlc.js');
      const local = { ts: 1000, counter: 0, nodeId: 'a' };
      const remote = { ts: 2000, counter: 5, nodeId: 'b' };
      return hlcReceive(local, remote);
    });

    expect(result.ts).toBeGreaterThanOrEqual(2000);
    expect(result.nodeId).toBe('a'); // preserves local nodeId
  });

  test('increments max counter when timestamps are equal', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { hlcReceive } = await import('/packages/core/dist/core/hlc.js');
      const farFuture = Date.now() + 10_000_000;
      const local = { ts: farFuture, counter: 3, nodeId: 'a' };
      const remote = { ts: farFuture, counter: 7, nodeId: 'b' };
      return hlcReceive(local, remote);
    });

    expect(result.counter).toBe(8); // max(3,7) + 1
  });

  test('clamps extreme future remote timestamps to max skew window', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { hlcReceive, HLC_MAX_FUTURE_SKEW_MS } = await import('/packages/core/dist/core/hlc.js');
      const before = Date.now();
      const local = { ts: before, counter: 0, nodeId: 'a' };
      const remote = { ts: before + 24 * 60 * 60 * 1000, counter: 0, nodeId: 'b' };
      const merged = hlcReceive(local, remote);
      const after = Date.now();
      return { mergedTs: merged.ts, before, after, maxSkew: HLC_MAX_FUTURE_SKEW_MS };
    });

    // Allow tiny runtime drift around Date.now() sampling.
    expect(result.mergedTs).toBeLessThanOrEqual(result.after + result.maxSkew + 10);
  });
});

test.describe('hlcSerialize / hlcParse round-trip', () => {
  test('survives a round-trip for normal values', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { hlcSerialize, hlcParse } = await import('/packages/core/dist/core/hlc.js');
      const original = { ts: 1711785600000, counter: 42, nodeId: 'dev_x1y2z3' };
      const serialized = hlcSerialize(original);
      const parsed = hlcParse(serialized);
      return { serialized, parsed, original };
    });

    expect(result.parsed).toEqual(result.original);
    // Verify format: 15-digit ts, 4-hex counter, nodeId
    expect(result.serialized).toMatch(/^\d{15}-[0-9a-f]{4}-.+$/);
  });

  test('produces lexicographically sortable strings', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { hlcSerialize } = await import('/packages/core/dist/core/hlc.js');
      const a = hlcSerialize({ ts: 1000, counter: 0, nodeId: 'a' });
      const b = hlcSerialize({ ts: 2000, counter: 0, nodeId: 'a' });
      const c = hlcSerialize({ ts: 2000, counter: 1, nodeId: 'a' });
      return { a, b, c, abOk: a < b, bcOk: b < c };
    });

    expect(result.abOk).toBe(true);
    expect(result.bcOk).toBe(true);
  });
});

test.describe('hlcCompare', () => {
  test('orders by timestamp first', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { hlcCompare } = await import('/packages/core/dist/core/hlc.js');
      const a = { ts: 100, counter: 99, nodeId: 'z' };
      const b = { ts: 200, counter: 0, nodeId: 'a' };
      return hlcCompare(a, b);
    });

    expect(result).toBeLessThan(0);
  });

  test('orders by counter when timestamps are equal', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { hlcCompare } = await import('/packages/core/dist/core/hlc.js');
      const a = { ts: 100, counter: 1, nodeId: 'z' };
      const b = { ts: 100, counter: 2, nodeId: 'a' };
      return hlcCompare(a, b);
    });

    expect(result).toBeLessThan(0);
  });

  test('orders by nodeId when ts and counter are equal', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { hlcCompare } = await import('/packages/core/dist/core/hlc.js');
      const a = { ts: 100, counter: 1, nodeId: 'alpha' };
      const b = { ts: 100, counter: 1, nodeId: 'bravo' };
      return hlcCompare(a, b);
    });

    expect(result).toBeLessThan(0);
  });

  test('returns 0 for identical clocks', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { hlcCompare } = await import('/packages/core/dist/core/hlc.js');
      const a = { ts: 100, counter: 1, nodeId: 'x' };
      return hlcCompare(a, { ...a });
    });

    expect(result).toBe(0);
  });
});

test.describe('hlcCompareStr', () => {
  test('agrees with hlcCompare on serialized forms', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { hlcCompare, hlcCompareStr, hlcSerialize } = await import('/packages/core/dist/core/hlc.js');
      const a = { ts: 1000, counter: 5, nodeId: 'dev_a' };
      const b = { ts: 1000, counter: 10, nodeId: 'dev_b' };
      const objCmp = hlcCompare(a, b);
      const strCmp = hlcCompareStr(hlcSerialize(a), hlcSerialize(b));
      return { objSign: Math.sign(objCmp), strSign: Math.sign(strCmp) };
    });

    expect(result.objSign).toBe(result.strSign);
  });
});
