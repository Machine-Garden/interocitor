import { expect, test } from "@playwright/test";
import type { Interocitor } from "@interocitor/core";

import { useImage } from "../../dist/index.js";
import { deferred, renderHook, runInAct, waitFor } from "./helpers.js";

type Schema = Record<string, never>;

function imageDatabase(
  read: (path: string) => Promise<Uint8Array> = async () => new Uint8Array([1, 2, 3]),
): Interocitor<Schema> {
  // `getImage` opens the stored object once and reads the metadata from it,
  // so the stub answers through `openFile` the way the engine does.
  return {
    openFile: async (path: string) => ({
      metadata: {
        name: path.split("/").pop() ?? path,
        path,
        size: 3,
        storedSize: 3,
        modifiedTime: new Date(0).toISOString(),
        contentType: "image/webp",
        uploadedByDeviceId: "image-writer",
      },
      open: () => read(path),
    }),
  } as unknown as Interocitor<Schema>;
}

function replaceBlobUrlMethods(): {
  created: Blob[];
  revoked: string[];
  restore(): void;
} {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const created: Blob[] = [];
  const revoked: string[] = [];
  URL.createObjectURL = (blob: Blob) => {
    created.push(blob);
    return `blob:react-test-${created.length}`;
  };
  URL.revokeObjectURL = (url: string) => {
    revoked.push(url);
  };
  return {
    created,
    revoked,
    restore() {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    },
  };
}

test("useImage skips empty paths without reading remote files", async () => {
  let reads = 0;
  const database = imageDatabase(async () => {
    reads += 1;
    return new Uint8Array();
  });
  const harness = await renderHook(() => useImage(database, null));

  expect(harness.result()).toMatchObject({
    url: null,
    blob: null,
    loading: false,
    error: null,
    metadata: null,
    contentType: null,
  });
  expect(reads).toBe(0);

  await harness.unmount();
});

test("useImage loads bytes, metadata, and exposes an idempotent revoke", async () => {
  const urls = replaceBlobUrlMethods();
  const database = imageDatabase();
  const harness = await renderHook(() => useImage(database, "avatars/me.webp"));

  try {
    await waitFor(() => expect(harness.result().url).toBe("blob:react-test-1"));
    expect(harness.result().contentType).toBe("image/webp");
    expect(harness.result().blob?.type).toBe("image/webp");
    expect(harness.result().metadata?.uploadedByDeviceId).toBe("image-writer");
    expect(urls.created).toHaveLength(1);

    await runInAct(() => harness.result().revoke());
    expect(harness.result().url).toBeNull();
    expect(urls.revoked).toEqual(["blob:react-test-1"]);
    await runInAct(() => harness.result().revoke());
    expect(urls.revoked).toEqual(["blob:react-test-1"]);
  } finally {
    await harness.unmount();
    urls.restore();
  }
});

test("useImage revokes the previous URL on path changes and unmount", async () => {
  const urls = replaceBlobUrlMethods();
  const database = imageDatabase();
  let path = "avatars/first.webp";
  const harness = await renderHook(() => useImage(database, path));

  try {
    await waitFor(() => expect(harness.result().url).toBe("blob:react-test-1"));
    path = "avatars/second.webp";
    await harness.rerender();
    await waitFor(() => expect(harness.result().url).toBe("blob:react-test-2"));
    expect(urls.revoked).toEqual(["blob:react-test-1"]);

    await harness.unmount();
    expect(urls.revoked).toEqual(["blob:react-test-1", "blob:react-test-2"]);
  } finally {
    urls.restore();
  }
});

test("useImage normalizes read failures", async () => {
  const database = imageDatabase(() => Promise.reject("image unavailable"));
  const harness = await renderHook(() => useImage(database, "avatars/missing.webp"));

  await waitFor(() => {
    expect(harness.result().loading).toBe(false);
    expect(harness.result().error).toBeInstanceOf(Error);
    expect(harness.result().error?.message).toBe("image unavailable");
  });

  await harness.unmount();
});

test("useImage revokes a URL created after the component unmounts", async () => {
  const urls = replaceBlobUrlMethods();
  const bytes = deferred<Uint8Array>();
  const database = imageDatabase(() => bytes.promise);
  const harness = await renderHook(() => useImage(database, "avatars/slow.webp"));

  try {
    expect(harness.result().loading).toBe(true);
    await harness.unmount();
    await runInAct(async () => {
      bytes.resolve(new Uint8Array([4, 5, 6]));
      await bytes.promise;
      await Promise.resolve();
    });
    await waitFor(() => expect(urls.revoked).toEqual(["blob:react-test-1"]));
  } finally {
    urls.restore();
  }
});
