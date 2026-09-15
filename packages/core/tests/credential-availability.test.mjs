import assert from "node:assert/strict";
import { test } from "node:test";
import { Interocitor, MemoryLocalStore, PortablePassphraseKeySource } from "../dist/index.js";
import { MeshCredentialAccessError } from "../dist/crypto/key-source.js";
import { generateKey, keyToPassphrase } from "../dist/crypto/encryption.js";

/**
 * A credential store that reports the richer availability contract.
 *
 * `state` is what `loadCredentialState()` returns; a store that only
 * implements the legacy `load()` is modelled by {@link legacyStore}.
 */
function statefulStore(state, credentials = null) {
  const calls = { load: 0, loadCredentialState: 0, save: 0, clear: 0 };
  return {
    calls,
    async load() {
      calls.load += 1;
      return state === "present" ? credentials : null;
    },
    async loadCredentialState() {
      calls.loadCredentialState += 1;
      if (state === "present") return { status: "present", credentials };
      if (state === "absent") return { status: "absent" };
      return { status: state, reason: `simulated ${state}` };
    },
    async save(creds) {
      calls.save += 1;
      credentials = creds;
    },
    async clear() {
      calls.clear += 1;
      credentials = null;
    },
  };
}

/** The contract as it exists today: `null` and "cannot read" are the same. */
function legacyStore(credentials = null) {
  const calls = { load: 0, save: 0, clear: 0 };
  return {
    calls,
    async load() {
      calls.load += 1;
      return credentials;
    },
    async save(creds) {
      calls.save += 1;
      credentials = creds;
    },
    async clear() {
      calls.clear += 1;
      credentials = null;
    },
  };
}

function engineWith(credentialStore) {
  const keySource = new PortablePassphraseKeySource({ credentialStore });
  const engine = new Interocitor({
    dbName: "credential-availability",
    deviceId: "device_cred",
    localStore: new MemoryLocalStore(),
    keySource,
    batchWindowMs: 0,
    autoCompact: false,
  });
  engine.keySourceUnderTest = keySource;
  return engine;
}

/** The active mesh key, read back off the key source the engine was given. */
function activeKey(engine) {
  return engine.keySourceUnderTest.getPortableKey();
}

// ─── ABSENT: the only state that may mint a key ──────────────────────

test("ABSENT credentials generate a new mesh key (first run)", async () => {
  const store = statefulStore("absent");
  const engine = engineWith(store);

  await engine.init();

  // init() consults the store more than once (resolve, restore, persist
  // parity); what matters is that the richer hook is the one used.
  assert.ok(store.calls.loadCredentialState >= 1, "the availability hook was not consulted");
  assert.equal(store.calls.load, 0, "the richer hook should supersede the legacy load()");
  assert.equal(store.calls.save, 1, "a freshly generated key should be persisted");
  const key = activeKey(engine);
  assert.equal(typeof key, "string");
  assert.ok(key.length >= 43, "generated key should be a full-length portable key");
});

test("a legacy store returning null still behaves as absence", async () => {
  // Defensive requirement: a credential store that does not yet implement
  // loadCredentialState() must keep working exactly as it does today.
  const store = legacyStore(null);
  const engine = engineWith(store);

  await engine.init();

  assert.equal(store.calls.load >= 1, true);
  assert.equal(store.calls.save, 1);
  assert.equal(typeof activeKey(engine), "string");
});

// ─── PRESENT: adopt, never regenerate ────────────────────────────────

test("PRESENT credentials are adopted unchanged", async () => {
  const portableKey = await keyToPassphrase(await generateKey());
  const store = statefulStore("present", { portableKey, deviceId: "device_cred" });
  const engine = engineWith(store);

  await engine.init();

  assert.equal(activeKey(engine), portableKey);
});

// ─── UNAVAILABLE: fail closed, never fork ────────────────────────────

test("UNAVAILABLE credentials throw and never generate a replacement key", async () => {
  const store = statefulStore("unavailable");
  const engine = engineWith(store);

  const err = await engine.init().then(
    () => null,
    (e) => e,
  );

  assert.ok(err, "init() resolved instead of failing on an unreadable credential store");
  assert.ok(err instanceof MeshCredentialAccessError, `wrong error type: ${err?.name}`);
  assert.equal(err.status, "unavailable");
  assert.equal(err.code, "MESH_CREDENTIAL_ACCESS_FAILED");
  assert.match(err.message, /unavailable/i);

  // The actual regression this guards: a cancelled ceremony must not mint a
  // second mesh key, and must not write one anywhere.
  assert.equal(store.calls.save, 0, "a new key was persisted despite unreadable credentials");
  assert.equal(store.calls.clear, 0, "the existing credential record was touched");
});

test("a cancelled ceremony on a second open does not fork the mesh", async () => {
  // Device has joined a mesh. The user then declines the biometric prompt on
  // the next open. Before the fix, the engine silently minted a fresh key and
  // the two halves of the mesh could never merge again.
  const portableKey = await keyToPassphrase(await generateKey());
  let declined = false;
  const store = {
    saved: { portableKey, deviceId: "device_cred" },
    async load() {
      return declined ? null : this.saved;
    },
    async loadCredentialState() {
      return declined
        ? { status: "unavailable", reason: "user dismissed the prompt" }
        : { status: "present", credentials: this.saved };
    },
    async save(creds) {
      this.saved = creds;
    },
    async clear() {
      this.saved = null;
    },
  };

  const first = engineWith(store);
  await first.init();
  assert.equal(activeKey(first), portableKey);

  declined = true;
  const second = engineWith(store);
  const err = await second.init().then(
    () => null,
    (e) => e,
  );

  assert.ok(err instanceof MeshCredentialAccessError);
  assert.equal(err.status, "unavailable");
  assert.equal(store.saved.portableKey, portableKey, "the stored mesh key was overwritten");

  declined = false;
  const third = engineWith(store);
  await third.init();
  assert.equal(
    activeKey(third),
    portableKey,
    "retrying after the decline must land on the same mesh key",
  );
});

test("a store that throws is treated as UNAVAILABLE, not as absence", async () => {
  const store = {
    async load() {
      throw new Error("authenticator went away");
    },
    async loadCredentialState() {
      throw new Error("authenticator went away");
    },
    async save() {
      assert.fail("save() must not be reached when credentials cannot be read");
    },
    async clear() {},
  };

  const err = await engineWith(store)
    .init()
    .then(
      () => null,
      (e) => e,
    );

  assert.ok(err instanceof MeshCredentialAccessError);
  assert.equal(err.status, "unavailable");
});

// ─── UNREADABLE: fail closed, distinctly ─────────────────────────────

test("UNREADABLE credentials throw with their own status", async () => {
  const store = statefulStore("unreadable");
  const err = await engineWith(store)
    .init()
    .then(
      () => null,
      (e) => e,
    );

  assert.ok(err instanceof MeshCredentialAccessError);
  assert.equal(err.status, "unreadable");
  assert.match(err.message, /unreadable/i);
  assert.equal(store.calls.save, 0);
});

test("a malformed availability report fails closed rather than generating", async () => {
  // A store that reports a status core does not understand, or claims
  // "present" with nothing in hand, must not be read as "nothing stored".
  for (const bogus of [
    { status: "maybe" },
    { status: undefined },
    { status: "present" },
    { status: "present", credentials: { deviceId: "d" } },
  ]) {
    const store = {
      async load() {
        return null;
      },
      async loadCredentialState() {
        return bogus;
      },
      async save() {
        assert.fail(`save() reached for ${JSON.stringify(bogus)}`);
      },
      async clear() {},
    };

    const err = await engineWith(store)
      .init()
      .then(
        () => null,
        (e) => e,
      );
    assert.ok(
      err instanceof MeshCredentialAccessError,
      `${JSON.stringify(bogus)} did not fail closed`,
    );
    assert.equal(err.status, "unreadable");
  }
});

// ─── Key sources report the status directly too ──────────────────────

test("the key source reports credentialStatus on the material it returns", async () => {
  const context = { dbName: "credential-availability", deviceId: "device_cred" };

  const absent = await new PortablePassphraseKeySource({
    credentialStore: statefulStore("absent"),
  }).load(context);
  assert.equal(absent.credentialStatus, "absent");
  assert.equal(absent.portableKey, null);

  const portableKey = await keyToPassphrase(await generateKey());
  const present = await new PortablePassphraseKeySource({
    credentialStore: statefulStore("present", { portableKey, deviceId: "device_cred" }),
  }).load(context);
  assert.equal(present.credentialStatus, "present");
  assert.equal(present.portableKey, portableKey);

  await assert.rejects(
    () =>
      new PortablePassphraseKeySource({ credentialStore: statefulStore("unavailable") }).load(
        context,
      ),
    (err) => err instanceof MeshCredentialAccessError && err.status === "unavailable",
  );
});

test("a key source that returns an unreadable status instead of throwing still fails closed", async () => {
  // The contract permits either; the engine must honour both.
  const source = {
    credentialPersistence: "none",
    async load() {
      return { encrypted: true, key: null, portableKey: null, credentialStatus: "unavailable" };
    },
    async persist() {
      assert.fail("persist() must not be reached");
    },
    async clear() {},
  };

  const engine = new Interocitor({
    dbName: "credential-availability",
    deviceId: "device_cred",
    localStore: new MemoryLocalStore(),
    keySource: source,
    batchWindowMs: 0,
    autoCompact: false,
  });

  const err = await engine.init().then(
    () => null,
    (e) => e,
  );
  assert.ok(err instanceof MeshCredentialAccessError);
  assert.equal(err.status, "unavailable");
});
