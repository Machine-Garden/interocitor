import { createHash } from 'node:crypto';
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

export const CF_TESTS_ENABLED = Boolean(process.env.RUN_CF_EXAMPLE_TESTS);
export const CF_POLL_INTERVAL_MS = 250;
export const CF_WORKER_BASE_URL = `http://127.0.0.1:${process.env.PLAYWRIGHT_CF_WORKER_PORT || '8788'}/todo-interocitor`;
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
    await window.__todoDemo.createSession({ namespace, remotePath: remotePath || '/todo-app', token, workerBaseUrl });
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
      configure(options: { pollInterval?: number }): { pollInterval: number };
      getShareToken(): string;
      getStatus(): string;
    };
  }
}
