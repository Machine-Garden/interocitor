import { test, expect } from '@playwright/test';

test.describe('ConnectedStores credential vault', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/packages/core/tests/e2e/fixtures/harness-plain.html');
    await page.evaluate(async () => {
      const dbs = await indexedDB.databases?.() ?? [];
      await Promise.all(dbs.map(d => d.name && new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase(d.name!);
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      })));
    });
  });

  test('parent stores, lists, updates, and removes sub-store credentials', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { Interocitor } = await import('/packages/core/dist/core/sync-engine.js');

      const parent = new Interocitor({
        appName: 'planner',
        dbName: 'planner-db',
        encrypted: false,
      });
      // Trigger init via a benign read.
      await parent.tableNames();

      // Vault must be empty initially.
      const initial = await parent.connectedStores.list();

      // Store credentials for two sub-stores.
      const reviews = await parent.connectedStores.put({
        id: 'reviews',
        alias: 'family-reviews',
        remotePath: '/family/reviews',
        passphrase: 'review-pass',
        encrypted: true,
        dbName: 'reviews-db',
        adapter: { kind: 'memory' },
        metadata: { icon: 'star' },
      });
      await parent.connectedStores.put({
        id: 'recipes',
        remotePath: '/family/recipes',
        passphrase: null,
        encrypted: false,
        dbName: 'recipes-db',
      });

      const listed = await parent.connectedStores.list();

      // Update via put (same id) bumps updatedAt and preserves createdAt.
      const updated = await parent.connectedStores.put({
        id: 'reviews',
        remotePath: '/family/reviews-v2',
        passphrase: 'review-pass-v2',
        encrypted: true,
        dbName: 'reviews-db',
      });

      // Sub-store credentials never appear in the parent's data model.
      const parentTables = await parent.tableNames();

      // Removing returns true on hit, false on miss.
      const removedHit = await parent.connectedStores.remove('recipes');
      const removedMiss = await parent.connectedStores.remove('nonexistent');
      const afterRemove = await parent.connectedStores.list();

      // Persistence across re-instantiation: a brand-new engine sees the
      // same vault contents because they live inside the parent LocalStore.
      const parent2 = new Interocitor({
        appName: 'planner',
        dbName: 'planner-db',
        encrypted: false,
      });
      const persisted = await parent2.connectedStores.list();

      return {
        initialCount: initial.length,
        addedId: reviews.id,
        listedIds: listed.map(c => c.id).toSorted(),
        updatedRemotePath: updated.remotePath,
        updatedHasCreatedAt: typeof updated.createdAt === 'string',
        updatedHasUpdatedAt: typeof updated.updatedAt === 'string',
        updatedKeepsCreatedAt: updated.createdAt === reviews.createdAt,
        parentTables,
        removedHit,
        removedMiss,
        afterRemoveIds: afterRemove.map(c => c.id),
        persistedIds: persisted.map(c => c.id),
      };
    });

    expect(result.initialCount).toBe(0);
    expect(result.addedId).toBe('reviews');
    expect(result.listedIds).toEqual(['recipes', 'reviews']);
    expect(result.updatedRemotePath).toBe('/family/reviews-v2');
    expect(result.updatedHasCreatedAt).toBe(true);
    expect(result.updatedHasUpdatedAt).toBe(true);
    expect(result.updatedKeepsCreatedAt).toBe(true);
    expect(result.parentTables).toEqual([]);
    expect(result.removedHit).toBe(true);
    expect(result.removedMiss).toBe(false);
    expect(result.afterRemoveIds).toEqual(['reviews']);
    expect(result.persistedIds).toEqual(['reviews']);
  });
});
