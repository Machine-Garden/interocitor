import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decryptBytes,
  decryptEntry,
  encryptBytes,
  encryptEntry,
  generateKey,
} from "../dist/crypto/encryption.js";
import { deflateRaw, MAX_INFLATED_BYTES } from "../dist/crypto/compression.js";

const changeJson = JSON.stringify({
  meshId: "mesh_01a15dcf-ae89-73fc-b6d6-e184ad7f9851",
  kind: "change",
  entry: {
    id: "chg_01a15dcf-ae8e-7c4e-8774-22498ba329c9",
    ts: 1792575254158,
    device: "device_7f3a9c",
    hlc: "001792575254158-0000-device_7f3a9c",
    ops: [
      {
        type: "upsert",
        table: "tasks",
        rowId: "task-1",
        columns: {
          title: { value: "", hlc: "001792575254158-0000-device_7f3a9c" },
          done: { value: true, hlc: "001792575254158-0000-device_7f3a9c" },
        },
      },
    ],
  },
});

const PLAIN = 0x02;
const DEFLATE = 0x03;

function randomBytes(length) {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 65536) crypto.getRandomValues(out.subarray(i, i + 65536));
  return out;
}

async function sealBinary(key, format, body) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: Uint8Array.of(format) },
      key,
      body,
    ),
  );
  return Uint8Array.from([format, ...iv, ...ct]);
}

async function sealJson(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  return new TextEncoder().encode(
    JSON.stringify({
      v: 1,
      iv: Buffer.from(iv).toString("base64"),
      ct: Buffer.from(ct).toString("base64"),
    }),
  );
}

test("a change payload is sealed as a compressed binary envelope", async () => {
  const key = await generateKey();
  const sealed = await encryptEntry(key, changeJson);
  assert.equal(sealed[0], DEFLATE);
  const json = await sealJson(key, new TextEncoder().encode(changeJson));
  assert.ok(
    sealed.byteLength < json.byteLength * 0.5,
    `${sealed.byteLength} vs ${json.byteLength}`,
  );
  assert.equal(await decryptEntry(key, sealed), changeJson);
});

test("bytes that do not shrink are sealed as given with 29 bytes of overhead", async () => {
  const key = await generateKey();
  const media = randomBytes(4096);
  const sealed = await encryptBytes(key, media);
  assert.equal(sealed[0], PLAIN);
  assert.equal(sealed.byteLength, media.byteLength + 29);
  assert.deepEqual(await decryptBytes(key, sealed), media);
});

test("empty plaintext round-trips", async () => {
  const key = await generateKey();
  assert.equal(await decryptEntry(key, await encryptEntry(key, "")), "");
});

test("JSON envelopes written before the binary format still open", async () => {
  const key = await generateKey();
  const legacy = await sealJson(key, new TextEncoder().encode(changeJson));
  assert.equal(await decryptEntry(key, legacy), changeJson);
  const padded = new Uint8Array([0x0a, ...legacy]);
  assert.equal(await decryptEntry(key, padded), changeJson);
});

test("the format tag is authenticated", async () => {
  const key = await generateKey();
  const compressed = await encryptEntry(key, changeJson);
  compressed[0] = PLAIN;
  await assert.rejects(decryptEntry(key, compressed));

  const plain = await encryptBytes(key, randomBytes(64));
  plain[0] = DEFLATE;
  await assert.rejects(decryptBytes(key, plain));
});

test("unknown formats, unknown JSON versions, and truncation are rejected by name", async () => {
  const key = await generateKey();
  const sealed = await encryptEntry(key, changeJson);
  sealed[0] = 0x04;
  await assert.rejects(decryptEntry(key, sealed), /Unknown envelope format: 0x04/);
  await assert.rejects(
    decryptEntry(key, new TextEncoder().encode('{"v":2,"iv":"","ct":""}')),
    /Unknown envelope version: 2/,
  );
  await assert.rejects(decryptEntry(key, Uint8Array.of(PLAIN, 1, 2, 3)), /truncated/);
  await assert.rejects(decryptEntry(key, new Uint8Array(0)), /empty/);
});

test("a compressed envelope that inflates past the cap is refused", async () => {
  const key = await generateKey();
  const bomb = await deflateRaw(new Uint8Array(MAX_INFLATED_BYTES + 1));
  await assert.rejects(decryptEntry(key, await sealBinary(key, DEFLATE, bomb)), /inflates past/);
});

test("authenticated bytes that are not DEFLATE fail as malformed", async () => {
  const key = await generateKey();
  const sealed = await sealBinary(key, DEFLATE, randomBytes(64));
  await assert.rejects(decryptEntry(key, sealed), /malformed/);
});
