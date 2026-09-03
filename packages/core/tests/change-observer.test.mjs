import assert from "node:assert/strict";
import { test } from "node:test";
import { Interocitor, MemoryLocalStore } from "../dist/index.js";
import { MemoryAdapter } from "../dist/adapters/memory.js";

function localEngine() {
  return new Interocitor({
    deviceId: "device_local",
    keySource: null,
    localStore: new MemoryLocalStore(),
    batchWindowMs: 0,
    autoCompact: false,
  });
}

test("observeChanges reports effective local column transitions", async () => {
  const engine = localEngine();
  const observations = [];
  engine.observeChanges((observation) => observations.push(observation));

  await engine.put("tasks", "task-1", { title: "First", done: false }, "user-1");
  await engine.put("tasks", "task-1", { done: true }, "user-1");
  await engine.delete("tasks", "task-1", "user-1");
  await engine.put("tasks", "task-1", { title: "Again" }, "user-1");

  assert.equal(observations.length, 4);
  assert.equal(observations[0].source, "local");
  assert.equal(observations[0].change.device, "device_local");
  assert.equal(observations[0].effects[0].kind, "create");
  assert.deepEqual(Object.keys(observations[0].effects[0].fields).toSorted(), ["done", "title"]);

  assert.equal(observations[1].effects[0].kind, "update");
  assert.deepEqual(Object.keys(observations[1].effects[0].fields), ["done"]);
  assert.equal(observations[1].effects[0].fields.done.before.value, false);
  assert.equal(observations[1].effects[0].fields.done.after.value, true);

  assert.equal(observations[2].effects[0].kind, "delete");
  assert.deepEqual(Object.keys(observations[2].effects[0].fields).toSorted(), ["done", "title"]);
  assert.equal(observations[2].effects[0].fields.title.before.value, "First");
  assert.equal(observations[2].effects[0].fields.title.after, undefined);

  assert.equal(observations[3].effects[0].kind, "resurrect");
  assert.deepEqual(Object.keys(observations[3].effects[0].fields), ["title"]);
  assert.equal(observations[3].effects[0].fields.title.before, undefined);
  assert.equal(observations[3].effects[0].fields.title.after.value, "Again");

  await engine.disconnect();
});

test("observeChanges reports one net effect for an explicit local batch", async () => {
  const engine = localEngine();
  const observations = [];
  engine.observeChanges((observation) => observations.push(observation));

  await engine.batch(async () => {
    await engine.put("tasks", "task-1", { title: "First", done: false });
    await engine.put("tasks", "task-1", { title: "Second" });
  });

  assert.equal(observations.length, 1);
  assert.equal(observations[0].change.ops.length, 2);
  assert.equal(observations[0].effects.length, 1);
  assert.equal(observations[0].effects[0].kind, "create");
  assert.equal(observations[0].effects[0].fields.title.before, undefined);
  assert.equal(observations[0].effects[0].fields.title.after.value, "Second");

  await engine.disconnect();
});

test("a subscription starts with the next local batch boundary", async () => {
  const engine = new Interocitor({
    deviceId: "device_local",
    keySource: null,
    localStore: new MemoryLocalStore(),
    batchWindowMs: 60_000,
    autoCompact: false,
  });

  await engine.put("tasks", "before-subscription", { title: "Before" });
  const observations = [];
  engine.observeChanges((observation) => observations.push(observation));
  await engine.put("tasks", "same-open-batch", { title: "During" });
  await engine.flush();
  assert.deepEqual(observations, []);

  await engine.put("tasks", "next-batch", { title: "After" });
  await engine.flush();
  assert.equal(observations.length, 1);
  assert.equal(observations[0].effects[0].rowId, "next-batch");

  await engine.disconnect();
});

test("a same-value write remains observable when its CRDT timestamp advances", async () => {
  const engine = localEngine();
  const observations = [];
  engine.observeChanges((observation) => observations.push(observation));

  await engine.put("tasks", "task-1", { title: "Same" });
  await engine.put("tasks", "task-1", { title: "Same" });

  assert.equal(observations.length, 2);
  const transition = observations[1].effects[0].fields.title;
  assert.equal(transition.before.value, "Same");
  assert.equal(transition.after.value, "Same");
  assert.notEqual(transition.before.hlc, transition.after.hlc);

  await engine.disconnect();
});

test("observer failures and mutations do not affect writes or other observers", async () => {
  const engine = localEngine();
  const observations = [];
  engine.observeChanges((observation) => {
    observation.effects[0].fields.title.after.value = "tampered";
    throw new Error("observer failed");
  });
  engine.observeChanges((observation) => observations.push(observation));

  await engine.put("tasks", "task-1", { title: "Original" });

  assert.equal(observations[0].effects[0].fields.title.after.value, "Original");
  assert.equal((await engine.table("tasks").row("task-1")).title, "Original");

  await engine.disconnect();
});

test("observeChanges exposes remote observations through the public engine", async () => {
  const adapter = new MemoryAdapter();
  const config = (deviceId) => ({
    deviceId,
    remotePath: "/observed-mesh",
    keySource: null,
    localStore: new MemoryLocalStore(),
    batchWindowMs: 0,
    autoCompact: false,
  });
  const writer = new Interocitor(adapter, config("device_writer"));
  const reader = new Interocitor(adapter, config("device_reader"));
  await writer.connect();
  await reader.connect();

  const observations = [];
  reader.observeChanges((observation) => observations.push(observation));
  await writer.put("tasks", "task-remote", { title: "From writer" });
  await writer.flush();
  await reader.pull();

  assert.equal(observations.length, 1);
  assert.equal(observations[0].source, "remote");
  assert.equal(observations[0].change.device, "device_writer");
  assert.match(observations[0].fileName, /-chg_/);
  assert.equal(observations[0].effects[0].fields.title.after.value, "From writer");

  await writer.disconnect();
  await reader.disconnect();
});
