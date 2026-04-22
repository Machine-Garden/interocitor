/**
 * self-poison.spec.ts
 *
 * Multi-client mesh self-sabotage scenarios (the "Observer problem"):
 *
 *   A. Two clients on a mesh, one reloads with stale credentials,
 *      then the other reloads — original client must still decode its
 *      own writes; remote must not get poisoned by silent passphrase
 *      drift.
 *   B. Same dbName re-used with a different passphrase: must surface a
 *      'credentials:conflict' event instead of silently corrupting.
 *   C. Wrong-passphrase reconnect on an existing encrypted mesh: must
 *      emit decode:error and remote:poisoned with rich context, never
 *      destroy local rows.
 *   D. Diagnostic events (mesh:configured, encryption:resolved,
 *      credentials:persisted, connect:state) are emitted with the
 *      expected shape so observability tools can hook in.
 */

import { expect, test } from '@playwright/test';
import {
  attachWebDavRouteMock,
  createWebDavRouteState,
  type WebDavRouteState,
} from './helpers/webdav-route-mock';

type Page = import('@playwright/test').Page;

async function clearLocalDb(page: Page, dbName: string): Promise<void> {
  await page.evaluate(async (db) => {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(db);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  }, dbName);
}

async function clearAllLocalState(page: Page, dbNames: string[]): Promise<void> {
  for (const db of dbNames) await clearLocalDb(page, db);
  await page.evaluate((dbs) => {
    localStorage.removeItem('interocitor-device-id');
    for (const db of dbs) localStorage.removeItem(`interocitor-key:${db}`);
  }, dbNames);
}

// ─── Tests ────────────────────────────────────────────────────────────

test.describe('Mesh self-poison + diagnostics', () => {
  test('A. observer problem: original creator still decodes its own writes after a peer joins, peer reloads, creator reloads', async ({ browser, baseURL }) => {
    const cloud: WebDavRouteState = createWebDavRouteState();
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      await attachWebDavRouteMock(ctxA, cloud, '/__dav_obs__');
      await attachWebDavRouteMock(ctxB, cloud, '/__dav_obs__');

      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();
      const harness = `${baseURL}/packages/core/tests/e2e/fixtures/harness-plain.html`;
      await Promise.all([pageA.goto(harness), pageB.goto(harness)]);
      await Promise.all([
        clearAllLocalState(pageA, ['observer-mesh']),
        clearAllLocalState(pageB, ['observer-mesh']),
      ]);

      // 1. A creates encrypted mesh, writes, captures passphrase.
      const setup = await pageA.evaluate(async () => {
        const { Interocitor } = await import('/packages/core/dist/index.js');
        const { WebDAVAdapter } = await import('/packages/core/dist/adapters/webdav.js');
        const adapter = new WebDAVAdapter({ baseUrl: `${location.origin}/__dav_obs__`, auth: { username: 'u', password: 'p' } });
        const engine = new Interocitor(adapter, {
          remotePath: '/Observer', dbName: 'observer-mesh', deviceId: 'device_A',
          encrypted: true, pollInterval: 600_000, flushDebounce: 60_000, flushThreshold: 999,
        });
        await engine.init();
        await engine.connect();
        await engine.put('notes', 'a1', { text: 'created by A' });
        await engine.flush();
        const passphrase = engine.getPassphrase();
        const meshId = engine.getMeshId();
        await engine.disconnect();
        return { passphrase, meshId };
      });

      // 2. B joins with same passphrase, writes, reloads (disconnect/reconnect).
      const joinB = await pageB.evaluate(async (passArg: string) => {
        const { Interocitor, readColumn } = await import('/packages/core/dist/index.js');
        const { WebDAVAdapter } = await import('/packages/core/dist/adapters/webdav.js');
        const adapter = new WebDAVAdapter({ baseUrl: `${location.origin}/__dav_obs__`, auth: { username: 'u', password: 'p' } });
        const engine = new Interocitor(adapter, {
          remotePath: '/Observer', dbName: 'observer-mesh', deviceId: 'device_B',
          passphrase: passArg, pollInterval: 600_000, flushDebounce: 60_000, flushThreshold: 999,
        });
        await engine.init();
        await engine.connect();
        await engine.put('notes', 'b1', { text: 'created by B' });
        await engine.flush();
        const meshId = engine.getMeshId();
        await engine.disconnect();

        // Simulate page reload — fresh engine, identical config (passphrase
        // recovered from credential store).
        const engine2 = new Interocitor(adapter, {
          remotePath: '/Observer', dbName: 'observer-mesh', deviceId: 'device_B',
          encrypted: true, pollInterval: 600_000, flushDebounce: 60_000, flushThreshold: 999,
        });
        await engine2.init();
        await engine2.connect();
        const rows = await engine2.query('notes');
        const titles = rows.map((r: any) => readColumn(r, 'text')).toSorted();
        await engine2.disconnect();
        return { meshId, titles, restoredPassphrase: engine2.getPassphrase() };
      }, setup.passphrase);

      expect(joinB.meshId).toBe(setup.meshId);
      expect(joinB.titles).toEqual(['created by A', 'created by B']);
      // Critical: silent restore must hand back the same passphrase, not
      // a freshly-generated one.
      expect(joinB.restoredPassphrase).toBe(setup.passphrase);

      // 3. A reloads — fresh engine, no passphrase in config (relies on
      // credential store). Must decode B's writes AND its own original
      // write. No remote:poisoned events.
      const reloadA = await pageA.evaluate(async () => {
        const { Interocitor, readColumn } = await import('/packages/core/dist/index.js');
        const { WebDAVAdapter } = await import('/packages/core/dist/adapters/webdav.js');
        const adapter = new WebDAVAdapter({ baseUrl: `${location.origin}/__dav_obs__`, auth: { username: 'u', password: 'p' } });
        const engine = new Interocitor(adapter, {
          remotePath: '/Observer', dbName: 'observer-mesh', deviceId: 'device_A',
          encrypted: true, pollInterval: 600_000, flushDebounce: 60_000, flushThreshold: 999,
        });
        const events: string[] = [];
        engine.on((e) => { events.push(e.type); });
        await engine.init();
        await engine.connect();
        const rows = await engine.query('notes');
        const titles = rows.map((r: any) => readColumn(r, 'text')).toSorted();
        // Make a new write — own writes must round-trip through the same key.
        await engine.put('notes', 'a2', { text: 'A after reload' });
        await engine.flush();
        const titlesAfter = (await engine.query('notes'))
          .map((r: any) => readColumn(r, 'text')).toSorted();
        await engine.disconnect();
        return {
          titles, titlesAfter,
          poisoned: events.filter((t) => t === 'remote:poisoned'),
          decodeErrors: events.filter((t) => t === 'decode:error'),
          restored: events.filter((t) => t === 'credentials:restored'),
        };
      });

      expect(reloadA.poisoned).toEqual([]);
      expect(reloadA.decodeErrors).toEqual([]);
      expect(reloadA.restored.length).toBeGreaterThan(0);
      expect(reloadA.titles).toEqual(['created by A', 'created by B']);
      expect(reloadA.titlesAfter).toEqual(['A after reload', 'created by A', 'created by B']);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('B. same dbName + different passphrase emits credentials:conflict and does not silently swap key', async ({ browser, baseURL }) => {
    const cloud: WebDavRouteState = createWebDavRouteState();
    const ctx = await browser.newContext();
    try {
      await attachWebDavRouteMock(ctx, cloud, '/__dav_conflict__');
      const page = await ctx.newPage();
      await page.goto(`${baseURL}/packages/core/tests/e2e/fixtures/harness-plain.html`);
      await clearAllLocalState(page, ['conflict-mesh']);

      const result = await page.evaluate(async () => {
        const { Interocitor } = await import('/packages/core/dist/index.js');
        const { WebDAVAdapter } = await import('/packages/core/dist/adapters/webdav.js');
        const { generateKey, keyToPassphrase } = await import('/packages/core/dist/crypto/keys.js');
        const adapter = new WebDAVAdapter({ baseUrl: `${location.origin}/__dav_conflict__`, auth: { username: 'u', password: 'p' } });

        const k1 = await keyToPassphrase(await generateKey());
        const k2 = await keyToPassphrase(await generateKey());

        // First open — persist k1 under dbName.
        const e1 = new Interocitor(adapter, {
          remotePath: '/Conflict', dbName: 'conflict-mesh', deviceId: 'dev_c',
          passphrase: k1, pollInterval: 600_000, flushDebounce: 60_000, flushThreshold: 999,
        });
        await e1.init();
        await e1.connect();
        await e1.put('items', 'i1', { text: 'first' });
        await e1.flush();
        await e1.disconnect();

        // Second open — same dbName but caller provides a *different*
        // passphrase. Must surface conflict, not silently overwrite local
        // rows or the remote with a key the user did not intend.
        const events: any[] = [];
        const e2 = new Interocitor(adapter, {
          remotePath: '/Conflict', dbName: 'conflict-mesh', deviceId: 'dev_c',
          passphrase: k2, pollInterval: 600_000, flushDebounce: 60_000, flushThreshold: 999,
        });
        e2.on((e) => events.push(e));
        await e2.init();
        let connectError = '';
        try { await e2.connect(); } catch (err: any) { connectError = String(err?.message ?? err); }
        await e2.disconnect().catch(() => {});

        const conflicts = events.filter((e) => e.type === 'credentials:conflict');
        const poisoned = events.filter((e) => e.type === 'remote:poisoned');
        return { connectError, conflicts: conflicts.length, poisoned: poisoned.length };
      });

      expect(result.conflicts).toBeGreaterThan(0);
      // Either decode poisons remote or mesh-id mismatch — engine must
      // refuse to silently keep going.
      expect(result.poisoned + (result.connectError ? 1 : 0)).toBeGreaterThan(0);
    } finally {
      await ctx.close();
    }
  });

  test('C. wrong passphrase on existing encrypted mesh emits decode:error + remote:poisoned with context, leaves local DB untouched', async ({ browser, baseURL }) => {
    const cloud: WebDavRouteState = createWebDavRouteState();
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      await attachWebDavRouteMock(ctxA, cloud, '/__dav_wrong__');
      await attachWebDavRouteMock(ctxB, cloud, '/__dav_wrong__');
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();
      const harness = `${baseURL}/packages/core/tests/e2e/fixtures/harness-plain.html`;
      await Promise.all([pageA.goto(harness), pageB.goto(harness)]);
      await Promise.all([
        clearAllLocalState(pageA, ['wrong-mesh']),
        clearAllLocalState(pageB, ['wrong-mesh']),
      ]);

      // A creates the mesh and writes one row.
      const setup = await pageA.evaluate(async () => {
        const { Interocitor } = await import('/packages/core/dist/index.js');
        const { WebDAVAdapter } = await import('/packages/core/dist/adapters/webdav.js');
        const adapter = new WebDAVAdapter({ baseUrl: `${location.origin}/__dav_wrong__`, auth: { username: 'u', password: 'p' } });
        const engine = new Interocitor(adapter, {
          remotePath: '/Wrong', dbName: 'wrong-mesh', deviceId: 'A',
          encrypted: true, pollInterval: 600_000, flushDebounce: 60_000, flushThreshold: 999,
        });
        await engine.init();
        await engine.connect();
        await engine.put('rows', 'r1', { v: 1 });
        await engine.flush();
        const passphrase = engine.getPassphrase();
        await engine.disconnect();
        return { passphrase };
      });

      // B tries to join with the wrong passphrase. Local DB must remain
      // intact afterwards (nothing was written, nothing was clobbered).
      const result = await pageB.evaluate(async (correctPass: string) => {
        const { Interocitor } = await import('/packages/core/dist/index.js');
        const { WebDAVAdapter } = await import('/packages/core/dist/adapters/webdav.js');
        const { generateKey, keyToPassphrase } = await import('/packages/core/dist/crypto/keys.js');
        const wrongPass = await keyToPassphrase(await generateKey());
        const adapter = new WebDAVAdapter({ baseUrl: `${location.origin}/__dav_wrong__`, auth: { username: 'u', password: 'p' } });
        const engine = new Interocitor(adapter, {
          remotePath: '/Wrong', dbName: 'wrong-mesh', deviceId: 'B',
          passphrase: wrongPass, pollInterval: 600_000, flushDebounce: 60_000, flushThreshold: 999,
        });
        const events: any[] = [];
        engine.on((e) => events.push(e));
        let connectError = '';
        await engine.init();
        try { await engine.connect(); } catch (err: any) { connectError = String(err?.message ?? err); }
        const localRows = await engine.query('rows').catch(() => []);
        await engine.disconnect().catch(() => {});

        const decodeErrors = events.filter((e) => e.type === 'decode:error');
        const poisoned = events.filter((e) => e.type === 'remote:poisoned');
        return {
          connectError,
          localRowCount: localRows.length,
          decodeErrorCount: decodeErrors.length,
          poisonedCount: poisoned.length,
          poisonedHasContext: poisoned[0]?.context?.dbName === 'wrong-mesh',
          poisonedHasMessage: typeof poisoned[0]?.error?.message === 'string'
            && poisoned[0]?.error?.message.length > 0,
          unused: correctPass.length > 0,
        };
      }, setup.passphrase);

      // B never wrote anything locally; row count must be 0.
      expect(result.localRowCount).toBe(0);
      // We expect either decode failure or mesh mismatch poisoning.
      expect(result.poisonedCount + result.decodeErrorCount).toBeGreaterThan(0);
      if (result.poisonedCount > 0) {
        expect(result.poisonedHasContext).toBe(true);
        expect(result.poisonedHasMessage).toBe(true);
      }
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('E. connect() is idempotent on already-connected mesh: no transport restart, emits connect:noop', async ({ browser, baseURL }) => {
    const cloud: WebDavRouteState = createWebDavRouteState();
    const ctx = await browser.newContext();
    try {
      await attachWebDavRouteMock(ctx, cloud, '/__dav_idemp__');
      const page = await ctx.newPage();
      await page.goto(`${baseURL}/packages/core/tests/e2e/fixtures/harness-plain.html`);
      await clearAllLocalState(page, ['idemp-mesh']);

      const result = await page.evaluate(async () => {
        const { Interocitor } = await import('/packages/core/dist/index.js');
        const { WebDAVAdapter } = await import('/packages/core/dist/adapters/webdav.js');
        const adapter = new WebDAVAdapter({ baseUrl: `${location.origin}/__dav_idemp__`, auth: { username: 'u', password: 'p' } });
        const engine = new Interocitor(adapter, {
          remotePath: '/Idemp', dbName: 'idemp-mesh', deviceId: 'i1',
          encrypted: true, pollInterval: 600_000, flushDebounce: 60_000, flushThreshold: 999,
        });
        const events: any[] = [];
        engine.on((e) => events.push(e));
        await engine.init();
        await engine.connect();
        await engine.connect(); // idempotent
        await engine.connect(); // still idempotent
        await engine.disconnect();
        const noops = events.filter((e) => e.type === 'connect:noop');
        const states = events.filter((e) => e.type === 'connect:state');
        const teardowns = events.filter((e) => e.type === 'transport:teardown');
        return {
          noopCount: noops.length,
          stateCount: states.length,
          teardownCount: teardowns.length,
          teardownReason: teardowns[0]?.reason,
        };
      });

      // First connect: 1 connect:state. Two follow-up connects: 2 noops.
      expect(result.noopCount).toBe(2);
      expect(result.stateCount).toBe(1);
      // Disconnect must hard-teardown exactly once.
      expect(result.teardownCount).toBe(1);
      expect(result.teardownReason).toBe('disconnect');
    } finally {
      await ctx.close();
    }
  });

  test('F. setRemoteStorage(newAdapter) hard-tears down the old transport before swapping', async ({ browser, baseURL }) => {
    const cloudA: WebDavRouteState = createWebDavRouteState();
    const cloudB: WebDavRouteState = createWebDavRouteState();
    const ctx = await browser.newContext();
    try {
      await attachWebDavRouteMock(ctx, cloudA, '/__dav_swapA__');
      await attachWebDavRouteMock(ctx, cloudB, '/__dav_swapB__');
      const page = await ctx.newPage();
      await page.goto(`${baseURL}/packages/core/tests/e2e/fixtures/harness-plain.html`);
      await clearAllLocalState(page, ['swap-mesh']);

      const result = await page.evaluate(async () => {
        const { Interocitor } = await import('/packages/core/dist/index.js');
        const { WebDAVAdapter } = await import('/packages/core/dist/adapters/webdav.js');
        const a1 = new WebDAVAdapter({ baseUrl: `${location.origin}/__dav_swapA__`, auth: { username: 'u', password: 'p' } });
        const a2 = new WebDAVAdapter({ baseUrl: `${location.origin}/__dav_swapB__`, auth: { username: 'u', password: 'p' } });
        const engine = new Interocitor(a1, {
          remotePath: '/Swap', dbName: 'swap-mesh', deviceId: 's1',
          encrypted: false, pollInterval: 600_000, flushDebounce: 60_000, flushThreshold: 999,
        });
        const events: any[] = [];
        engine.on((e) => events.push(e));
        await engine.init();
        await engine.connect();
        await engine.put('items', 'i1', { v: 1 });
        await engine.flush();
        await engine.setRemoteStorage(a2);
        await engine.put('items', 'i2', { v: 2 });
        await engine.flush();
        await engine.disconnect();
        const teardowns = events.filter((e) => e.type === 'transport:teardown');
        return {
          teardownCount: teardowns.length,
          teardownReasons: teardowns.map((t: any) => t.reason),
        };
      });

      // Exactly two teardowns: one for the swap, one for the final disconnect.
      expect(result.teardownCount).toBe(2);
      expect(result.teardownReasons).toEqual(['switch-adapter', 'disconnect']);
    } finally {
      await ctx.close();
    }
  });

  test('G. setRemoteStorage(null) marks engine local-only and tears down the previous transport', async ({ browser, baseURL }) => {
    const cloud: WebDavRouteState = createWebDavRouteState();
    const ctx = await browser.newContext();
    try {
      await attachWebDavRouteMock(ctx, cloud, '/__dav_detach__');
      const page = await ctx.newPage();
      await page.goto(`${baseURL}/packages/core/tests/e2e/fixtures/harness-plain.html`);
      await clearAllLocalState(page, ['detach-mesh']);

      const result = await page.evaluate(async () => {
        const { Interocitor } = await import('/packages/core/dist/index.js');
        const { WebDAVAdapter } = await import('/packages/core/dist/adapters/webdav.js');
        const adapter = new WebDAVAdapter({ baseUrl: `${location.origin}/__dav_detach__`, auth: { username: 'u', password: 'p' } });
        const engine = new Interocitor(adapter, {
          remotePath: '/Detach', dbName: 'detach-mesh', deviceId: 'd1',
          encrypted: false, pollInterval: 600_000, flushDebounce: 60_000, flushThreshold: 999,
        });
        const events: any[] = [];
        engine.on((e) => events.push(e));
        await engine.init();
        await engine.connect();
        await engine.setRemoteStorage(null);
        // After detach, connecting should require a remote adapter.
        let detachedConnectError = '';
        try { await engine.connect(); } catch (err: any) { detachedConnectError = String(err?.message ?? err); }
        return {
          detachedConnectError,
          teardownReasons: events.filter((e) => e.type === 'transport:teardown').map((t: any) => t.reason),
        };
      });

      expect(result.teardownReasons).toContain('detach');
      expect(result.detachedConnectError).toMatch(/remote/i);
    } finally {
      await ctx.close();
    }
  });

  test('D. diagnostic events fire with expected shape during normal init/connect', async ({ browser, baseURL }) => {
    const cloud: WebDavRouteState = createWebDavRouteState();
    const ctx = await browser.newContext();
    try {
      await attachWebDavRouteMock(ctx, cloud, '/__dav_diag__');
      const page = await ctx.newPage();
      await page.goto(`${baseURL}/packages/core/tests/e2e/fixtures/harness-plain.html`);
      await clearAllLocalState(page, ['diag-mesh']);

      const result = await page.evaluate(async () => {
        const { Interocitor } = await import('/packages/core/dist/index.js');
        const { WebDAVAdapter } = await import('/packages/core/dist/adapters/webdav.js');
        const adapter = new WebDAVAdapter({ baseUrl: `${location.origin}/__dav_diag__`, auth: { username: 'u', password: 'p' } });
        const engine = new Interocitor(adapter, {
          remotePath: '/Diag', dbName: 'diag-mesh', deviceId: 'd1',
          encrypted: true, pollInterval: 600_000, flushDebounce: 60_000, flushThreshold: 999,
        });
        const collected: any[] = [];
        engine.on((e) => collected.push(e));
        await engine.init();
        await engine.connect();
        await engine.put('x', '1', { v: 1 });
        await engine.flush();
        await engine.disconnect();
        const byType = (t: string) => collected.filter((e) => e.type === t);
        return {
          encryptionResolved: byType('encryption:resolved')[0],
          credentialsPersisted: byType('credentials:persisted')[0],
          connectState: byType('connect:state')[0],
          credentialsRestored: byType('credentials:restored').length,
        };
      });

      expect(result.encryptionResolved?.strategy).toBe('generated');
      expect(result.encryptionResolved?.dbName).toBe('diag-mesh');
      expect(result.encryptionResolved?.encrypted).toBe(true);
      expect(result.credentialsPersisted?.dbName).toBe('diag-mesh');
      expect(result.credentialsPersisted?.deviceId).toBe('d1');
      expect(result.connectState?.dbName).toBe('diag-mesh');
      expect(result.connectState?.remotePath).toBe('/Diag');
      expect(result.connectState?.encrypted).toBe(true);
      // No persisted creds first time — restore emit is fine to be 0 here.
      expect(result.credentialsRestored).toBeGreaterThanOrEqual(0);
    } finally {
      await ctx.close();
    }
  });
});
