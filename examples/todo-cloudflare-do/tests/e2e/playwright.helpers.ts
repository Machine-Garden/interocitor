import { createHash, createHmac, randomBytes } from 'node:crypto';
import { type Browser, type BrowserContext, type Page } from '@playwright/test';

export const CF_TESTS_ENABLED = Boolean(process.env.RUN_CF_EXAMPLE_TESTS);
export const CF_POLL_INTERVAL_MS = 250;
export const CF_WORKER_BASE_URL = `http://127.0.0.1:${process.env.PLAYWRIGHT_CF_WORKER_PORT || '8788'}/todo-interocitor`;
export const CF_ACCESS_SECRET = process.env.PLAYWRIGHT_CF_ACCESS_SECRET || 'playwright-access-secret';
export const CF_SYSTEM_SECRET = process.env.PLAYWRIGHT_CF_SYSTEM_SECRET || 'playwright-system-secret';
export const CF_MESH_SECRET = process.env.PLAYWRIGHT_CF_MESH_SECRET || 'replace-with-production-mesh-secret';

/** Generate a UUIDv7 (matches `packages/workers/src/ids.ts`). */
function uuidv7(): string {
  const now = Date.now();
  const tsBytes = Buffer.alloc(6);
  let ts = now;
  for (let i = 5; i >= 0; i--) { tsBytes[i] = ts & 0xff; ts = Math.floor(ts / 256); }
  const rand = randomBytes(10);
  const bytes = Buffer.concat([tsBytes, rand]);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Mint a strict mesh-id (`<uuidv7>.<hmac-tag>`) using the dev mesh secret.
 * Matches `validateMeshPrefix` in the worker, so the resulting id passes the
 * fast-fail integrity check at request entry. The optional `_label` argument
 * is accepted for backward compatibility with older test code; it is ignored
 * since strict prefixes have no human-readable component.
 */
export function makeNamespace(_label = 'team-cf'): string {
  const id = uuidv7();
  const sig = createHmac('sha256', CF_MESH_SECRET).update(id).digest();
  const tag = sig.subarray(0, 8).toString('base64url');
  return `${id}.${tag}`;
}

export function accessTokenForNamespace(namespace: string): string {
  return createHash('sha256').update(`${namespace}${CF_ACCESS_SECRET}`).digest('hex');
}

/** Tamper a strict mesh-id by flipping the last char of the HMAC tag. */
export function tamperNamespace(namespace: string): string {
  const last = namespace.slice(-1);
  const flipped = last === 'A' ? 'B' : 'A';
  return namespace.slice(0, -1) + flipped;
}

export async function openDemo(page: Page, baseURL: string): Promise<void> {
  await page.goto(`${baseURL}/examples/todo-cloudflare-do/index.html`);
}

export async function createSession(
  page: Page,
  options: { namespace: string; remotePath?: string; token?: string; workerBaseUrl?: string; pollInterval?: number; relayEnabled?: boolean; relayHealthyPollInterval?: number },
): Promise<string> {
  return await page.evaluate(async ({ namespace, remotePath, token, workerBaseUrl, pollInterval, relayEnabled, relayHealthyPollInterval }) => {
    window.__todoDemo.configure({ pollInterval, relayEnabled, relayHealthyPollInterval });
    await window.__todoDemo.createSession({ namespace, remotePath: remotePath || '/todo-app', token, workerBaseUrl });
    return window.__todoDemo.getShareToken();
  }, {
    namespace: options.namespace,
    remotePath: options.remotePath ?? '/todo-app',
    token: options.token ?? '',
    workerBaseUrl: options.workerBaseUrl ?? CF_WORKER_BASE_URL,
    pollInterval: options.pollInterval ?? CF_POLL_INTERVAL_MS,
    relayEnabled: options.relayEnabled ?? true,
    relayHealthyPollInterval: options.relayHealthyPollInterval ?? 300_000,
  });
}

export async function applySession(page: Page, token: string, pollInterval = CF_POLL_INTERVAL_MS, relayEnabled = true, relayHealthyPollInterval = 300_000): Promise<void> {
  await page.evaluate(({ raw, pollInterval: nextPollInterval, relayEnabled: nextRelayEnabled, relayHealthyPollInterval: nextRelayHealthyPollInterval }) => {
    window.__todoDemo.configure({ pollInterval: nextPollInterval, relayEnabled: nextRelayEnabled, relayHealthyPollInterval: nextRelayHealthyPollInterval });
    window.__todoDemo.applyToken(raw);
  }, { raw: token, pollInterval, relayEnabled, relayHealthyPollInterval });
}

export async function connectDemo(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.__todoDemo.connect();
  });
}

export async function connectDemoExpectError(page: Page): Promise<string> {
  return await page.evaluate(async () => {
    try {
      await window.__todoDemo.connect();
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });
}

export async function addTask(page: Page, title: string): Promise<void> {
  await page.evaluate(async (taskTitle) => {
    await window.__todoDemo.addTask(taskTitle);
  }, title);
}

export async function compactDemo(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.__todoDemo.compact();
  });
}

export async function getTitles(page: Page): Promise<string[]> {
  return await page.evaluate(async () => {
    const items = await window.__todoDemo.refreshTasks();
    return items.map((item) => String(item.title ?? ''));
  });
}

export async function getStatus(page: Page): Promise<string> {
  return await page.evaluate(() => window.__todoDemo.getStatus());
}

export async function waitForEvent(page: Page, eventName: string, timeoutMs = 5_000): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const status = await getStatus(page);
    if (status.includes('Connected:')) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

export async function newDemoPages(browser: Browser, baseURL: string, count: number): Promise<{ context: BrowserContext; pages: Page[] }> {
  const context = await browser.newContext();
  const pages = await Promise.all(Array.from({ length: count }, async () => context.newPage()));
  await Promise.all(pages.map((page) => openDemo(page, baseURL)));
  return { context, pages };
}

declare global {
  interface Window {
    __todoDemo: {
      createSession(overrides?: { workerBaseUrl?: string; namespace?: string; remotePath?: string; token?: string }): Promise<unknown>;
      applyToken(raw: string): unknown;
      connect(): Promise<void>;
      disconnect(): Promise<void>;
      addTask(title: string): Promise<void>;
      refreshTasks(): Promise<Array<{ title?: unknown }>>;
      compact(): Promise<void>;
      configure(options: { pollInterval?: number; relayEnabled?: boolean; relayHealthyPollInterval?: number }): { pollInterval: number; relayEnabled: boolean; relayHealthyPollInterval: number };
      getShareToken(): string;
      getStatus(): string;
      resetRequestStats(): void;
      getRequestStats(): { fetch: Record<string, number>; websocket: { opened: number; messages: number; closed: number; errors: number } };
    };
  }
}
