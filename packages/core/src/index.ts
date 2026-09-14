/**
 * interocitor
 *
 * Runtime-neutral local-first CRDT database and durable byte file store with
 * optional client-side encryption.
 * Browser packages provide concrete local stores and credential stores.
 *
 * @example
 * ```ts
 * import {
 *   Interocitor,
 *   MemoryLocalStore,
 *   PortablePassphraseKeySource,
 * } from '@interocitor/core';
 * import { MemoryAdapter } from '@interocitor/core/adapters/memory';
 *
 * const portableKey = '...high-entropy-base58...';
 *
 * const engine = new Interocitor(new MemoryAdapter(), {
 *   dbName: 'meals',
 *   remotePath: '/Meals',
 *   localStore: new MemoryLocalStore(),
 *   keySource: new PortablePassphraseKeySource({ portableKey }),
 * });
 *
 * await engine.init();
 * await engine.connect();
 *
 * await engine.table('meals').add({ name: 'Butter Chicken', servings: 4 });
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
  generateECDHKeypair,
  exportECDHPublicKey,
  importECDHPublicKey,
  createGeneratorSession,
  runScannerHandshake,
  buildPairUrl,
  parseQRFromUrl,
  decodeQRPayload,
  encodeQRPayload,
  INDIRECT_MESH_ROUTING_V1,
  MESH_GRANT_AUTHORIZATION_V1,
  UnsupportedPairingCapabilityError,
} from "./handshake/index.ts";

export type {
  HandshakeCredentials,
  HandshakeQRPayload,
  HandshakeIntent,
  GenerateShareQROptions,
  GenerateShareQRResult,
  GenerateJoinQROptions,
  GenerateJoinQRResult,
  HandleScannedQROptions,
  HandshakeChannelOptions,
  PairingCapabilities,
  PairingCapabilityId,
  GeneratorSession,
} from "./handshake/index.ts";

// ─── Engine ───────────────────────────────────────────────────────────

export { Interocitor, type InterocitorInitContext } from "./core/sync-engine.ts";
export {
  InterocitorReader,
  type InterocitorReaderConfig,
  type InterocitorReaderConnectionStatusDetails,
  type InterocitorReaderReadOnceDiagnostics,
  type InterocitorReaderReadOnceResult,
} from "./core/reader.ts";
export type { LocalStore, RowRef } from "./storage/local-store.ts";
export { MemoryLocalStore } from "./storage/memory-store.ts";
export {
  ConnectStageTimeoutError,
  DEFAULT_CONNECT_STAGE_TIMEOUT_MS,
  withDeadline,
} from "./core/with-deadline.ts";
export {
  DAY_MS,
  DEFAULT_COMPACT_AFTER_MS,
  DEFAULT_MAX_OFFLINE_DURATION_MS,
} from "./core/retention.ts";
export {
  BoundSharedKeySource,
  PortablePassphraseKeySource,
  type BoundSharedKeySourceOptions,
  type MeshKeyContext,
  type MeshKeyMaterial,
  type MeshKeySource,
  type MeshKeyCredentialPersistence,
  type PortablePassphraseKeySourceOptions,
} from "./crypto/key-source.ts";
export {
  generateSigningKeypair,
  exportPublicKey,
  importPublicKey,
  exportPrivateKey,
  importPrivateKey,
  sign,
  verify,
  signToken,
  verifyToken,
  type SignedClaims,
  type SignTokenOptions,
  type VerifyTokenOptions,
} from "./crypto/signing.ts";
export {
  recoveryLocator,
  createRecoveryWrapper,
  unwrapRecoveryWrapper,
  publishRecoveryWrapper,
  recoverMeshCredentials,
  type RecoveredMeshCredentials,
  type RecoveryStorageAdapter,
  type RecoveryWrapper,
} from "./crypto/recovery.ts";
export { type CredentialStore, type StoredCredentials } from "./storage/credential-store.ts";
export { Table, ReadonlyTable, TableWhere, QueryResult, RowResult } from "./core/table.ts";
export { types } from "./core/schema-types.ts";
export { toFileRef, sha256Hex } from "./core/file-ref.ts";
export {
  LocalStoreConnectedStoresApi,
  type ConnectedStoresApi,
  type ConnectedStoreCredentials,
  type ConnectedStoreAdapterRef,
} from "./core/connected-stores.ts";

// ─── Typed errors ─────────────────────────────────────────────────────

export {
  MeshEncryptionMismatchError,
  MeshCredentialMismatchError,
  CredentialReplacementRequiredError,
  CredentialPersistenceError,
  MeshKeySourceContractError,
  ReaderRemotePullIncompleteError,
  FileIntegrityError,
  RemoteAccessError,
  isRemoteAccessError,
  type RemoteAccessKind,
  type RemoteAccessErrorInit,
} from "./core/errors.ts";

// ─── Row utilities ────────────────────────────────────────────────────

export { readColumn, rowToPlain } from "./core/crdt.ts";
export { createRowId } from "./core/row-id.ts";
export {
  uuidv7,
  createDeviceId,
  isValidDeviceId,
  issueMeshId,
  isValidMeshId,
  parseMeshId,
  createMeshSecret,
} from "./core/ids.ts";
export type { CreateRowIdOptions } from "./core/row-id.ts";

// ─── Types ────────────────────────────────────────────────────────────

export type {
  // Remote adapter contract — needed for custom adapter implementations
  StorageAdapter,
  FileEntry,
  StoredFileMetadata,
  StoredFileWriteOptions,
  FileRef,
  FileSeal,
  SealedFile,

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
  ChangeObservation,
  ChangeObservationListener,
  ChangeObservationSource,
  RowChangeEffect,
  RowChangeKind,
  ColumnChangeEffect,
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
  RetentionPolicy,
  RetentionPolicyInput,
  QuarantinedOfflineChanges,
} from "./core/types.ts";
