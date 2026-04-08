import { createHash } from 'node:crypto';
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

export const CF_TESTS_ENABLED = Boolean(process.env.RUN_CF_EXAMPLE_TESTS);
export const CF_POLL_INTERVAL_MS = 10 * 60 * 1000;
export const CF_SSE_TIMEOUT_MS = 5_000;
export const CF_WORKER_BASE_URL = `http://127.0.0.1:${process.env.PLAYWRIGHT_CF_WORKER_PORT || '8788'}`;
export const CF_ACCESS_SECRET = process.env.PLAYWRIGHT_CF_ACCESS_SECRET || 'playwright-access-secret';
export const CF_SYSTEM_SECRET = process.env.PLAYWRIGHT_CF_SYSTEM_SECRET || 'playwright-system-secret';

export function makeNamespace(prefix = 'team-cf'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function accessTokenForNamespace(namespace: string): string {
  return createHash('sha256').update(`${namespace}${CF_ACCESS_SECRET}`).digest('hex');
}

export async function openDemo(page: Page, baseURL: string): Promise<void> {
  await page.goto(`${baseURL}/examples/todo-cloudflare-do/index.html`);
}

export async function createSession(
  page: Page,
  options: { namespace: string; remotePath?: string; token?: string; workerBaseUrl?: string; pollInterval?: number },
): Promise<string> {
  return await page.evaluate(async ({ namespace, remotePath, token, workerBaseUrl, pollInterval }) => {
    window.__todoDemo.configure({ pollInterval });
    await window.__todoDemo.createSession({
      namespace,
      remotePath: remotePath || '/todo-app',
      token,
      workerBaseUrl,
    });
    return window.__todoDemo.getShareToken();
  }, {
    namespace: options.namespace,
    remotePath: options.remotePath ?? '/todo-app',
    token: options.token ?? '',
    workerBaseUrl: options.workerBaseUrl ?? CF_WORKER_BASE_URL,
    pollInterval: options.pollInterval ?? CF_POLL_INTERVAL_MS,
  });
}

export async function applySession(page: Page, token: string, pollInterval = CF_POLL_INTERVAL_MS): Promise<void> {
  await page.evaluate(({ raw, pollInterval: nextPollInterval }) => {
    window.__todoDemo.configure({ pollInterval: nextPollInterval });
    window.__todoDemo.applyToken(raw);
  }, { raw: token, pollInterval });
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

export async function waitForSseReady(page: Page): Promise<boolean> {
  return await page.evaluate(async () => await window.__todoDemo.waitForSseReady());
}

export async function waitForAllSseReady(pages: Page[]): Promise<void> {
  await expect.poll(async () => {
    return await Promise.all(pages.map((page) => waitForSseReady(page)));
  }, {
    timeout: 5_000,
    message: 'Expected all Cloudflare demo tabs to establish SSE subscriptions.',
  }).toEqual(pages.map(() => true));
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

export async function waitForTitle(page: Page, title: string, timeout = CF_SSE_TIMEOUT_MS): Promise<void> {
  await expect.poll(async () => await getTitles(page), {
    timeout,
    intervals: [100, 250, 500],
    message: `Expected Cloudflare demo tab to show task title ${title}.`,
  }).toContain(title);
}

export async function waitForEvent(page: Page, type: string, timeoutMs = 5_000): Promise<boolean> {
  return await page.evaluate(async ({ eventType, timeoutMs: timeout }) => {
    return await window.__todoDemo.waitForEvent(eventType, timeout);
  }, { eventType: type, timeoutMs });
}

export async function clearEvents(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__todoDemo.clearEvents();
  });
}

async function executeControl(namespace: string, payload: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${CF_WORKER_BASE_URL}/__interocitor/system/${encodeURIComponent(namespace)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CF_SYSTEM_SECRET}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`Cloudflare control op failed: HTTP ${res.status}`);
  }

  return await res.json().catch(() => ({}));
}

export async function resetRealtime(namespace: string): Promise<unknown> {
  return await executeControl(namespace, { op: 'drop-sse-clients' });
}

export async function getStatus(page: Page): Promise<string> {
  return await page.evaluate(() => window.__todoDemo.getStatus());
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
      configure(options: { pollInterval?: number }): { pollInterval: number };
      getShareToken(): string;
      getStatus(): string;
      waitForSseReady(timeoutMs?: number): Promise<boolean>;
      getEventTypes(): string[];
      clearEvents(): void;
      waitForEvent(type: string, timeoutMs?: number): Promise<boolean>;
    };
  }
}
