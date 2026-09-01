import { expect, test } from "@playwright/test";
import { Interocitor, MemoryLocalStore, type QueryResult } from "@interocitor/core";

import { useLiveQuery } from "../../dist/index.js";
import { renderHook, runInAct, waitFor } from "./helpers.js";

type Task = { title: string; period: string; done: boolean };
type Schema = { tasks: Task };

async function createDatabase(
  deviceId: string,
  localStore = new MemoryLocalStore(),
): Promise<Interocitor<Schema>> {
  const database = new Interocitor<Schema>({
    keySource: null,
    deviceId,
    localStore,
  });
  await database.init();
  return database;
}

test("useLiveQuery follows local add, patch, ordering, and delete events", async () => {
  const database = await createDatabase("react_live_query_lifecycle");
  const tasks = database.table("tasks");
  const harness = await renderHook(() =>
    useLiveQuery(
      () => tasks.query().orderBy("title"),
      [tasks],
      (rows) => rows.map(({ title }) => title),
    ),
  );

  await waitFor(() => expect(harness.result().data).toEqual([]));
  await runInAct(() => tasks.put("b", { title: "bravo", period: "one", done: false }));
  await runInAct(() => tasks.put("a", { title: "alpha", period: "one", done: false }));
  await waitFor(() => expect(harness.result().data).toEqual(["alpha", "bravo"]));

  await runInAct(() => tasks.patch("b", { title: "aardvark" }));
  await waitFor(() => expect(harness.result().data).toEqual(["aardvark", "alpha"]));
  await runInAct(() => tasks.delete("a"));
  await waitFor(() => expect(harness.result().data).toEqual(["aardvark"]));

  await harness.unmount();
  await database.disconnect();
});

test("useLiveQuery rebuilds its descriptor when dependencies change", async () => {
  const database = await createDatabase("react_live_query_deps");
  const tasks = database.table("tasks");
  await tasks.put("one", { title: "first", period: "one", done: false });
  await tasks.put("two", { title: "second", period: "two", done: false });
  let period = "one";
  const harness = await renderHook(() =>
    useLiveQuery(
      () => tasks.where("period").equals(period),
      [period],
      (rows) => rows.map(({ title }) => title),
    ),
  );

  await waitFor(() => expect(harness.result().data).toEqual(["first"]));
  period = "two";
  await harness.rerender();
  await waitFor(() => expect(harness.result().data).toEqual(["second"]));

  await harness.unmount();
  await database.disconnect();
});

test("sibling useLiveQuery consumers share the core cache and in-flight read", async () => {
  const localStore = new MemoryLocalStore();
  const originalGetTable = localStore.getTable.bind(localStore);
  let reads = 0;
  localStore.getTable = async (table) => {
    reads += 1;
    return originalGetTable(table);
  };
  const database = await createDatabase("react_live_query_siblings", localStore);
  const tasks = database.table("tasks");
  await tasks.put("one", { title: "shared", period: "one", done: false });
  const harness = await renderHook(
    () =>
      [
        useLiveQuery(() => tasks.query(), [tasks]),
        useLiveQuery(() => tasks.query(), [tasks]),
      ] as const,
  );

  await waitFor(() => {
    expect(harness.result()[0].data?.[0]?.title).toBe("shared");
    expect(harness.result()[1].data?.[0]?.title).toBe("shared");
  });
  expect(reads).toBe(1);

  await harness.unmount();
  await database.disconnect();
});

test("useLiveQuery exposes asynchronous load failures as Error state", async () => {
  const failure = new Error("query failed");
  let status: "empty" | "pending" | "error" = "empty";
  let pending: Promise<Task[]> | null = null;
  const query = {
    metadata: {
      descriptor: { table: "tasks" },
      cacheKey: "t=tasks",
    },
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
  } as unknown as QueryResult<Task>;
  const harness = await renderHook(() => useLiveQuery(() => query, []));

  await waitFor(() => {
    expect(harness.result().loading).toBe(false);
    expect(harness.result().error).toBe(failure);
  });

  await harness.unmount();
});
