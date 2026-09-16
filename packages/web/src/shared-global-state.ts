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
 * store of its own: N copies of the helper still resolve exactly one store
 * wherever the environment lets one be published. The copies must stay
 * byte-identical, and a test in `@interocitor/core` says so.
 */

/**
 * What this copy has already answered for a given id.
 *
 * An answer must never change under a caller that is holding it. Where the
 * store could be published this is already guaranteed — the property is defined
 * non-writable and non-configurable — but where it could not, nothing outside
 * this module remembers the store we invented, and a second call would mint a
 * second one. Callers that resolve lazily (a function called per operation,
 * rather than a module-level constant) would then get a fresh store every time:
 * for a lock registry that means no lock at all, which is exactly the class of
 * bug this helper exists to remove.
 */
const answers = new Map<symbol, object>();

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
 * @param usable - Decides whether whatever is already published can be adopted.
 *   The default accepts any object. Pass a narrower check where the store has a
 *   shape worth confirming: the key is a plain string in a registry shared with
 *   every other script in the realm, so a squatted or mistyped key is possible,
 *   and adopting the wrong structure is worse than declining to share. Copies
 *   that share a `globalThis` necessarily share its intrinsics, so `instanceof`
 *   is a sound check here.
 */
export function sharedGlobalState<T extends object>(
  id: `${string}.v${number}`,
  create: () => T,
  usable: (candidate: unknown) => boolean = (candidate) =>
    typeof candidate === "object" && candidate !== null,
): T {
  const key = Symbol.for(`interocitor.${id}`);
  const answered = answers.get(key);
  if (answered !== undefined) return answered as T;

  const host = globalThis as unknown as Record<symbol, unknown>;
  const remember = (store: T): T => {
    answers.set(key, store);
    return store;
  };

  let published: unknown;
  try {
    published = host[key];
  } catch {
    published = undefined;
  }
  if (usable(published)) return remember(published as T);

  const store = create();
  try {
    // Non-writable and non-configurable: once a copy has handed this object
    // out, nothing should be able to swap the shared store underneath it.
    Object.defineProperty(host, key, {
      value: store,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    // Re-read rather than trusting the write: if the key was already held
    // non-configurably the definition above threw, and if it was held by
    // something unusable we would rather keep our own store than return it.
    const installed = host[key];
    return remember(usable(installed) ? (installed as T) : store);
  } catch {
    // A frozen or otherwise hardened `globalThis` (a lockdown shim, a locked
    // embedder) leaves nowhere to publish. Fall back to this copy's own store:
    // that is exactly the sharing callers had before this helper existed, and
    // failing to import is a far worse outcome than losing a guarantee the
    // environment will not let us have.
    return remember(store);
  }
}
