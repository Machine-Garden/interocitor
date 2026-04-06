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
 * const engine = new SyncEngine(adapter, { rootPath: '/Interocitor' });
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

// ─── Row utilities ────────────────────────────────────────────────────

export { readColumn, rowToPlain } from './core/crdt.ts';

// ─── Types ────────────────────────────────────────────────────────────

export type {
  // Adapter contract — needed for custom adapter implementations
  StorageAdapter,
  FileEntry,

  // Engine configuration
  SyncConfig,

  // Events
  SyncEvent,
  SyncEventListener,

  // Data model
  Row,

  // protocol types
  Manifest,
  ManifestPointer,
  ChannelManifest,
  ServerConfig,
  DeviceInfo,
  DeviceMetadata,
  DeviceHead,
} from './core/types.ts';
