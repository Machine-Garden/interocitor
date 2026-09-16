/**
 * Realm-wide state that survives a duplicated copy of this package.
 *
 * Module-level `Map`/`WeakMap` state belongs to a module *instance*, not to an
 * application. A consumer's dependency tree can easily hold two copies of this
 * package — a duplicated install, an isolated node_modules layout, or a bundler
 * that emits the module into two chunks — and a `peerDependencies` range
 * prevents none of them. Each copy then builds its own store, and whatever one
 * copy registers the other cannot see. Where the keys are objects that cross
 * the copy boundary freely — a `CryptoKey`, a store handle, a request — that is
 * a silent correctness bug, not a duplicated cache.
 *
 * Hanging the store off `globalThis` under a `Symbol.for` key removes the
 * problem at its root: the symbol registry is keyed by string and shared by
 * every module copy in the agent, so every copy resolves the same object.
 * `globalThis` itself is per realm, which is the right scope — a worker cannot
 * share object references with its host anyway.
 *
 * This helper is duplicated verbatim in every package that needs it
 * (`@interocitor/core`, `@interocitor/web`, `@interocitor/workers`) rather than
 * published from one of them. Duplicating it costs nothing, because it holds no
 * state of its own: N copies of the helper still resolve exactly one store. The
 * copies must stay byte-identical, and a test in `@interocitor/core` says so.
 */

/**
 * Resolve the one instance of a shared store for this realm.
 *
 * @param id - Dot-separated name ending in a version, e.g.
 *   `"core.crypto.derivation-twins.v1"`. The version is part of the identity on
 *   purpose: a release that changes a store's *shape* must bump it, because two
 *   copies sharing a store whose layout one of them does not expect is worse
 *   than two copies not sharing at all. Names live in one flat
 *   `interocitor.` namespace, so lead with the owning package.
 * @param create - Builds the store the first time this realm asks for it.
 *   Called once per realm, or once per copy where `globalThis` refuses to hold
 *   the property.
 */
export function sharedGlobalState<T extends object>(
  id: `${string}.v${number}`,
  create: () => T,
): T {
  const key = Symbol.for(`interocitor.${id}`);
  const host = globalThis as unknown as Record<symbol, T | undefined>;
  const published = host[key];
  if (published !== undefined) return published;

  const store = create();
  try {
    // Non-writable and non-configurable: once a copy has handed this object
    // out, nothing should be able to swap the shared store underneath it.
    Object.defineProperty(globalThis, key, {
      value: store,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  } catch {
    // A frozen or otherwise hardened `globalThis` (a lockdown shim, a locked
    // embedder) leaves nowhere to publish. Fall back to this copy's own store:
    // that is exactly the sharing callers had before this helper existed, and
    // failing to import is a far worse outcome than losing a guarantee the
    // environment will not let us have.
  }
  return store;
}
