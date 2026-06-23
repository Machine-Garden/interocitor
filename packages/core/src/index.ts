/**
 * interocitor
 *
 * Encrypted local-first CRDT database that syncs over cloud storage.
 * Runtime packages provide concrete local stores and credential stores.
 *
 * @example
 * ```ts
 * import { Interocitor } from 'interocitor';
 * import { MemoryAdapter, MemoryLocalStore } from '@interocitor/core';
 *
 * const adapter = new MemoryAdapter();
 * const engine = new Interocitor(adapter, {
 *   remotePath: '/Interocitor',
 *   localStore: new MemoryLocalStore(),
 *   encrypted: true, // generates key automatically
 * });
 *
 * await engine.init();
 * await engine.connect();
 *
 * // Share this passphrase with other devices:
 * console.log('Passphrase:', engine.getPassphrase());
 *
 * await engine.put('meals', 'meal_1', { name: 'Butter Chicken', servings: 4 });
 *
 * engine.on((event) => {
 *   if (event.type === 'change') {
 *     console.log(`${event.table}/${event.rowId} updated`);
 *   }
 * });
 * ```
 */

// ─── Handshake (public API) ───────────────────────────────────────────

export {
  generateShareQR,
  generateJoinQR,
  handleScannedQR,
  buildPairUrl,
  parseQRFromUrl,
  decodeQRPayload,
  encodeQRPayload,
} from './handshake/index.ts';

export type {
  HandshakeCredentials,
  HandshakeQRPayload,
  HandshakeIntent,
  GenerateShareQROptions,
  GenerateShareQRResult,
  GenerateJoinQROptions,
  GenerateJoinQRResult,
  HandleScannedQROptions,
} from './handshake/index.ts';

// ─── Engine ───────────────────────────────────────────────────────────

export {
  Interocitor,
  type InterocitorInitContext,
} from './core/sync-engine.ts';
export type { LocalStore } from './storage/local-store.ts';
export { MemoryLocalStore } from './storage/memory-store.ts';
export { MemoryAdapter } from './adapters/memory.ts';
export {
  GoogleDriveAdapter,
  type GoogleDriveConfig,
} from './adapters/google-drive.ts';
export {
  WebDAVAdapter,
  type WebDAVConfig,
} from './adapters/webdav.ts';
export {
  CloudflareAdapter,
  type CloudflareAdapterConfig,
  type CloudflareHandshakeConfig,
} from './adapters/cloudflare.ts';
export {
  ConnectStageTimeoutError,
  DEFAULT_CONNECT_STAGE_TIMEOUT_MS,
  withDeadline,
} from './core/with-deadline.ts';
export {
  type CredentialStore,
  type StoredCredentials,
} from './storage/credential-store.ts';
export { Table, QueryResult, RowResult } from './core/table.ts';
export { types } from './core/schema-types.ts';
export {
  LocalStoreConnectedStoresApi,
  type ConnectedStoresApi,
  type ConnectedStoreCredentials,
  type ConnectedStoreAdapterRef,
} from './core/connected-stores.ts';

// ─── Typed errors ─────────────────────────────────────────────────────

export {
  MeshEncryptionMismatchError,
  MeshCredentialMismatchError,
} from './core/errors.ts';

// ─── Row utilities ────────────────────────────────────────────────────

export { readColumn, rowToPlain } from './core/crdt.ts';
export { createRowId } from './core/row-id.ts';
export {
  uuidv7,
  createDeviceId,
  isValidDeviceId,
  issueMeshId,
  isValidMeshId,
  parseMeshId,
  createMeshSecret,
} from './core/ids.ts';
export type { CreateRowIdOptions } from './core/row-id.ts';

// ─── Types ────────────────────────────────────────────────────────────

export type {
  // Remote adapter contract — needed for custom adapter implementations
  StorageAdapter,
  FileEntry,
  StoredFileMetadata,
  StoredFileWriteOptions,

  // Engine configuration
  SyncConfig,
  SyncInitialState,
  LogLevel,
  DatabaseSchemaDefinition,
  TableSchemaDefinition,
  InferSchemaType,
  InferTableType,
  TableEvent,
  TableEventListener,
  TableIndexDefinition,
  SchemaFieldKind,
  IndexableSchemaFieldKind,
  SchemaField,
  IndexableSchemaField,
  BuiltinMergeStrategy,
  MergeStrategy,
  MergeFunction,
  MergeContext,
  TableMergeConfig,
  QueryDescriptor,
  QueryExecutionOptions,
  QueryExecutionPolicy,
  QueryMetadata,
  QueryReadable,
  QueryReadyReadable,
  QueryCacheSnapshot,
  QueryCacheOwner,
  ReadinessAwareQueryExecutor,
  QueryExecutionMode,
  QueryRuntime,
  QueryReadyRuntime,
  RowDescriptor,
  RowCacheSnapshot,
  RowCacheOwner,
  WhereClause,
  WherePrimitive,
  WhereOperator,

  // Events
  SyncEvent,
  SyncEventListener,
  ConnectionStatus,
  ConnectionStatusDetails,
  RemoteInvalidationPayload,
  RemoteInvalidationHooks,

  // Data model
  Row,
  ChangeEntry,

  // Protocol types
  Manifest,
  ManifestPointer,
  ServerConfig,
  MeshChangePayload,
  MeshSnapshotPayload,
  DeviceInfo,
  DeviceMetadata,
  DeviceType,
  DeviceHead,
  ChangesHead,
  ReplicaConfig,
} from './core/types.ts';
