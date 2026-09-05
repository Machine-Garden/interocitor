import test from "node:test";
import assert from "node:assert/strict";

import {
  Interocitor,
  MemoryLocalStore,
  RemoteAccessError,
  isRemoteAccessError,
} from "../dist/index.js";
import { CloudflareAdapter } from "../dist/adapters/cloudflare.js";
import { MemoryAdapter } from "../dist/adapters/memory.js";
import { httpFailure, remoteAccessError, retryAfterMs } from "../dist/adapters/http-status.js";

function response(status, headers = {}) {
  return new Response(status === 204 ? null : "{}", { status, headers });
}

test("RemoteAccessError classifies the access statuses and nothing else", () => {
  assert.equal(RemoteAccessError.kindForStatus(401), "unauthenticated");
  assert.equal(RemoteAccessError.kindForStatus(403), "forbidden");
  assert.equal(RemoteAccessError.kindForStatus(404), null);
  assert.equal(RemoteAccessError.kindForStatus(404, true), "not-found");
  assert.equal(RemoteAccessError.kindForStatus(429), "rate-limited");
  assert.equal(RemoteAccessError.kindForStatus(503), "policy-unavailable");
  assert.equal(RemoteAccessError.kindForStatus(500), null);
  assert.equal(RemoteAccessError.kindForStatus(200), null);

  const denied = new RemoteAccessError({
    status: 403,
    adapter: "cloudflare",
    operation: "listFiles",
  });
  assert.equal(denied.kind, "forbidden");
  assert.equal(denied.denied, true);
  assert.equal(denied.code, "REMOTE_ACCESS");
  assert.match(denied.message, /HTTP 403 \(forbidden\)/);
  assert.ok(isRemoteAccessError(denied));
  assert.ok(isRemoteAccessError({ code: "REMOTE_ACCESS", status: 401 }));
  assert.equal(isRemoteAccessError(new Error("HTTP 403")), false);

  const limited = new RemoteAccessError({ status: 429, adapter: "webdav", operation: "writeFile" });
  assert.equal(limited.denied, false);
});

test("httpFailure keeps access statuses typed and leaves other failures plain", () => {
  const ctx = { adapter: "cloudflare", operation: "listFiles", path: "/mesh/changes" };
  const unauthenticated = httpFailure(response(401), ctx, "Failed to list");
  assert.ok(isRemoteAccessError(unauthenticated));
  assert.equal(unauthenticated.kind, "unauthenticated");
  assert.equal(unauthenticated.path, "/mesh/changes");

  const server = httpFailure(response(500), ctx, "Failed to list");
  assert.equal(isRemoteAccessError(server), false);
  assert.equal(server.message, "Failed to list: HTTP 500");

  assert.equal(remoteAccessError(response(404), ctx), null);
  assert.equal(
    remoteAccessError(response(404), { ...ctx, notFoundIsAccess: true })?.kind,
    "not-found",
  );

  const limited = remoteAccessError(response(429, { "Retry-After": "7" }), ctx);
  assert.equal(limited.retryAfterMs, 7000);
  assert.equal(retryAfterMs(response(429)), undefined);
  const at = new Date(Date.now() + 30_000).toUTCString();
  const fromDate = retryAfterMs(response(503, { "Retry-After": at }));
  assert.ok(fromDate > 20_000 && fromDate <= 31_000, `retry-after date parsed: ${fromDate}`);
});

class GatedAdapter extends MemoryAdapter {
  /** Set to a status to have every listing rejected with that status. */
  rejectWith = null;
  retryAfterMs = undefined;
  listCalls = 0;

  async listFiles(folderPath) {
    this.listCalls++;
    if (this.rejectWith !== null) {
      throw new RemoteAccessError({
        status: this.rejectWith,
        adapter: this.name,
        operation: "listFiles",
        path: folderPath,
        retryAfterMs: this.retryAfterMs,
      });
    }
    return super.listFiles(folderPath);
  }
}

async function connectedEngine(adapter) {
  const db = new Interocitor({
    keySource: null,
    localStore: new MemoryLocalStore(),
    remotePath: "/mesh",
    pollInterval: 20,
  });
  const events = [];
  db.on((event) => {
    if (event.type.startsWith("remote:access") || event.type === "connection:status")
      events.push(event);
  });
  await db.setRemoteStorage(adapter);
  await db.connect();
  assert.equal(db.getConnectionStatusDetails().connected, true);
  assert.equal(db.getRemoteAccessError(), null);
  return { db, events };
}

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

test("a 403 pauses the remote session, stops polling, and connect() resumes it", async () => {
  const adapter = new GatedAdapter();
  const { db, events } = await connectedEngine(adapter);
  try {
    adapter.rejectWith = 403;
    await assert.rejects(db.pull(), (err) => isRemoteAccessError(err) && err.kind === "forbidden");

    const access = events.find((e) => e.type === "remote:access");
    assert.ok(access, "remote:access emitted");
    assert.equal(access.kind, "forbidden");
    assert.equal(access.status, 403);
    assert.equal(access.stage, "pull");
    assert.equal(access.paused, true);
    assert.equal(access.adapter, adapter.name);

    const details = db.getConnectionStatusDetails();
    assert.equal(details.connected, false);
    assert.equal(details.status, "offline");
    assert.equal(details.remoteAccess?.kind, "forbidden");
    assert.equal(db.getRemoteAccessError()?.status, 403);

    // No blind retry: polling has stopped and the denied listing is not repeated.
    const callsAfterDenial = adapter.listCalls;
    await sleep(120);
    assert.equal(adapter.listCalls, callsAfterDenial, "polling stopped after denial");

    // Local work keeps going while paused.
    await db.table("tasks").put("t1", { title: "offline edit" });
    assert.equal(db.getRemoteAccessError()?.status, 403, "local writes do not clear the pause");

    // The application reacted (access restored on the provider side) and reconnects.
    adapter.rejectWith = null;
    await db.connect();
    const restored = events.find((e) => e.type === "remote:access:restored");
    assert.ok(restored, "remote:access:restored emitted");
    assert.equal(restored.previous.status, 403);
    assert.equal(db.getRemoteAccessError(), null);
    assert.equal(db.getConnectionStatusDetails().connected, true);
    assert.equal(db.getConnectionStatusDetails().remoteAccess, null);
  } finally {
    await db.disconnect();
  }
});

test("a 429 is reported without pausing and backs polling off", async () => {
  const adapter = new GatedAdapter();
  const { db, events } = await connectedEngine(adapter);
  try {
    adapter.rejectWith = 429;
    adapter.retryAfterMs = 5000;
    await assert.rejects(
      db.pull(),
      (err) => isRemoteAccessError(err) && err.kind === "rate-limited",
    );

    const access = events.find((e) => e.type === "remote:access");
    assert.equal(access.kind, "rate-limited");
    assert.equal(access.paused, false);
    assert.equal(db.getRemoteAccessError(), null, "temporary conditions never pause");
    assert.equal(db.getConnectionStatusDetails().connected, true);
    assert.equal(db.getConnectionStatusDetails().remoteAccess, null);
  } finally {
    await db.disconnect();
  }
});

test("disconnect() clears a pause", async () => {
  const adapter = new GatedAdapter();
  const { db } = await connectedEngine(adapter);
  adapter.rejectWith = 401;
  await assert.rejects(db.pull(), (err) => err.kind === "unauthenticated");
  assert.equal(db.getRemoteAccessError()?.kind, "unauthenticated");
  await db.disconnect();
  assert.equal(db.getRemoteAccessError(), null);
});

test("CloudflareAdapter surfaces 401/403 with status intact and keeps 404 metadata benign", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  let nextStatus = 200;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers ?? {} });
    return response(nextStatus);
  };
  try {
    const adapter = new CloudflareAdapter({
      baseUrl: "https://worker.example/io/alias-1",
      token: "old-token",
      relayEnabled: false,
    });

    nextStatus = 401;
    await assert.rejects(adapter.listFiles("/mesh/changes"), (err) => {
      assert.ok(isRemoteAccessError(err));
      assert.equal(err.kind, "unauthenticated");
      assert.equal(err.status, 401);
      assert.equal(err.adapter, adapter.name);
      assert.equal(err.operation, "listFiles");
      return true;
    });
    await assert.rejects(adapter.authenticate(), (err) => err.kind === "unauthenticated");
    assert.equal(adapter.isAuthenticated(), false);

    nextStatus = 403;
    await assert.rejects(
      adapter.getFileMetadata("/mesh/changes/a.json"),
      (err) => err.kind === "forbidden",
    );
    await assert.rejects(
      adapter.writeFile("/mesh/changes/a.json", new Uint8Array(1)),
      (err) => err.kind === "forbidden",
    );

    // A concealed mesh reads as not-found at mesh level, but a missing file is just null.
    nextStatus = 404;
    await assert.rejects(adapter.listFiles("/mesh/changes"), (err) => err.kind === "not-found");
    assert.equal(await adapter.getFileMetadata("/mesh/changes/missing.json"), null);

    // Non-access failures stay ordinary errors.
    nextStatus = 500;
    await assert.rejects(
      adapter.listFiles("/mesh/changes"),
      (err) => !isRemoteAccessError(err) && /HTTP 500/.test(err.message),
    );

    // The application re-authenticated and hands over a new token.
    nextStatus = 200;
    adapter.setToken("new-token");
    await adapter.authenticate();
    assert.equal(adapter.isAuthenticated(), true);
    const last = calls.at(-1);
    assert.equal(last.headers.Authorization ?? last.headers.authorization, "Bearer new-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
