import { test, expect } from "@playwright/test";

const HARNESS = "/packages/web/tests/e2e/fixtures/harness.html";
const STORE_MODULE = "/packages/web/dist/storage/indexed-db-local-store.js";

/** Per-tab state the cross-tab test parks on `window` between evaluate calls. */
interface LockProbe {
  enteredAt: number | null;
  exitedAt: number | null;
  announceGranted?: () => void;
  release?: () => void;
  finished?: Promise<void>;
}
type ProbeWindow = typeof window & { interocitorLockProbe?: LockProbe };

/**
 * `withLock` is exercised directly rather than through a write path. It never
 * touches the database — only the name — so these tests prove the locking
 * itself, without an IndexedDB open in the way of a clean failure message.
 */

test.beforeEach(async ({ page }) => {
  await page.goto(HARNESS);
});

test("concurrent sections on one store do not interleave", async ({ page }) => {
  const log = await page.evaluate(async () => {
    const { IndexedDbLocalStore } =
      await import("/packages/web/dist/storage/indexed-db-local-store.js");
    const store = new IndexedDbLocalStore("lock-exclusion");
    const observed: string[] = [];
    const section = (tag: string) => async () => {
      observed.push(`${tag}:enter`);
      // An await inside the section is the whole point: without a lock, the
      // second caller runs here while the first is suspended.
      await new Promise((resolve) => {
        setTimeout(resolve, 80);
      });
      observed.push(`${tag}:exit`);
    };
    await Promise.all([
      store.withLock("sync-state", section("a")),
      store.withLock("sync-state", section("b")),
    ]);
    return observed;
  });

  // Either order is correct; overlap is not.
  expect([
    ["a:enter", "a:exit", "b:enter", "b:exit"],
    ["b:enter", "b:exit", "a:enter", "a:exit"],
  ]).toContainEqual(log);
});

test("distinct lock names and databases are not serialized against each other", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { IndexedDbLocalStore } =
      await import("/packages/web/dist/storage/indexed-db-local-store.js");
    const observed: string[] = [];
    const section = (tag: string) => async () => {
      observed.push(`${tag}:enter`);
      await new Promise((resolve) => {
        setTimeout(resolve, 80);
      });
      observed.push(`${tag}:exit`);
    };
    const one = new IndexedDbLocalStore("lock-independence-one");
    const two = new IndexedDbLocalStore("lock-independence-two");
    await Promise.all([
      one.withLock("sync-state", section("name")),
      one.withLock("credential-state", section("other-name")),
      two.withLock("sync-state", section("other-db")),
    ]);
    return observed;
  });

  // Over-locking is its own bug: unrelated databases and unrelated named
  // sections must make progress together.
  expect(result.slice(0, 3).toSorted()).toEqual([
    "name:enter",
    "other-db:enter",
    "other-name:enter",
  ]);
});

test("a throw inside the critical section releases the lock", async ({ page }) => {
  for (const webLocks of [true, false] as const) {
    const result = await page.evaluate(async (useWebLocks: boolean) => {
      const { IndexedDbLocalStore } =
        await import("/packages/web/dist/storage/indexed-db-local-store.js");
      // `locks` lives on Navigator.prototype, so an own property shadows it
      // and `delete` puts the platform's getter back.
      const stubbed = !useWebLocks;
      if (stubbed) {
        Object.defineProperty(navigator, "locks", { value: undefined, configurable: true });
      }
      try {
        if (stubbed && navigator.locks) throw new Error("failed to stub navigator.locks away");
        const store = new IndexedDbLocalStore("lock-throw");
        const failure = await store
          .withLock("sync-state", async () => {
            throw new Error("boom");
          })
          .then(
            () => null,
            (error: Error) => error.message,
          );
        // If the throw leaked the lock, this never settles and the test times
        // out rather than reporting a wrong value.
        const after = await store.withLock("sync-state", async () => "recovered");
        return { failure, after };
      } finally {
        if (stubbed) delete (navigator as { locks?: unknown }).locks;
      }
    }, webLocks);

    expect(result, `webLocks=${webLocks}`).toEqual({ failure: "boom", after: "recovered" });
  }
});

test("the fallback queue serializes when Web Locks is unavailable", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { IndexedDbLocalStore } =
      await import("/packages/web/dist/storage/indexed-db-local-store.js");
    Object.defineProperty(navigator, "locks", { value: undefined, configurable: true });
    try {
      if (navigator.locks) throw new Error("failed to stub navigator.locks away");
      const store = new IndexedDbLocalStore("lock-fallback");
      let active = 0;
      let peak = 0;
      const section = async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => {
          setTimeout(resolve, 60);
        });
        active -= 1;
      };
      await Promise.all([
        store.withLock("sync-state", section),
        store.withLock("sync-state", section),
        store.withLock("sync-state", section),
      ]);
      return peak;
    } finally {
      delete (navigator as { locks?: unknown }).locks;
    }
  });

  expect(result).toBe(1);
});

test("duplicate module copies share one fallback lock", async ({ page }) => {
  const result = await page.evaluate(async (moduleUrl: string) => {
    // The module registry keys on the resolved URL, so two query strings load
    // two genuinely separate copies — the same shape a duplicate install, a
    // pnpm-isolated tree, or a bundler emitting two chunks produces. Each copy
    // has its own module-level state; only realm-global state is shared.
    const [copyOne, copyTwo] = await Promise.all([
      import(`${moduleUrl}?copy=one`),
      import(`${moduleUrl}?copy=two`),
    ]);
    if (copyOne.IndexedDbLocalStore === copyTwo.IndexedDbLocalStore) {
      throw new Error("the two imports resolved to one module copy; the test proves nothing");
    }

    Object.defineProperty(navigator, "locks", { value: undefined, configurable: true });
    try {
      if (navigator.locks) throw new Error("failed to stub navigator.locks away");
      const observed: string[] = [];
      const section = (tag: string) => async () => {
        observed.push(`${tag}:enter`);
        await new Promise((resolve) => {
          setTimeout(resolve, 80);
        });
        observed.push(`${tag}:exit`);
      };
      const storeOne = new copyOne.IndexedDbLocalStore("lock-duplicate-copies");
      const storeTwo = new copyTwo.IndexedDbLocalStore("lock-duplicate-copies");
      await Promise.all([
        storeOne.withLock("sync-state", section("one")),
        storeTwo.withLock("sync-state", section("two")),
      ]);
      return observed;
    } finally {
      delete (navigator as { locks?: unknown }).locks;
    }
  }, STORE_MODULE);

  expect([
    ["one:enter", "one:exit", "two:enter", "two:exit"],
    ["two:enter", "two:exit", "one:enter", "one:exit"],
  ]).toContainEqual(result);
});

test("a blocked global registry degrades to a module-local lock", async ({ page }) => {
  const result = await page.evaluate(async (moduleUrl: string) => {
    // Simulate a hardened or squatted `globalThis`: the registry key is held
    // non-configurably by something that is not a lock queue, so the module
    // can neither adopt it nor replace it. Failing to import, or throwing on
    // first use, would be far worse than locking a little less widely.
    //
    // The squatter is a plain object on purpose. A string would be turned away
    // by the shape check every shared store gets for free; only the narrower
    // `instanceof Map` this registry passes in can tell that an object which is
    // not a lock queue must not be adopted as one.
    Object.defineProperty(globalThis, Symbol.for("interocitor.web.fallback-lock-tails.v1"), {
      value: { notALockQueue: true },
      writable: false,
      configurable: false,
    });
    const { IndexedDbLocalStore } = await import(`${moduleUrl}?copy=squatted`);
    Object.defineProperty(navigator, "locks", { value: undefined, configurable: true });
    try {
      const store = new IndexedDbLocalStore("lock-squatted-registry");
      let active = 0;
      let peak = 0;
      const section = async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => {
          setTimeout(resolve, 60);
        });
        active -= 1;
      };
      await Promise.all([
        store.withLock("sync-state", section),
        store.withLock("sync-state", section),
      ]);
      return peak;
    } finally {
      delete (navigator as { locks?: unknown }).locks;
    }
  }, STORE_MODULE);

  // Still a real lock for this module copy — just no longer shared with a
  // second copy, which is the honest limit of what the environment allows.
  expect(result).toBe(1);
});

test("a refused Web Locks acquisition falls back instead of failing the operation", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { IndexedDbLocalStore } =
      await import("/packages/web/dist/storage/indexed-db-local-store.js");
    // What an opaque origin looks like from here: the API object is present,
    // and every request is denied. A `file://` document and a sandboxed iframe
    // both land in this state.
    const requested: string[] = [];
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request(name: string) {
          requested.push(name);
          return Promise.reject(new DOMException("denied in this context", "SecurityError"));
        },
      },
    });
    try {
      const store = new IndexedDbLocalStore("lock-refused");
      let active = 0;
      let peak = 0;
      const section = async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => {
          setTimeout(resolve, 60);
        });
        active -= 1;
      };
      await Promise.all([
        store.withLock("sync-state", section),
        store.withLock("sync-state", section),
      ]);
      const askedWhileLearning = requested.length;
      await store.withLock("sync-state", section);
      return { peak, requested, askedWhileLearning, askedAfter: requested.length };
    } finally {
      delete (navigator as { locks?: unknown }).locks;
    }
  });

  // The refusal did not become the caller's failure, and both callers landed
  // on the same fallback queue rather than one each.
  expect(result.peak).toBe(1);
  expect(result.requested[0]).toBe("interocitor:lock-refused:sync-state");
  // Callers already in flight when the first refusal lands ask for themselves;
  // once the verdict is recorded, later callers skip the doomed request.
  expect(result.askedAfter).toBe(result.askedWhileLearning);
});

test("two tabs do not hold the same lock at once", async ({ page, context }) => {
  const second = await context.newPage();
  await second.goto(HARNESS);
  const dbName = `crosstab-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // Handshake by lock ownership rather than by clock: tab A is known to hold
  // the lock before tab B asks for it, so a passing run cannot be two tabs
  // that merely missed each other. No timer drives the rendezvous, which
  // matters because a browser throttles timers in whichever tab is not
  // foreground.
  const claimed = await page.evaluate(async (name: string) => {
    const { IndexedDbLocalStore } =
      await import("/packages/web/dist/storage/indexed-db-local-store.js");
    if (!navigator.locks) return false;
    const probe: LockProbe = { enteredAt: null, exitedAt: null };
    (window as ProbeWindow).interocitorLockProbe = probe;
    const store = new IndexedDbLocalStore(name);
    const granted = new Promise<void>((resolve) => {
      probe.announceGranted = resolve;
    });
    probe.finished = store.withLock("sync-state", async () => {
      probe.enteredAt = Date.now();
      probe.announceGranted?.();
      await new Promise<void>((resolve) => {
        probe.release = resolve;
      });
      probe.exitedAt = Date.now();
    });
    await granted;
    return true;
  }, dbName);

  const queued = await second.evaluate(async (name: string) => {
    const { IndexedDbLocalStore } =
      await import("/packages/web/dist/storage/indexed-db-local-store.js");
    if (!navigator.locks) return false;
    const probe: LockProbe = { enteredAt: null, exitedAt: null };
    (window as ProbeWindow).interocitorLockProbe = probe;
    const store = new IndexedDbLocalStore(name);
    // Deliberately not awaited here: the request joins the queue and this
    // evaluate returns, leaving the test free to observe that it stays queued.
    probe.finished = store.withLock("sync-state", async () => {
      probe.enteredAt = Date.now();
      probe.exitedAt = Date.now();
    });
    return true;
  }, dbName);

  // Web Locks is present in both browsers this suite runs against, so a skip
  // would mean the cross-tab guarantee went untested rather than unmet.
  expect(claimed, "Web Locks unavailable in tab a").toBe(true);
  expect(queued, "Web Locks unavailable in tab b").toBe(true);

  await second.waitForTimeout(400);
  const enteredWhileHeld = await second.evaluate(
    () => (window as ProbeWindow).interocitorLockProbe!.enteredAt,
  );
  // The whole point: a promise chain in tab A cannot hold tab B back. Before
  // Web Locks entered this file, tab B walked straight into the section.
  expect(enteredWhileHeld, "tab b entered the section while tab a held the lock").toBeNull();

  const firstExit = await page.evaluate(async () => {
    const probe = (window as ProbeWindow).interocitorLockProbe!;
    probe.release?.();
    await probe.finished;
    return probe.exitedAt;
  });
  const secondEnter = await second.evaluate(async () => {
    const probe = (window as ProbeWindow).interocitorLockProbe!;
    await probe.finished;
    return probe.enteredAt;
  });
  await second.close();

  expect(secondEnter).not.toBeNull();
  expect(
    secondEnter! >= firstExit!,
    `tab b entered at ${secondEnter} before tab a left at ${firstExit}`,
  ).toBe(true);
});
