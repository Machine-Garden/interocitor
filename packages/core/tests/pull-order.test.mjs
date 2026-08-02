import assert from "node:assert/strict";
import { test } from "node:test";
import { pull } from "../dist/core/pull.js";

function payloadForOps(hlc, id, ops) {
  return JSON.stringify({
    meshId: "mesh_pull_order",
    kind: "change",
    entry: {
      id,
      ts: 1,
      device: hlc.split("-").slice(2).join("-"),
      hlc,
      ops,
    },
  });
}

function changePayload(hlc, id, value, rowId = "shared-task") {
  return payloadForOps(hlc, id, [
    {
      type: "upsert",
      table: "tasks",
      rowId,
      columns: { state: { value, hlc } },
    },
  ]);
}

function changePath(hlc, id) {
  return `/mesh/changes/${hlc}-${id}.json`;
}

function fileEntry(path, data) {
  return {
    name: path.slice(path.lastIndexOf("/") + 1),
    path,
    size: data.length,
    modifiedTime: "2026-01-01T00:00:00.000Z",
  };
}

function createPullHarness({ payloads, listings, initialMetadata = {}, schema, manifest }) {
  const metadata = new Map(Object.entries(initialMetadata));
  const tables = {};
  const events = [];
  const changeReads = [];
  let listIndex = 0;
  let hlc = { ts: 0, counter: 0, nodeId: "reader" };

  const adapter = {
    async listFiles() {
      const paths = listings[Math.min(listIndex, listings.length - 1)] ?? [];
      listIndex++;
      return paths.map((path) => fileEntry(path, payloads.get(path) ?? ""));
    },
    async readFile(path) {
      const data = payloads.get(path);
      if (data === undefined) throw new Error(`not found: ${path}`);
      changeReads.push(path);
      return new TextEncoder().encode(data);
    },
  };
  const local = {
    async getMeta(key) {
      return metadata.get(key);
    },
    async setMeta(key, value) {
      metadata.set(key, value);
    },
    async putRows() {},
  };
  const context = {
    adapter,
    local,
    remotePath: "/mesh",
    codecState: {
      encryptionKey: null,
      encrypted: false,
      manifest: manifest ?? { meshId: "mesh_pull_order", schema: 1 },
    },
    get hlc() {
      return hlc;
    },
    deviceId: "reader",
    tables,
    knownTables: new Set(),
    schema,
    emit(event) {
      events.push(event);
    },
    async ensureRowsCached() {},
    async poisonRemote(error) {
      return error instanceof Error ? error : new Error(String(error));
    },
    async loadOrCreateManifest() {},
  };

  return {
    metadata,
    tables,
    events,
    changeReads,
    async pull() {
      hlc = await pull(context);
    },
  };
}

function permutations(values) {
  if (values.length <= 1) return [values];
  return values.flatMap((value, index) => {
    const rest = [...values.slice(0, index), ...values.slice(index + 1)];
    return permutations(rest).map((permutation) => [value, ...permutation]);
  });
}

test("same-tick writer IDs resolve by the HLC total order, not adapter order", async () => {
  const upper = "000000000000001-0000-A";
  const lower = "000000000000001-0000-a";
  const payloads = new Map([
    [`/mesh/changes/${lower}-chg_lower.json`, changePayload(lower, "chg_lower", "from-lowercase")],
    [`/mesh/changes/${upper}-chg_upper.json`, changePayload(upper, "chg_upper", "from-uppercase")],
  ]);
  const metadata = new Map();
  const adapter = {
    async listFiles() {
      // Deliberately return the opposite order. Pull must derive a canonical
      // order from HLC, not from adapter insertion order or locale collation.
      return [...payloads].map(([path, data]) => ({
        name: path.slice(path.lastIndexOf("/") + 1),
        path,
        size: data.length,
        modifiedTime: "2026-01-01T00:00:00.000Z",
      }));
    },
    async readFile(path) {
      const data = payloads.get(path);
      if (data === undefined) throw new Error(`not found: ${path}`);
      return new TextEncoder().encode(data);
    },
  };
  const local = {
    async getMeta(key) {
      return metadata.get(key);
    },
    async setMeta(key, value) {
      metadata.set(key, value);
    },
    async putRows() {},
  };
  const tables = {};

  await pull({
    adapter,
    local,
    remotePath: "/mesh",
    codecState: {
      encryptionKey: null,
      encrypted: false,
      manifest: { meshId: "mesh_pull_order", schema: 1 },
    },
    hlc: { ts: 0, counter: 0, nodeId: "reader" },
    deviceId: "reader",
    tables,
    knownTables: new Set(),
    schema: { tables: { tasks: { merge: "lww" } } },
    emit() {},
    async ensureRowsCached() {},
    async poisonRemote(error) {
      return error instanceof Error ? error : new Error(String(error));
    },
    async loadOrCreateManifest() {},
  });

  // `A` is before `a` in the HLC's UTF-16 ordering, so the lower-case
  // change wins regardless of discovery order.
  assert.equal(tables.tasks["shared-task"].payload.state.value, "from-lowercase");
});

test("an unseen change behind another writer global high-water is still merged and reported", async () => {
  const late = "000000000000010-0000-writer-late";
  const high = "000000000000020-0000-writer-high";
  const latePath = changePath(late, "chg_late");
  const highPath = changePath(high, "chg_high");
  const harness = createPullHarness({
    payloads: new Map([
      [latePath, changePayload(late, "chg_late", "late-value", "late-row")],
      [highPath, changePayload(high, "chg_high", "high-value", "high-row")],
    ]),
    listings: [[latePath, highPath]],
    initialMetadata: {
      cursor: high,
      seenChangeFiles: [highPath.slice(highPath.lastIndexOf("/") + 1)],
      writerFrontiers: { "writer-high": high },
    },
  });

  await harness.pull();

  assert.equal(harness.tables.tasks["late-row"].payload.state.value, "late-value");
  assert.deepEqual(harness.changeReads, [latePath]);
  assert.deepEqual(
    harness.events
      .filter((event) => event.type === "sync:late-change")
      .map((event) => ({
        writerId: event.writerId,
        relation: event.relation,
      })),
    [{ writerId: "writer-late", relation: "behind-global-high-water" }],
  );
});

test("a transient listing omission cannot hide an older change from the same writer", async () => {
  const older = "000000000000010-0000-writer";
  const newer = "000000000000020-0000-writer";
  const olderPath = changePath(older, "chg_older");
  const newerPath = changePath(newer, "chg_newer");
  const harness = createPullHarness({
    payloads: new Map([
      [olderPath, changePayload(older, "chg_older", "older-value", "older-row")],
      [newerPath, changePayload(newer, "chg_newer", "newer-value", "newer-row")],
    ]),
    // First listing omits the older file. It becomes visible only after the
    // per-writer frontier has already advanced to the newer HLC.
    listings: [[newerPath], [olderPath, newerPath], [olderPath, newerPath]],
  });

  await harness.pull();
  assert.equal(harness.tables.tasks["older-row"], undefined);
  assert.equal(harness.tables.tasks["newer-row"].payload.state.value, "newer-value");

  await harness.pull();
  assert.equal(harness.tables.tasks["older-row"].payload.state.value, "older-value");
  assert.deepEqual(harness.changeReads, [newerPath, olderPath]);
  assert.deepEqual(
    harness.events
      .filter((event) => event.type === "sync:late-change")
      .map((event) => event.relation),
    ["behind-writer-frontier"],
  );

  await harness.pull();
  assert.deepEqual(
    harness.changeReads,
    [newerPath, olderPath],
    "a stable listing must not re-read observed files",
  );
});

test("a non-monotonic listing does not erase exact observation history", async () => {
  const first = "000000000000010-0000-writer";
  const second = "000000000000020-0000-writer";
  const firstPath = changePath(first, "chg_first");
  const secondPath = changePath(second, "chg_second");
  const harness = createPullHarness({
    payloads: new Map([
      [firstPath, changePayload(first, "chg_first", "first-value", "first-row")],
      [secondPath, changePayload(second, "chg_second", "second-value", "second-row")],
    ]),
    listings: [[firstPath, secondPath], [secondPath], [firstPath, secondPath]],
  });

  await harness.pull();
  await harness.pull();
  await harness.pull();

  assert.deepEqual(harness.changeReads, [firstPath, secondPath]);
  assert.equal(harness.tables.tasks["first-row"].payload.state.value, "first-value");
  assert.equal(harness.tables.tasks["second-row"].payload.state.value, "second-value");
});

test("exact receipts suppress duplicate application even for an invalid custom-merge sentinel", async () => {
  const first = "000000000000010-0000-writer-a";
  const second = "000000000000020-0000-writer-b";
  const firstPath = changePath(first, "chg_first");
  const secondPath = changePath(second, "chg_second");
  const harness = createPullHarness({
    payloads: new Map([
      [firstPath, changePayload(first, "chg_first", 1, "counter")],
      [secondPath, changePayload(second, "chg_second", 2, "counter")],
    ]),
    listings: [[firstPath, secondPath], [secondPath], [firstPath, secondPath]],
    // Deliberately violates the public idempotence requirement. This is an
    // adversarial receipt test, not an example of a supported merge policy.
    schema: {
      tables: {
        tasks: {
          merge(local, remote) {
            return {
              value: local.value + remote.value,
              hlc: local.hlc > remote.hlc ? local.hlc : remote.hlc,
            };
          },
        },
      },
    },
  });

  await harness.pull();
  await harness.pull();
  await harness.pull();

  assert.deepEqual(harness.changeReads, [firstPath, secondPath]);
  assert.equal(harness.tables.tasks.counter.payload.state.value, 3);
});

test("changes at or below the manifest GC floor are retired and cannot replay", async () => {
  const retired = "000000000000010-0000-writer-a";
  const current = "000000000000020-0000-writer-b";
  const retiredPath = changePath(retired, "chg_retired");
  const currentPath = changePath(current, "chg_current");
  const harness = createPullHarness({
    payloads: new Map([
      [retiredPath, changePayload(retired, "chg_retired", "must-not-replay", "retired-row")],
      [currentPath, changePayload(current, "chg_current", "current", "current-row")],
    ]),
    listings: [[retiredPath, currentPath]],
    initialMetadata: {
      seenChangeFiles: [retiredPath.slice(retiredPath.lastIndexOf("/") + 1)],
    },
    manifest: {
      meshId: "mesh_pull_order",
      schema: 1,
      gcFloorHlc: "000000000000015-0000-compactor",
    },
  });

  await harness.pull();

  assert.equal(harness.tables.tasks["retired-row"], undefined);
  assert.equal(harness.tables.tasks["current-row"].payload.state.value, "current");
  assert.deepEqual(harness.changeReads, [currentPath]);
  assert.deepEqual(harness.metadata.get("seenChangeFiles"), [
    currentPath.slice(currentPath.lastIndexOf("/") + 1),
  ]);
});

test("legacy scalar cursor migration replays retained older files without a false late-change alarm", async () => {
  const older = "000000000000010-0000-writer-old";
  const legacyHigh = "000000000000020-0000-writer-high";
  const olderPath = changePath(older, "chg_older");
  const harness = createPullHarness({
    payloads: new Map([
      [olderPath, changePayload(older, "chg_older", "restored-value", "restored-row")],
    ]),
    listings: [[olderPath]],
    initialMetadata: { cursor: legacyHigh },
  });

  await harness.pull();

  assert.equal(harness.tables.tasks["restored-row"].payload.state.value, "restored-value");
  assert.deepEqual(harness.changeReads, [olderPath]);
  assert.equal(
    harness.events.some((event) => event.type === "sync:late-change"),
    false,
  );
  assert.deepEqual(harness.metadata.get("seenChangeFiles"), [
    olderPath.slice(olderPath.lastIndexOf("/") + 1),
  ]);
});

test("duplicate entries in one remote listing are read and applied once", async () => {
  const hlc = "000000000000010-0000-writer";
  const path = changePath(hlc, "chg_once");
  const harness = createPullHarness({
    payloads: new Map([[path, changePayload(hlc, "chg_once", "once", "once-row")]]),
    listings: [[path, path]],
  });

  await harness.pull();

  assert.deepEqual(harness.changeReads, [path]);
  assert.equal(harness.tables.tasks["once-row"].payload.state.value, "once");
});

test("lww converges across every publication order, not only every listing order", async () => {
  const changes = [
    ["000000000000010-0000-writer-a", "chg_a", "a"],
    ["000000000000020-0000-writer-b", "chg_b", "b"],
    ["000000000000030-0000-writer-c", "chg_c", "c"],
    ["000000000000040-0000-writer-a", "chg_d", "d"],
  ];
  const payloads = new Map(
    changes.map(([hlc, id, value]) => {
      const path = changePath(hlc, id);
      return [path, changePayload(hlc, id, value)];
    }),
  );
  const paths = [...payloads.keys()];

  for (const publicationOrder of permutations(paths)) {
    const published = [];
    const listings = publicationOrder.map((path) => {
      published.push(path);
      return [...published];
    });
    const harness = createPullHarness({ payloads, listings });
    for (let index = 0; index < publicationOrder.length; index++) {
      await harness.pull();
    }
    assert.equal(
      harness.tables.tasks["shared-task"].payload.state.value,
      "d",
      `failed publication order: ${publicationOrder.map((path) => path.slice(path.lastIndexOf("-chg_"))).join(", ")}`,
    );
  }
});

test("fresh bootstrap and incremental sync agree after observing the same exact files", async () => {
  const older = "000000000000010-0000-writer-a";
  const newer = "000000000000020-0000-writer-b";
  const olderPath = changePath(older, "chg_older");
  const newerPath = changePath(newer, "chg_newer");
  const payloads = new Map([
    [olderPath, changePayload(older, "chg_older", "older")],
    [newerPath, changePayload(newer, "chg_newer", "newer")],
  ]);

  const freshClient = createPullHarness({
    payloads,
    listings: [[olderPath, newerPath]],
  });
  const incrementalClient = createPullHarness({
    payloads,
    // The existing client sees the newer file first and the older queued
    // file only after its global and per-writer progress has advanced.
    listings: [[newerPath], [olderPath, newerPath]],
  });

  await freshClient.pull();
  await incrementalClient.pull();
  await incrementalClient.pull();

  assert.deepEqual(incrementalClient.tables, freshClient.tables);
  assert.deepEqual(
    incrementalClient.metadata.get("seenChangeFiles"),
    freshClient.metadata.get("seenChangeFiles"),
  );
});

test("delete and resurrection converge across every publication order", async () => {
  const created = "000000000000010-0000-writer-a";
  const deleted = "000000000000020-0000-writer-b";
  const resurrected = "000000000000030-0000-writer-c";
  const changes = [
    [
      changePath(created, "chg_create"),
      changePayload(created, "chg_create", "created", "lifecycle-row"),
    ],
    [
      changePath(deleted, "chg_delete"),
      payloadForOps(deleted, "chg_delete", [
        {
          type: "delete",
          table: "tasks",
          rowId: "lifecycle-row",
          hlc: deleted,
        },
      ]),
    ],
    [
      changePath(resurrected, "chg_resurrect"),
      changePayload(resurrected, "chg_resurrect", "resurrected", "lifecycle-row"),
    ],
  ];
  const payloads = new Map(changes);
  const paths = changes.map(([path]) => path);

  for (const publicationOrder of permutations(paths)) {
    const published = [];
    const harness = createPullHarness({
      payloads,
      listings: publicationOrder.map((path) => {
        published.push(path);
        return [...published];
      }),
    });
    for (let index = 0; index < publicationOrder.length; index++) {
      await harness.pull();
    }
    const row = harness.tables.tasks["lifecycle-row"];
    assert.equal(row._meta.deleted, false);
    assert.equal(row.payload.state.value, "resurrected");
  }
});

test("lww ignores an older file that is published late", async () => {
  const older = "000000000000010-0000-writer-a";
  const newer = "000000000000020-0000-writer-b";
  const olderPath = changePath(older, "chg_older");
  const newerPath = changePath(newer, "chg_newer");
  const harness = createPullHarness({
    payloads: new Map([
      [olderPath, changePayload(older, "chg_older", "older")],
      [newerPath, changePayload(newer, "chg_newer", "newer")],
    ]),
    listings: [[newerPath], [olderPath, newerPath]],
    schema: { tables: { tasks: { merge: "lww" } } },
  });

  await harness.pull();
  await harness.pull();

  assert.equal(harness.tables.tasks["shared-task"].payload.state.value, "newer");
});
