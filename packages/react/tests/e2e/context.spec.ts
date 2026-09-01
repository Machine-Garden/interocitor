import { expect, test } from "@playwright/test";
import React from "react";
import type { Interocitor } from "@interocitor/core";

import { createInterocitorContext } from "../../dist/index.js";
import { renderHook } from "./helpers.js";

type Schema = { tasks: { title: string } };

test("typed context returns the engine supplied by its provider", async () => {
  const [Provider, useDatabase] = createInterocitorContext<Schema>();
  const database = { marker: "primary" } as unknown as Interocitor<Schema>;
  const harness = await renderHook(
    () => useDatabase(),
    (child) => React.createElement(Provider, { value: database }, child),
  );

  expect(harness.result()).toBe(database);
  await harness.unmount();
});

test("typed context uses the nearest matching provider", async () => {
  const [Provider, useDatabase] = createInterocitorContext<Schema>();
  const outer = { marker: "outer" } as unknown as Interocitor<Schema>;
  const inner = { marker: "inner" } as unknown as Interocitor<Schema>;
  const harness = await renderHook(
    () => useDatabase(),
    (child) =>
      React.createElement(
        Provider,
        { value: outer },
        React.createElement(Provider, { value: inner }, child),
      ),
  );

  expect(harness.result()).toBe(inner);
  await harness.unmount();
});

test("typed context fails clearly outside its provider", async () => {
  const [, useDatabase] = createInterocitorContext<Schema>();

  await expect(renderHook(() => useDatabase())).rejects.toThrow(
    "Interocitor not provided. Build and initialize the engine first",
  );
});
