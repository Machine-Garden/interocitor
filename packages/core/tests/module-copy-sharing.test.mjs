// State that must be shared between two copies of @interocitor/core.
//
// A consumer's tree can hold two copies of this package — a duplicated install,
// an isolated node_modules layout, a bundler emitting one module into two
// chunks — and `peerDependencies` prevents none of them. Node gives us the same
// situation for free: importing one built module under two distinct specifiers
// produces two module instances whose own relative imports still resolve to the
// single shared graph, which is exactly the shape of a duplicated package.
//
// Every assertion below fails when the state lives in a module-level Map.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);

const ENCRYPTION = new URL("../dist/crypto/encryption.js", import.meta.url);
const CHANGE_OBSERVATION = new URL("../dist/core/change-observation.js", import.meta.url);

/** Two module instances of one built file, standing in for two installs. */
function copies(url) {
  return Promise.all([import(`${url}?copy=a`), import(`${url}?copy=b`)]);
}

test("an HKDF twin registered by one copy is found by the other", async () => {
  const [copyA, copyB] = await copies(ENCRYPTION);

  const raw = new Uint8Array(32).fill(7);
  const key = await copyA.importKeyRaw(raw);

  // The key is non-extractable, so there is no export-and-reimport fallback:
  // copy B either sees copy A's twin or it throws.
  const twinFromB = await copyB.meshKeyDerivationBase(key);
  const twinFromA = await copyA.meshKeyDerivationBase(key);

  assert.equal(twinFromB, twinFromA, "both copies must hand out the same twin object");
  assert.equal(twinFromB.algorithm.name, "HKDF");
});

/** HKDF over a base key, so two twins can be compared by what they produce. */
async function derive(base) {
  const derived = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(16), info: new Uint8Array(0) },
    base,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt"],
  );
  return new Uint8Array(await crypto.subtle.exportKey("raw", derived));
}

test("a derivation crossing copies produces the same key bytes either way", async () => {
  const [copyA, copyB] = await copies(ENCRYPTION);
  const key = await copyA.importKeyRaw(new Uint8Array(32).fill(11));

  assert.deepEqual(
    await derive(await copyB.meshKeyDerivationBase(key)),
    await derive(await copyA.meshKeyDerivationBase(key)),
  );
});

/** Hand the event loop to whatever else is mid-flight. */
function yieldTurn() {
  return new Promise((resolve) => {
    setTimeout(resolve, 5);
  });
}

/**
 * A metadata store with no `withLock`, so change observation falls back to its
 * own writer gate. `getMeta` opens a critical section and `setMeta` closes it,
 * which is exactly the span the gate is supposed to hold exclusively.
 */
function serializationProbe() {
  const metadata = new Map();
  const state = { active: 0, peak: 0 };
  return {
    state,
    async getMeta(key) {
      state.active += 1;
      state.peak = Math.max(state.peak, state.active);
      await yieldTurn();
      return metadata.get(key);
    },
    async setMeta(key, value) {
      await yieldTurn();
      metadata.set(key, value);
      state.active -= 1;
    },
  };
}

test("one copy's fallback writer gate serializes another copy's writes", async () => {
  const [copyA, copyB] = await copies(CHANGE_OBSERVATION);
  const local = serializationProbe();

  await Promise.all([
    copyA.ChangeObservationLedger.reset(local),
    copyB.ChangeObservationLedger.reset(local),
  ]);

  assert.equal(local.state.peak, 1, "two copies must share one gate per store object");
});

test("the fallback writer gate still serializes within a single copy", async () => {
  const [copyA] = await copies(CHANGE_OBSERVATION);
  const local = serializationProbe();

  await Promise.all([
    copyA.ChangeObservationLedger.reset(local),
    copyA.ChangeObservationLedger.reset(local),
  ]);

  assert.equal(local.state.peak, 1);
});

test("a frozen globalThis degrades to per-copy state instead of failing to import", async () => {
  // A hardened embedder may freeze the global before any library loads. The
  // helper must lose sharing there, not take the import down with it.
  const probe = `
    Object.freeze(globalThis);
    const copyA = await import(${JSON.stringify(`${ENCRYPTION}?frozen=a`)});
    const copyB = await import(${JSON.stringify(`${ENCRYPTION}?frozen=b`)});
    const key = await copyA.importKeyRaw(new Uint8Array(32).fill(5));
    const ownCopyWorks = (await copyA.meshKeyDerivationBase(key)).algorithm.name === "HKDF";
    let sharedAcrossCopies = true;
    try {
      await copyB.meshKeyDerivationBase(key);
    } catch {
      sharedAcrossCopies = false;
    }
    const published = Object.getOwnPropertySymbols(globalThis).some((symbol) =>
      String(symbol).includes("interocitor."),
    );
    console.log(JSON.stringify({ ownCopyWorks, sharedAcrossCopies, published }));
  `;

  const { stdout } = await run(process.execPath, ["--input-type=module", "--eval", probe]);
  const result = JSON.parse(stdout.trim().split("\n").pop());

  assert.equal(result.ownCopyWorks, true, "the module must still work inside its own copy");
  assert.equal(result.published, false, "nothing may be forced onto a frozen global");
  assert.equal(result.sharedAcrossCopies, false, "degradation is per-copy state, not sharing");
});

test("every package carries the identical copy of the shared-state helper", async () => {
  // The helper is duplicated on purpose — see its module note — which only
  // holds while the copies agree. A divergent version prefix or a copy that
  // stopped catching a frozen global would be invisible to every other test.
  const canonical = new URL("../src/core/shared-global-state.ts", import.meta.url);
  const duplicates = [
    new URL("../../web/src/shared-global-state.ts", import.meta.url),
    new URL("../../workers/src/shared-global-state.ts", import.meta.url),
  ];

  const expected = await readFile(canonical, "utf8");
  for (const duplicate of duplicates) {
    assert.equal(await readFile(duplicate, "utf8"), expected, `${duplicate} drifted`);
  }
});
