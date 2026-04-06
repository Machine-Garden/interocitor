/**
 * interocitor
 *
 * Encrypted local-first CRDT database that syncs over cloud storage.
 * Google Drive is the default path; server-managed compaction is optional.
 *
 * @example
 * ```ts
 * import { SyncEngine } from 'interocitor';
 * import { GoogleDriveAdapter } from 'interocitor/adapters/google-drive';
 * import { generateKey, keyToPassphrase } from 'interocitor/crypto/keys';
 *
 * const adapter = new GoogleDriveAdapter({
 *   clientId: 'YOUR_GOOGLE_CLIENT_ID',
 * });
 * const engine = new SyncEngine(adapter, { remotePath: '/Interocitor' });
 *
 * const key = await generateKey();
 * console.log('Share this with your mesh:', await keyToPassphrase(key));
 * engine.setEncryptionKey(key);
 *
 * await engine.init();
 * await engine.connect();
 *
 * await engine.put('meals', 'meal_1', { name: 'Butter Chicken', servings: 4 });
 *
 * const meals = engine.query('meals');
 *
 * engine.on((event) => {
 *   if (event.type === 'change') {
 *     console.log(`${event.table}/${event.rowId} updated`);
 *   }
 * });
 * ```
 */

// ─── Engine ───────────────────────────────────────────────────────────

export { SyncEngine } from './core/sync-engine.ts';
export { LocalStore } from './storage/local-store.ts';
export { Table } from './core/table.ts';
export { types } from './core/schema-types.ts';

// ─── Row utilities ────────────────────────────────────────────────────

export { readColumn, rowToPlain } from './core/crdt.ts';

// ─── Types ────────────────────────────────────────────────────────────

export type {
  // Remote adapter contract — needed for custom adapter implementations
  StorageAdapter,
  FileEntry,

  // Local adapter contract — implement to plug in a custom local backend
  LocalStoreAdapter,
  LocalStoreFactory,

  // Engine configuration
  SyncConfig,
  DatabaseSchemaDefinition,
  TableSchemaDefinition,
  TableIndexDefinition,
  SchemaFieldKind,
  IndexableSchemaFieldKind,
  SchemaField,
  IndexableSchemaField,
  WhereClause,
  WherePrimitive,
  WhereOperator,

  // Events
  SyncEvent,
  SyncEventListener,

  // Data model
  Row,

  // Protocol types
  Manifest,
  ManifestPointer,
  ChannelManifest,
  ServerConfig,
  DeviceInfo,
  DeviceMetadata,
  DeviceHead,
} from './core/types.ts';
