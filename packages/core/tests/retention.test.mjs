import test from "node:test";
import assert from "node:assert/strict";

import {
  DAY_MS,
  DEFAULT_COMPACT_AFTER_MS,
  DEFAULT_MAX_OFFLINE_DURATION_MS,
  Interocitor,
  MemoryLocalStore,
} from "../dist/index.js";

test("retention defaults leave a week for uploaded changes and a month for offline clients", () => {
  assert.equal(DEFAULT_COMPACT_AFTER_MS, 7 * DAY_MS);
  assert.equal(DEFAULT_MAX_OFFLINE_DURATION_MS, 30 * DAY_MS);

  const engine = new Interocitor({ keySource: null, localStore: new MemoryLocalStore() });
  assert.ok(engine);
});

for (const [field, value] of [
  ["compactAfterMs", 0],
  ["compactAfterMs", Infinity],
  ["compactAfterMs", Number.NaN],
  ["maxOfflineDurationMs", -1],
  ["maxOfflineDurationMs", Infinity],
]) {
  test(`retention rejects ${field}=${String(value)}`, () => {
    assert.throws(
      () =>
        new Interocitor({
          keySource: null,
          localStore: new MemoryLocalStore(),
          retention: { [field]: value },
        }),
      /positive finite duration/,
    );
  });
}
