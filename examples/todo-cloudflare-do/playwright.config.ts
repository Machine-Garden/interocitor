import { defineConfig, devices } from '@playwright/test';

const STATIC_PORT = Number(process.env.PLAYWRIGHT_CF_STATIC_PORT || '4174');
const WORKER_PORT = Number(process.env.PLAYWRIGHT_CF_WORKER_PORT || '8788');

export default defineConfig({
  testDir: '.',
  testMatch: ['*.e2e.spec.ts'],
  timeout: 45_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${STATIC_PORT}`,
    trace: 'on-first-retry',
  },
  webServer: [
    {
      command: `PORT=${STATIC_PORT} yarn --cwd ../.. test:e2e:server`,
      url: `http://127.0.0.1:${STATIC_PORT}`,
      reuseExistingServer: true,
      timeout: 10_000,
    },
    {
      command: `sh -c 'node --check ../../packages/interocitor-workers/src/index.js && npx wrangler d1 migrations apply TODO_DB --local --config wrangler.playwright.toml && npx wrangler dev --config wrangler.playwright.toml --port ${WORKER_PORT} --persist-to .wrangler/state'`,
      url: `http://127.0.0.1:${WORKER_PORT}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
