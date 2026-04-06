import { expect, test } from '@playwright/test';

test('TODO demo shares join token across tabs and syncs over local WebDAV', async ({ browser, baseURL }) => {
  const context = await browser.newContext();

  try {
    const tabA = await context.newPage();
    const tabB = await context.newPage();

    await tabA.goto(`${baseURL}/examples/todo-webdav/index.html`);
    await tabB.goto(`${baseURL}/examples/todo-webdav/index.html`);

    const token = await tabA.evaluate(async () => {
      await window.__todoDemo.createSession();
      return window.__todoDemo.getShareToken();
    });

    expect(token).toContain('"remotePath"');
    expect(token).toContain('"key"');

    await tabB.evaluate((raw) => {
      window.__todoDemo.applyToken(raw);
    }, token);

    await tabA.evaluate(async () => {
      await window.__todoDemo.connect();
    });
    await tabB.evaluate(async () => {
      await window.__todoDemo.connect();
    });

    await tabA.evaluate(async () => {
      await window.__todoDemo.addTask('from tab a');
    });

    const titlesOnB = await tabB.evaluate(async () => {
      await window.__todoDemo.disconnect();
      await window.__todoDemo.connect();
      const items = await window.__todoDemo.refreshTasks();
      return items.map(item => String(item.title));
    });

    expect(titlesOnB).toContain('from tab a');
  } finally {
    await context.close();
  }
});

test('local WebDAV server supports multiple remote paths without cross-talk', async ({ browser, baseURL }) => {
  const context = await browser.newContext();

  try {
    const tabA = await context.newPage();
    const tabB = await context.newPage();

    await tabA.goto(`${baseURL}/examples/todo-webdav/index.html`);
    await tabB.goto(`${baseURL}/examples/todo-webdav/index.html`);

    const tokenA = await tabA.evaluate(async () => {
      await window.__todoDemo.createSession();
      return window.__todoDemo.getShareToken();
    });

    const tokenB = await tabB.evaluate(async () => {
      await window.__todoDemo.createSession();
      return window.__todoDemo.getShareToken();
    });

    expect(tokenA).not.toBe(tokenB);

    await tabA.evaluate((raw) => {
      window.__todoDemo.applyToken(raw);
    }, tokenA);

    await tabB.evaluate((raw) => {
      window.__todoDemo.applyToken(raw);
    }, tokenB);

    await tabA.evaluate(async () => {
      await window.__todoDemo.connect();
      await window.__todoDemo.addTask('only path A');
    });

    await tabB.evaluate(async () => {
      await window.__todoDemo.connect();
      await window.__todoDemo.addTask('only path B');
    });

    const state = await Promise.all([
      tabA.evaluate(async () => {
        const items = await window.__todoDemo.refreshTasks();
        return items.map(item => String(item.title));
      }),
      tabB.evaluate(async () => {
        const items = await window.__todoDemo.refreshTasks();
        return items.map(item => String(item.title));
      }),
    ]);

    expect(state[0]).toContain('only path A');
    expect(state[0]).not.toContain('only path B');
    expect(state[1]).toContain('only path B');
    expect(state[1]).not.toContain('only path A');
  } finally {
    await context.close();
  }
});

declare global {
  interface Window {
    __todoDemo: {
      createSession(): Promise<unknown>;
      applyToken(raw: string): unknown;
      connect(): Promise<void>;
      disconnect(): Promise<void>;
      addTask(title: string): Promise<void>;
      refreshTasks(): Promise<Array<{ title?: unknown }>>;
      getShareToken(): string;
      getSession(): { baseUrl: string; remotePath: string; key: string };
    };
  }
}

