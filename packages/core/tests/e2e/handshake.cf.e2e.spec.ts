/**
 * Handshake integration tests against a real Cloudflare Worker backend.
 *
 * Opt-in: set RUN_CF_HANDSHAKE_TESTS=1 to execute.
 * Requires the CF worker from examples/todo-cloudflare-do to be running
 * locally via `wrangler dev` (see that package's README).
 *
 * Environment variables:
 *   PLAYWRIGHT_CF_WORKER_PORT   Worker port          (default: 8788)
 *   PLAYWRIGHT_CF_WORKER_PATH   Worker path prefix   (default: /todo-interocitor)
 *   PLAYWRIGHT_CF_ACCESS_SECRET HMAC secret for token derivation
 *                               (default: playwright-access-secret)
 *
 * Coordination pattern:
 *   The two browser pages (simulating two devices) need to exchange the QR
 *   payload before the scan side can start. They do this via a short-lived
 *   coordination file written to the relay backend itself:
 *
 *     {RELAY_BASE}/__qr__/{handshakeId}  ← generator writes QR string here
 *
 *   The scanner polls this path, reads the QR, then starts the ECDH exchange.
 *   Both sides run their page.evaluate() concurrently inside Promise.all().
 *
 * Relay files end up at:
 *   {RELAY_BASE}/handshake/{handshakeId}/scanner-pub.json
 *   {RELAY_BASE}/handshake/{handshakeId}/credentials.json
 */

import { expect, test, type Page } from '@playwright/test';
function bytesToHex(b: Uint8Array): string {
  return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
}


// ─── Config ──────────────────────────────────────────────────────────

const CF_TESTS_ENABLED = Boolean(process.env.RUN_CF_HANDSHAKE_TESTS);
const CF_WORKER_PORT   = process.env.PLAYWRIGHT_CF_WORKER_PORT  || '8788';
const CF_WORKER_PATH   = process.env.PLAYWRIGHT_CF_WORKER_PATH  || '/todo-interocitor';
const CF_ACCESS_SECRET = process.env.PLAYWRIGHT_CF_ACCESS_SECRET || 'playwright-access-secret';

const CF_WORKER_BASE_URL = `http://127.0.0.1:${CF_WORKER_PORT}${CF_WORKER_PATH}`;

/**
 * Base path on the worker used for relay + coordination files.
 * Must be a path the worker accepts for generic PUT/GET/DELETE.
 * Kept short so it does not match any mesh-specific path classifiers.
 */
const RELAY_BASE = '/hs-test';

// ─── Helpers ─────────────────────────────────────────────────────────

async function setupPage(page: Page): Promise<void> {
  await page.goto('/packages/core/tests/e2e/fixtures/harness.html');
}

/** Derive a deterministic bearer token for a namespace (matches CF worker HMAC check). */
async function tokenFor(namespace: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    'raw', enc.encode(CF_ACCESS_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await globalThis.crypto.subtle.sign('HMAC', key, enc.encode(namespace));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Shared scanner-side poll loop: waits for the generator to publish the QR
 * string to {relayBase}/__qr__/{any file}, reads it, deletes it, returns it.
 * Inlined into page.evaluate() as a self-contained string so Playwright can
 * serialise it into the browser context.
 */
const POLL_FOR_QR = /* js */ `
  async function pollForQR(adapter, relayBase) {
    const coordBase = relayBase + '/__qr__';
    const deadline  = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const files = await adapter.listFiles(coordBase);
        if (files.length > 0) {
          const bytes = await adapter.readFile(files[0].path);
          adapter.deleteFile(files[0].path).catch(() => {});
          return new TextDecoder().decode(bytes);
        }
      } catch { /* path not yet created */ }
      await new Promise(r => setTimeout(r, 300));
    }
    throw new Error('Timed out waiting for QR coordination file');
  }
`;

// ─── Fixtures ────────────────────────────────────────────────────────

test.skip(!CF_TESTS_ENABLED, 'CF handshake e2e is opt-in; set RUN_CF_HANDSHAKE_TESTS=1 to run.');

test.describe('Handshake via Cloudflare Worker relay', () => {
  let pageA: Page;
  let pageB: Page;

  test.beforeEach(async ({ browser }) => {
    const ctx = await browser.newContext();
    [pageA, pageB] = await Promise.all([ctx.newPage(), ctx.newPage()]);
    await Promise.all([setupPage(pageA), setupPage(pageB)]);
  });

  test.afterEach(async () => {
    await Promise.all([pageA.close(), pageB.close()]).catch(() => {});
  });

  // ── share flow ────────────────────────────────────────────────────

  test('share flow: scanner receives correct remotePath and meshKey', async () => {
    const ns     = `hs-share-${Date.now()}`;
    const token  = await tokenFor(ns);
    const remote = `/mesh/${ns}`;

    const [shareResult, scanResult] = await Promise.all([
      // Generator (pageA): has credentials, shows "share" QR
      pageA.evaluate(async ({ workerBaseUrl, relayBase, tok, remotePath }) => {
        const { CloudflareAdapter } = await import('/packages/core/dist/adapters/cloudflare.js');
        const { generateShareQR }   = await import('/packages/core/dist/index.js');
        const { generateKey, keyToPassphrase } = await import('/packages/core/dist/crypto/keys.js');

        const adapter = new CloudflareAdapter({ baseUrl: `${workerBaseUrl}/io${relayBase}`, token: tok });
        await adapter.authenticate();

        const key = await generateKey();
        const passphrase = await keyToPassphrase(key);
        const share   = await generateShareQR({
          adapter, relayBase, remotePath, passphrase,
          pollIntervalMs: 500, timeoutMs: 30_000,
        });

        // Publish QR to coordination path so pageB can find it
        await adapter.writeFile(`${relayBase}/__qr__/${share.qrPayload.handshakeId}`, share.qrEncoded);

        // Wait for pageB to complete the handshake
        await share.complete();

        return { remotePath, passphraseHex: bytesToHex(new TextEncoder().encode(passphrase)), handshakeId: share.qrPayload.handshakeId };
      }, { workerBaseUrl: CF_WORKER_BASE_URL, relayBase: RELAY_BASE, tok: token, remotePath: remote }),

      // Scanner (pageB): scans the QR, receives credentials
      pageB.evaluate(async ({ workerBaseUrl, relayBase, tok, pollForQRSrc }) => {
        const { CloudflareAdapter } = await import('/packages/core/dist/adapters/cloudflare.js');
        const { handleScannedQR, decodeQRPayload } = await import('/packages/core/dist/index.js');

        const adapter = new CloudflareAdapter({ baseUrl: `${workerBaseUrl}/io${relayBase}`, token: tok });
        await adapter.authenticate();

        // Evaluate the polling helper in this scope
        const pollForQR = new Function(`${pollForQRSrc}; return pollForQR;`)() as
          (adapter: unknown, relayBase: string) => Promise<string>;

        const qrEncoded = await pollForQR(adapter, relayBase);
        const payload   = decodeQRPayload(qrEncoded);
        const received  = await handleScannedQR({
          adapter, relayBase, payload,
          pollIntervalMs: 500, timeoutMs: 30_000,
        });

        if (!received) throw new Error('share flow: expected credentials');
        return { remotePath: received.remotePath, passphraseHex: bytesToHex(new TextEncoder().encode(received.passphrase!)) };
      }, { workerBaseUrl: CF_WORKER_BASE_URL, relayBase: RELAY_BASE, tok: token, pollForQRSrc: POLL_FOR_QR }),
    ]);

    expect(scanResult.remotePath).toBe(shareResult.remotePath);
    expect(scanResult.passphraseHex).toBe(shareResult.passphraseHex);
  });

  test('share flow: unencrypted mesh — meshKey is null, remotePath delivered', async () => {
    const ns     = `hs-plain-${Date.now()}`;
    const token  = await tokenFor(ns);
    const remote = `/mesh/${ns}`;

    const [shareResult, scanResult] = await Promise.all([
      pageA.evaluate(async ({ workerBaseUrl, relayBase, tok, remotePath }) => {
        const { CloudflareAdapter } = await import('/packages/core/dist/adapters/cloudflare.js');
        const { generateShareQR }   = await import('/packages/core/dist/index.js');

        const adapter = new CloudflareAdapter({ baseUrl: `${workerBaseUrl}/io${relayBase}`, token: tok });
        await adapter.authenticate();

        const share = await generateShareQR({
          adapter, relayBase, remotePath, passphrase: null,
          pollIntervalMs: 500, timeoutMs: 30_000,
        });
        await adapter.writeFile(`${relayBase}/__qr__/${share.qrPayload.handshakeId}`, share.qrEncoded);
        await share.complete();
        return { remotePath };
      }, { workerBaseUrl: CF_WORKER_BASE_URL, relayBase: RELAY_BASE, tok: token, remotePath: remote }),

      pageB.evaluate(async ({ workerBaseUrl, relayBase, tok, pollForQRSrc }) => {
        const { CloudflareAdapter } = await import('/packages/core/dist/adapters/cloudflare.js');
        const { handleScannedQR, decodeQRPayload } = await import('/packages/core/dist/index.js');

        const adapter = new CloudflareAdapter({ baseUrl: `${workerBaseUrl}/io${relayBase}`, token: tok });
        await adapter.authenticate();

        const pollForQR = new Function(`${pollForQRSrc}; return pollForQR;`)() as
          (adapter: unknown, relayBase: string) => Promise<string>;

        const payload  = decodeQRPayload(await pollForQR(adapter, relayBase));
        const received = await handleScannedQR({
          adapter, relayBase, payload,
          pollIntervalMs: 500, timeoutMs: 30_000,
        });
        return { remotePath: received!.remotePath, hasPassphrase: received!.passphrase !== null };
      }, { workerBaseUrl: CF_WORKER_BASE_URL, relayBase: RELAY_BASE, tok: token, pollForQRSrc: POLL_FOR_QR }),
    ]);

    expect(scanResult.remotePath).toBe(shareResult.remotePath);
    expect(scanResult.hasPassphrase).toBe(false);
  });

  // ── join flow ─────────────────────────────────────────────────────

  test('join flow: generator receives credentials pushed by scanner', async () => {
    const ns     = `hs-join-${Date.now()}`;
    const token  = await tokenFor(ns);
    const remote = `/mesh/${ns}`;

    const [joinResult, scanResult] = await Promise.all([
      // Generator (pageB): wants credentials, shows "join" QR
      pageB.evaluate(async ({ workerBaseUrl, relayBase, tok }) => {
        const { CloudflareAdapter } = await import('/packages/core/dist/adapters/cloudflare.js');
        const { generateJoinQR }    = await import('/packages/core/dist/index.js');

        const adapter = new CloudflareAdapter({ baseUrl: `${workerBaseUrl}/io${relayBase}`, token: tok });
        await adapter.authenticate();

        const join = await generateJoinQR({ adapter, relayBase, pollIntervalMs: 500, timeoutMs: 30_000 });

        // Publish QR for the scanner
        await adapter.writeFile(`${relayBase}/__qr__/${join.qrPayload.handshakeId}`, join.qrEncoded);

        const received = await join.credentials;
        return { remotePath: received.remotePath, passphraseHex: bytesToHex(new TextEncoder().encode(received.passphrase!)) };
      }, { workerBaseUrl: CF_WORKER_BASE_URL, relayBase: RELAY_BASE, tok: token }),

      // Scanner (pageA): has credentials, pushes them
      pageA.evaluate(async ({ workerBaseUrl, relayBase, tok, remotePath, pollForQRSrc }) => {
        const { CloudflareAdapter } = await import('/packages/core/dist/adapters/cloudflare.js');
        const { handleScannedQR, decodeQRPayload } = await import('/packages/core/dist/index.js');
        const { generateKey, keyToPassphrase } = await import('/packages/core/dist/crypto/keys.js');

        const adapter = new CloudflareAdapter({ baseUrl: `${workerBaseUrl}/io${relayBase}`, token: tok });
        await adapter.authenticate();

        const key = await generateKey();
        const passphrase = await keyToPassphrase(key);

        const pollForQR = new Function(`${pollForQRSrc}; return pollForQR;`)() as
          (adapter: unknown, relayBase: string) => Promise<string>;

        const payload = decodeQRPayload(await pollForQR(adapter, relayBase));
        await handleScannedQR({
          adapter, relayBase, payload,
          ownCredentials: { remotePath, passphrase },
          pollIntervalMs: 500, timeoutMs: 30_000,
        });

        return { remotePath, passphraseHex: bytesToHex(new TextEncoder().encode(passphrase)) };
      }, { workerBaseUrl: CF_WORKER_BASE_URL, relayBase: RELAY_BASE, tok: token, remotePath: remote, pollForQRSrc: POLL_FOR_QR }),
    ]);

    expect(joinResult.remotePath).toBe(scanResult.remotePath);
    expect(joinResult.passphraseHex).toBe(scanResult.passphraseHex);
  });

  // ── relay cleanup ─────────────────────────────────────────────────

  test('relay files are deleted from CF backend after successful handshake', async () => {
    const ns     = `hs-cleanup-${Date.now()}`;
    const token  = await tokenFor(ns);
    const remote = `/mesh/${ns}`;

    const [shareResult] = await Promise.all([
      pageA.evaluate(async ({ workerBaseUrl, relayBase, tok, remotePath }) => {
        const { CloudflareAdapter } = await import('/packages/core/dist/adapters/cloudflare.js');
        const { generateShareQR }   = await import('/packages/core/dist/index.js');
        const { generateKey, keyToPassphrase }       = await import('/packages/core/dist/crypto/keys.js');

        const adapter = new CloudflareAdapter({ baseUrl: `${workerBaseUrl}/io${relayBase}`, token: tok });
        await adapter.authenticate();

        const key = await generateKey();
        const passphrase = await keyToPassphrase(key);
        const share = await generateShareQR({
          adapter, relayBase, remotePath, passphrase,
          pollIntervalMs: 500, timeoutMs: 30_000,
        });
        await adapter.writeFile(`${relayBase}/__qr__/${share.qrPayload.handshakeId}`, share.qrEncoded);
        await share.complete();
        return { handshakeId: share.qrPayload.handshakeId };
      }, { workerBaseUrl: CF_WORKER_BASE_URL, relayBase: RELAY_BASE, tok: token, remotePath: remote }),

      pageB.evaluate(async ({ workerBaseUrl, relayBase, tok, pollForQRSrc }) => {
        const { CloudflareAdapter } = await import('/packages/core/dist/adapters/cloudflare.js');
        const { handleScannedQR, decodeQRPayload } = await import('/packages/core/dist/index.js');

        const adapter = new CloudflareAdapter({ baseUrl: `${workerBaseUrl}/io${relayBase}`, token: tok });
        await adapter.authenticate();

        const pollForQR = new Function(`${pollForQRSrc}; return pollForQR;`)() as
          (adapter: unknown, relayBase: string) => Promise<string>;

        const payload = decodeQRPayload(await pollForQR(adapter, relayBase));
        await handleScannedQR({ adapter, relayBase, payload, pollIntervalMs: 500, timeoutMs: 30_000 });
      }, { workerBaseUrl: CF_WORKER_BASE_URL, relayBase: RELAY_BASE, tok: token, pollForQRSrc: POLL_FOR_QR }),
    ]);

    // Allow cleanup to propagate
    await pageA.waitForTimeout(500);

    const relayFilesGone = await pageA.evaluate(async ({ workerBaseUrl, relayBase, tok, handshakeId }) => {
      const { CloudflareAdapter } = await import('/packages/core/dist/adapters/cloudflare.js');
      const adapter = new CloudflareAdapter({ baseUrl: `${workerBaseUrl}/io${relayBase}`, token: tok });
      await adapter.authenticate();
      try {
        const files = await adapter.listFiles(`${relayBase}/handshake/${handshakeId}`);
        return files.length === 0;
      } catch {
        return true; // 404 = already gone
      }
    }, { workerBaseUrl: CF_WORKER_BASE_URL, relayBase: RELAY_BASE, tok: token, handshakeId: shareResult.handshakeId });

    expect(relayFilesGone).toBe(true);
  });

  // ── timeout ──────────────────────────────────────────────────────

  test('share times out when scanner never appears', async () => {
    const ns    = `hs-timeout-${Date.now()}`;
    const token = await tokenFor(ns);

    const errorMsg = await pageA.evaluate(async ({ workerBaseUrl, relayBase, tok }) => {
      const { CloudflareAdapter } = await import('/packages/core/dist/adapters/cloudflare.js');
      const { generateShareQR }   = await import('/packages/core/dist/index.js');
      const { generateKey, keyToPassphrase }       = await import('/packages/core/dist/crypto/keys.js');

      const adapter = new CloudflareAdapter({ baseUrl: `${workerBaseUrl}/io${relayBase}`, token: tok });
      await adapter.authenticate();

      const key = await generateKey();
      const passphrase = await keyToPassphrase(key);
      const share = await generateShareQR({
        adapter, relayBase, remotePath: '/nowhere', passphrase,
        pollIntervalMs: 200, timeoutMs: 800,
      });

      try   { await share.complete(); return 'no-error'; }
      catch (e) { return (e as Error).message; }
    }, { workerBaseUrl: CF_WORKER_BASE_URL, relayBase: RELAY_BASE, tok: token });

    expect(errorMsg).toContain('timed out');
  });

  test('join times out when scanner never appears', async () => {
    const ns    = `hs-join-timeout-${Date.now()}`;
    const token = await tokenFor(ns);

    const errorMsg = await pageA.evaluate(async ({ workerBaseUrl, relayBase, tok }) => {
      const { CloudflareAdapter } = await import('/packages/core/dist/adapters/cloudflare.js');
      const { generateJoinQR }    = await import('/packages/core/dist/index.js');

      const adapter = new CloudflareAdapter({ baseUrl: `${workerBaseUrl}/io${relayBase}`, token: tok });
      await adapter.authenticate();

      const join = await generateJoinQR({
        adapter, relayBase,
        pollIntervalMs: 200, timeoutMs: 800,
      });

      try   { await join.credentials; return 'no-error'; }
      catch (e) { return (e as Error).message; }
    }, { workerBaseUrl: CF_WORKER_BASE_URL, relayBase: RELAY_BASE, tok: token });

    expect(errorMsg).toContain('timed out');
  });
});
