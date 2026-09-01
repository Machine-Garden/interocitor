#!/usr/bin/env node

/**
 * Core <-> Swift interoperability phases.
 *
 * This intentionally imports the built @interocitor/core package rather than
 * duplicating its wire format. `run-core-swift-interop.sh` runs these phases
 * around the Swift XCTest cases:
 *
 *   bootstrap                 Core creates an encrypted mesh and a task row.
 *   verify                    A fresh Core client proves it can read Swift's task row.
 *   compact                   Core compacts the mixed-runtime mesh before Swift rehydrates.
 *   verify-swift-bootstrap    Core validates, reads, and first-compacts a
 *                             Swift-created mesh at epoch 1.
 *   verify-swift-compacted    Core validates and rehydrates Swift's epoch-2
 *                             snapshot and removes covered changes.
 *
 * Required environment:
 *   INTEROCITOR_WEBDAV_URL          e.g. http://127.0.0.1:4175
 *   INTEROCITOR_INTEROP_REMOTE_PATH e.g. /core-swift-interop-123
 *   INTEROCITOR_INTEROP_SWIFT_REMOTE_PATH e.g. /swift-core-interop-123
 *
 * Optional environment:
 *   INTEROCITOR_INTEROP_PASSPHRASE  Base58 256-bit test key
 *   INTEROCITOR_INTEROP_DB_NAME     Local diagnostic namespace
 */

import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

if (!globalThis.crypto) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto });
}

// eslint-disable-next-line unicorn/prefer-import-meta-properties -- Keep Node 18 compatibility; import.meta.dirname was added later.
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDir, "../../..");
const coreEntry = new URL(`file://${join(repositoryRoot, "packages/core/dist/index.js")}`).href;
const webDavAdapterEntry = new URL(
  `file://${join(repositoryRoot, "packages/core/dist/adapters/webdav.js")}`,
).href;

const { Interocitor, MemoryLocalStore, PortablePassphraseKeySource } = await import(coreEntry);
const { WebDAVAdapter } = await import(webDavAdapterEntry);

const TEST_PASSPHRASE = "1thX6LZfHDZZKUs92febYZhYRcXddmzfzF2NvTkPNE";
const CORE_ROW_ID = "core-created";
const SWIFT_BOOTSTRAP_ROW_ID = "swift-bootstrap-nested";

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function interopConfig(flow = "core") {
  const serverUrl = requiredEnv("INTEROCITOR_WEBDAV_URL").replace(/\/$/, "");
  const isSwiftBootstrap = flow === "swift-bootstrap";
  const remotePath = requiredEnv(
    isSwiftBootstrap ? "INTEROCITOR_INTEROP_SWIFT_REMOTE_PATH" : "INTEROCITOR_INTEROP_REMOTE_PATH",
  );
  if (!remotePath.startsWith("/")) {
    throw new Error("Interoperability remote paths must start with /");
  }

  return {
    baseUrl: serverUrl.endsWith("/__webdav__") ? serverUrl : `${serverUrl}/__webdav__`,
    remotePath,
    portableKey: process.env.INTEROCITOR_INTEROP_PASSPHRASE?.trim() || TEST_PASSPHRASE,
    dbName: isSwiftBootstrap
      ? process.env.INTEROCITOR_INTEROP_SWIFT_DB_NAME?.trim() || "swift-core-interop"
      : process.env.INTEROCITOR_INTEROP_DB_NAME?.trim() || "core-swift-interop",
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function createDatabase(deviceId, flow = "core") {
  const config = interopConfig(flow);
  const adapter = new WebDAVAdapter({
    baseUrl: config.baseUrl,
    auth: { username: "core-interop", password: "core-interop" },
  });
  const db = new Interocitor(adapter, {
    dbName: config.dbName,
    remotePath: config.remotePath,
    deviceId,
    localStore: new MemoryLocalStore(),
    keySource: new PortablePassphraseKeySource({
      portableKey: config.portableKey,
      generateIfMissing: false,
    }),
    relayEnabled: false,
    pollInterval: 60_000,
    flushDebounce: 0,
    // Each phase calls flush() explicitly. Avoid an implicit background flush
    // racing the phase boundary or process teardown.
    flushThreshold: 100,
    batchWindowMs: 0,
    autoCompact: false,
  });
  return { adapter, config, db };
}

async function readManifest(adapter, remotePath) {
  const decoder = new TextDecoder();
  const pointer = JSON.parse(decoder.decode(await adapter.readFile(`${remotePath}/manifest.json`)));
  return JSON.parse(decoder.decode(await adapter.readFile(`${remotePath}/${pointer.file}`)));
}

async function bootstrap() {
  const { adapter, config, db } = createDatabase("core_interop_bootstrap");
  await db.init();
  try {
    await db.connect();
    await db.put("tasks", CORE_ROW_ID, {
      origin: "core",
      title: "Created by @interocitor/core",
      done: false,
    });
    await db.flush();

    const manifest = await readManifest(adapter, config.remotePath);
    assert(manifest.encrypted === true, "Core bootstrap did not create an encrypted mesh");
    assert(
      typeof manifest.contentHash === "string" && manifest.contentHash.startsWith("sha256:"),
      "Core bootstrap did not create a content-hashed manifest",
    );
    console.log(
      JSON.stringify({
        phase: "bootstrap",
        meshId: manifest.meshId,
        remotePath: config.remotePath,
      }),
    );
  } finally {
    await db.disconnect();
  }
}

function assertMixedRuntimeRows(rows) {
  const plainRows = toPlainRows(rows);
  const coreRow = plainRows.find((row) => row.origin === "core");
  const swiftRow = plainRows.find((row) => row.origin === "swift");
  const received = JSON.stringify(plainRows);
  assert(
    coreRow?.title === "Created by @interocitor/core",
    `Core-created row is absent or changed; received ${received}`,
  );
  assert(
    coreRow?.done === false,
    `Core-created Boolean value did not survive the Swift round trip; received ${received}`,
  );
  assert(
    swiftRow?.title === "Created by InterocitorSwift",
    `Swift-created row is absent or changed; received ${received}`,
  );
  assert(
    swiftRow?.done === true,
    `Swift-created Boolean value was not readable by Core; received ${received}`,
  );
}

function toPlainRows(rows) {
  return rows.map((row) => {
    if (!row || typeof row !== "object" || !row.payload) return row;
    return Object.fromEntries(
      Object.entries(row.payload).map(([name, entry]) => [name, entry?.value]),
    );
  });
}

function assertSwiftBootstrapNestedRow(rows) {
  const plainRows = toPlainRows(rows);
  const rowIndex = rows.findIndex(
    (candidate) => candidate?._meta?.rowId === SWIFT_BOOTSTRAP_ROW_ID,
  );
  const row = rowIndex === -1 ? undefined : plainRows[rowIndex];
  const details = row?.details;
  const labels = details?.labels;
  const received = JSON.stringify(plainRows);

  assert(row, `Swift bootstrap row ${SWIFT_BOOTSTRAP_ROW_ID} is absent; received ${received}`);
  assert(
    row?.title === "Swift bootstrapped encrypted mesh",
    `Swift bootstrap row is absent or changed; received ${received}`,
  );
  assert(
    details?.attempt === 3,
    `Swift object value was not readable by Core; received ${received}`,
  );
  assert(
    Array.isArray(labels) && labels.length === 3,
    `Swift nested array value was not readable by Core; received ${received}`,
  );
  assert(
    labels?.[0] === "mesh" && labels?.[1]?.retries === 2 && labels?.[1]?.enabled === true,
    `Swift nested object inside an array was not readable by Core; received ${received}`,
  );
  assert(
    labels?.[2] === null && details?.owner?.id === "worker-7",
    `Swift nested null/object values were not readable by Core; received ${received}`,
  );
}

async function verify() {
  const { adapter, config, db } = createDatabase("core_interop_verify");
  await db.init();
  try {
    const changeFiles = await adapter.listFiles(`${config.remotePath}/changes`);
    console.log(
      JSON.stringify({
        phase: "verify:before-connect",
        // map() returns a fresh array, and this script supports Node 18.
        // eslint-disable-next-line unicorn/no-array-sort
        changeFiles: changeFiles.map((file) => file.name).sort(),
      }),
    );
    await db.connect();
    const rows = await db.query("tasks");
    assertMixedRuntimeRows(rows);
    console.log(
      JSON.stringify({ phase: "verify", rows: rows.length, remotePath: config.remotePath }),
    );
  } finally {
    await db.disconnect();
  }
}

async function compact() {
  const { adapter, config, db } = createDatabase("core_interop_compact");
  await db.init();
  try {
    await db.connect();
    assertMixedRuntimeRows(await db.query("tasks"));
    await db.compact();
    const manifest = await readManifest(adapter, config.remotePath);
    assert(manifest.epoch >= 1, "Core compaction did not advance the mesh epoch");
    assert(
      typeof manifest.snapshotPath === "string" && manifest.snapshotPath.length > 0,
      "Core compaction did not publish a snapshot",
    );
    console.log(
      JSON.stringify({
        phase: "compact",
        epoch: manifest.epoch,
        snapshotPath: manifest.snapshotPath,
      }),
    );
  } finally {
    await db.disconnect();
  }
}

async function verifySwiftBootstrap() {
  const { adapter, config, db } = createDatabase(
    "core_interop_read_swift_bootstrap",
    "swift-bootstrap",
  );
  await db.init();
  try {
    await db.connect();
    const manifest = await readManifest(adapter, config.remotePath);
    assert(manifest.encrypted === true, "Core did not accept Swift encrypted bootstrap manifest");
    assert(
      typeof manifest.contentHash === "string" && manifest.contentHash.startsWith("sha256:"),
      "Swift bootstrap manifest is missing its Core-compatible content hash",
    );
    assertSwiftBootstrapNestedRow(await db.query("tasks"));

    // This is deliberately the same Core device that just read Swift's
    // bootstrap change. Compaction publishes a receipt-bearing snapshot and
    // removes the exactly covered immutable history.
    await db.compact();
    const firstCompaction = await readManifest(adapter, config.remotePath);
    assert(
      firstCompaction.epoch === 1,
      `Core first compaction expected epoch 1; received ${firstCompaction.epoch}`,
    );
    assert(
      !Object.hasOwn(firstCompaction, "gcFloorHlc"),
      "Core first compaction must not publish a scalar GC floor",
    );
    assert(
      typeof firstCompaction.snapshotPath === "string" && firstCompaction.snapshotPath.length > 0,
      "Core first compaction did not publish a snapshot",
    );
    console.log(
      JSON.stringify({
        phase: "verify-swift-bootstrap",
        remotePath: config.remotePath,
        firstEpoch: firstCompaction.epoch,
      }),
    );
  } finally {
    await db.disconnect();
  }
}

async function verifySwiftCompacted() {
  const { adapter, config, db } = createDatabase(
    "core_interop_read_swift_snapshot",
    "swift-bootstrap",
  );
  await db.init();
  try {
    const changeFiles = await adapter.listFiles(`${config.remotePath}/changes`);
    const retainedChanges = changeFiles.filter((file) => file.name !== "head.json");
    assert(
      retainedChanges.length === 0,
      "Swift compaction must remove exactly covered immutable changes",
    );

    await db.connect();
    const manifest = await readManifest(adapter, config.remotePath);
    assert(
      manifest.epoch === 2 &&
        typeof manifest.snapshotPath === "string" &&
        manifest.snapshotPath.length > 0,
      `Core did not receive Swift's epoch-2 snapshot manifest; received epoch ${manifest.epoch}`,
    );
    assert(
      !Object.hasOwn(manifest, "gcFloorHlc"),
      "Swift manifest must not publish a scalar GC floor",
    );
    // This Core client has a fresh MemoryLocalStore and can restore the Swift
    // snapshot, then verify exact retained change identities during catch-up.
    assertSwiftBootstrapNestedRow(await db.query("tasks"));
    console.log(
      JSON.stringify({
        phase: "verify-swift-compacted",
        epoch: manifest.epoch,
        snapshotPath: manifest.snapshotPath,
        retainedChangeCount: retainedChanges.length,
      }),
    );
  } finally {
    await db.disconnect();
  }
}

const phase = process.argv[2];
const phases = {
  bootstrap,
  verify,
  compact,
  "verify-swift-bootstrap": verifySwiftBootstrap,
  "verify-swift-compacted": verifySwiftCompacted,
};
const run = phases[phase];

if (run) {
  try {
    await run();
  } catch (error) {
    console.error(`Core/Swift interop ${phase} failed:`, error);
    process.exitCode = 1;
  }
} else {
  console.error(
    "Usage: node Scripts/core-swift-interop.mjs <bootstrap|verify|compact|verify-swift-bootstrap|verify-swift-compacted>",
  );
  process.exitCode = 2;
}
