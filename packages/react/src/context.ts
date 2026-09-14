// compass: interocitor.mailbox-sync.sync-lifecycle

import { createContext, useContext } from "react";
import type { Interocitor, InterocitorReader } from "@interocitor/core";

export interface InterocitorContextOptions {
  mode?: "read-write" | "reader";
}

/**
 * Create a typed provider + hook pair for your database.
 * Call once at app level — types are captured, no generics needed downstream.
 *
 * @example
 * // db.ts
 * const [CaseVaultProvider, useCaseVault] = createInterocitorContext<DB>();
 * export { CaseVaultProvider, useCaseVault };
 *
 * // bootstrap.ts
 * const db = new Interocitor<DB>(adapter, {
 *   dbName: 'case-vault',
 *   remotePath: '/CaseVault',
 *   localStore,
 *   keySource,
 * });
 * await db.init();
 * await db.connect(); // starts remote sync; may return offline-ready
 *
 * // App.tsx
 * <CaseVaultProvider value={db}><App /></CaseVaultProvider>
 *
 * // Component.tsx
 * const db = useCaseVault();
 * const cases = await db.table('cases').query(); // fully typed
 */
export function createInterocitorContext<
  S extends Record<string, Record<string, unknown>>,
>(options: {
  mode: "reader";
}): [provider: React.Provider<InterocitorReader<S> | null>, hook: () => InterocitorReader<S>];
export function createInterocitorContext<
  S extends Record<string, Record<string, unknown>>,
>(options?: {
  mode?: "read-write";
}): [provider: React.Provider<Interocitor<S> | null>, hook: () => Interocitor<S>];
export function createInterocitorContext<S extends Record<string, Record<string, unknown>>>(
  _options: InterocitorContextOptions = {},
): [
  // Overloads above preserve the selected capability; this implementation
  // owns the one runtime context shared by both structurally distinct modes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  provider: React.Provider<any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  hook: () => any,
] {
  const ctx = createContext<Interocitor<S> | InterocitorReader<S> | null>(null);

  function useDb(): Interocitor<S> | InterocitorReader<S> {
    const db = useContext(ctx);
    if (!db) {
      throw new Error(
        "Interocitor not provided. Build and initialize the engine first, then wrap your app with the provider. connect() can run before or after providing depending on your app bootstrap.",
      );
    }
    return db;
  }

  return [ctx.Provider, useDb];
}
