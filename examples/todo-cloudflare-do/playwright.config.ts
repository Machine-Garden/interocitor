import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

const STATIC_PORT = Number(process.env.PLAYWRIGHT_CF_STATIC_PORT || "4174");
const WORKER_PORT = Number(process.env.PLAYWRIGHT_CF_WORKER_PORT || "8788");
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const serverEntry = fileURLToPath(new URL("../../tools/webdav-server/server.mjs", import.meta.url));

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["*.e2e.spec.ts"],
  timeout: 45_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${STATIC_PORT}`,
    trace: "on-first-retry",
  },
  webServer: [
    {
      command: `PORT=${STATIC_PORT} node ${JSON.stringify(serverEntry)} --mode=memory`,
      url: `http://127.0.0.1:${STATIC_PORT}`,
      reuseExistingServer: false,
      timeout: 10_000,
    },
    {
      command: `yarn workspace @interocitor/workers build && yarn --cwd examples/todo-cloudflare-do db:prepare:local:test && PORT=${WORKER_PORT} yarn --cwd examples/todo-cloudflare-do dev:test`,
      url: `http://127.0.0.1:${WORKER_PORT}/todo-interocitor/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      cwd: repoRoot,
    },
  ],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
