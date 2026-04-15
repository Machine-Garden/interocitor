export function createDatabaseAdapter(env) {
  const db = env?.INTEROCITOR_DB;
  if (!db) throw new Error('Missing D1 binding INTEROCITOR_DB');

  return {
    kind: 'd1',
    raw: db,
    prepare(sql) {
      return db.prepare(sql);
    },
    async first(sql, ...params) {
      return await db.prepare(sql).bind(...params).first();
    },
    async run(sql, ...params) {
      return await db.prepare(sql).bind(...params).run();
    },
    async all(sql, ...params) {
      const result = await db.prepare(sql).bind(...params).all();
      return result?.results ?? [];
    },
    async batch(statements) {
      return await db.batch(statements);
    },
  };
}
