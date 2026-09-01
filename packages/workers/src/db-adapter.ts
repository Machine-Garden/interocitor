import type { D1Database, DatabaseAdapter, QueryRow } from "./types.ts";

/**
 * Create a {@link DatabaseAdapter} from an explicit D1 binding.
 *
 * Prefer this overload when you control the binding reference directly:
 * ```ts
 * const db = createDatabaseAdapter(env.MY_DB);
 * ```
 */
export function createDatabaseAdapter(db: D1Database): DatabaseAdapter {
  return {
    kind: "d1",
    raw: db,

    prepare(sql: string) {
      return db.prepare(sql);
    },

    async first<T extends QueryRow = QueryRow>(
      sql: string,
      ...params: unknown[]
    ): Promise<T | null> {
      return db
        .prepare(sql)
        .bind(...params)
        .first<T>();
    },

    async run<T extends QueryRow = QueryRow>(
      sql: string,
      ...params: unknown[]
    ): Promise<{ results?: T[]; meta?: Record<string, unknown> }> {
      return db
        .prepare(sql)
        .bind(...params)
        .run<T>();
    },

    async all<T extends QueryRow = QueryRow>(sql: string, ...params: unknown[]): Promise<T[]> {
      const result = await db
        .prepare(sql)
        .bind(...params)
        .all<T>();
      return result.results ?? [];
    },

    async batch(statements) {
      return db.batch(statements);
    },
  };
}
