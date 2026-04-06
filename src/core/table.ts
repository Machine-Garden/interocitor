/**
 * Table<T> — typed handle for a named collection within a SyncEngine.
 *
 * Wraps the engine's raw Row/string API with a type-safe surface.
 * All reads return plain T objects (internal HLC metadata stripped).
 * All writes accept Partial<T> and return T.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { SyncEngine } from './sync-engine.ts';

// Use a loose engine reference so Table<T> doesn't need to know S
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEngine = SyncEngine<any>;
import type { Row, ColumnEntry } from './types.ts';

function rowToTyped<T extends Record<string, unknown>>(row: Row): T {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(row)) {
    if (key.startsWith('_')) continue;
    if (val !== null && val !== undefined && typeof val === 'object' && 'value' in val && 'hlc' in val) {
      result[key] = (val as ColumnEntry).value;
    }
  }
  return result as T;
}

export class Table<T extends Record<string, unknown>> {
  constructor(
    private readonly engine: AnyEngine,
    /** The collection name as stored in the engine. */
    readonly name: string,
  ) {}

  /** Retrieve a single record by ID, or undefined if not found / deleted. */
  async get(rowId: string): Promise<T | undefined> {
    const row = await this.engine.get(this.name, rowId);
    return row ? rowToTyped<T>(row) : undefined;
  }

  /** Retrieve all live (non-deleted) records in this collection. */
  async query(): Promise<T[]> {
    const rows = await this.engine.query(this.name);
    return rows.map(r => rowToTyped<T>(r));
  }

  /** Insert or update a record. Returns the merged result. */
  async put(rowId: string, data: Partial<T>, userId?: string): Promise<T> {
    const row = await this.engine.put(
      this.name,
      rowId,
      data as Record<string, unknown>,
      userId,
    );
    return rowToTyped<T>(row);
  }

  /** Soft-delete a record. */
  async delete(rowId: string, userId?: string): Promise<void> {
    return this.engine.delete(this.name, rowId, userId);
  }
}

