import assert from "node:assert/strict";
import { test } from "node:test";
import {
  exportKeyRaw,
  generateKey,
  keyToPassphrase,
  passphraseToKey,
} from "../dist/crypto/encryption.js";

test("a generated key round-trips through its base58 form", async () => {
  for (let i = 0; i < 64; i++) {
    const key = await generateKey();
    const passphrase = await keyToPassphrase(key);
    const restored = await passphraseToKey(passphrase);
    assert.deepEqual(
      [...(await exportKeyRaw(restored))],
      [...(await exportKeyRaw(key))],
      `round trip lost bytes for ${passphrase.length}-character key`,
    );
  }
});

test("surrounding whitespace is still tolerated", async () => {
  const passphrase = await keyToPassphrase(await generateKey());
  const restored = await passphraseToKey(`\n  ${passphrase}\t `);
  assert.equal(await keyToPassphrase(restored), passphrase);
});

test("a short human-chosen string is rejected, not silently padded", async () => {
  // The bug: base58Decode left-padded to 32 bytes, so "hunter2" produced a
  // structurally valid AES-256 key carrying ~40 bits of entropy, and the mesh
  // came up looking perfectly healthy.
  for (const weak of ["hunter2", "a", "correcthorse", "12345678", "password", "1"]) {
    await assert.rejects(
      () => passphraseToKey(weak),
      (err) => err instanceof Error && /Invalid mesh key/.test(err.message),
      `weak key accepted: ${weak}`,
    );
  }
});

test("an empty or whitespace-only key is rejected", async () => {
  for (const blank of ["", "   ", "\n\t"]) {
    await assert.rejects(() => passphraseToKey(blank), /Invalid mesh key: empty/);
  }
});

test("an over-long key is rejected here rather than deep inside importKey", async () => {
  const passphrase = await keyToPassphrase(await generateKey());

  // Wide enough to decode past 32 bytes.
  await assert.rejects(
    () => passphraseToKey(`zzzz${passphrase}`),
    (err) => err instanceof Error && /more than 32 bytes/.test(err.message),
  );

  // Odd-length hex regression: `num.toString(16)` on an oversized value can
  // yield an odd number of digits, which used to slice a half byte off the
  // front (or throw a RangeError) instead of reporting a bad key.
  for (let extra = 1; extra <= 12; extra++) {
    const oversized = "z".repeat(extra) + passphrase;
    const err = await passphraseToKey(oversized).then(
      () => null,
      (e) => e,
    );
    assert.ok(err instanceof Error, `oversized key of +${extra} chars was accepted`);
    assert.equal(err.name, "Error", `oversized key of +${extra} chars threw ${err.name}`);
    assert.match(err.message, /Invalid mesh key/);
  }
});

test("a non-canonical encoding of the right byte count is rejected", async () => {
  const passphrase = await keyToPassphrase(await generateKey());
  // Leading "1" is base58 zero: it decodes to the same 32 bytes but is not
  // what keyToPassphrase emits, so accepting it would mean two spellings of
  // one mesh key.
  await assert.rejects(() => passphraseToKey(`1${passphrase}`), /Invalid mesh key/);
});

test("a non-base58 character is reported as such", async () => {
  const passphrase = await keyToPassphrase(await generateKey());
  await assert.rejects(
    () => passphraseToKey(`${passphrase.slice(0, -1)}0`),
    /Invalid base58 character/,
  );
});

test("keys with leading zero bytes are accepted", async () => {
  // Vanishingly rare from generateKey, but a legitimate 32-byte key. The
  // canonical check must not reject one for being shorter than 43 characters.
  const { importKeyRaw } = await import("../dist/crypto/encryption.js");
  for (const leadingZeros of [1, 2, 5, 10]) {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    raw.fill(0, 0, leadingZeros);
    const key = await importKeyRaw(raw);
    const passphrase = await keyToPassphrase(key);
    const restored = await passphraseToKey(passphrase);
    assert.deepEqual(
      [...(await exportKeyRaw(restored))],
      [...raw],
      `${leadingZeros} leading zero bytes broke the round trip`,
    );
  }
});
