import assert from "node:assert/strict";
import test from "node:test";

import {
  CredentialPersistenceError,
  Interocitor,
  isCredentialPersistenceError,
  isMeshKeySourceContractError,
  MemoryLocalStore,
  MeshKeySourceContractError,
} from "../dist/index.js";
import {
  isMeshCredentialAccessError,
  MeshCredentialAccessError,
} from "../dist/crypto/key-source.js";
import { generateKey, keyToPassphrase } from "../dist/crypto/encryption.js";

/**
 * Rebuild an error the way a *second copy* of this package would have thrown
 * it: the same own fields and name, on a prototype chain this copy has never
 * seen.
 *
 * This is the duplicate install, the pnpm-isolated transitive dependency, and
 * the bundler that emitted the module into two chunks. None of them is
 * prevented by a peerDependency range, and under all three `instanceof`
 * answers "no" for an error that is in every observable way the real thing.
 */
function fromAnotherCopy(error) {
  class ForeignError extends Error {}
  const foreign = new ForeignError(error.message);
  for (const key of Object.getOwnPropertyNames(error)) {
    if (key === "stack") continue;
    Object.defineProperty(foreign, key, Object.getOwnPropertyDescriptor(error, key));
  }
  return foreign;
}

/** A durable key source that fails at exactly one step, with a given error. */
function keySourceThrowing(error, step, portableKey) {
  return {
    credentialPersistence: "durable",
    async load() {
      return { encrypted: true, key: null, portableKey, credentialStatus: "present" };
    },
    async loadPersistedCredentials() {
      if (step === "inspect") throw error;
      return null;
    },
    async persist() {
      if (step === "persist") throw error;
    },
    async clear() {},
  };
}

function engineWith(keySource) {
  return new Interocitor({
    dbName: "error-identity",
    deviceId: "device_identity",
    localStore: new MemoryLocalStore(),
    keySource,
    batchWindowMs: 0,
    autoCompact: false,
  });
}

const failedInit = (engine) =>
  engine.init().then(
    () => null,
    (err) => err,
  );

// ─── The predicates ──────────────────────────────────────────────────

test("the credential predicates match an error from another copy of the package", () => {
  const cases = [
    [new CredentialPersistenceError("db", "inspect"), isCredentialPersistenceError],
    [new MeshKeySourceContractError(), isMeshKeySourceContractError],
    [new MeshCredentialAccessError("unavailable", { dbName: "db" }), isMeshCredentialAccessError],
  ];

  for (const [error, predicate] of cases) {
    const foreign = fromAnotherCopy(error);
    assert.equal(predicate(error), true, `${error.name}: own copy not matched`);
    assert.equal(
      foreign instanceof error.constructor,
      false,
      `${error.name}: the foreign copy shares a class identity, so it proves nothing`,
    );
    assert.equal(predicate(foreign), true, `${error.name}: foreign copy not matched`);
    assert.equal(foreign.code, error.code, `${error.name}: the stable code did not survive`);
  }
});

test("the credential predicates stay narrow", () => {
  for (const predicate of [isCredentialPersistenceError, isMeshKeySourceContractError]) {
    assert.equal(predicate(new Error("unrelated")), false);
    assert.equal(predicate(null), false);
    assert.equal(predicate(void 0), false);
    assert.equal(predicate("CREDENTIAL_PERSISTENCE_FAILED"), false);
    assert.equal(predicate({ code: "SOMETHING_ELSE" }), false);
  }
  assert.equal(isCredentialPersistenceError({ code: "MESH_KEY_SOURCE_CONTRACT_INVALID" }), false);
  assert.equal(isMeshKeySourceContractError({ code: "CREDENTIAL_PERSISTENCE_FAILED" }), false);
});

// ─── The engine paths that decide whether to replace credentials ─────

test("a fail-closed credential error from another copy is not re-wrapped as a persist failure", async () => {
  // A host's key source throws MeshCredentialAccessError from its own copy of
  // this package. Wrapping it as CredentialPersistenceError loses `status`,
  // which is what tells the host to re-prompt rather than treat the record as
  // beyond repair.
  const portableKey = await keyToPassphrase(await generateKey());
  const thrown = fromAnotherCopy(
    new MeshCredentialAccessError("unavailable", {
      dbName: "error-identity",
      reason: "user dismissed the prompt",
    }),
  );

  const err = await failedInit(engineWith(keySourceThrowing(thrown, "inspect", portableKey)));

  assert.ok(err, "init() resolved despite an unreadable credential record");
  assert.equal(err, thrown, "the fail-closed error was replaced instead of propagated");
  assert.equal(err.code, "MESH_CREDENTIAL_ACCESS_FAILED");
  assert.equal(err.status, "unavailable");
});

test("a persistence failure from another copy propagates with its own context", async () => {
  const portableKey = await keyToPassphrase(await generateKey());
  // `dbName` identifies the copy that raised it: a re-wrap would report this
  // engine's dbName instead.
  const thrown = fromAnotherCopy(new CredentialPersistenceError("host-copy", "persist"));

  const err = await failedInit(engineWith(keySourceThrowing(thrown, "persist", portableKey)));

  assert.equal(err, thrown, "the error was re-wrapped instead of propagated");
  assert.equal(err.dbName, "host-copy");
});

test("a key-source contract error from another copy propagates unchanged", async () => {
  const portableKey = await keyToPassphrase(await generateKey());
  const thrown = fromAnotherCopy(new MeshKeySourceContractError());

  const err = await failedInit(engineWith(keySourceThrowing(thrown, "persist", portableKey)));

  assert.equal(err, thrown, "the error was re-wrapped instead of propagated");
  assert.equal(err.code, "MESH_KEY_SOURCE_CONTRACT_INVALID");
});

test("an ordinary failure is still wrapped as a persistence error", async () => {
  // The predicates widen what passes through; they must not widen it to
  // everything. An unclassified throw still becomes the typed persist failure.
  const portableKey = await keyToPassphrase(await generateKey());
  const err = await failedInit(
    engineWith(keySourceThrowing(new Error("disk on fire"), "persist", portableKey)),
  );

  assert.ok(isCredentialPersistenceError(err), `wrong error type: ${err?.name}`);
  assert.equal(err.dbName, "error-identity");
  assert.equal(err.operation, "persist");
  assert.equal(err.cause?.message, "disk on fire");
});
