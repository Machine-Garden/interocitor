import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ChangeObservationLedger,
  changeFileName,
  compareChangeFiles,
  recordFlushedChanges,
} from "../dist/core/change-observation.js";
import { flushPrimary } from "../dist/core/flush.js";

function memoryMetadata(initial = {}) {
  const { cursor, seenChangeFiles, writerFrontiers, ...other } = initial;
  const metadata = new Map(Object.entries(other));
  if (cursor !== undefined || seenChangeFiles !== undefined || writerFrontiers !== undefined) {
    metadata.set("changeObservation", {
      generation: 0,
      globalHighWaterHlc: cursor ?? "",
      seenChangeFiles: seenChangeFiles ?? [],
      writerFrontiers: writerFrontiers ?? {},
    });
  }
  return {
    metadata,
    async getMeta(key) {
      return metadata.get(key);
    },
    async setMeta(key, value) {
      metadata.set(key, value);
    },
  };
}

function observation(local) {
  return local.metadata.get("changeObservation");
}

test("one canonical filename rule is shared by publication and receipts", async () => {
  const local = memoryMetadata();
  const entry = {
    id: "chg_local",
    ts: 1,
    device: "writer",
    hlc: "000000000000010-0000-writer",
    ops: [],
  };

  await recordFlushedChanges(local, [entry]);

  assert.deepEqual(observation(local).seenChangeFiles, [changeFileName(entry)]);
  assert.equal(observation(local).globalHighWaterHlc, entry.hlc);
  assert.deepEqual(observation(local).writerFrontiers, { writer: entry.hlc });
});

test("the ledger classifies a late file but never suppresses exact unseen identity", async () => {
  const high = "000000000000020-0000-writer-high";
  const late = "000000000000010-0000-writer-late";
  const highName = `${high}-chg_high.json`;
  const lateName = `${late}-chg_late.json`;
  const local = memoryMetadata({
    cursor: high,
    seenChangeFiles: [highName],
    writerFrontiers: { "writer-high": high },
  });
  const ledger = await ChangeObservationLedger.load(local);

  assert.equal(ledger.hasUnseenChange([{ name: lateName }]), true);
  assert.deepEqual(ledger.observe(lateName, late), {
    writerId: "writer-late",
    changeHlc: late,
    fileName: lateName,
    relation: "behind-global-high-water",
    writerFrontierHlc: undefined,
    legacyGlobalHighWaterHlc: high,
  });
  await ledger.persist(local);

  assert.deepEqual(observation(local).seenChangeFiles, [lateName, highName]);
  assert.equal(observation(local).globalHighWaterHlc, high);
});

test("exact receipts are retained regardless of HLC age", async () => {
  const oldName = "000000000000010-0000-writer-chg_old.json";
  const retainedName = "000000000000030-0000-writer-chg_retained.json";
  const local = memoryMetadata({
    cursor: retainedName.slice(0, retainedName.lastIndexOf("-chg_")),
    seenChangeFiles: [oldName, retainedName],
    writerFrontiers: {},
  });
  const ledger = await ChangeObservationLedger.load(local);

  assert.equal(ledger.hasUnseenChange([{ name: oldName }]), false);
  assert.equal(
    ledger.hasUnseenChange([{ name: "000000000000005-0000-writer-chg_unseen.json" }]),
    true,
  );
  await ledger.persist(local);

  assert.deepEqual(observation(local).seenChangeFiles, [oldName, retainedName]);
});

test("change-file ordering is deterministic without locale collation", () => {
  const files = [
    { name: "000000000000001-0000-a-chg_lower.json" },
    { name: "000000000000001-0000-A-chg_upper.json" },
  ];

  files.sort(compareChangeFiles);

  assert.deepEqual(
    files.map((file) => file.name),
    ["000000000000001-0000-A-chg_upper.json", "000000000000001-0000-a-chg_lower.json"],
  );
});

test("reset clears every observation marker through one operation", async () => {
  const local = memoryMetadata({
    cursor: "000000000000010-0000-writer",
    seenChangeFiles: ["000000000000010-0000-writer-chg_one.json"],
    writerFrontiers: { writer: "000000000000010-0000-writer" },
  });

  await ChangeObservationLedger.reset(local);

  assert.equal(observation(local).globalHighWaterHlc, "");
  assert.deepEqual(observation(local).seenChangeFiles, []);
  assert.deepEqual(observation(local).writerFrontiers, {});
});

test("snapshot coverage restores exact receipts before post-snapshot pull", async () => {
  const covered = [
    "000000000000010-0000-writer-a-chg_first.json",
    "000000000000020-0000-writer-b-chg_second.json",
  ];
  const snapshotHlc = "000000000000030-0000-compactor";
  const local = memoryMetadata();

  await ChangeObservationLedger.restoreSnapshot(local, snapshotHlc, covered);
  const restored = await ChangeObservationLedger.load(local);

  assert.equal(restored.globalHighWaterHlc, snapshotHlc);
  assert.equal(restored.hasExactObservationHistory, true);
  assert.equal(restored.hasSeen(covered[0]), true);
  assert.equal(restored.hasSeen(covered[1]), true);
  assert.equal(
    restored.hasUnseenChange([{ name: "000000000000015-0000-writer-c-chg_late.json" }]),
    true,
  );
});

test("concurrent observation commits merge receipts instead of overwriting them", async () => {
  const local = memoryMetadata({
    cursor: "",
    seenChangeFiles: [],
    writerFrontiers: {},
  });
  const left = {
    id: "chg_left",
    ts: 1,
    device: "left",
    hlc: "000000000000010-0000-left",
    ops: [],
  };
  const right = {
    id: "chg_right",
    ts: 2,
    device: "right",
    hlc: "000000000000020-0000-right",
    ops: [],
  };

  await Promise.all([recordFlushedChanges(local, [left]), recordFlushedChanges(local, [right])]);

  assert.deepEqual(observation(local).seenChangeFiles, [
    changeFileName(left),
    changeFileName(right),
  ]);
  assert.deepEqual(observation(local).writerFrontiers, {
    left: left.hlc,
    right: right.hlc,
  });
  assert.equal(observation(local).globalHighWaterHlc, right.hlc);
});

test("reset prevents an already-loaded ledger from restoring stale receipts", async () => {
  const staleName = "000000000000010-0000-old-chg_stale.json";
  const local = memoryMetadata({
    cursor: "000000000000010-0000-old",
    seenChangeFiles: [staleName],
    writerFrontiers: { old: "000000000000010-0000-old" },
  });
  const staleLedger = await ChangeObservationLedger.load(local);

  await ChangeObservationLedger.reset(local);
  assert.equal(await staleLedger.persist(local), false);

  assert.equal(observation(local).globalHighWaterHlc, "");
  assert.deepEqual(observation(local).seenChangeFiles, []);
  assert.deepEqual(observation(local).writerFrontiers, {});
});

test("a ledger load cannot observe reset halfway through its metadata writes", async () => {
  const staleName = "000000000000010-0000-old-chg_stale.json";
  const local = memoryMetadata({
    cursor: "000000000000010-0000-old",
    seenChangeFiles: [staleName],
    writerFrontiers: { old: "000000000000010-0000-old" },
  });
  const originalSetMeta = local.setMeta;
  let announceCursorWrite;
  const cursorWriteStarted = new Promise((resolve) => {
    announceCursorWrite = resolve;
  });
  let releaseCursorWrite;
  const cursorWriteMayFinish = new Promise((resolve) => {
    releaseCursorWrite = resolve;
  });
  local.setMeta = async (key, value) => {
    if (key === "changeObservation" && value.globalHighWaterHlc === "") {
      announceCursorWrite();
      await cursorWriteMayFinish;
    }
    await originalSetMeta(key, value);
  };

  const reset = ChangeObservationLedger.reset(local);
  await cursorWriteStarted;
  const loadedDuringReset = ChangeObservationLedger.load(local);
  releaseCursorWrite();
  await reset;
  const ledger = await loadedDuringReset;

  assert.equal(ledger.globalHighWaterHlc, "");
  assert.equal(ledger.hasSeen(staleName), false);
  assert.equal(await ledger.persist(local), true);
  assert.deepEqual(observation(local).seenChangeFiles, []);
  assert.deepEqual(observation(local).writerFrontiers, {});
});

test("receipt persistence failure prevents authoritative publication", async () => {
  const local = memoryMetadata();
  const originalSetMeta = local.setMeta;
  local.setMeta = async (key, value) => {
    if (key === "changeObservation") throw new Error("receipt store unavailable");
    await originalSetMeta(key, value);
  };
  let remoteWrites = 0;
  const adapter = {
    name: "publication-spy",
    async authenticate() {},
    isAuthenticated() {
      return true;
    },
    async ensureFolder() {},
    async listFiles() {
      return [];
    },
    async readFile() {
      throw new Error("missing");
    },
    async writeFile() {
      remoteWrites += 1;
    },
    async deleteFile() {},
    async getFileMetadata() {
      return null;
    },
  };
  const entry = {
    id: "chg_blocked",
    ts: 1,
    device: "writer",
    hlc: "000000000000010-0000-writer",
    ops: [],
  };

  await assert.rejects(
    flushPrimary(
      adapter,
      local,
      "/mesh",
      [entry],
      { encrypted: false, encryptionKey: null, manifest: null },
      "writer",
    ),
    /receipt store unavailable/,
  );
  assert.equal(remoteWrites, 0);
});
