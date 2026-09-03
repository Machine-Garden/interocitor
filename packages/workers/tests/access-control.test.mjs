import assert from "node:assert/strict";
import test from "node:test";

import {
  attenuateMeshGrant,
  createMeshGrantAuthorizationMiddleware,
  markMeshGrantRevoked,
} from "../dist/index.js";

const NOW = 2_000;

function rootGrant(overrides = {}) {
  return {
    grantId: "root",
    parentGrantId: null,
    canonicalAddress: "canonical-mesh",
    issuerSubjectId: "controller",
    subjectId: "owner",
    authorization: "full",
    delegationDepth: 3,
    issuedAt: 1_000,
    notBefore: 1_000,
    expiresAt: 10_000,
    ...overrides,
  };
}

function childGrant(parent = rootGrant(), overrides = {}) {
  return attenuateMeshGrant(parent, {
    grantId: "child",
    subjectId: "member",
    authorization: "readonly",
    delegationDepth: 1,
    issuedAt: 1_500,
    expiresAt: 9_000,
    ...overrides,
  });
}

function meshContext(access = "read") {
  return {
    address: "canonical-mesh",
    presentedAddress: "public-handle",
    canonicalAddress: "canonical-mesh",
    request: new Request("https://example.test/io/public-handle/health", {
      headers: { Authorization: "Bearer member" },
    }),
    surface: "io",
    access,
  };
}

async function runMiddleware(middleware, context = meshContext()) {
  let terminalCalls = 0;
  const response = await middleware(context, {}, async () => {
    terminalCalls += 1;
    return new Response(null, { status: 204 });
  });
  return { response, terminalCalls };
}

function grantMiddleware(getChain, overrides = {}) {
  return createMeshGrantAuthorizationMiddleware({
    authenticate: () => ({ subjectId: "member" }),
    loadGrantChain: () => getChain(),
    isTrustedRoot: (grant) => grant.grantId === "root",
    now: () => NOW,
    ...overrides,
  });
}

test("grant middleware allows reads, attenuates writes, and retains both route identities", async () => {
  const root = rootGrant();
  const child = childGrant(root);
  const seen = [];
  const middleware = createMeshGrantAuthorizationMiddleware({
    authenticate: (context) => {
      seen.push(["authenticate", context.presentedAddress, context.canonicalAddress]);
      return { subjectId: "member" };
    },
    loadGrantChain: (_subjectId, context) => {
      seen.push(["load", context.presentedAddress, context.canonicalAddress]);
      return [root, child];
    },
    isTrustedRoot: (_grant, context) => {
      seen.push(["root", context.presentedAddress, context.canonicalAddress]);
      return true;
    },
    now: () => NOW,
  });

  const read = await runMiddleware(middleware);
  assert.equal(read.response.status, 204);
  assert.equal(read.terminalCalls, 1);

  const write = await runMiddleware(middleware, meshContext("write"));
  assert.equal(write.response.status, 404);
  assert.equal(write.terminalCalls, 0);
  assert.deepEqual(seen, [
    ["authenticate", "public-handle", "canonical-mesh"],
    ["load", "public-handle", "canonical-mesh"],
    ["root", "public-handle", "canonical-mesh"],
    ["authenticate", "public-handle", "canonical-mesh"],
    ["load", "public-handle", "canonical-mesh"],
    ["root", "public-handle", "canonical-mesh"],
  ]);
});

test("current leaf or ancestor revocation is observed on the next request", async () => {
  let root = rootGrant();
  const child = childGrant(root);
  const middleware = grantMiddleware(() => [root, child]);

  assert.equal((await runMiddleware(middleware)).response.status, 204);
  root = markMeshGrantRevoked(root, NOW);
  const denied = await runMiddleware(middleware);
  assert.equal(denied.response.status, 404);
  assert.equal(denied.terminalCalls, 0);

  const leafRevoked = grantMiddleware(() => [rootGrant(), markMeshGrantRevoked(child, NOW)]);
  assert.equal((await runMiddleware(leafRevoked)).response.status, 404);
});

test("revoking one subject leaves a sibling grant active", async () => {
  const root = rootGrant();
  const alice = childGrant(root, { grantId: "alice-grant", subjectId: "alice" });
  let jake = childGrant(root, { grantId: "jake-grant", subjectId: "jake" });
  const middleware = createMeshGrantAuthorizationMiddleware({
    authenticate: ({ request }) => {
      const subjectId = request.headers.get("Authorization")?.replace("Bearer ", "");
      return subjectId ? { subjectId } : null;
    },
    loadGrantChain: (subjectId) => {
      if (subjectId === "alice") return [root, alice];
      if (subjectId === "jake") return [root, jake];
      return null;
    },
    isTrustedRoot: (grant) => grant.grantId === root.grantId,
    now: () => NOW,
  });
  const contextFor = (subjectId) => ({
    ...meshContext(),
    request: new Request("https://example.test/io/public-handle/health", {
      headers: { Authorization: `Bearer ${subjectId}` },
    }),
  });

  assert.equal((await runMiddleware(middleware, contextFor("alice"))).response.status, 204);
  assert.equal((await runMiddleware(middleware, contextFor("jake"))).response.status, 204);

  jake = markMeshGrantRevoked(jake, NOW);
  assert.equal((await runMiddleware(middleware, contextFor("jake"))).response.status, 404);
  assert.equal((await runMiddleware(middleware, contextFor("alice"))).response.status, 204);
});

test("missing, expired, and not-yet-valid grants are denied", async () => {
  assert.equal((await runMiddleware(grantMiddleware(() => null))).response.status, 404);

  const expiredRoot = rootGrant({ expiresAt: NOW });
  const expiredChild = childGrant(expiredRoot, { expiresAt: NOW });
  assert.equal(
    (await runMiddleware(grantMiddleware(() => [expiredRoot, expiredChild]))).response.status,
    404,
  );

  const futureRoot = rootGrant({ notBefore: NOW + 1 });
  const futureChild = childGrant(futureRoot, { expiresAt: 9_000 });
  assert.equal(
    (await runMiddleware(grantMiddleware(() => [futureRoot, futureChild]))).response.status,
    404,
  );

  const futureIssuedRoot = rootGrant({
    subjectId: "member",
    issuedAt: NOW + 1,
    notBefore: undefined,
  });
  assert.equal(
    (await runMiddleware(grantMiddleware(() => [futureIssuedRoot]))).response.status,
    404,
  );
});

test("grant-chain corruption and authorization service errors fail closed with 503", async () => {
  const root = rootGrant();
  const child = childGrant(root);
  const escalated = { ...child, authorization: "full" };
  const readonlyRoot = rootGrant({ authorization: "readonly" });
  assert.equal(
    (await runMiddleware(grantMiddleware(() => [readonlyRoot, escalated]))).response.status,
    503,
  );

  for (const corruptChild of [
    { ...child, canonicalAddress: "other-mesh" },
    { ...child, grantId: root.grantId },
    { ...child, parentGrantId: "detached" },
    { ...child, issuerSubjectId: "intruder" },
    { ...child, delegationDepth: root.delegationDepth },
    { ...child, expiresAt: undefined },
    { ...child, issuedAt: root.issuedAt - 1 },
  ]) {
    assert.equal(
      (await runMiddleware(grantMiddleware(() => [root, corruptChild]))).response.status,
      503,
    );
  }

  const missingIssuedAt = rootGrant({ issuedAt: undefined });
  assert.equal(
    (await runMiddleware(grantMiddleware(() => [missingIssuedAt]))).response.status,
    503,
  );

  assert.equal(
    (
      await runMiddleware(
        grantMiddleware(() => [root, child], {
          maxChainLength: 1,
        }),
      )
    ).response.status,
    503,
  );

  const unavailable = grantMiddleware(() => {
    throw new Error("grant store unavailable");
  });
  assert.equal((await runMiddleware(unavailable)).response.status, 503);
});

test("root trust and authenticated subject are mandatory", async () => {
  const root = rootGrant();
  const child = childGrant(root);
  const untrusted = grantMiddleware(() => [root, child], { isTrustedRoot: () => false });
  assert.equal((await runMiddleware(untrusted)).response.status, 404);

  const malformedTrust = grantMiddleware(() => [root, child], {
    isTrustedRoot: () => "false",
  });
  assert.equal((await runMiddleware(malformedTrust)).response.status, 503);

  const anonymous = grantMiddleware(() => [root, child], { authenticate: () => null });
  assert.equal((await runMiddleware(anonymous)).response.status, 404);

  const arrayPrincipal = Object.assign([], { subjectId: "member" });
  const malformedPrincipal = grantMiddleware(() => [root, child], {
    authenticate: () => arrayPrincipal,
  });
  const malformed = await runMiddleware(malformedPrincipal);
  assert.equal(malformed.response.status, 503);
  assert.equal(malformed.terminalCalls, 0);

  const wrongSubject = grantMiddleware(() => [root, child], {
    authenticate: () => ({ subjectId: "someone-else" }),
  });
  assert.equal((await runMiddleware(wrongSubject)).response.status, 503);
});

test("principal and grant callback records are snapshotted before policy evaluation", async () => {
  const root = rootGrant();
  const child = childGrant(root);
  let subjectReads = 0;
  const stablePrincipal = createMeshGrantAuthorizationMiddleware({
    authenticate: () => ({
      get subjectId() {
        subjectReads += 1;
        return subjectReads === 1 ? "member" : "intruder";
      },
    }),
    loadGrantChain: () => [root, child],
    isTrustedRoot: () => true,
    now: () => NOW,
  });
  assert.equal((await runMiddleware(stablePrincipal)).response.status, 204);
  assert.equal(subjectReads, 1);

  let authorizationReads = 0;
  const volatileGrant = {
    ...rootGrant({ subjectId: "member", delegationDepth: 0 }),
    get authorization() {
      authorizationReads += 1;
      return authorizationReads === 1 ? "readonly" : "full";
    },
  };
  const stableGrant = grantMiddleware(() => [volatileGrant], {
    isTrustedRoot: () => true,
  });
  const write = await runMiddleware(stableGrant, meshContext("write"));
  assert.equal(write.response.status, 404);
  assert.equal(write.terminalCalls, 0);
  assert.equal(authorizationReads, 1);

  const revokedRoot = markMeshGrantRevoked(root, NOW);
  const deceptiveChain = [revokedRoot, child];
  deceptiveChain[Symbol.iterator] = function* () {
    yield root;
    yield child;
  };
  const stableChain = grantMiddleware(() => deceptiveChain);
  assert.equal((await runMiddleware(stableChain)).response.status, 404);
});

test("attenuation helper rejects authority, duration, and delegation escalation", () => {
  const root = rootGrant();
  const child = childGrant(root);
  assert.deepEqual(child, {
    grantId: "child",
    parentGrantId: "root",
    canonicalAddress: "canonical-mesh",
    issuerSubjectId: "owner",
    subjectId: "member",
    authorization: "readonly",
    delegationDepth: 1,
    issuedAt: 1_500,
    notBefore: 1_000,
    expiresAt: 9_000,
  });
  assert.equal(Object.isFrozen(child), true);

  assert.throws(
    () => childGrant(rootGrant({ authorization: "readonly" }), { authorization: "full" }),
    /authorization exceeds/,
  );
  assert.throws(() => childGrant(root, { delegationDepth: 3 }), /delegation depth exceeds/);
  assert.throws(() => childGrant(root, { expiresAt: 10_001 }), /expires after/);
  assert.throws(() => childGrant(root, { notBefore: 999 }), /starts before/);
  assert.throws(() => childGrant(markMeshGrantRevoked(root, NOW)), /revoked grant/);
});

test("revocation helper is immutable and preserves the first revocation time", () => {
  const root = rootGrant();
  const revoked = markMeshGrantRevoked(root, 3_000);
  assert.equal(root.revokedAt, undefined);
  assert.equal(revoked.revokedAt, 3_000);
  assert.equal(markMeshGrantRevoked(revoked, 4_000).revokedAt, 3_000);
  assert.equal(Object.isFrozen(revoked), true);
});
