import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PLAYWRIGHT_WEBDAV_PORT || '4174');

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: true,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry',
  },
  webServer: {
    command: `PORT=${PORT} yarn test:e2e:server`,
    url: `http://127.0.0.1:${PORT}`,
    // Always launch the test server so e2e uses in-memory WebDAV storage only.
    reuseExistingServer: false,
    timeout: 10_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});

