/**
 * Handshake integration tests against a real Cloudflare Worker backend.
 *
 * The Cloudflare example Playwright config starts the Worker, provisions its
 * local schema, and runs this suite with the other release-gating scenarios.
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

import { expect, test, type Page } from "@playwright/test";
import {
  CF_TESTS_ENABLED,
  CF_WORKER_BASE_URL,
  makeNamespace,
  meshBearerForNamespace,
} from "./playwright.helpers";

// ─── Config ──────────────────────────────────────────────────────────

/**
 * Base path on the worker used for relay + coordination files.
 * Must be a path the worker accepts for generic PUT/GET/DELETE.
 * Kept short so it does not match any mesh-specific path classifiers.
 */
const RELAY_BASE = "/hs-test";

function createWorkerRoute(label: string): {
  workerBaseUrl: string;
  token: string;
  remotePath: string;
} {
  const namespace = makeNamespace();
  return {
    workerBaseUrl: `${CF_WORKER_BASE_URL}/io/${encodeURIComponent(namespace)}`,
    token: meshBearerForNamespace(namespace),
    remotePath: `/mesh/${label}-${Date.now()}`,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

async function setupPage(page: Page): Promise<void> {
  await page.goto("/packages/core/tests/e2e/fixtures/harness-plain.html");
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

test.skip(
  !CF_TESTS_ENABLED,
  "Cloudflare example e2e is opt-in; set RUN_CF_EXAMPLE_TESTS=1 to execute it.",
);

test.describe("Handshake via Cloudflare Worker relay", () => {
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

  test("share flow: scanner receives correct remotePath and passphrase", async () => {
    const route = createWorkerRoute("share");

    const [shareResult, scanResult] = await Promise.all([
      // Generator (pageA): has credentials, shows "share" QR
      pageA.evaluate(
        async ({ workerBaseUrl, relayBase, tok, remotePath }) => {
          const { CloudflareAdapter } = await import("/packages/core/dist/adapters/cloudflare.js");
          const { generateShareQR } = await import("/packages/core/dist/index.js");
          const { generateKey, keyToPassphrase } =
            await import("/packages/core/dist/crypto/keys.js");

          const adapter = new CloudflareAdapter({
            baseUrl: workerBaseUrl,
            token: tok,
          });
          await adapter.authenticate();

          const key = await generateKey();
          const passphrase = await keyToPassphrase(key);
          const share = await generateShareQR({
            adapter,
            relayBase,
            remotePath,
            passphrase,
            pollIntervalMs: 500,
            timeoutMs: 30_000,
          });

          // Publish QR to coordination path so pageB can find it
          await adapter.writeFile(
            `${relayBase}/__qr__/${share.qrPayload.handshakeId}`,
            share.qrEncoded,
          );

          // Wait for pageB to complete the handshake
          await share.complete();

          return {
            remotePath,
            passphrase,
            handshakeId: share.qrPayload.handshakeId,
          };
        },
        {
          workerBaseUrl: route.workerBaseUrl,
          relayBase: RELAY_BASE,
          tok: route.token,
          remotePath: route.remotePath,
        },
      ),

      // Scanner (pageB): scans the QR, receives credentials
      pageB.evaluate(
        async ({ workerBaseUrl, relayBase, tok, pollForQRSrc }) => {
          const { CloudflareAdapter } = await import("/packages/core/dist/adapters/cloudflare.js");
          const { handleScannedQR, decodeQRPayload } = await import("/packages/core/dist/index.js");

          const adapter = new CloudflareAdapter({
            baseUrl: workerBaseUrl,
            token: tok,
          });
          await adapter.authenticate();

          // Evaluate the polling helper in this scope
          const pollForQR = new Function(`${pollForQRSrc}; return pollForQR;`)() as (
            adapter: unknown,
            relayBase: string,
          ) => Promise<string>;

          const qrEncoded = await pollForQR(adapter, relayBase);
          const payload = decodeQRPayload(qrEncoded);
          const received = await handleScannedQR({
            adapter,
            relayBase,
            payload,
            pollIntervalMs: 500,
            timeoutMs: 30_000,
          });

          if (!received) throw new Error("share flow: expected credentials");
          return {
            remotePath: received.remotePath,
            passphrase: received.passphrase,
          };
        },
        {
          workerBaseUrl: route.workerBaseUrl,
          relayBase: RELAY_BASE,
          tok: route.token,
          pollForQRSrc: POLL_FOR_QR,
        },
      ),
    ]);

    expect(scanResult.remotePath).toBe(shareResult.remotePath);
    expect(scanResult.passphrase).toBe(shareResult.passphrase);
  });

  test("share flow: unencrypted mesh — passphrase is null, remotePath delivered", async () => {
    const route = createWorkerRoute("plain");

    const [shareResult, scanResult] = await Promise.all([
      pageA.evaluate(
        async ({ workerBaseUrl, relayBase, tok, remotePath }) => {
          const { CloudflareAdapter } = await import("/packages/core/dist/adapters/cloudflare.js");
          const { generateShareQR } = await import("/packages/core/dist/index.js");

          const adapter = new CloudflareAdapter({
            baseUrl: workerBaseUrl,
            token: tok,
          });
          await adapter.authenticate();

          const share = await generateShareQR({
            adapter,
            relayBase,
            remotePath,
            passphrase: null,
            pollIntervalMs: 500,
            timeoutMs: 30_000,
          });
          await adapter.writeFile(
            `${relayBase}/__qr__/${share.qrPayload.handshakeId}`,
            share.qrEncoded,
          );
          await share.complete();
          return { remotePath };
        },
        {
          workerBaseUrl: route.workerBaseUrl,
          relayBase: RELAY_BASE,
          tok: route.token,
          remotePath: route.remotePath,
        },
      ),

      pageB.evaluate(
        async ({ workerBaseUrl, relayBase, tok, pollForQRSrc }) => {
          const { CloudflareAdapter } = await import("/packages/core/dist/adapters/cloudflare.js");
          const { handleScannedQR, decodeQRPayload } = await import("/packages/core/dist/index.js");

          const adapter = new CloudflareAdapter({
            baseUrl: workerBaseUrl,
            token: tok,
          });
          await adapter.authenticate();

          const pollForQR = new Function(`${pollForQRSrc}; return pollForQR;`)() as (
            adapter: unknown,
            relayBase: string,
          ) => Promise<string>;

          const payload = decodeQRPayload(await pollForQR(adapter, relayBase));
          const received = await handleScannedQR({
            adapter,
            relayBase,
            payload,
            pollIntervalMs: 500,
            timeoutMs: 30_000,
          });
          return { remotePath: received!.remotePath, hasPassphrase: received!.passphrase !== null };
        },
        {
          workerBaseUrl: route.workerBaseUrl,
          relayBase: RELAY_BASE,
          tok: route.token,
          pollForQRSrc: POLL_FOR_QR,
        },
      ),
    ]);

    expect(scanResult.remotePath).toBe(shareResult.remotePath);
    expect(scanResult.hasPassphrase).toBe(false);
  });

  // ── join flow ─────────────────────────────────────────────────────

  test("join flow: generator receives credentials pushed by scanner", async () => {
    const route = createWorkerRoute("join");

    const [joinResult, scanResult] = await Promise.all([
      // Generator (pageB): wants credentials, shows "join" QR
      pageB.evaluate(
        async ({ workerBaseUrl, relayBase, tok }) => {
          const { CloudflareAdapter } = await import("/packages/core/dist/adapters/cloudflare.js");
          const { generateJoinQR } = await import("/packages/core/dist/index.js");

          const adapter = new CloudflareAdapter({
            baseUrl: workerBaseUrl,
            token: tok,
          });
          await adapter.authenticate();

          const join = await generateJoinQR({
            adapter,
            relayBase,
            pollIntervalMs: 500,
            timeoutMs: 30_000,
          });

          // Publish QR for the scanner
          await adapter.writeFile(
            `${relayBase}/__qr__/${join.qrPayload.handshakeId}`,
            join.qrEncoded,
          );

          const received = await join.credentials;
          return {
            remotePath: received.remotePath,
            passphrase: received.passphrase,
          };
        },
        { workerBaseUrl: route.workerBaseUrl, relayBase: RELAY_BASE, tok: route.token },
      ),

      // Scanner (pageA): has credentials, pushes them
      pageA.evaluate(
        async ({ workerBaseUrl, relayBase, tok, remotePath, pollForQRSrc }) => {
          const { CloudflareAdapter } = await import("/packages/core/dist/adapters/cloudflare.js");
          const { handleScannedQR, decodeQRPayload } = await import("/packages/core/dist/index.js");
          const { generateKey, keyToPassphrase } =
            await import("/packages/core/dist/crypto/keys.js");

          const adapter = new CloudflareAdapter({
            baseUrl: workerBaseUrl,
            token: tok,
          });
          await adapter.authenticate();

          const key = await generateKey();
          const passphrase = await keyToPassphrase(key);

          const pollForQR = new Function(`${pollForQRSrc}; return pollForQR;`)() as (
            adapter: unknown,
            relayBase: string,
          ) => Promise<string>;

          const payload = decodeQRPayload(await pollForQR(adapter, relayBase));
          await handleScannedQR({
            adapter,
            relayBase,
            payload,
            ownCredentials: { remotePath, passphrase },
            pollIntervalMs: 500,
            timeoutMs: 30_000,
          });

          return { remotePath, passphrase };
        },
        {
          workerBaseUrl: route.workerBaseUrl,
          relayBase: RELAY_BASE,
          tok: route.token,
          remotePath: route.remotePath,
          pollForQRSrc: POLL_FOR_QR,
        },
      ),
    ]);

    expect(joinResult.remotePath).toBe(scanResult.remotePath);
    expect(joinResult.passphrase).toBe(scanResult.passphrase);
  });

  // ── relay cleanup ─────────────────────────────────────────────────

  test("relay files are deleted from CF backend after successful handshake", async () => {
    const route = createWorkerRoute("cleanup");

    const [shareResult] = await Promise.all([
      pageA.evaluate(
        async ({ workerBaseUrl, relayBase, tok, remotePath }) => {
          const { CloudflareAdapter } = await import("/packages/core/dist/adapters/cloudflare.js");
          const { generateShareQR } = await import("/packages/core/dist/index.js");
          const { generateKey, keyToPassphrase } =
            await import("/packages/core/dist/crypto/keys.js");

          const adapter = new CloudflareAdapter({
            baseUrl: workerBaseUrl,
            token: tok,
          });
          await adapter.authenticate();

          const key = await generateKey();
          const passphrase = await keyToPassphrase(key);
          const share = await generateShareQR({
            adapter,
            relayBase,
            remotePath,
            passphrase,
            pollIntervalMs: 500,
            timeoutMs: 30_000,
          });
          await adapter.writeFile(
            `${relayBase}/__qr__/${share.qrPayload.handshakeId}`,
            share.qrEncoded,
          );
          await share.complete();
          return { handshakeId: share.qrPayload.handshakeId };
        },
        {
          workerBaseUrl: route.workerBaseUrl,
          relayBase: RELAY_BASE,
          tok: route.token,
          remotePath: route.remotePath,
        },
      ),

      pageB.evaluate(
        async ({ workerBaseUrl, relayBase, tok, pollForQRSrc }) => {
          const { CloudflareAdapter } = await import("/packages/core/dist/adapters/cloudflare.js");
          const { handleScannedQR, decodeQRPayload } = await import("/packages/core/dist/index.js");

          const adapter = new CloudflareAdapter({
            baseUrl: workerBaseUrl,
            token: tok,
          });
          await adapter.authenticate();

          const pollForQR = new Function(`${pollForQRSrc}; return pollForQR;`)() as (
            adapter: unknown,
            relayBase: string,
          ) => Promise<string>;

          const payload = decodeQRPayload(await pollForQR(adapter, relayBase));
          await handleScannedQR({
            adapter,
            relayBase,
            payload,
            pollIntervalMs: 500,
            timeoutMs: 30_000,
          });
        },
        {
          workerBaseUrl: route.workerBaseUrl,
          relayBase: RELAY_BASE,
          tok: route.token,
          pollForQRSrc: POLL_FOR_QR,
        },
      ),
    ]);

    // Allow cleanup to propagate
    await pageA.waitForTimeout(500);

    const relayFilesGone = await pageA.evaluate(
      async ({ workerBaseUrl, relayBase, tok, handshakeId }) => {
        const { CloudflareAdapter } = await import("/packages/core/dist/adapters/cloudflare.js");
        const adapter = new CloudflareAdapter({
          baseUrl: workerBaseUrl,
          token: tok,
        });
        await adapter.authenticate();
        try {
          const files = await adapter.listFiles(`${relayBase}/handshake/${handshakeId}`);
          return files.length === 0;
        } catch {
          return true; // 404 = already gone
        }
      },
      {
        workerBaseUrl: route.workerBaseUrl,
        relayBase: RELAY_BASE,
        tok: route.token,
        handshakeId: shareResult.handshakeId,
      },
    );

    expect(relayFilesGone).toBe(true);
  });

  // ── timeout ──────────────────────────────────────────────────────

  test("share times out when scanner never appears", async () => {
    const route = createWorkerRoute("timeout");

    const errorMsg = await pageA.evaluate(
      async ({ workerBaseUrl, relayBase, tok, remotePath }) => {
        const { CloudflareAdapter } = await import("/packages/core/dist/adapters/cloudflare.js");
        const { generateShareQR } = await import("/packages/core/dist/index.js");
        const { generateKey, keyToPassphrase } = await import("/packages/core/dist/crypto/keys.js");

        const adapter = new CloudflareAdapter({
          baseUrl: workerBaseUrl,
          token: tok,
        });
        await adapter.authenticate();

        const key = await generateKey();
        const passphrase = await keyToPassphrase(key);
        const share = await generateShareQR({
          adapter,
          relayBase,
          remotePath,
          passphrase,
          pollIntervalMs: 200,
          timeoutMs: 800,
        });

        try {
          await share.complete();
          return "no-error";
        } catch (e) {
          return (e as Error).message;
        }
      },
      {
        workerBaseUrl: route.workerBaseUrl,
        relayBase: RELAY_BASE,
        tok: route.token,
        remotePath: route.remotePath,
      },
    );

    expect(errorMsg).toContain("timed out");
  });

  test("join times out when scanner never appears", async () => {
    const route = createWorkerRoute("join-timeout");

    const errorMsg = await pageA.evaluate(
      async ({ workerBaseUrl, relayBase, tok }) => {
        const { CloudflareAdapter } = await import("/packages/core/dist/adapters/cloudflare.js");
        const { generateJoinQR } = await import("/packages/core/dist/index.js");

        const adapter = new CloudflareAdapter({
          baseUrl: workerBaseUrl,
          token: tok,
        });
        await adapter.authenticate();

        const join = await generateJoinQR({
          adapter,
          relayBase,
          pollIntervalMs: 200,
          timeoutMs: 800,
        });

        try {
          await join.credentials;
          return "no-error";
        } catch (e) {
          return (e as Error).message;
        }
      },
      { workerBaseUrl: route.workerBaseUrl, relayBase: RELAY_BASE, tok: route.token },
    );

    expect(errorMsg).toContain("timed out");
  });
});
