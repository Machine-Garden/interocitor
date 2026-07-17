import { createContext, useContext } from 'react';
import type { Interocitor } from '@interocitor/core';

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
 * const db = new Interocitor<DB>({ dbName: 'case-vault', localStore });
 * db.configureMesh({ remotePath: '/CaseVault', passphrase, encrypted: true });
 * await db.setRemoteStorage(adapter);
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
>(): [
  provider: React.Provider<Interocitor<S> | null>,
  hook: () => Interocitor<S>,
] {
  const ctx = createContext<Interocitor<S> | null>(null);

  function useDb(): Interocitor<S> {
    const db = useContext(ctx);
    if (!db) {
      throw new Error('Interocitor not provided. Build and initialize the engine first, then wrap your app with the provider. connect() can run before or after providing depending on your app bootstrap.');
    }
    return db;
  }

  return [ctx.Provider, useDb];
}
