import assert from "node:assert/strict";
import { test } from "node:test";
import { Interocitor, MemoryLocalStore, PortablePassphraseKeySource } from "../dist/index.js";
import { MemoryAdapter } from "../dist/adapters/memory.js";
import { generateKey, keyToPassphrase } from "../dist/crypto/encryption.js";

const CONSOLE_METHODS = ["debug", "log", "info", "warn", "error", "trace", "dir"];

/**
 * Flatten a console argument to text the way a console sink would render it.
 *
 * Recursive on purpose: a key nested three objects deep in a structured log is
 * still a leaked key, so the guard sees object payloads, not just format
 * strings.
 */
function render(value, depth = 0) {
  if (depth > 8) return "";
  if (value === null || value === undefined) return String(value);
  if (typeof value === "string") return value;
  if (typeof value !== "object") return String(value);
  if (value instanceof Error) {
    return `${value.name} ${value.message} ${value.stack ?? ""} ${render(value.cause, depth + 1)}`;
  }
  if (Array.isArray(value)) return value.map((item) => render(item, depth + 1)).join(" ");
  if (value instanceof Map) {
    return [...value].map(([k, v]) => `${render(k, depth + 1)}=${render(v, depth + 1)}`).join(" ");
  }
  if (value instanceof Set) return [...value].map((item) => render(item, depth + 1)).join(" ");
  return Object.entries(value)
    .map(([k, v]) => `${k}=${render(v, depth + 1)}`)
    .join(" ");
}

/** Capture everything written to every console method, flattened to text. */
function captureConsole() {
  const originals = {};
  const lines = [];

  for (const method of CONSOLE_METHODS) {
    originals[method] = console[method];
    console[method] = (...args) => {
      lines.push(`${method}: ${args.map((arg) => render(arg)).join(" ")}`);
    };
  }

  return {
    lines,
    restore() {
      for (const method of CONSOLE_METHODS) console[method] = originals[method];
    },
  };
}

/** Every substring of `key` of at least `minLength` characters. */
function substrings(key, minLength) {
  const out = new Set();
  for (let start = 0; start + minLength <= key.length; start++) {
    for (let end = start + minLength; end <= key.length; end++) {
      out.add(key.slice(start, end));
    }
  }
  return [...out];
}

function assertNoKeyMaterial(lines, key) {
  const haystack = lines.join("\n");

  // Whole key, obviously.
  assert.equal(haystack.includes(key), false, "console output contained the whole portable key");

  // Any run of 6+ characters. Six base58 characters is ~35 bits, well under
  // the ~70 bits the head=<8>/tail=<4> fingerprints leaked, and short enough
  // that no truncated-key "fingerprint" can slip past. Shorter runs than this
  // collide with ordinary log text (ids, paths, HLCs) often enough to make
  // the guard flaky rather than strict.
  for (const fragment of substrings(key, 6)) {
    assert.equal(
      haystack.includes(fragment),
      false,
      `console output contained a ${fragment.length}-character run of the portable key`,
    );
  }
}

async function runFullCycle(portableKey, { logLevel } = {}) {
  const adapter = new MemoryAdapter();
  const engine = new Interocitor(adapter, {
    dbName: "log-hygiene",
    remotePath: "/mesh/log-hygiene",
    deviceId: "device_log_hygiene",
    localStore: new MemoryLocalStore(),
    keySource: new PortablePassphraseKeySource({ portableKey }),
    batchWindowMs: 0,
    autoCompact: false,
    pollInterval: 1_000_000,
    relayEnabled: false,
    ...(logLevel ? { logLevel } : {}),
  });

  await engine.init();
  await engine.connect();
  await engine.put("tasks", "task-1", { title: "Buy milk", done: false }, "user-1");
  await engine.flush();
  await engine.pull();
  await engine.put("tasks", "task-1", { done: true }, "user-1");
  await engine.flush();
  await engine.disconnect();
  return { adapter, engine };
}

test("a full init + connect + flush cycle never prints mesh key material", async () => {
  const portableKey = await keyToPassphrase(await generateKey());
  const capture = captureConsole();
  try {
    await runFullCycle(portableKey);
  } finally {
    capture.restore();
  }

  assertNoKeyMaterial(capture.lines, portableKey);
});

test("the same cycle at logLevel debug still never prints mesh key material", async () => {
  // The quiet default is not the guarantee. Anything routed through the
  // engine logger at its most verbose must still be key-free, and bare
  // console.* calls ignore the level gate entirely.
  const portableKey = await keyToPassphrase(await generateKey());
  const capture = captureConsole();
  try {
    await runFullCycle(portableKey, { logLevel: "debug" });
  } finally {
    capture.restore();
  }

  assert.ok(
    capture.lines.length > 0,
    "logLevel debug produced no output — the guard proved nothing",
  );
  assertNoKeyMaterial(capture.lines, portableKey);
});

test("the leak guard actually fires when key material reaches the console", async () => {
  // Without this, a future change that silences all logging would make the
  // tests above pass for the wrong reason.
  const portableKey = await keyToPassphrase(await generateKey());
  const capture = captureConsole();
  try {
    console.log("activePassphraseFingerprint", {
      head: portableKey.slice(0, 8),
      tail: portableKey.slice(-4),
    });
  } finally {
    capture.restore();
  }

  assert.throws(() => assertNoKeyMaterial(capture.lines, portableKey), {
    name: "AssertionError",
  });
});

test("the remote never stores the key or row plaintext in the clear", async () => {
  const portableKey = await keyToPassphrase(await generateKey());
  const { adapter } = await runFullCycle(portableKey);

  const dump = JSON.stringify(adapter.dump());
  assert.equal(dump.includes(portableKey), false);
  assert.equal(dump.includes("Buy milk"), false, "row values reached the remote unencrypted");
});
