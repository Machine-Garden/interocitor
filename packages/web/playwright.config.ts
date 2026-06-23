import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PLAYWRIGHT_WEBDAV_PORT || '4175');
const serverEntry = fileURLToPath(new URL('../webdav/server.mjs', import.meta.url));

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
    command: `PORT=${PORT} node ${JSON.stringify(serverEntry)} --mode=memory`,
    url: `http://127.0.0.1:${PORT}`,
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

