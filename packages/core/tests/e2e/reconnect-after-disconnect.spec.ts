/**
 * reconnect-after-disconnect.spec.ts
 *
 * Repro for client report:
 *   - create new mesh
 *   - disconnect
 *   - reconnect -> failure
 *
 * Same trace happens on page reload. Console shows:
 *   [interocitor] pull() — failed Error: Decryption failed:
 *   payload not decryptable with the active mesh key
 *   (Unknown envelope version: undefined).
 *
 * Engine writes a change file during the first session, then on the
 * second connect() pull() can't decode it — meaning either the file
 * was written without an encryption envelope, or the active key on
 * reconnect differs from the key used to write.
 */
import { test, expect } from '@playwright/test';
import {
  attachWebDavRouteMock,
  createWebDavRouteState,
  type WebDavRouteState,
} from './helpers/webdav-route-mock.ts';

type Page = import('@playwright/test').Page;

async function clearAllLocalState(page: Page, dbNames: string[]): Promise<void> {
  await page.evaluate(async (names: string[]) => {
    localStorage.clear();
    for (const n of names) {
      await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase(n);
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      });
    }
  }, dbNames);
}

test.describe('Reconnect on the same engine after disconnect', () => {
  test('same engine: create mesh → write → disconnect → reconnect must not poison remote', async ({ browser, baseURL }) => {
    const cloud: WebDavRouteState = createWebDavRouteState();
    const ctx = await browser.newContext();
    try {
      await attachWebDavRouteMock(ctx, cloud, '/__dav_recon__');
      const page = await ctx.newPage();
      await page.goto(`${baseURL}/packages/core/tests/e2e/fixtures/harness-plain.html`);
      await clearAllLocalState(page, ['recon-mesh']);

      const result = await page.evaluate(async () => {
        const { Interocitor, readColumn } = await import('/packages/core/dist/index.js');
        const { WebDAVAdapter } = await import('/packages/core/dist/adapters/webdav.js');
        const adapter = new WebDAVAdapter({
          baseUrl: `${location.origin}/__dav_recon__`,
          auth: { username: 'u', password: 'p' },
        });

        // Default config: encrypted is true unless set false. Mirrors
        // what the user app does when "create new mesh" is clicked.
        const engine = new Interocitor(adapter, {
          remotePath: '/MealPlanner',
          dbName: 'recon-mesh',
          deviceId: 'dev_recon',
          pollInterval: 600_000,
          flushDebounce: 60_000,
          flushThreshold: 999,
        });

        const events: any[] = [];
        engine.on((e) => events.push(e));

        // Cycle 1: create mesh, write, flush, disconnect.
        await engine.init();
        await engine.connect();
        await engine.put('items', 'i1', { text: 'first' });
        await engine.flush();
        await engine.disconnect();

        // Cycle 2: reconnect on the same engine instance. After
        // disconnect, init is reset; the engine should re-init,
        // resolve the same key (silent credential restore), and
        // decode its own previously-flushed change file.
        let secondConnectError = '';
        try {
          await engine.connect();
        } catch (err: any) {
          secondConnectError = String(err?.message ?? err);
        }

        const rows = await engine.query('items').catch(() => []);
        const titles = rows.map((r: any) => readColumn(r, 'text')).toSorted();

        await engine.disconnect().catch(() => {});

        const poisoned = events.filter((e) => e.type === 'remote:poisoned');
        const decodeErrors = events.filter((e) => e.type === 'decode:error');

        return {
          secondConnectError,
          titles,
          poisonedCount: poisoned.length,
          poisonedMessage: poisoned[0]?.error?.message ?? null,
          decodeErrorCount: decodeErrors.length,
        };
      });

      expect(result.secondConnectError).toBe('');
      expect(result.poisonedCount).toBe(0);
      expect(result.decodeErrorCount).toBe(0);
      expect(result.titles).toEqual(['first']);
    } finally {
      await ctx.close();
    }
  });

  test('regression: encrypted-default reconnect on plaintext-written remote must not poison silently', async ({ browser, baseURL }) => {
    // Repro: first session opens the mesh with encryption disabled
    // (or never resolves a key before flush), so the change file lands
    // on the remote as plaintext JSON. On reconnect the engine defaults
    // to `encrypted: true`, derives a key from the credential store,
    // and pull() throws `Unknown envelope version: undefined` because
    // the file has no envelope.
    //
    // Matches the client trace:
    //   [interocitor] resolveEncryption() — derived key from passphrase
    //   [interocitor] pull() — start
    //   [interocitor] remote:poisoned — sync halted ...
    //     message: 'Decryption failed: ... Unknown envelope version: undefined'
    const cloud: WebDavRouteState = createWebDavRouteState();
    const ctx = await browser.newContext();
    try {
      await attachWebDavRouteMock(ctx, cloud, '/__dav_recon3__');
      const page = await ctx.newPage();
      await page.goto(`${baseURL}/packages/core/tests/e2e/fixtures/harness-plain.html`);
      await clearAllLocalState(page, ['recon3-mesh']);

      const result = await page.evaluate(async () => {
        const { Interocitor, MeshEncryptionMismatchError } = await import('/packages/core/dist/index.js');
        const { WebDAVAdapter } = await import('/packages/core/dist/adapters/webdav.js');
        const adapter = new WebDAVAdapter({
          baseUrl: `${location.origin}/__dav_recon3__`,
          auth: { username: 'u', password: 'p' },
        });

        // Cycle 1: encrypted explicitly OFF.
        const e1 = new Interocitor(adapter, {
          remotePath: '/MealPlanner',
          dbName: 'recon3-mesh',
          deviceId: 'dev_recon3',
          encrypted: false,
          pollInterval: 600_000,
          flushDebounce: 60_000,
          flushThreshold: 999,
        });
        await e1.init();
        await e1.connect();
        await e1.put('items', 'i1', { text: 'first' });
        await e1.flush();
        await e1.disconnect();

        // Cycle 2: brand new engine, no `encrypted` flag set →
        // defaults to true. This is the user's "page reload" path.
        const adapter2 = new WebDAVAdapter({
          baseUrl: `${location.origin}/__dav_recon3__`,
          auth: { username: 'u', password: 'p' },
        });
        const e2 = new Interocitor(adapter2, {
          remotePath: '/MealPlanner',
          dbName: 'recon3-mesh',
          deviceId: 'dev_recon3',
          pollInterval: 600_000,
          flushDebounce: 60_000,
          flushThreshold: 999,
        });
        const events: any[] = [];
        e2.on((e) => events.push(e));
        let connectError = '';
        let connectErrorCode: string | undefined;
        let connectErrorName = '';
        let connectErrorIsTyped = false;
        let connectErrorExpected: boolean | undefined;
        let connectErrorActual: boolean | undefined;
        await e2.init();
        try { await e2.connect(); } catch (err: any) {
          connectError = String(err?.message ?? err);
          connectErrorCode = err?.code;
          connectErrorName = err?.name ?? '';
          connectErrorIsTyped = err instanceof MeshEncryptionMismatchError;
          connectErrorExpected = err?.expectedMode;
          connectErrorActual = err?.actualMode;
        }
        await e2.disconnect().catch(() => {});

        const poisoned = events.filter((e) => e.type === 'remote:poisoned');
        return {
          connectError,
          connectErrorCode,
          connectErrorName,
          connectErrorIsTyped,
          connectErrorExpected,
          connectErrorActual,
          poisonedCount: poisoned.length,
          poisonedMessage: poisoned[0]?.error?.message ?? null,
        };
      });

      // 1. connect() must throw the typed error with structured fields.
      expect(result.connectErrorIsTyped).toBe(true);
      expect(result.connectErrorName).toBe('MeshEncryptionMismatchError');
      expect(result.connectErrorCode).toBe('MESH_ENCRYPTION_MISMATCH');
      expect(result.connectErrorExpected).toBe(false);
      expect(result.connectErrorActual).toBe(true);

      // 2. Message stays human-actionable.
      expect(result.connectError).toMatch(/Mesh encryption mode mismatch/);
      expect(result.connectError).toMatch(/encrypted=false/);
      expect(result.connectError).toMatch(/encrypted=true/);

      // 3. Must NOT crash with the cryptic decode error or its envelope cause.
      expect(result.connectError).not.toMatch(/Unknown envelope version: undefined/);
      expect(result.connectError).not.toMatch(/payload not decryptable/);

      // 4. Must NOT poison the remote — the remote is fine, the local
      //    engine config is wrong. Poisoning a healthy remote on bad
      //    config is the bug we are fixing.
      expect(result.poisonedCount).toBe(0);
    } finally {
      await ctx.close();
    }
  });

  test('credential store: stale meshId record under same dbName must not silently reuse old key', async ({ browser, baseURL }) => {
    // Repro: app uses one dbName for "create new mesh" each time. The
    // credential store keeps ONE record per dbName, so the second mesh
    // would inherit the first mesh's passphrase and either fail to
    // decrypt or poison the new remote.
    //
    // Expected: connect() throws MeshCredentialMismatchError with the
    // old + new meshIds, emits credentials:meshMismatch, and never
    // poisons the remote.
    const cloud1: WebDavRouteState = createWebDavRouteState();
    const cloud2: WebDavRouteState = createWebDavRouteState();
    const ctx = await browser.newContext();
    try {
      await attachWebDavRouteMock(ctx, cloud1, '/__dav_meshA__');
      await attachWebDavRouteMock(ctx, cloud2, '/__dav_meshB__');
      const page = await ctx.newPage();
      await page.goto(`${baseURL}/packages/core/tests/e2e/fixtures/harness-plain.html`);
      await clearAllLocalState(page, ['shared-mesh-name']);

      const result = await page.evaluate(async () => {
        const { Interocitor, MeshCredentialMismatchError } = await import('/packages/core/dist/index.js');
        const { WebDAVAdapter } = await import('/packages/core/dist/adapters/webdav.js');

        // Mesh A: created, written, disconnected. Cred store now holds
        // {passphrase, deviceId, meshId: A}.
        const adapterA = new WebDAVAdapter({
          baseUrl: `${location.origin}/__dav_meshA__`,
          auth: { username: 'u', password: 'p' },
        });
        const eA = new Interocitor(adapterA, {
          remotePath: '/MealPlanner',
          dbName: 'shared-mesh-name',
          deviceId: 'dev_meshA',
          pollInterval: 600_000,
          flushDebounce: 60_000,
          flushThreshold: 999,
        });
        await eA.init();
        await eA.connect();
        await eA.put('items', 'i1', { text: 'A' });
        await eA.flush();
        const meshIdA = eA.getMeshId();
        await eA.disconnect();

        // Wipe local indexed-db so the next engine has no local meshId
        // memory, but keep localStorage (= keep credential record). This
        // mirrors the "page reload after re-pairing under same dbName"
        // failure mode.
        await new Promise<void>((resolve) => {
          const req = indexedDB.deleteDatabase('shared-mesh-name');
          req.onsuccess = req.onerror = req.onblocked = () => resolve();
        });

        // Mesh B: brand-new mesh, same dbName, different remote path.
        const adapterB = new WebDAVAdapter({
          baseUrl: `${location.origin}/__dav_meshB__`,
          auth: { username: 'u', password: 'p' },
        });
        const eB = new Interocitor(adapterB, {
          remotePath: '/MealPlanner',
          dbName: 'shared-mesh-name',
          deviceId: 'dev_meshB',
          pollInterval: 600_000,
          flushDebounce: 60_000,
          flushThreshold: 999,
        });
        const events: any[] = [];
        eB.on((e) => events.push(e));

        let connectError = '';
        let isTyped = false;
        let storedMeshId = '';
        let activeMeshId = '';
        let code = '';
        await eB.init();
        try { await eB.connect(); } catch (err: any) {
          connectError = String(err?.message ?? err);
          isTyped = err instanceof MeshCredentialMismatchError;
          storedMeshId = err?.storedMeshId ?? '';
          activeMeshId = err?.activeMeshId ?? '';
          code = err?.code ?? '';
        }
        await eB.disconnect().catch(() => {});

        const poisoned = events.filter((e) => e.type === 'remote:poisoned');
        const mismatch = events.filter((e) => e.type === 'credentials:meshMismatch');
        return {
          meshIdA,
          connectError,
          isTyped,
          code,
          storedMeshId,
          activeMeshId,
          poisonedCount: poisoned.length,
          mismatchEventCount: mismatch.length,
          mismatchEventStored: mismatch[0]?.storedMeshId ?? '',
          mismatchEventActive: mismatch[0]?.activeMeshId ?? '',
        };
      });

      expect(result.isTyped).toBe(true);
      expect(result.code).toBe('MESH_CREDENTIAL_MISMATCH');
      expect(result.storedMeshId).toBe(result.meshIdA);
      expect(result.activeMeshId).not.toBe('');
      expect(result.activeMeshId).not.toBe(result.meshIdA);
      expect(result.connectError).toMatch(/Stored credentials under dbName/);
      expect(result.connectError).toMatch(/clearCredentials/);

      // Event surfaced and remote untouched.
      expect(result.mismatchEventCount).toBeGreaterThanOrEqual(1);
      expect(result.mismatchEventStored).toBe(result.meshIdA);
      expect(result.mismatchEventActive).toBe(result.activeMeshId);
      expect(result.poisonedCount).toBe(0);
    } finally {
      await ctx.close();
    }
  });

  test('fresh engine (page reload sim): create mesh → write → close → new engine reconnects', async ({ browser, baseURL }) => {
    const cloud: WebDavRouteState = createWebDavRouteState();
    const ctx = await browser.newContext();
    try {
      await attachWebDavRouteMock(ctx, cloud, '/__dav_recon2__');
      const page = await ctx.newPage();
      await page.goto(`${baseURL}/packages/core/tests/e2e/fixtures/harness-plain.html`);
      await clearAllLocalState(page, ['recon2-mesh']);

      const result = await page.evaluate(async () => {
        const { Interocitor, readColumn } = await import('/packages/core/dist/index.js');
        const { WebDAVAdapter } = await import('/packages/core/dist/adapters/webdav.js');
        const adapter = new WebDAVAdapter({
          baseUrl: `${location.origin}/__dav_recon2__`,
          auth: { username: 'u', password: 'p' },
        });

        // Cycle 1: same as above, then drop the engine reference.
        const e1 = new Interocitor(adapter, {
          remotePath: '/MealPlanner',
          dbName: 'recon2-mesh',
          deviceId: 'dev_recon2',
          pollInterval: 600_000,
          flushDebounce: 60_000,
          flushThreshold: 999,
        });
        await e1.init();
        await e1.connect();
        await e1.put('items', 'i1', { text: 'first' });
        await e1.flush();
        await e1.disconnect();

        // Cycle 2: brand-new engine, same dbName + remotePath.
        // Mirrors a page reload: passphrase must come back from the
        // credential store; pull must decode the previously-flushed
        // change file.
        const adapter2 = new WebDAVAdapter({
          baseUrl: `${location.origin}/__dav_recon2__`,
          auth: { username: 'u', password: 'p' },
        });
        const e2 = new Interocitor(adapter2, {
          remotePath: '/MealPlanner',
          dbName: 'recon2-mesh',
          deviceId: 'dev_recon2',
          pollInterval: 600_000,
          flushDebounce: 60_000,
          flushThreshold: 999,
        });
        const events: any[] = [];
        e2.on((e) => events.push(e));

        let connectError = '';
        await e2.init();
        try {
          await e2.connect();
        } catch (err: any) {
          connectError = String(err?.message ?? err);
        }

        const rows = await e2.query('items').catch(() => []);
        const titles = rows.map((r: any) => readColumn(r, 'text')).toSorted();
        await e2.disconnect().catch(() => {});

        const poisoned = events.filter((e) => e.type === 'remote:poisoned');
        const decodeErrors = events.filter((e) => e.type === 'decode:error');
        return {
          connectError,
          titles,
          poisonedCount: poisoned.length,
          poisonedMessage: poisoned[0]?.error?.message ?? null,
          decodeErrorCount: decodeErrors.length,
        };
      });

      expect(result.connectError).toBe('');
      expect(result.poisonedCount).toBe(0);
      expect(result.decodeErrorCount).toBe(0);
      expect(result.titles).toEqual(['first']);
    } finally {
      await ctx.close();
    }
  });
});
