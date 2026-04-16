/**
 * pairing-flow.spec.ts
 *
 * Real-world multi-device pairing scenarios:
 *
 *   1. Device 1 creates an encrypted mesh, writes data.
 *   2. Device 2 joins Device 1 via handshake — downloads data.
 *   3. Device 2 "switches teams" — joins a *different* mesh on Device 3.
 *      Old data must NOT leak into the new mesh.
 *   4. Device 2 reconnects to Device 1's mesh — downloads data again.
 *   5. Device 2 invites Device 4 into Device 1's mesh (chain-invite).
 *
 * Validates:
 *   - deviceId / meshId lifecycle
 *   - passphrase handling via SyncEngine config and credentials
 *   - database isolation across meshes (different remotePath + dbName)
 *   - no unintentional data leakage between teams
 *   - passphrase survival across reconnects (lost passphrase == lost data)
 */

import { expect, test } from '@playwright/test';
import {
  attachWebDavRouteMock,
  createWebDavRouteState,
  type WebDavRouteState,
} from './helpers/webdav-route-mock';

// ─── Helpers ──────────────────────────────────────────────────────────

type Page = import('@playwright/test').Page;

async function clearLocalDb(page: Page, dbName = 'interocitor'): Promise<void> {
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
  for (const db of dbNames) {
    await clearLocalDb(page, db);
  }
  await page.evaluate(() => {
    localStorage.removeItem('interocitor-device-id');
    localStorage.removeItem('interocitor-key:team-alpha');
    localStorage.removeItem('interocitor-key:team-beta');
  });
}

// ─── Test ─────────────────────────────────────────────────────────────

test.describe('Multi-device pairing flow', () => {
  test('full lifecycle: setup → join → switch team → reconnect → chain-invite', async ({ browser, baseURL }) => {
    const cloudAlpha: WebDavRouteState = createWebDavRouteState();
    const cloudBeta: WebDavRouteState = createWebDavRouteState();

    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const ctx3 = await browser.newContext();
    const ctx4 = await browser.newContext();

    try {
      for (const ctx of [ctx1, ctx2, ctx3, ctx4]) {
        await attachWebDavRouteMock(ctx, cloudAlpha, '/__dav_alpha__');
        await attachWebDavRouteMock(ctx, cloudBeta, '/__dav_beta__');
      }

      const page1 = await ctx1.newPage();
      const page2 = await ctx2.newPage();
      const page3 = await ctx3.newPage();
      const page4 = await ctx4.newPage();

      const harness = `${baseURL}/packages/interocitor/tests/e2e/fixtures/harness-plain.html`;
      await Promise.all([
        page1.goto(harness), page2.goto(harness),
        page3.goto(harness), page4.goto(harness),
      ]);

      const allDbs = ['team-alpha', 'team-beta'];
      await Promise.all([
        clearAllLocalState(page1, allDbs),
        clearAllLocalState(page2, allDbs),
        clearAllLocalState(page3, allDbs),
        clearAllLocalState(page4, allDbs),
      ]);

      // ──────────────────────────────────────────────────────────────
      // STEP 1: Device 1 — master setup for team-alpha (encrypted)
      // ──────────────────────────────────────────────────────────────

      const step1 = await page1.evaluate(async () => {
        const { SyncEngine, readColumn } = await import('/packages/interocitor/dist/index.js');
        const { WebDAVAdapter } = await import('/packages/interocitor/dist/adapters/webdav.js');

        const adapter = new WebDAVAdapter({
          baseUrl: `${location.origin}/__dav_alpha__`,
          auth: { username: 'u', password: 'p' },
        });

        const engine = new SyncEngine(adapter, {
          remotePath: '/TeamAlpha',
          dbName: 'team-alpha',
          deviceId: 'device_1',
          encrypted: true,
          pollInterval: 600_000,
          flushDebounce: 60_000,
          flushThreshold: 999,
        });
        await engine.init();
        await engine.connect();

        await engine.put('projects', 'proj_1', { name: 'Secret Project', budget: 100000 });
        await engine.put('projects', 'proj_2', { name: 'Internal Tool', budget: 5000 });
        await engine.flush();

        const deviceId = engine.getDeviceId();
        const meshId = engine.getMeshId();
        const rows = await engine.query('projects');
        const passphrase = engine.getPassphrase();

        await engine.disconnect();

        return {
          deviceId,
          meshId,
          rowCount: rows.length,
          names: rows.map((r: any) => readColumn(r, 'name')).sort(),
          passphrase,
        };
      });

      expect(step1.deviceId).toBe('device_1');
      expect(step1.meshId).toBeTruthy();
      expect(step1.rowCount).toBe(2);
      expect(step1.names).toEqual(['Internal Tool', 'Secret Project']);

      const alphaMeshId = step1.meshId!;
      const alphaPassphrase = step1.passphrase;

      // ──────────────────────────────────────────────────────────────
      // STEP 2: Device 2 joins Device 1 via handshake (share flow)
      //
      // Device 1 generates "share" QR.
      // Device 2 scans it and receives credentials.
      // They communicate via relay files on cloudAlpha.
      // ──────────────────────────────────────────────────────────────

      // Phase A: Device 1 starts the share — returns QR payload and
      // begins waiting for scanner. We don't await complete() yet.
      const step2_qr = await page1.evaluate(async (alphaPassphrase: string) => {
        const { generateShareQR } = await import('/packages/interocitor/dist/index.js');
        const { WebDAVAdapter } = await import('/packages/interocitor/dist/adapters/webdav.js');

        const adapter = new WebDAVAdapter({
          baseUrl: `${location.origin}/__dav_alpha__`,
          auth: { username: 'u', password: 'p' },
        });

        const { qrPayload, complete } = await generateShareQR({
          adapter,
          relayBase: '/TeamAlpha',
          remotePath: '/TeamAlpha',
          passphrase: alphaPassphrase,
          pollIntervalMs: 50,
          timeoutMs: 15_000,
        });

        // Stash complete() on window so we can call it later.
        (window as any).__hsComplete = complete;

        return qrPayload;
      }, alphaPassphrase);

      // Phase B: Device 2 scans the QR, receives credentials, connects.
      // Meanwhile Device 1's complete() is waiting for scanner-pub.
      const [, step2_device2] = await Promise.all([
        // Device 1: finish the handshake.
        page1.evaluate(async () => {
          await (window as any).__hsComplete();
        }),
        // Device 2: scan and join.
        page2.evaluate(async (payload: any) => {
          const { SyncEngine, readColumn, handleScannedQR } =
            await import('/packages/interocitor/dist/index.js');
          const { WebDAVAdapter } = await import('/packages/interocitor/dist/adapters/webdav.js');

          const adapter = new WebDAVAdapter({
            baseUrl: `${location.origin}/__dav_alpha__`,
            auth: { username: 'u', password: 'p' },
          });

          const credentials = await handleScannedQR({
            adapter,
            relayBase: '/TeamAlpha',
            payload,
            pollIntervalMs: 50,
            timeoutMs: 15_000,
          });

          if (!credentials) return { error: 'no credentials' };

          const engine = new SyncEngine(adapter, {
            remotePath: credentials.remotePath,
            dbName: 'team-alpha',
            deviceId: 'device_2',
            passphrase: credentials.passphrase,
            pollInterval: 600_000,
            flushDebounce: 60_000,
            flushThreshold: 999,
          });
          await engine.init();
          await engine.connect();

          const deviceId = engine.getDeviceId();
          const meshId = engine.getMeshId();
          const rows = await engine.query('projects');

          await engine.disconnect();

          return {
            remotePath: credentials.remotePath,
            deviceId,
            meshId,
            rowCount: rows.length,
            names: rows.map((r: any) => readColumn(r, 'name')).sort(),
          };
        }, step2_qr),
      ]);

      expect(step2_device2.deviceId).toBe('device_2');
      expect(step2_device2.meshId).toBe(alphaMeshId);
      expect(step2_device2.rowCount).toBe(2);
      expect(step2_device2.names).toEqual(['Internal Tool', 'Secret Project']);
      expect(step2_device2.remotePath).toBe('/TeamAlpha');

      // ──────────────────────────────────────────────────────────────
      // STEP 3: Device 3 creates team-beta. Device 2 switches teams.
      //         Old team-alpha data must NOT appear in team-beta.
      // ──────────────────────────────────────────────────────────────

      // Device 3: setup team-beta + generate share QR
      const step3_qr = await page3.evaluate(async () => {
        const { SyncEngine, generateShareQR } = await import('/packages/interocitor/dist/index.js');
        const { WebDAVAdapter } = await import('/packages/interocitor/dist/adapters/webdav.js');

        const adapter = new WebDAVAdapter({
          baseUrl: `${location.origin}/__dav_beta__`,
          auth: { username: 'u', password: 'p' },
        });

        const engine = new SyncEngine(adapter, {
          remotePath: '/TeamBeta',
          dbName: 'team-beta',
          deviceId: 'device_3',
          encrypted: true,
          pollInterval: 600_000,
          flushDebounce: 60_000,
          flushThreshold: 999,
        });
        await engine.init();
        await engine.connect();

        await engine.put('projects', 'beta_1', { name: 'Public Launch', budget: 50000 });
        await engine.flush();

        const meshId = engine.getMeshId();
        const passphrase = engine.getPassphrase();

        const { qrPayload, complete } = await generateShareQR({
          adapter,
          relayBase: '/TeamBeta',
          remotePath: '/TeamBeta',
          passphrase,
          pollIntervalMs: 50,
          timeoutMs: 15_000,
        });

        (window as any).__hsComplete = complete;

        await engine.disconnect();

        return { meshId, qrPayload };
      });

      const betaMeshId = step3_qr.meshId!;
      expect(betaMeshId).toBeTruthy();
      expect(betaMeshId).not.toBe(alphaMeshId);

      // Device 2: local reset + join team-beta
      const [, step3_device2] = await Promise.all([
        page3.evaluate(async () => { await (window as any).__hsComplete(); }),
        page2.evaluate(async (payload: any) => {
          const { SyncEngine, readColumn, handleScannedQR } =
            await import('/packages/interocitor/dist/index.js');
          const { WebDAVAdapter } = await import('/packages/interocitor/dist/adapters/webdav.js');

          const adapter = new WebDAVAdapter({
            baseUrl: `${location.origin}/__dav_beta__`,
            auth: { username: 'u', password: 'p' },
          });

          const credentials = await handleScannedQR({
            adapter,
            relayBase: '/TeamBeta',
            payload,
            pollIntervalMs: 50,
            timeoutMs: 15_000,
          });

          if (!credentials) return { error: 'no credentials' };

          // DIFFERENT dbName — team-beta is a separate database.
          const engine = new SyncEngine(adapter, {
            remotePath: credentials.remotePath,
            dbName: 'team-beta',
            deviceId: 'device_2',
            passphrase: credentials.passphrase,
            pollInterval: 600_000,
            flushDebounce: 60_000,
            flushThreshold: 999,
          });
          await engine.init();
          await engine.connect();

          const meshId = engine.getMeshId();
          const rows = await engine.query('projects');
          const betaNames = rows.map((r: any) => readColumn(r, 'name')).sort();

          await engine.disconnect();

          // Verify isolation: team-alpha local DB is untouched.
          const alphaEngine = new SyncEngine(new (await import('/packages/interocitor/dist/adapters/webdav.js')).WebDAVAdapter({
            baseUrl: `${location.origin}/__dav_alpha__`,
            auth: { username: 'u', password: 'p' },
          }), {
            remotePath: '/TeamAlpha',
            dbName: 'team-alpha',
            pollInterval: 600_000,
          });
          await alphaEngine.init();
          const alphaRows = await alphaEngine.query('projects');
          const alphaNames = alphaRows.map((r: any) => readColumn(r, 'name')).sort();
          await alphaEngine.disconnect();

          return {
            meshId,
            betaNames,
            betaRowCount: rows.length,
            alphaNames,
            alphaRowCount: alphaRows.length,
            remotePath: credentials.remotePath,
          };
        }, step3_qr.qrPayload),
      ]);

      expect(step3_device2.meshId).toBe(betaMeshId);
      expect(step3_device2.betaRowCount).toBe(1);
      expect(step3_device2.betaNames).toEqual(['Public Launch']);
      expect(step3_device2.remotePath).toBe('/TeamBeta');
      // Old data still in its own local DB — isolated, not leaked.
      expect(step3_device2.alphaRowCount).toBe(2);
      expect(step3_device2.alphaNames).toEqual(['Internal Tool', 'Secret Project']);

      // ──────────────────────────────────────────────────────────────
      // STEP 4: Device 2 reconnects to team-alpha.
      //         Must restore the old key — without it, data is lost.
      // ──────────────────────────────────────────────────────────────

      const step4 = await page2.evaluate(async (alphaPassphrase: string) => {
        const { SyncEngine, readColumn } = await import('/packages/interocitor/dist/index.js');
        const { WebDAVAdapter } = await import('/packages/interocitor/dist/adapters/webdav.js');

        const adapter = new WebDAVAdapter({
          baseUrl: `${location.origin}/__dav_alpha__`,
          auth: { username: 'u', password: 'p' },
        });
        const engine = new SyncEngine(adapter, {
          remotePath: '/TeamAlpha',
          dbName: 'team-alpha',
          deviceId: 'device_2',
          passphrase: alphaPassphrase,
          pollInterval: 600_000,
          flushDebounce: 60_000,
          flushThreshold: 999,
        });
        await engine.init();
        await engine.connect();

        const rows = await engine.query('projects');
        const names = rows.map((r: any) => readColumn(r, 'name')).sort();
        const meshId = engine.getMeshId();

        // Write something new — device 2 is back in the game.
        await engine.put('projects', 'proj_3', { name: 'Comeback Feature', budget: 7500 });
        await engine.flush();

        await engine.disconnect();
        return { meshId, names, rowCount: rows.length };
      }, alphaPassphrase);

      expect(step4.meshId).toBe(alphaMeshId);
      expect(step4.rowCount).toBe(2);
      expect(step4.names).toEqual(['Internal Tool', 'Secret Project']);

      // Verify Device 1 sees the new row.
      const step4_verify = await page1.evaluate(async (alphaPassphrase: string) => {
        const { SyncEngine, readColumn } = await import('/packages/interocitor/dist/index.js');
        const { WebDAVAdapter } = await import('/packages/interocitor/dist/adapters/webdav.js');

        const adapter = new WebDAVAdapter({
          baseUrl: `${location.origin}/__dav_alpha__`,
          auth: { username: 'u', password: 'p' },
        });
        const engine = new SyncEngine(adapter, {
          remotePath: '/TeamAlpha',
          dbName: 'team-alpha',
          deviceId: 'device_1',
          passphrase: alphaPassphrase,
          pollInterval: 600_000,
          flushDebounce: 60_000,
          flushThreshold: 999,
        });
        await engine.init();
        await engine.connect();

        const rows = await engine.query('projects');
        const names = rows.map((r: any) => readColumn(r, 'name')).sort();

        await engine.disconnect();
        return { names, rowCount: rows.length };
      }, alphaPassphrase);

      expect(step4_verify.rowCount).toBe(3);
      expect(step4_verify.names).toEqual(['Comeback Feature', 'Internal Tool', 'Secret Project']);

      // ──────────────────────────────────────────────────────────────
      // STEP 5: Device 2 invites Device 4 into team-alpha.
      //         Chain-invite: device 2 is NOT the original creator
      //         but has the credentials and can share them.
      // ──────────────────────────────────────────────────────────────

      // Device 2: generate share QR for team-alpha.
      const step5_qr = await page2.evaluate(async (alphaPassphrase: string) => {
        const { generateShareQR } = await import('/packages/interocitor/dist/index.js');
        const { WebDAVAdapter } = await import('/packages/interocitor/dist/adapters/webdav.js');

        const adapter = new WebDAVAdapter({
          baseUrl: `${location.origin}/__dav_alpha__`,
          auth: { username: 'u', password: 'p' },
        });

        const { qrPayload, complete } = await generateShareQR({
          adapter,
          relayBase: '/TeamAlpha',
          remotePath: '/TeamAlpha',
          passphrase: alphaPassphrase,
          pollIntervalMs: 50,
          timeoutMs: 15_000,
        });

        (window as any).__hsComplete = complete;
        return qrPayload;
      }, alphaPassphrase);

      // Device 4: scan and join.
      const [, step5_device4] = await Promise.all([
        page2.evaluate(async () => { await (window as any).__hsComplete(); }),
        page4.evaluate(async (payload: any) => {
          const { SyncEngine, readColumn, handleScannedQR } =
            await import('/packages/interocitor/dist/index.js');
          const { WebDAVAdapter } = await import('/packages/interocitor/dist/adapters/webdav.js');

          const adapter = new WebDAVAdapter({
            baseUrl: `${location.origin}/__dav_alpha__`,
            auth: { username: 'u', password: 'p' },
          });

          const credentials = await handleScannedQR({
            adapter,
            relayBase: '/TeamAlpha',
            payload,
            pollIntervalMs: 50,
            timeoutMs: 15_000,
          });

          if (!credentials) return { error: 'no credentials' };

          const engine = new SyncEngine(adapter, {
            remotePath: credentials.remotePath,
            dbName: 'team-alpha',
            deviceId: 'device_4',
            passphrase: credentials.passphrase,
            pollInterval: 600_000,
            flushDebounce: 60_000,
            flushThreshold: 999,
          });
          await engine.init();
          await engine.connect();

          const deviceId = engine.getDeviceId();
          const meshId = engine.getMeshId();
          const rows = await engine.query('projects');
          const names = rows.map((r: any) => readColumn(r, 'name')).sort();

          await engine.disconnect();

          return {
            deviceId,
            meshId,
            remotePath: credentials.remotePath,
            rowCount: rows.length,
            names,
          };
        }, step5_qr),
      ]);

      expect(step5_device4.deviceId).toBe('device_4');
      expect(step5_device4.meshId).toBe(alphaMeshId);
      expect(step5_device4.remotePath).toBe('/TeamAlpha');
      expect(step5_device4.rowCount).toBe(3);
      expect(step5_device4.names).toEqual(['Comeback Feature', 'Internal Tool', 'Secret Project']);

      // ──────────────────────────────────────────────────────────────
      // FINAL: Cross-cloud pollution check.
      //
      // Data is encrypted, so we can't check plaintext in cloud dumps.
      // Instead verify structural isolation:
      //   - cloudAlpha only has /TeamAlpha/ paths
      //   - cloudBeta only has /TeamBeta/ paths
      //   - each cloud has change files (data was actually written)
      // ──────────────────────────────────────────────────────────────

      const alphaPaths = [...cloudAlpha.files.keys()];
      const betaPaths = [...cloudBeta.files.keys()];

      // Every file in cloudAlpha is under /TeamAlpha/
      for (const p of alphaPaths) {
        expect(p).toMatch(/^\/TeamAlpha\//);
      }
      // Every file in cloudBeta is under /TeamBeta/
      for (const p of betaPaths) {
        expect(p).toMatch(/^\/TeamBeta\//);
      }

      // Both clouds have change files (actual data was written)
      const alphaChanges = alphaPaths.filter(p => p.includes('/changes/') && p.endsWith('.json') && !p.endsWith('head.json'));
      const betaChanges = betaPaths.filter(p => p.includes('/changes/') && p.endsWith('.json') && !p.endsWith('head.json'));
      expect(alphaChanges.length).toBeGreaterThanOrEqual(3); // proj_1, proj_2, proj_3
      expect(betaChanges.length).toBeGreaterThanOrEqual(1); // beta_1

      // No /TeamBeta/ paths in cloudAlpha and vice versa
      expect(alphaPaths.some(p => p.startsWith('/TeamBeta/'))).toBe(false);
      expect(betaPaths.some(p => p.startsWith('/TeamAlpha/'))).toBe(false);

    } finally {
      await Promise.all([ctx1.close(), ctx2.close(), ctx3.close(), ctx4.close()]);
    }
  });
});
