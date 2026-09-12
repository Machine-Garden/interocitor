import assert from "node:assert/strict";
import test from "node:test";
import { provideMeshInfo, standardUploadPolicy } from "../dist/index.js";

/** Build an upload request with mesh facts already seeded. */
function uploadRequest({ size = 100, replacedBytes = 0, ...info } = {}) {
  const request = {
    address: "mesh",
    presentedAddress: "mesh",
    canonicalAddress: "mesh",
    path: "/photo.jpg",
    uploadedByDeviceId: "dev-a",
    size,
    sealed: false,
    overwritesSealed: false,
    replacedBytes,
    currentMeshStoredBytes: info.storedBytes ?? 0,
    maxMeshStoredBytes: 4096,
    request: new Request("https://example.test/"),
  };
  provideMeshInfo(request, {
    createdAt: 0,
    ageMs: 10 * 60_000,
    deviceCount: 2,
    storedFileCount: 0,
    storedBytes: 0,
    ...info,
  });
  return request;
}

test("the default policy admits an established mesh with somewhere to share", async () => {
  const policy = standardUploadPolicy();
  assert.equal(await policy(uploadRequest()), true);
});

test("the default policy rejects a mesh younger than a minute", async () => {
  const policy = standardUploadPolicy();
  const verdict = await policy(uploadRequest({ ageMs: 30_000 }));
  assert.deepEqual(verdict, {
    allowed: false,
    status: 429,
    reason: "Mesh is too new for uploads",
  });
  assert.equal(await policy(uploadRequest({ ageMs: 60_000 })), true, "the boundary admits");
});

test("the default policy rejects a mesh that has told nobody about itself", async () => {
  const policy = standardUploadPolicy();
  const verdict = await policy(uploadRequest({ deviceCount: 1 }));
  assert.equal(verdict.status, 403);
  assert.match(verdict.reason, /other device/);
});

test("an undetermined mesh age reads as too new, unless the application says otherwise", async () => {
  const strict = standardUploadPolicy();
  assert.equal((await strict(uploadRequest({ ageMs: null, createdAt: null }))).status, 429);

  const lenient = standardUploadPolicy({ onUnknownMeshAge: "allow" });
  assert.equal(await lenient(uploadRequest({ ageMs: null, createdAt: null })), true);
});

test("zero disables a check without disabling the rest", async () => {
  const ageless = standardUploadPolicy({ minMeshAgeMs: 0 });
  assert.equal(await ageless(uploadRequest({ ageMs: 1, createdAt: null })), true);
  assert.equal(
    (await ageless(uploadRequest({ ageMs: 1, deviceCount: 1 }))).status,
    403,
    "the device check still applies",
  );

  const solo = standardUploadPolicy({ minDeviceCount: 0 });
  assert.equal(await solo(uploadRequest({ deviceCount: 0 })), true);
});

test("a tier ceiling credits the bytes an overwrite frees", async () => {
  const policy = standardUploadPolicy({
    minMeshAgeMs: 0,
    minDeviceCount: 0,
    maxMeshStoredBytes: 1000,
  });

  assert.equal(
    (await policy(uploadRequest({ storedBytes: 950, size: 100 }))).status,
    413,
    "a new file that would exceed the ceiling is refused",
  );
  assert.equal(
    await policy(uploadRequest({ storedBytes: 950, size: 100, replacedBytes: 100 })),
    true,
    "re-saving a file of the same size is not charged twice",
  );
  assert.equal(
    (await policy(uploadRequest({ storedBytes: 950, size: 200, replacedBytes: 100 }))).status,
    413,
    "only the bytes actually freed are credited",
  );
});

test("a single-upload ceiling is checked without reading mesh facts", async () => {
  const policy = standardUploadPolicy({
    minMeshAgeMs: 0,
    minDeviceCount: 0,
    maxStoredFileBytes: 50,
  });
  const unseeded = {
    address: "mesh",
    presentedAddress: "mesh",
    canonicalAddress: "mesh",
    path: "/big.bin",
    uploadedByDeviceId: "dev-a",
    size: 100,
    sealed: false,
    overwritesSealed: false,
    replacedBytes: 0,
    currentMeshStoredBytes: 0,
    maxMeshStoredBytes: 4096,
    request: new Request("https://example.test/"),
  };
  assert.equal((await policy(unseeded)).status, 413, "no meshInfo call was needed");
});

test("an application policy composes the standard one rather than forking it", async () => {
  const standard = standardUploadPolicy();
  const policy = async (request) => {
    if (request.request.headers.get("X-Plan") === "premium") return true;
    return standard(request);
  };

  const free = uploadRequest({ ageMs: 1_000 });
  assert.equal((await policy(free)).status, 429);

  const premium = uploadRequest({ ageMs: 1_000 });
  premium.request = new Request("https://example.test/", { headers: { "X-Plan": "premium" } });
  assert.equal(await policy(premium), true);
});
