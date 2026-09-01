import { createElement } from "react";
import type { Interocitor } from "@interocitor/core";

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
