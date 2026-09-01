import React, { type ReactElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

export interface HookHarness<T> {
  result(): T;
  rerender(): Promise<void>;
  unmount(): Promise<void>;
}

export async function renderHook<T>(
  useValue: () => T,
  wrap?: (child: ReactElement) => ReactElement,
): Promise<HookHarness<T>> {
  let current: T;
  let rendered = false;
  let renderer: ReactTestRenderer;

  function Probe(): null {
    current = useValue();
    rendered = true;
    return null;
  }

  const element = () => {
    const probe = React.createElement(Probe);
    return wrap ? wrap(probe) : probe;
  };

  await act(async () => {
    renderer = create(element());
  });

  return {
    result() {
      if (!rendered) throw new Error("Hook probe has not rendered");
      return current!;
    },
    async rerender() {
      await act(async () => {
        renderer.update(element());
      });
    },
    async unmount() {
      await act(async () => {
        renderer.unmount();
      });
    },
  };
}

export async function waitFor(
  assertion: () => void | Promise<void>,
  timeoutMs = 2_000,
): Promise<void> {
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
          setTimeout(resolve, 20);
        });
      });
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function runInAct<T>(action: () => T | Promise<T>): Promise<T> {
  let result: T;
  await act(async () => {
    result = await action();
  });
  return result!;
}

export function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
