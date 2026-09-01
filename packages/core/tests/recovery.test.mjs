import assert from "node:assert/strict";
import test from "node:test";
import {
  createRecoveryWrapper,
  publishRecoveryWrapper,
  recoverMeshCredentials,
  recoveryLocator,
  unwrapRecoveryWrapper,
} from "../dist/crypto/recovery.js";
import { MemoryAdapter } from "../dist/adapters/memory.js";

const phrase =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const anotherPhrase = "legal winner thank year wave sausage worth useful legal winner thank yellow";

test("a recovery phrase publishes opaque mesh credentials and restores them without a mesh id", async () => {
  const adapter = new MemoryAdapter();
  const credentials = {
    remotePath: "/case-vault/mesh-a",
    portableKey: "4f3jvRY3nUCGz6ey45nY14B6AxRrz9q2QohRMWDFDT8",
    meshId: "mesh_a",
  };

  assert.equal(phrase.split(" ").length, 12);
  const wrapper = await createRecoveryWrapper(phrase, credentials);
  assert.equal(wrapper.locator, await recoveryLocator(phrase));
  assert.notEqual(wrapper.locator, phrase);
  assert.notEqual(wrapper.ciphertext.includes(credentials.portableKey), true);

  await publishRecoveryWrapper(adapter, wrapper);
  assert.deepEqual(await recoverMeshCredentials(adapter, phrase), credentials);
  assert.deepEqual(await unwrapRecoveryWrapper(phrase, wrapper), credentials);

  const dump = adapter.dump();
  assert.ok(dump[`/.interocitor/recovery/${wrapper.locator}.json`]);
  assert.equal(JSON.stringify(dump).includes(phrase), false);
  assert.equal(JSON.stringify(dump).includes(credentials.portableKey), false);
});

test("a different phrase cannot unlock a recovery wrapper", async () => {
  const wrapper = await createRecoveryWrapper(phrase, {
    remotePath: "/mesh",
    portableKey: "4f3jvRY3nUCGz6ey45nY14B6AxRrz9q2QohRMWDFDT8",
  });

  await assert.rejects(
    () => unwrapRecoveryWrapper(anotherPhrase, wrapper),
    /does not match this wrapper/,
  );
});
