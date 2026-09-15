import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decryptBytes,
  decryptEntry,
  encryptBytes,
  encryptEntry,
  exportKeyRaw,
  generateKey,
  generateMeshKeyMaterial,
  importKeyRaw,
  keyToPassphrase,
  passphraseToKey,
} from "../dist/crypto/encryption.js";
import { Interocitor, MemoryLocalStore } from "../dist/index.js";
import {
  decodeStoredFrame,
  deriveFileGuard,
  deriveFilePathKey,
  encodeStoredFrame,
  hideFilePath,
  openStoredFrame,
  sealStoredFrame,
} from "../dist/core/stored-file.js";
import { createRecoveryWrapper, unwrapRecoveryWrapper } from "../dist/crypto/recovery.js";
import { snapshotHandshakeCredentials } from "../dist/handshake/channel.js";

const encoder = new TextEncoder();

/** The domain separators pinned by the durable-file wire format. */
const PATH_INFO = encoder.encode("interocitor/durable-file-path/v1");
const GUARD_INFO = encoder.encode("interocitor/durable-file-guard/v1");

function fixedRaw(seed = 7) {
  return Uint8Array.from({ length: 32 }, (_, index) => (index * 31 + seed) % 256);
}

/**
 * Reproduce the pre-change derivation straight from raw bytes: export the
 * AES-GCM key, re-import as HKDF, derive HMAC, sign. Nothing in the library is
 * involved, so a match pins the stored format rather than the implementation.
 */
async function legacyHmacHex(raw, info, text) {
  const base = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
  const hmac = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", hmac, encoder.encode(text));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ─── The posture itself ──────────────────────────────────────────────

test("an imported mesh key cannot be exported", async () => {
  const key = await importKeyRaw(fixedRaw());

  assert.equal(key.extractable, false);
  await assert.rejects(
    () => crypto.subtle.exportKey("raw", key),
    (err) => err instanceof Error,
    "crypto.subtle.exportKey handed back the raw mesh key",
  );
  await assert.rejects(() => exportKeyRaw(key));
});

test("a mesh key restored from its base58 form cannot be exported", async () => {
  const portableKey = await keyToPassphrase(await generateKey());
  const key = await passphraseToKey(portableKey);

  assert.equal(key.extractable, false);
  await assert.rejects(() => crypto.subtle.exportKey("raw", key));
  await assert.rejects(() => keyToPassphrase(key));
});

test("extractability is still available on request", async () => {
  const raw = fixedRaw(11);
  const key = await importKeyRaw(raw, { extractable: true });

  assert.equal(key.extractable, true);
  assert.deepEqual([...(await exportKeyRaw(key))], [...raw]);

  const fromPassphrase = await passphraseToKey(await keyToPassphrase(key), { extractable: true });
  assert.deepEqual([...(await exportKeyRaw(fromPassphrase))], [...raw]);
});

test("generateKey stays extractable by default and honours the opt-out", async () => {
  // The default is deliberate: `Interocitor.resolveEncryption()` generates a
  // key at first run purely to read its base58 form back out. Flipping this
  // default without moving that call site to generateMeshKeyMaterial() would
  // throw on every first run.
  assert.equal((await generateKey()).extractable, true);
  assert.equal((await generateKey({ extractable: false })).extractable, false);
});

test("generateMeshKeyMaterial mints a non-extractable key beside its portable form", async () => {
  const { key, portableKey } = await generateMeshKeyMaterial();

  assert.equal(key.extractable, false);
  await assert.rejects(() => crypto.subtle.exportKey("raw", key));

  // The portable string is canonical base58 and names the very same key.
  const restored = await passphraseToKey(portableKey);
  assert.equal(
    await decryptEntry(restored, await encryptEntry(key, "same mesh")),
    "same mesh",
    "the portable form did not reproduce the generated key",
  );
});

// ─── Nothing on the wire moved ───────────────────────────────────────

test("ciphertext is interchangeable between extractable and non-extractable imports", async () => {
  const raw = fixedRaw(3);
  const locked = await importKeyRaw(raw);
  const open = await importKeyRaw(raw, { extractable: true });

  assert.equal(await decryptEntry(open, await encryptEntry(locked, "hello")), "hello");
  assert.equal(await decryptEntry(locked, await encryptEntry(open, "hello")), "hello");

  const payload = Uint8Array.from([0, 1, 2, 250, 251]);
  assert.deepEqual(
    [...(await decryptBytes(locked, await encryptBytes(open, payload)))],
    [...payload],
  );
});

test("durable file object names are unchanged by extractability", async () => {
  const raw = fixedRaw(5);
  const locked = await importKeyRaw(raw);
  const open = await importKeyRaw(raw, { extractable: true });
  const path = "photos/2026/cat.png";

  const viaTwin = await hideFilePath(await deriveFilePathKey(locked), path);
  const viaExport = await hideFilePath(await deriveFilePathKey(open), path);

  assert.equal(viaTwin, viaExport);
  assert.equal(
    viaTwin,
    await legacyHmacHex(raw, PATH_INFO, path),
    "the remote object name for a path changed; existing files would go missing",
  );
});

test("seal guards are unchanged by extractability", async () => {
  const raw = fixedRaw(9);
  const locked = await importKeyRaw(raw);
  const open = await importKeyRaw(raw, { extractable: true });
  const objectName = "9f2c";

  const viaTwin = await deriveFileGuard(locked, objectName);
  assert.equal(viaTwin, await deriveFileGuard(open, objectName));
  assert.equal(viaTwin, await legacyHmacHex(raw, GUARD_INFO, objectName));
});

test("stored frames round-trip under a non-extractable mesh key", async () => {
  const raw = fixedRaw(13);
  const locked = await importKeyRaw(raw);
  const open = await importKeyRaw(raw, { extractable: true });
  const body = encoder.encode("durable body");
  const header = { size: body.byteLength, digest: "abc", contentType: "text/plain" };

  // Sealed by the extractable key an older client would have held; opened by
  // the non-extractable key this one imports.
  const stored = await sealStoredFrame(open, encodeStoredFrame(header, body));
  const reopened = decodeStoredFrame(await openStoredFrame(locked, stored));

  assert.deepEqual(reopened.header, header);
  assert.equal(new TextDecoder().decode(reopened.body), "durable body");
});

// ─── Keys this module did not mint ───────────────────────────────────

test("an application-supplied extractable seal key still derives", async () => {
  const raw = fixedRaw(17);
  const foreign = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, true, [
    "encrypt",
    "decrypt",
  ]);

  assert.equal(await deriveFileGuard(foreign, "obj"), await legacyHmacHex(raw, GUARD_INFO, "obj"));
});

test("a foreign non-extractable key fails with a diagnosable message", async () => {
  const foreign = await crypto.subtle.importKey("raw", fixedRaw(19), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);

  await assert.rejects(
    () => deriveFileGuard(foreign, "obj"),
    /no HKDF twin is registered/,
    "a non-derivable key surfaced as a bare InvalidAccessError",
  );
});

// ─── Paths that never touched the CryptoKey ──────────────────────────

test("recovery wrappers carry the portable string, not a CryptoKey", async () => {
  const { key, portableKey } = await generateMeshKeyMaterial();
  const wrapper = await createRecoveryWrapper("correct horse battery staple", {
    remotePath: "/mesh",
    portableKey,
  });
  const recovered = await unwrapRecoveryWrapper("correct horse battery staple", wrapper);

  assert.equal(recovered.portableKey, portableKey);
  assert.equal(
    await decryptEntry(await passphraseToKey(recovered.portableKey), await encryptEntry(key, "ok")),
    "ok",
  );
});

test("pairing credentials carry the portable string, not a CryptoKey", async () => {
  const { portableKey } = await generateMeshKeyMaterial();
  const snapshot = snapshotHandshakeCredentials({ remotePath: "/mesh", passphrase: portableKey });

  assert.equal(snapshot.passphrase, portableKey);
  assert.equal(typeof snapshot.passphrase, "string");
});

// ─── The engine's own hot path ────────────────────────────────────────

test("a mesh created from scratch holds a non-extractable key", async () => {
  // The branch under test is the one that mints a key because the key source
  // had none: previously `generateKey()` + `keyToPassphrase()`, which needed
  // an extractable key purely to read back the bytes it had just generated.
  const source = {
    credentialPersistence: "none",
    async load() {
      return { encrypted: true, key: null, portableKey: null };
    },
    async persist() {},
    async clear() {},
  };

  const engine = new Interocitor({
    dbName: "mesh-key-extractability",
    deviceId: "device_fresh",
    localStore: new MemoryLocalStore(),
    keySource: source,
    batchWindowMs: 0,
    autoCompact: false,
  });
  await engine.init();

  const key = engine.encryptionKey;
  assert.ok(key instanceof CryptoKey, "the engine minted a mesh key");
  assert.equal(key.extractable, false);
  await assert.rejects(() => crypto.subtle.exportKey("raw", key), /InvalidAccessError|not extractable/);

  // Non-extractability costs the mesh nothing: the portable form is produced
  // alongside the key, so the mesh is still shareable and recoverable.
  assert.equal(typeof engine.passphrase, "string");
  const rejoined = await passphraseToKey(engine.passphrase);
  const sealed = await encryptBytes(key, encoder.encode("fresh mesh"));
  assert.equal(new TextDecoder().decode(await decryptBytes(rejoined, sealed)), "fresh mesh");
});
