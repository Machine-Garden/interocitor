import type { D1Database, DatabaseAdapter, InterocitorEnv, QueryRow } from './types.ts';

/**
 * Create a {@link DatabaseAdapter} from an explicit D1 binding.
 *
 * Prefer this overload when you control the binding reference directly:
 * ```ts
 * const db = createDatabaseAdapter(env.MY_DB);
 * ```
 */
export function createDatabaseAdapter(db: D1Database): DatabaseAdapter;

/**
 * Create a {@link DatabaseAdapter} from a Worker env object.
 *
 * Reads `env.INTEROCITOR_DB`. Throws if the binding is absent.
 * ```ts
 * const db = createDatabaseAdapter(env);
 * ```
 */
export function createDatabaseAdapter(env: InterocitorEnv): DatabaseAdapter;

export function createDatabaseAdapter(dbOrEnv: D1Database | InterocitorEnv): DatabaseAdapter {
  const db: D1Database = isD1Database(dbOrEnv)
    ? dbOrEnv
    : (dbOrEnv as InterocitorEnv).INTEROCITOR_DB ?? (() => { throw new Error('Missing D1 binding. Pass a D1Database directly or set env.INTEROCITOR_DB.'); })();

  return {
    kind: 'd1',
    raw: db,

    prepare(sql: string) {
      return db.prepare(sql);
    },

    async first<T extends QueryRow = QueryRow>(sql: string, ...params: unknown[]): Promise<T | null> {
      return db.prepare(sql).bind(...params).first<T>();
    },

    async run<T extends QueryRow = QueryRow>(sql: string, ...params: unknown[]): Promise<{ results?: T[]; meta?: Record<string, unknown> }> {
      return db.prepare(sql).bind(...params).run<T>();
    },

    async all<T extends QueryRow = QueryRow>(sql: string, ...params: unknown[]): Promise<T[]> {
      const result = await db.prepare(sql).bind(...params).all<T>();
      return result.results ?? [];
    },

    async batch(statements) {
      return db.batch(statements);
    },
  };
}

/** Type guard — distinguishes a raw D1Database from a Worker env object. */
function isD1Database(value: unknown): value is D1Database {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as D1Database).prepare === 'function' &&
    typeof (value as D1Database).batch === 'function'
  );
}
