import { createElement } from "react";
import type { Interocitor, InterocitorReader } from "@interocitor/core";

import {
  createInterocitorContext,
  useConnectedStore,
  useConnectedStores,
  useConnectionStatus,
  useImage,
  useIsSolo,
  useLiveQuery,
  useRow,
  type ConnectionStatus,
  type UseConnectedStoreResult,
  type UseConnectedStoresResult,
  type UseImageResult,
  type UseLiveQueryResult,
  type UseRowResult,
} from "../../src/index.ts";

type Task = { title: string; done: boolean };
type TestDatabase = { tasks: Task };

export function PublicApiTypeFixture({
  database,
  taskId,
  imagePath,
}: {
  database: Interocitor<TestDatabase>;
  taskId?: string;
  imagePath?: string;
}): ReturnType<typeof createElement> {
  const [Provider, useDatabase] = createInterocitorContext<TestDatabase>();
  const fromContext: Interocitor<TestDatabase> = useDatabase();
  const query: UseLiveQueryResult<Task[]> = useLiveQuery(
    () => database.table("tasks").query(),
    [database],
  );
  const titles: UseLiveQueryResult<string[]> = useLiveQuery(
    () => database.table("tasks").query(),
    [database],
    (tasks) => tasks.map(({ title }) => title),
  );
  const row: UseRowResult<Task> = useRow(database.table("tasks"), taskId);
  const title: UseRowResult<string> = useRow(
    () => database.table("tasks").row(taskId ?? "fallback"),
    [database, taskId],
    (task) => task?.title ?? "",
  );
  const image: UseImageResult = useImage(database, imagePath);
  const stores: UseConnectedStoresResult = useConnectedStores(database);
  const store: UseConnectedStoreResult = useConnectedStore(database, "reviews");
  const status: ConnectionStatus = useConnectionStatus(database);
  const solo: boolean = useIsSolo(database);

  return createElement(Provider, {
    value: fromContext,
    children: JSON.stringify({ query, titles, row, title, image, stores, store, status, solo }),
  });
}

export function ReaderPublicApiTypeFixture({
  reader,
  taskId,
  imagePath,
}: {
  reader: InterocitorReader<TestDatabase>;
  taskId?: string;
  imagePath?: string;
}): ReturnType<typeof createElement> {
  const [Provider, useDatabase] = createInterocitorContext<TestDatabase>({ mode: "reader" });
  const fromContext: InterocitorReader<TestDatabase> = useDatabase();
  const query = useLiveQuery(() => reader.table("tasks").query(), [reader]);
  const row = useRow(reader.table("tasks"), taskId);
  const image = useImage(reader, imagePath);
  const status = useConnectionStatus(reader);
  const solo = useIsSolo(reader);

  // @ts-expect-error — the reader context does not expose row mutations
  fromContext.table("tasks").put("task-1", { title: "write" });

  return createElement(Provider, {
    value: fromContext,
    children: JSON.stringify({ query, row, image, status, solo }),
  });
}
