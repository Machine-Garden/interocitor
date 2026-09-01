# Test an Interocitor product

This how-to shows how an application that uses Interocitor can test its own
behavior. Most tests need no Interocitor server at all: they use a local-only,
in-memory engine. Run the local Interocitor WebDAV server only when the
behavior under test crosses the mailbox boundary.

Use the level that matches the behavior under test:

- **unit, component, and Storybook behavior:** create an engine with
  `MemoryLocalStore` and no remote adapter. This works in Jest, browser-based
  Playwright tests, and Storybook; it needs no Interocitor server.
- **server-backed behavior:** run the repository's private
  `@interocitor/webdav-server` tool in memory mode and point
  the product's real `WebDAVAdapter` at it. Use this for connection, flush,
  pull, encrypted-file, and mailbox integration tests.
- **browser persistence and custody:** use Playwright with the product's
  normal `IndexedDbLocalStore`, credential configuration, and optional local
  WebDAV server. Use this for browser-owned behavior such as IndexedDB,
  credentials, and image URLs.

The server is a mailbox: it stores transport artifacts and never reads or
merges product data. Server-backed tests exercise the real client protocol
against a real HTTP endpoint; the other layers do not require a remote at all.

TypeScript and TSX blocks on this page are illustrative product templates.
They use current Interocitor APIs but omit each product's schema modules,
components, provider, environment switch, and test configuration. Shell
commands are runnable after installing the listed package in the product.

## 1. Test local behavior without a server

For code that does not need a remote connection, use `MemoryLocalStore` and
omit the adapter. This tests the same table API that the product uses in the
browser, without IndexedDB or HTTP.

```ts
import {
  Interocitor,
  MemoryLocalStore,
  types,
  type DatabaseSchemaDefinition,
} from "@interocitor/core";

const schema = {
  tables: {
    tasks: {
      fields: {
        title: types.string,
        done: types.boolean,
      },
    },
  },
} satisfies DatabaseSchemaDefinition;

test("marks a task complete locally", async () => {
  const db = new Interocitor({
    dbName: "task-test",
    schema,
    localStore: new MemoryLocalStore(),
    keySource: null,
  });

  await db.init();
  const id = await db.table("tasks").add({ title: "Ship it", done: false });
  await db.table("tasks").patch(id, { done: true });

  await expect(db.table("tasks").row(id)).resolves.toMatchObject({
    title: "Ship it",
    done: true,
  });

  await db.disconnect();
});
```

`MemoryLocalStore` is isolated to that engine and is cleared by `disconnect()`.
`keySource: null` deliberately creates an unencrypted test mesh. Keep
production encryption enabled in product code. For encryption coverage, pass a
test-only fixed `PortablePassphraseKeySource` instead.

The same setup works in a browser. Use it for Playwright component tests or a
test-only app mode that does not cover browser persistence or remote sync:

```ts
// product/src/interocitor.test.ts
import { Interocitor, MemoryLocalStore } from "@interocitor/core";
import { schema } from "./schema";

export function createLocalTestDb() {
  return new Interocitor({
    dbName: "product-test",
    schema,
    localStore: new MemoryLocalStore(),
    keySource: null,
  });
}
```

Inject this factory at the product boundary rather than mocking Interocitor
methods. A Jest test, a Playwright component test, and a Storybook decorator
can therefore exercise the real table and React-hook behavior with the same
zero-server configuration.

## 2. Use local-only mode from Playwright

Playwright does not need an Interocitor service for ordinary UI tests. Start
only the product app, configured to use `createLocalTestDb()` above.

```ts
// playwright.config.ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  webServer: {
    command: "INTEROCITOR_MODE=local yarn dev --port 3000",
    url: "http://127.0.0.1:3000",
  },
  use: { baseURL: "http://127.0.0.1:3000" },
});
```

The product owns the `INTEROCITOR_MODE` switch; it selects its local test
factory rather than an `IndexedDbLocalStore` and remote adapter. The test is
otherwise a normal user-facing Playwright test.

```ts
import { expect, test } from "@playwright/test";

test("creates a task without a mailbox server", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Task title").fill("Ship it");
  await page.getByRole("button", { name: "Add task" }).click();
  await expect(page.getByText("Ship it")).toBeVisible();
});
```

Use a new browser context or reload the app between tests if the product keeps
the local test engine alive. Its state is intentionally process-local, not
durable browser state.

## 3. Use local-only mode in Storybook

Storybook is another component-test environment. Decorate stories with an
initialized in-memory engine and the product's typed Interocitor provider; no
Interocitor server, IndexedDB, or credential store is required.

```tsx
// .storybook/InterocitorStoryProvider.tsx
import { useEffect, useMemo, useState, type PropsWithChildren } from "react";
import { Interocitor, MemoryLocalStore } from "@interocitor/core";
import { InterocitorProvider } from "../src/interocitor-context";
import { schema } from "../src/schema";

export function InterocitorStoryProvider({ children }: PropsWithChildren) {
  const db = useMemo(
    () =>
      new Interocitor({
        dbName: "storybook",
        schema,
        localStore: new MemoryLocalStore(),
        keySource: null,
      }),
    [],
  );
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    void db.init().then(() => {
      if (active) setReady(true);
    });
    return () => {
      active = false;
      void db.disconnect();
    };
  }, [db]);

  return ready ? <InterocitorProvider value={db}>{children}</InterocitorProvider> : null;
}
```

Use it as a decorator:

```tsx
// TaskList.stories.tsx
import type { Meta } from "@storybook/react";
import { InterocitorStoryProvider } from "../.storybook/InterocitorStoryProvider";
import { TaskList } from "./TaskList";

export default {
  component: TaskList,
  decorators: [
    (Story) => (
      <InterocitorStoryProvider>
        <Story />
      </InterocitorStoryProvider>
    ),
  ],
} satisfies Meta<typeof TaskList>;
```

Seed story data after `db.init()` in a story-specific wrapper. Keep the seed
local and deterministic; stories should not connect to a shared mesh.

## 4. Run the local mailbox for server-backed tests

From the repository root, start the private local server:

```bash
PORT=4174 node tools/webdav-server/server.mjs --mode=memory
```

The endpoint is `http://127.0.0.1:4174/__webdav__`. The local server accepts
any Basic-auth credentials; use fixed test-only credentials. In CI, start and
stop this process in the runner's global setup/teardown or service step. Do
not point tests at a personal or shared WebDAV account.

Give every test a unique `dbName` and `remotePath`. The server keeps its
in-memory mailbox for its process lifetime, so a unique remote path prevents
parallel tests from sharing a mesh.

```ts
import {
  Interocitor,
  MemoryLocalStore,
  types,
  type DatabaseSchemaDefinition,
} from "@interocitor/core";
import { WebDAVAdapter } from "@interocitor/core/adapters/webdav";

const schema = {
  tables: {
    tasks: { fields: { title: types.string } },
  },
} satisfies DatabaseSchemaDefinition;

function openServerBackedDb(testId: string) {
  const db = new Interocitor(
    new WebDAVAdapter({
      baseUrl: process.env.INTEROCITOR_WEBDAV_URL ?? "http://127.0.0.1:4174/__webdav__",
      auth: { username: "test", password: "test" },
    }),
    {
      dbName: `product-test-${testId}`,
      remotePath: `/product-tests/${testId}`,
      schema,
      localStore: new MemoryLocalStore(),
      keySource: null,
      batchWindowMs: 0,
      pollInterval: 60_000,
    },
  );

  return db;
}

test("flushes a product write to the local mailbox", async () => {
  const db = openServerBackedDb("create-task");
  await db.init();
  await db.connect();

  await db.table("tasks").add({ title: "Use the real local server" });
  await db.flush();

  await expect(db.table("tasks").query()).resolves.toHaveLength(1);
  await db.disconnect();
});
```

Use `await db.flush()` after a write when the assertion concerns the remote
mailbox. It drains the local outbox immediately, avoiding timer-based tests.
Use `await db.pull()` only when the test has arranged for the server state to
change outside that engine.

## 5. Use the same server from Playwright

Run the product's web app and the local mailbox as Playwright web servers.
The app should use its normal browser configuration, except that its test
configuration supplies the local WebDAV endpoint and test credentials.

```ts
// playwright.config.ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  webServer: [
    {
      command: "yarn dev --port 3000",
      url: "http://127.0.0.1:3000",
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "PORT=4174 node tools/webdav-server/server.mjs --mode=memory",
      url: "http://127.0.0.1:4174",
      reuseExistingServer: !process.env.CI,
    },
  ],
  use: {
    baseURL: "http://127.0.0.1:3000",
  },
});
```

In each test, create a new browser context and let the product bootstrap its
own `IndexedDbLocalStore` and credentials. Use a per-test app namespace or
remote path if the product exposes one. Close the context in `finally` so
IndexedDB handles and object URLs are released.

```ts
import { expect, test } from "@playwright/test";

test("creates a task while connected to local Interocitor", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto("/?testMesh=task-create");

    await page.getByLabel("Task title").fill("Ship it");
    await page.getByRole("button", { name: "Add task" }).click();

    await expect(page.getByText("Ship it")).toBeVisible();
  } finally {
    await context.close();
  }
});
```

Keep the test focused on a product outcome. There is no need to manufacture a
network or emulate a second device: when the product needs server behavior,
the active local Interocitor server is the integration boundary.

## Jest and module setup

`@interocitor/core` is ESM and uses standard Web APIs such as Web Crypto and
`fetch`. Configure Jest to run ESM dependencies and use a current Node runtime
with those APIs available. Local-core tests need the `node` environment;
browser-only APIs such as IndexedDB, `Blob` URLs, and WebAuthn belong in
Playwright rather than a Jest DOM shim.

If a React component only uses rows and queries, construct an initialized
memory-backed engine in the test, wrap it in the provider from
`createInterocitorContext`, and assert the component normally. Use the same
approach in Storybook. Cover `useImage`, browser credential custody, and
IndexedDB recovery in a browser test, where the browser owns those APIs.

## Test data and cleanup

- Never reuse production mesh keys, credentials, or remote paths.
- Use `keySource: null` only for tests that do not assert encryption. For
  encryption coverage, use a test-only fixed `PortablePassphraseKeySource`.
- Call `disconnect()` in `finally`; it stops polling, flushes pending writes,
  and closes the local store.
- Restart the in-memory WebDAV process between suites when complete mailbox
  isolation is simpler than unique remote paths.

For the local server's modes and operational behavior, see
the private [`@interocitor/webdav-server`](../../../tools/webdav-server/README.md)
tool.
