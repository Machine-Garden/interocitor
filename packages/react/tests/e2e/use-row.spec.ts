import { expect, test } from "@playwright/test";
import { Interocitor, MemoryLocalStore, type RowResult } from "@interocitor/core";

import { useRow } from "../../dist/index.js";
import { renderHook, runInAct, waitFor } from "./helpers.js";

type Task = { title: string; done: boolean };
type Schema = { tasks: Task };

async function createDatabase(deviceId: string): Promise<Interocitor<Schema>> {
  const database = new Interocitor<Schema>({
    keySource: null,
    deviceId,
    localStore: new MemoryLocalStore(),
  });
  await database.init();
  return database;
}

test("useRow resolves an existing row and follows patch and delete events", async () => {
  const database = await createDatabase("react_row_lifecycle");
  const tasks = database.table("tasks");
  await tasks.put("task-1", { title: "draft", done: false });
  const harness = await renderHook(() => useRow(tasks, "task-1"));

  await waitFor(() => {
    expect(harness.result()).toEqual({
      data: { title: "draft", done: false },
      loading: false,
      error: null,
    });
  });

  await runInAct(() => tasks.patch("task-1", { title: "ready" }));
  await waitFor(() => expect(harness.result().data?.title).toBe("ready"));

  await runInAct(() => tasks.delete("task-1"));
  await waitFor(() => {
    expect(harness.result()).toEqual({ data: undefined, loading: false, error: null });
  });

  await harness.unmount();
  await database.disconnect();
});

test("useRow resolves a loaded missing row without remaining in loading state", async () => {
  const database = await createDatabase("react_row_missing");
  const harness = await renderHook(() => useRow(database.table("tasks"), "missing"));

  await waitFor(() => {
    expect(harness.result()).toEqual({ data: undefined, loading: false, error: null });
  });

  await harness.unmount();
  await database.disconnect();
});

test("useRow runs a selector for a loaded missing row", async () => {
  const database = await createDatabase("react_row_missing_selector");
  const tasks = database.table("tasks");
  const harness = await renderHook(() =>
    useRow(tasks, "missing", (task) => task?.title ?? "not found"),
  );

  await waitFor(() => {
    expect(harness.result()).toEqual({ data: "not found", loading: false, error: null });
  });

  await harness.unmount();
  await database.disconnect();
});

test("useRow supports the documented inline db.table form for existing rows", async () => {
  const database = await createDatabase("react_row_inline_table");
  await database.table("tasks").put("task-1", { title: "inline", done: false });
  const harness = await renderHook(() => useRow(database.table("tasks"), "task-1"));

  await waitFor(() => expect(harness.result().data?.title).toBe("inline"));
  await harness.rerender();
  expect(harness.result().data?.title).toBe("inline");

  await harness.unmount();
  await database.disconnect();
});

test("useRow skips an undefined row id", async () => {
  const database = await createDatabase("react_row_skip");
  // eslint-disable-next-line unicorn/no-useless-undefined -- explicit undefined is the documented skip contract.
  const harness = await renderHook(() => useRow(database.table("tasks"), undefined));

  expect(harness.result()).toEqual({ data: undefined, loading: false, error: null });

  await harness.unmount();
  await database.disconnect();
});

test("useRow selector and factory forms follow dependency changes", async () => {
  const database = await createDatabase("react_row_factory");
  const tasks = database.table("tasks");
  await tasks.put("first", { title: "one", done: false });
  await tasks.put("second", { title: "two", done: true });
  let selectedId = "first";
  const harness = await renderHook(() =>
    useRow(
      () => tasks.row(selectedId),
      [selectedId],
      (task) => task?.title.toUpperCase(),
    ),
  );

  await waitFor(() => expect(harness.result().data).toBe("ONE"));
  selectedId = "second";
  await harness.rerender();
  await waitFor(() => expect(harness.result().data).toBe("TWO"));

  await harness.unmount();
  await database.disconnect();
});

test("useRow exposes asynchronous load failures as Error state", async () => {
  const failure = new Error("row failed");
  let status: "empty" | "pending" | "error" = "empty";
  let pending: Promise<Task | undefined> | null = null;
  const row = {
    load() {
      status = "pending";
      pending ??= Promise.resolve().then(() => {
        status = "error";
        throw failure;
      });
      return pending;
    },
    peekCache() {},
    peekStatus: () => ({ status, error: status === "error" ? failure : undefined }),
    subscribe: () => () => {},
  } as unknown as RowResult<Task>;
  const harness = await renderHook(() => useRow(() => row, []));

  await waitFor(() => {
    expect(harness.result().loading).toBe(false);
    expect(harness.result().error).toBe(failure);
  });

  await harness.unmount();
});
