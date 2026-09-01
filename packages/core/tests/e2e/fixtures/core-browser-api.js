// Explicit test-only constructor for intentionally unencrypted core browser
// integration tests. It calls the unchanged public Interocitor constructor
// with core's MemoryLocalStore and keySource: null.
export * from "/packages/core/dist/index.js";

import { Interocitor, MemoryLocalStore } from "/packages/core/dist/index.js";

function withCoreTestDependencies(config) {
  for (const legacyKey of ["encrypted", "passphrase", "localStoreFactory"]) {
    if (legacyKey in config) {
      throw new TypeError(
        `BrowserTestInterocitor is an unencrypted test helper and does not accept unsupported SyncConfig.${legacyKey}`,
      );
    }
  }
  if (config.keySource !== null && config.keySource !== undefined) {
    throw new TypeError(
      "BrowserTestInterocitor is only for intentionally unencrypted tests; use the public Interocitor constructor for encryption coverage",
    );
  }
  return {
    ...config,
    keySource: config.keySource ?? null,
    localStore: config.localStore ?? new MemoryLocalStore(),
  };
}

export class BrowserTestInterocitor extends Interocitor {
  constructor(adapterOrConfig, maybeConfig) {
    if (maybeConfig === undefined) {
      super(withCoreTestDependencies(adapterOrConfig));
      return;
    }
    super(adapterOrConfig, withCoreTestDependencies(maybeConfig));
  }
}
