import { expect, test, type Page } from "@playwright/test";

type ClientId = "client-1" | "client-2" | "client-3";
type Todo = { id: string; title: string; done: boolean; createdAt: number };

async function todos(page: Page, client: ClientId): Promise<Todo[]> {
  return page.evaluate((id) => window.__todoMvcDemo.getTodos(id), client);
}

async function addTodo(page: Page, title: string): Promise<void> {
  const input = page.getByLabel("New task for client 1");
  await input.fill(title);
  await input.press("Enter");
  await expect
    .poll(async () => (await todos(page, "client-2")).map((todo) => todo.title))
    .toContain(title);
}

async function addTodoFor(page: Page, client: ClientId, title: string): Promise<void> {
  const input = page
    .locator(`[data-client="${client}"]`)
    .getByLabel(`New task for client ${client.at(-1)}`);
  await input.fill(title);
  await input.press("Enter");
  await expect
    .poll(async () => (await todos(page, client)).map((todo) => todo.title))
    .toContain(title);
}

function todoState(rows: Todo[]): Record<string, boolean> {
  return Object.fromEntries(rows.map((todo) => [todo.title, todo.done]));
}

test("an older offline change remains observable after another client advances head", async ({
  page,
}) => {
  await page.goto("/docs/examples/todomvc/index.html");
  await page.waitForFunction(() => window.__todoMvcDemo?.ready());

  await addTodo(page, "second");
  await addTodo(page, "third");

  const client1 = page.locator('[data-client="client-1"]');
  const client2 = page.locator('[data-client="client-2"]');

  await client1.getByRole("button", { name: "Simulate disconnect for Client 1" }).click();
  await client1.locator(".todo-item", { hasText: "second" }).locator(".todo-toggle").check();
  await expect
    .poll(async () => (await todos(page, "client-1")).find((todo) => todo.title === "second")?.done)
    .toBe(true);

  await client2.locator(".todo-item", { hasText: "third" }).locator(".todo-toggle").check();
  await expect
    .poll(async () => (await todos(page, "client-2")).find((todo) => todo.title === "third")?.done)
    .toBe(true);

  await client1.getByRole("button", { name: "Reconnect Client 1" }).click();

  await expect
    .poll(async () => {
      const [left, right] = await Promise.all([todos(page, "client-1"), todos(page, "client-2")]);
      return [left, right].map((rows) =>
        Object.fromEntries(rows.map((todo) => [todo.title, todo.done])),
      );
    })
    .toEqual([
      { second: true, third: true },
      { second: true, third: true },
    ]);
});

test("three clients converge as two offline writers reconnect one at a time", async ({ page }) => {
  await page.goto("/docs/examples/todomvc/index.html");
  await page.waitForFunction(() => window.__todoMvcDemo?.ready());
  const addClientButton = page.getByRole("button", { name: "Add client 3" });
  const addClientControl = page.locator("#add-client-control");
  const demo = page.locator("#demo");
  await expect(addClientButton).toBeVisible();
  await expect(addClientButton).toBeInViewport();
  await expect(page.locator(".todo-header h2")).toHaveCount(0);
  expect(await addClientButton.evaluate((button) => Boolean(button.closest(".memory-pane")))).toBe(
    false,
  );
  const [controlBox, demoBox] = await Promise.all([
    addClientControl.boundingBox(),
    demo.boundingBox(),
  ]);
  expect(controlBox).not.toBeNull();
  expect(demoBox).not.toBeNull();
  expect(controlBox!.y + controlBox!.height).toBeLessThanOrEqual(demoBox!.y);

  await addClientButton.click();
  const client1 = page.locator('[data-client="client-1"]');
  const client2 = page.locator('[data-client="client-2"]');
  const client3 = page.locator('[data-client="client-3"]');
  await expect(client3).toBeVisible();
  await expect(addClientControl).toBeHidden();
  await expect(page.locator("[data-client-status]")).toHaveText(["Ready", "Ready", "Ready"]);
  const clientBoxes = await Promise.all(
    [client1, client2, client3].map((client) => client.boundingBox()),
  );
  expect(clientBoxes.every((box) => box !== null)).toBe(true);
  expect(new Set(clientBoxes.map((box) => box!.y)).size).toBe(1);

  await addTodoFor(page, "client-1", "todo1");
  await expect
    .poll(async () => (await todos(page, "client-3")).map((todo) => todo.title))
    .toContain("todo1");

  await client2.getByRole("button", { name: "Simulate disconnect for Client 2" }).click();
  await client3.getByRole("button", { name: "Simulate disconnect for Client 3" }).click();
  await expect(client2.locator("[data-client-status]")).toHaveText("Offline (simulated)");
  await expect(client3.locator("[data-client-status]")).toHaveText("Offline (simulated)");

  await addTodoFor(page, "client-2", "todo2");
  await addTodoFor(page, "client-3", "todo3");
  await client2.locator(".todo-item", { hasText: "todo1" }).locator(".todo-toggle").check();

  await client2.getByRole("button", { name: "Reconnect Client 2" }).click();
  await expect
    .poll(async () =>
      Promise.all(
        (["client-1", "client-2"] as const).map(async (client) =>
          todoState(await todos(page, client)),
        ),
      ),
    )
    .toEqual([
      { todo1: true, todo2: false },
      { todo1: true, todo2: false },
    ]);

  await client3.getByRole("button", { name: "Reconnect Client 3" }).click();
  await expect
    .poll(async () => {
      const states = await Promise.all(
        (["client-1", "client-2", "client-3"] as const).map(async (client) =>
          todoState(await todos(page, client)),
        ),
      );
      return states;
    })
    .toEqual([
      { todo1: true, todo2: false, todo3: false },
      { todo1: true, todo2: false, todo3: false },
      { todo1: true, todo2: false, todo3: false },
    ]);
});

test("compaction publishes exact snapshot coverage and removes covered changes", async ({
  page,
}) => {
  await page.goto("/docs/examples/todomvc/index.html");
  await page.waitForFunction(() => window.__todoMvcDemo?.ready());
  const compactButton = page.getByRole("button", { name: "Compact" });
  expect(
    await compactButton.evaluate(
      (button) => button.closest<HTMLElement>("[data-client]")?.dataset.client,
    ),
  ).toBe("client-1");
  expect(await compactButton.evaluate((button) => Boolean(button.closest(".memory-pane")))).toBe(
    false,
  );
  await addTodo(page, "retained");

  const retainedId = (await todos(page, "client-1")).find((todo) => todo.title === "retained")?.id;
  expect(retainedId).toBeTruthy();
  const retainedItem = page.locator('[data-client="client-1"] .todo-item', {
    hasText: "retained",
  });
  await retainedItem.hover();
  await retainedItem.locator(".destroy").click();
  await expect.poll(async () => todos(page, "client-2")).toEqual([]);

  const before = await page.evaluate(() => window.__todoMvcDemo.getFilesystem());
  const beforeChangePaths = Object.keys(before).filter((path) => path.includes("-chg_"));

  await compactButton.click();
  await expect(page.getByRole("status")).toContainText("0 uncovered change files remain");

  const after = await page.evaluate(() => window.__todoMvcDemo.getFilesystem());
  const afterPaths = Object.keys(after);
  expect(afterPaths.filter((path) => path.includes("-chg_"))).toHaveLength(0);

  const snapshotPath = afterPaths.find((path) => path.includes("/mainline/snapshot-"));
  expect(snapshotPath).toBeTruthy();
  const payload = JSON.parse(after[snapshotPath!]!) as {
    snapshot: {
      coveredChangeFiles: string[];
      tables: Record<string, Record<string, { _meta: { deleted: boolean } }>>;
    };
  };
  expect(payload.snapshot.coveredChangeFiles.toSorted()).toEqual(
    beforeChangePaths.map((path) => path.split("/").at(-1)!).toSorted(),
  );
  expect(payload.snapshot.tables.todos?.[retainedId!]?._meta.deleted).toBe(true);
});

test("live todos survive after covered changes are merged into mainline and removed", async ({
  page,
}) => {
  await page.goto("/docs/examples/todomvc/index.html");
  await page.waitForFunction(() => window.__todoMvcDemo?.ready());

  const expectedTodos = ["a", "b", "c"];
  for (const title of expectedTodos) {
    await addTodo(page, title);
  }

  const before = await page.evaluate(() => window.__todoMvcDemo.getFilesystem());
  const beforeChangePaths = Object.keys(before)
    .filter((path) => path.includes("-chg_"))
    .toSorted();
  expect(beforeChangePaths).toHaveLength(expectedTodos.length);

  await page.getByRole("button", { name: "Compact" }).click();
  await expect(page.getByRole("status")).toContainText("0 uncovered change files remain");

  const after = await page.evaluate(() => window.__todoMvcDemo.getFilesystem());
  const afterPaths = Object.keys(after);
  const snapshotPath = afterPaths.find((path) => path.includes("/mainline/snapshot-"));
  expect(snapshotPath).toBeTruthy();
  expect(afterPaths.filter((path) => path.includes("-chg_"))).toHaveLength(0);
  expect(
    await Promise.all(
      (["client-1", "client-2"] as const).map(async (client) =>
        (await todos(page, client)).map((todo) => todo.title),
      ),
    ),
  ).toEqual([expectedTodos, expectedTodos]);

  await page.getByRole("button", { name: "Add client 3" }).click();
  await expect(page.locator('[data-client="client-3"] [data-client-status]')).toHaveText("Ready");
  await expect
    .poll(async () => (await todos(page, "client-3")).map((todo) => todo.title))
    .toEqual(expectedTodos);
});

test("repeated compaction keeps only the current mainline snapshot", async ({ page }) => {
  await page.goto("/docs/examples/todomvc/index.html");
  await page.waitForFunction(() => window.__todoMvcDemo?.ready());
  await addTodo(page, "bounded");

  const compactButton = page.getByRole("button", { name: "Compact" });
  for (const epoch of [1, 2, 3]) {
    await compactButton.click();
    await expect
      .poll(async () => {
        const paths = Object.keys(await page.evaluate(() => window.__todoMvcDemo.getFilesystem()));
        return paths.filter((path) => path.includes("/mainline/snapshot-"));
      })
      .toEqual([`/TodoMVC/mainline/snapshot-${epoch}-server_relay_1.json`]);
  }

  await expect(page.getByRole("status")).toContainText(
    "1 current snapshot · 0 uncovered change files remain",
  );
  await expect
    .poll(async () => (await todos(page, "client-2")).map((todo) => todo.title))
    .toEqual(["bounded"]);
});

declare global {
  interface Window {
    __todoMvcDemo: {
      ready(): boolean;
      getFilesystem(): Record<string, string>;
      getTodos(id: ClientId): Promise<Todo[]>;
    };
  }
}
