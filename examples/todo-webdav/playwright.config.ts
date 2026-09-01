import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

const port = Number(process.env.PLAYWRIGHT_TODO_WEBDAV_PORT || "4175");
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const serverEntry = fileURLToPath(new URL("../../tools/webdav-server/server.mjs", import.meta.url));

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["todo-webdav.spec.ts"],
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "on-first-retry",
  },
  webServer: {
    command: `PORT=${port} node ${JSON.stringify(serverEntry)} --mode=memory`,
    url: `http://127.0.0.1:${port}/examples/todo-webdav/index.html`,
    reuseExistingServer: false,
    timeout: 10_000,
    cwd: repoRoot,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
