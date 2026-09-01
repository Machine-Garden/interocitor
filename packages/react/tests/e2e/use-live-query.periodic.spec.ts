import { expect, test } from "@playwright/test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { Interocitor, MemoryLocalStore } from "@interocitor/core";
import { MemoryAdapter } from "@interocitor/core/adapters/memory";

import { createInterocitorContext, useLiveQuery } from "../../dist/index.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function renderedText(renderer: ReactTestRenderer): string {
  const tree = renderer.toJSON();
  if (!tree || Array.isArray(tree)) return "";
  return tree.children?.join("") ?? "";
}

async function waitFor(assertion: () => void | Promise<void>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await act(async () => {
        await assertion();
      });
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 25);
        });
      });
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

test("useLiveQuery updates when periodic polling pulls remote rows", async () => {
  type Task = { title: string };
  type Schema = { tasks: Task };

  const [TaskDatabaseProvider, useTaskDatabase] = createInterocitorContext<Schema>();

  const remote = new MemoryAdapter();
  const writer = new Interocitor<Schema>(remote, {
    remotePath: "/LiveQueryPeriodic",
    keySource: null,
    deviceId: "live_query_writer",
    pollInterval: 60_000,
    flushThreshold: 1,
    batchWindowMs: 0,
    localStore: new MemoryLocalStore(),
  });
  const reader = new Interocitor<Schema>(remote, {
    remotePath: "/LiveQueryPeriodic",
    keySource: null,
    deviceId: "live_query_reader",
    pollInterval: 25,
    flushThreshold: 999,
    batchWindowMs: 0,
    localStore: new MemoryLocalStore(),
  });

  let renderer: ReactTestRenderer | null = null;

  function TaskTitles() {
    const database = useTaskDatabase();
    const result = useLiveQuery(
      () => database.table("tasks").query().orderBy("title"),
      [database],
      (rows) => rows.map((row) => row.title).join(","),
    );

    return React.createElement(
      "div",
      { id: "titles" },
      result.data ?? (result.loading ? "loading" : "empty"),
    );
  }

  try {
    await writer.init();
    await reader.init();
    await writer.connect();
    await reader.connect();

    await act(async () => {
      renderer = create(
        React.createElement(
          TaskDatabaseProvider,
          { value: reader },
          React.createElement(TaskTitles),
        ),
      );
    });

    await waitFor(() => {
      expect(renderedText(renderer!)).toBe("");
    });

    await writer.put("tasks", "task-from-remote", { title: "remote periodic task" });
    await writer.flush();

    await waitFor(() => {
      expect(renderedText(renderer!)).toBe("remote periodic task");
    });
  } finally {
    await act(async () => {
      renderer?.unmount();
    });
    await reader.disconnect().catch(() => {});
    await writer.disconnect().catch(() => {});
  }
});

test("period-filtered live query updates when first row for new period arrives remotely", async () => {
  type Task = { title: string; period: string };
  type Schema = { tasks: Task };

  const remote = new MemoryAdapter();
  const writer = new Interocitor<Schema>(remote, {
    remotePath: "/LiveQueryNewPeriod",
    keySource: null,
    deviceId: "live_query_period_writer",
    pollInterval: 25,
    flushThreshold: 999,
    batchWindowMs: 0,
    localStore: new MemoryLocalStore(),
  });
  const reader = new Interocitor<Schema>(remote, {
    remotePath: "/LiveQueryNewPeriod",
    keySource: null,
    deviceId: "live_query_period_reader",
    pollInterval: 25,
    flushThreshold: 999,
    batchWindowMs: 0,
    localStore: new MemoryLocalStore(),
  });

  let renderer: ReactTestRenderer | null = null;

  function PeriodTitles() {
    const result = useLiveQuery(
      () => reader.table("tasks").where("period").equals("2026-W21").orderBy("title"),
      [reader],
      (rows) => rows.map((row) => row.title).join(","),
    );

    return React.createElement(
      "div",
      { id: "titles" },
      result.data ?? (result.loading ? "loading" : "empty"),
    );
  }

  try {
    await writer.init();
    await reader.init();
    await writer.connect();
    await reader.connect();

    // Database is non-empty overall; only the current period-scoped view is empty.
    await writer.put("tasks", "prior-period-task", {
      title: "old sprint task",
      period: "2026-W20",
    });
    await writer.flush();

    await act(async () => {
      renderer = create(React.createElement(PeriodTitles));
    });

    await waitFor(() => {
      expect(renderedText(renderer!)).toBe("");
    });

    await writer.put("tasks", "new-period-task", {
      title: "first new sprint task",
      period: "2026-W21",
    });
    await writer.flush();

    await waitFor(() => {
      expect(renderedText(renderer!)).toBe("first new sprint task");
    });
  } finally {
    await act(async () => {
      renderer?.unmount();
    });
    await reader.disconnect().catch(() => {});
    await writer.disconnect().catch(() => {});
  }
});
