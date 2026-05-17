import { createContext, useContext } from 'react';
import type { Interocitor } from '@interocitor/core';

/**
 * Create a typed provider + hook pair for your database.
 * Call once at app level — types are captured, no generics needed downstream.
 *
 * @example
 * // db.ts
 * const [MealDbProvider, useMealDb] = createInterocitorContext<DB>();
 * export { MealDbProvider, useMealDb };
 *
 * // bootstrap.ts
 * const db = new Interocitor<DB>({ appName: 'Meal Planner', dbName: 'meal' });
 * db.configureMesh({ remotePath: '/MealPlanner', passphrase, encrypted: true });
 * await db.setRemoteStorage(adapter);
 * await db.init();
 * await db.connect(); // starts remote sync; may return offline-ready
 *
 * // App.tsx
 * <MealDbProvider value={db}><App /></MealDbProvider>
 *
 * // Component.tsx
 * const db = useMealDb();
 * const plans = await db.table('weekPlans').query(); // fully typed
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
