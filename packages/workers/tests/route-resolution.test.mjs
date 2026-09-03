import assert from "node:assert/strict";
import test from "node:test";

import {
  attenuateMeshGrant,
  createInterocitorMount,
  createInterocitorSystemHandler,
  createMeshGrantAuthorizationMiddleware,
  markMeshGrantRevoked,
} from "../dist/index.js";

const unusedDb = {
  prepare() {
    throw new Error("unexpected database access");
  },
  async batch() {
    throw new Error("unexpected database access");
  },
};

function createCtx() {
  return { waitUntil() {} };
}

function denyMeshMiddleware() {
  return new Response("denied", { status: 403 });
}

function acceptMeshIntegrity() {
  return true;
}

function rejectMeshIntegrity() {
  return false;
}

test("an optional mesh route resolver preserves presented and canonical identities", async () => {
  const seen = {};
  const mount = createInterocitorMount({
    db: () => unusedDb,
    files: (_env, context) => {
      seen.files = context;
    },
    runtime: {
      resolveMeshRoute(context) {
        seen.resolver = {
          presentedAddress: context.presentedAddress,
          surface: context.surface,
          access: context.access,
        };
        return context.presentedAddress === "public-handle"
          ? { canonicalAddress: "canonical-mesh" }
          : null;
      },
      meshIntegrityGates: [
        (context) => {
          seen.integrity = {
            address: context.address,
            presentedAddress: context.presentedAddress,
            canonicalAddress: context.canonicalAddress,
          };
          return context.address === "canonical-mesh";
        },
      ],
      meshMiddleware: [
        async (context, _env, next) => {
          seen.middleware = {
            address: context.address,
            presentedAddress: context.presentedAddress,
            canonicalAddress: context.canonicalAddress,
          };
          return next();
        },
      ],
    },
  });

  const response = await mount.fetch(
    new Request("https://example.test/io/public-handle/health"),
    {},
    createCtx(),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(seen.resolver, {
    presentedAddress: "public-handle",
    surface: "io",
    access: "read",
  });
  assert.deepEqual(seen.integrity, {
    address: "canonical-mesh",
    presentedAddress: "public-handle",
    canonicalAddress: "canonical-mesh",
  });
  assert.deepEqual(seen.middleware, seen.integrity);
  assert.deepEqual(seen.files, seen.integrity);
});

test("a configured resolver is authoritative and never falls back to a canonical address", async () => {
  const routes = new Map([["public-handle", "canonical-mesh"]]);
  let integrityCalls = 0;
  let middlewareCalls = 0;
  let databaseCalls = 0;
  const mount = createInterocitorMount({
    db: () => {
      databaseCalls += 1;
      return unusedDb;
    },
    runtime: {
      resolveMeshRoute: ({ presentedAddress }) => {
        const canonicalAddress = routes.get(presentedAddress);
        return canonicalAddress ? { canonicalAddress } : null;
      },
      meshIntegrityGates: [
        ({ canonicalAddress }) => {
          integrityCalls += 1;
          return canonicalAddress === "canonical-mesh";
        },
      ],
      meshMiddleware: [
        async (_context, _env, next) => {
          middlewareCalls += 1;
          return next();
        },
      ],
    },
  });

  assert.equal(
    (
      await mount.fetch(
        new Request("https://example.test/io/public-handle/health"),
        {},
        createCtx(),
      )
    ).status,
    200,
  );
  assert.equal(integrityCalls, 1);
  assert.equal(middlewareCalls, 1);
  assert.equal(databaseCalls, 1);

  assert.equal(
    (
      await mount.fetch(
        new Request("https://example.test/io/canonical-mesh/health"),
        {},
        createCtx(),
      )
    ).status,
    404,
  );
  assert.equal(integrityCalls, 1, "direct canonical address must stop before integrity");
  assert.equal(middlewareCalls, 1, "direct canonical address must stop before middleware");
  assert.equal(databaseCalls, 1, "direct canonical address must stop before storage");

  routes.delete("public-handle");
  assert.equal(
    (
      await mount.fetch(
        new Request("https://example.test/io/public-handle/health"),
        {},
        createCtx(),
      )
    ).status,
    404,
  );
});

test("per-subject routes and grants revoke one member without moving the shared mesh", async () => {
  const root = {
    grantId: "policy-root",
    parentGrantId: null,
    canonicalAddress: "canonical-mesh",
    issuerSubjectId: "policy",
    subjectId: "owner",
    authorization: "full",
    delegationDepth: 2,
    issuedAt: 1,
  };
  const alice = attenuateMeshGrant(root, {
    grantId: "alice-grant",
    subjectId: "alice",
    authorization: "full",
    delegationDepth: 1,
    issuedAt: 2,
  });
  let jake = attenuateMeshGrant(root, {
    grantId: "jake-grant",
    subjectId: "jake",
    authorization: "full",
    delegationDepth: 1,
    issuedAt: 2,
  });
  const routes = new Map([
    ["alice-route", "canonical-mesh"],
    ["jake-route", "canonical-mesh"],
  ]);
  let grantLoads = 0;
  const grantMiddleware = createMeshGrantAuthorizationMiddleware({
    authenticate: ({ request }) => {
      const subjectId = request.headers.get("Authorization")?.replace("Bearer ", "");
      return subjectId ? { subjectId } : null;
    },
    loadGrantChain: (subjectId) => {
      grantLoads += 1;
      if (subjectId === "alice") return [root, alice];
      if (subjectId === "jake") return [root, jake];
      return null;
    },
    isTrustedRoot: (grant) => grant.grantId === root.grantId,
    now: () => 10,
  });
  const mount = createInterocitorMount({
    db: () => unusedDb,
    runtime: {
      resolveMeshRoute: ({ presentedAddress }) => {
        const canonicalAddress = routes.get(presentedAddress);
        return canonicalAddress ? { canonicalAddress } : null;
      },
      meshIntegrityGates: [({ canonicalAddress }) => canonicalAddress === "canonical-mesh"],
      meshMiddleware: [grantMiddleware],
    },
  });
  const request = (route, subjectId) =>
    mount.fetch(
      new Request(`https://example.test/io/${route}/health`, {
        headers: { Authorization: `Bearer ${subjectId}` },
      }),
      {},
      createCtx(),
    );

  assert.equal((await request("alice-route", "alice")).status, 200);
  assert.equal((await request("jake-route", "jake")).status, 200);

  jake = markMeshGrantRevoked(jake, 10);
  assert.equal((await request("jake-route", "jake")).status, 404);
  assert.equal((await request("alice-route", "alice")).status, 200);

  routes.delete("jake-route");
  const loadsBeforeRemovedRoute = grantLoads;
  assert.equal((await request("jake-route", "jake")).status, 404);
  assert.equal(grantLoads, loadsBeforeRemovedRoute, "an unmapped route must stop before grants");
  assert.equal((await request("canonical-mesh", "alice")).status, 404);
});

test("route resolution is one hop and resolver failures fail closed", async () => {
  let calls = 0;
  const oneHop = createInterocitorMount({
    db: () => unusedDb,
    runtime: {
      resolveMeshRoute() {
        calls += 1;
        return { canonicalAddress: "another-handle" };
      },
      meshIntegrityGates: [({ canonicalAddress }) => canonicalAddress === "canonical-mesh"],
    },
  });
  assert.equal(
    (
      await oneHop.fetch(
        new Request("https://example.test/io/public-handle/health"),
        {},
        createCtx(),
      )
    ).status,
    404,
  );
  assert.equal(calls, 1);

  for (const resolveMeshRoute of [
    () => ({ canonicalAddress: "" }),
    () => ({ canonicalAddress: "   " }),
    () => Object.assign([], { canonicalAddress: "canonical-mesh" }),
    () => {
      throw new Error("route store unavailable");
    },
  ]) {
    const mount = createInterocitorMount({
      db: () => unusedDb,
      runtime: {
        resolveMeshRoute,
        meshIntegrityGates: [() => true],
      },
    });
    const response = await mount.fetch(
      new Request("https://example.test/io/public-handle/health"),
      {},
      createCtx(),
    );
    assert.equal(response.status, 503);
  }

  for (const resolveMeshRoute of [null, false, 0, ""]) {
    const mount = createInterocitorMount({
      db: () => unusedDb,
      runtime: {
        resolveMeshRoute,
        meshIntegrityGates: [({ canonicalAddress }) => canonicalAddress === "public-handle"],
      },
    });
    const response = await mount.fetch(
      new Request("https://example.test/io/public-handle/health"),
      {},
      createCtx(),
    );
    assert.equal(response.status, 503);
  }
});

test("mesh integrity gates require literal boolean decisions", async () => {
  for (const invalidDecision of ["false", 1, null, undefined]) {
    const mount = createInterocitorMount({
      db: () => unusedDb,
      runtime: { meshIntegrityGates: [() => invalidDecision] },
    });
    const response = await mount.fetch(
      new Request("https://example.test/io/arbitrary/health"),
      {},
      createCtx(),
    );
    assert.equal(response.status, 503);
  }

  for (const meshIntegrityGates of [null, false, {}, [null, acceptMeshIntegrity]]) {
    const mount = createInterocitorMount({
      db: () => unusedDb,
      runtime: { meshIntegrityGates },
    });
    const response = await mount.fetch(
      new Request("https://example.test/io/arbitrary/health"),
      {},
      createCtx(),
    );
    assert.equal(response.status, 503);
  }

  const deceptiveGates = [rejectMeshIntegrity];
  deceptiveGates[Symbol.iterator] = function* () {
    yield acceptMeshIntegrity;
  };
  const mount = createInterocitorMount({
    db: () => unusedDb,
    runtime: { meshIntegrityGates: deceptiveGates },
  });
  const response = await mount.fetch(
    new Request("https://example.test/io/arbitrary/health"),
    {},
    createCtx(),
  );
  assert.equal(response.status, 404);
});

test("route resolution snapshots the canonical address exactly once", async () => {
  let reads = 0;
  let admittedAddress = null;
  const mount = createInterocitorMount({
    db: () => unusedDb,
    runtime: {
      resolveMeshRoute: () => ({
        get canonicalAddress() {
          reads += 1;
          return reads <= 2 ? "canonical-mesh" : "";
        },
      }),
      meshIntegrityGates: [
        ({ canonicalAddress }) => {
          admittedAddress = canonicalAddress;
          return true;
        },
      ],
    },
  });

  const response = await mount.fetch(
    new Request("https://example.test/io/public-handle/health"),
    {},
    createCtx(),
  );
  assert.equal(response.status, 200);
  assert.equal(reads, 1);
  assert.equal(admittedAddress, "canonical-mesh");
});

test("malformed mesh middleware configuration cannot bypass the chain", async () => {
  for (const meshMiddleware of [
    null,
    false,
    {},
    [undefined, denyMeshMiddleware],
    [() => "not a response"],
  ]) {
    const mount = createInterocitorMount({
      db: () => unusedDb,
      runtime: {
        meshIntegrityGates: [() => true],
        meshMiddleware,
      },
    });
    const response = await mount.fetch(
      new Request("https://example.test/io/main/health"),
      {},
      createCtx(),
    );
    assert.equal(response.status, 503);
  }
});

test("mesh middleware snapshots array entries instead of trusting a custom iterator", async () => {
  const meshMiddleware = [() => new Response("denied", { status: 403 })];
  meshMiddleware[Symbol.iterator] = function* () {};
  const mount = createInterocitorMount({
    db: () => unusedDb,
    runtime: {
      meshIntegrityGates: [() => true],
      meshMiddleware,
    },
  });

  const response = await mount.fetch(
    new Request("https://example.test/io/main/health"),
    {},
    createCtx(),
  );
  assert.equal(response.status, 403);
});

test("notify aliases and IO writes converge on the canonical relay object", async () => {
  const objectNames = [];
  const relay = {
    idFromName(name) {
      objectNames.push(name);
      return { name };
    },
    get() {
      return {
        async fetch(request) {
          assert.equal(new URL(request.url).pathname, "/__status");
          return Response.json({ ok: true });
        },
      };
    },
  };
  const mount = createInterocitorMount({
    db: () => unusedDb,
    relay: () => relay,
    runtime: {
      resolveMeshRoute: ({ presentedAddress }) =>
        presentedAddress === "public-handle" ? { canonicalAddress: "canonical-mesh" } : null,
      meshIntegrityGates: [({ canonicalAddress }) => canonicalAddress === "canonical-mesh"],
    },
  });

  const response = await mount.fetch(
    new Request("https://example.test/notify/public-handle/health"),
    {},
    createCtx(),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(objectNames, ["canonical-mesh"]);
});

test("system operations remain canonical and do not invoke the public route resolver", async () => {
  let resolverCalls = 0;
  const system = createInterocitorSystemHandler({
    db: () => unusedDb,
    runtime: {
      resolveMeshRoute() {
        resolverCalls += 1;
        return null;
      },
      meshIntegrityGates: [
        ({ address, presentedAddress, canonicalAddress }) =>
          address === "canonical-mesh" &&
          presentedAddress === "canonical-mesh" &&
          canonicalAddress === "canonical-mesh",
      ],
    },
  });

  const response = await system.fetch(
    new Request("https://example.test/__interocitor/system/canonical-mesh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "run-maintenance" }),
    }),
    {},
    createCtx(),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ttlCandidates: 0, ttlDeleted: 0 });
  assert.equal(resolverCalls, 0);
});
