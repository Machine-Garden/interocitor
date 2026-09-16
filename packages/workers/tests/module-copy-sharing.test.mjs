// The mesh-info source registry must be shared between two copies of
// @interocitor/workers.
//
// Registration and lookup sit on opposite sides of the library boundary: the
// runtime attaches a source, then the application's own `authorizeFileUpload`
// calls `meshInfo()`. A worker bundle that resolves those two imports to
// different copies of this package — duplicated install, isolated layout, one
// module emitted into two chunks — used to leave every policy throwing on a
// request the runtime had registered correctly.
//
// Importing one built module under two specifiers gives two module instances
// whose own relative imports still resolve to the single shared graph, which is
// exactly the shape of a duplicated package.

import assert from "node:assert/strict";
import test from "node:test";

const MESH_INFO = new URL("../dist/mesh-info.js", import.meta.url);

const SEEDED = {
  createdAt: 1_700_000_000_000,
  ageMs: 5_000,
  deviceCount: 3,
  storedFileCount: 2,
  storedBytes: 4096,
};

test("a mesh-info source attached by one copy is readable through the other", async () => {
  const [copyA, copyB] = await Promise.all([
    import(`${MESH_INFO}?copy=a`),
    import(`${MESH_INFO}?copy=b`),
  ]);

  const request = { canonicalAddress: "mesh_cross_copy" };
  copyA.provideMeshInfo(request, SEEDED);

  assert.deepEqual(await copyB.meshInfo(request), SEEDED);
  assert.deepEqual(await copyA.meshInfo(request), SEEDED);
});

test("an unregistered request still refuses through either copy", async () => {
  const [copyA, copyB] = await Promise.all([
    import(`${MESH_INFO}?copy=a`),
    import(`${MESH_INFO}?copy=b`),
  ]);

  const stranger = { canonicalAddress: "mesh_never_registered" };
  await assert.rejects(async () => copyA.meshInfo(stranger), TypeError);
  await assert.rejects(async () => copyB.meshInfo(stranger), TypeError);
});
