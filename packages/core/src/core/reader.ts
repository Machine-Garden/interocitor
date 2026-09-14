import type {
  ChangeObservationListener,
  ConnectionStatus,
  FileRef,
  LogLevel,
  SealedFile,
  StorageAdapter,
  StoredFileMetadata,
  SyncConfig,
  SyncEventListener,
  WhereClause,
} from "./types.ts";
import type { RemoteAccessError } from "./errors.ts";
import { Interocitor } from "./sync-engine.ts";
import { ReadonlyTable } from "./table.ts";
import { READER_MODE } from "./reader-mode.ts";
import { MemoryLocalStore } from "../storage/memory-store.ts";

export interface InterocitorReaderConfig<
  S extends Record<string, Record<string, unknown>> = Record<string, Record<string, unknown>>,
> {
  /** Existing mesh root. Readers never bootstrap a missing mesh. */
  remotePath: string;
  keySource: SyncConfig<S>["keySource"];
  /** Read cache. Defaults to a process-local, in-memory store. */
  localStore?: SyncConfig<S>["localStore"];
  dbName?: string;
  schema?: SyncConfig<S>["schema"];
  /** Expected manifest writer for a server-managed mesh. */
  serverId?: string;
  pollInterval?: number;
  relayEnabled?: boolean;
  relayHealthyPollInterval?: number;
  logLevel?: LogLevel;
  connectStageTimeoutMs?: number;
  onConnectStalled?: SyncConfig<S>["onConnectStalled"];
}

export interface InterocitorReaderConnectionStatusDetails {
  status: ConnectionStatus;
  solo: false;
  ready: boolean;
  connected: boolean;
  remoteAccess: RemoteAccessError | null;
  remotePath: string;
  meshId?: string;
  mode: "reader";
}

const REMOTE_WRITE_METHODS = new Set<PropertyKey>([
  "ensureFolder",
  "writeFile",
  "deleteFile",
  "putStoredFile",
  "deleteStoredFile",
]);

function rejectRemoteWrite(property: PropertyKey): never {
  throw new Error(`InterocitorReader cannot call remote write operation ${String(property)}`);
}

/** Keep the no-remote-writes guarantee intact if a reader pipeline regresses. */
function guardAdapter(adapter: StorageAdapter): StorageAdapter {
  return new Proxy(adapter, {
    get(target, property) {
      if (REMOTE_WRITE_METHODS.has(property)) return () => rejectRemoteWrite(property);
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Identityless, remote-read-only view of an existing mesh.
 *
 * The reader uses the normal local row cache, exact change-file ledger,
 * polling, and relay invalidations. It never generates a device UUID, creates
 * mailbox objects, publishes changes, or acknowledges compaction. Use a local
 * store dedicated to the reader; queued writes from a read/write engine are
 * rejected during connection rather than silently discarded or published.
 */
export class InterocitorReader<S extends Record<string, Record<string, unknown>>> {
  private readonly runtime: Interocitor<S>;
  private sourceAdapter: StorageAdapter | null;
  private adapter: StorageAdapter | null;
  private readonly remotePath: string;

  constructor(config: InterocitorReaderConfig<S>);
  constructor(adapter: StorageAdapter | null, config: InterocitorReaderConfig<S>);
  constructor(
    adapterOrConfig: StorageAdapter | InterocitorReaderConfig<S> | null,
    maybeConfig?: InterocitorReaderConfig<S>,
  ) {
    const config = (maybeConfig ?? adapterOrConfig) as InterocitorReaderConfig<S>;
    const adapter = (maybeConfig ? adapterOrConfig : null) as StorageAdapter | null;
    if (!config.remotePath) throw new Error("InterocitorReader requires remotePath");

    this.remotePath = config.remotePath;
    this.sourceAdapter = adapter;
    this.adapter = adapter ? guardAdapter(adapter) : null;
    const runtimeConfig = {
      ...config,
      localStore: config.localStore ?? new MemoryLocalStore(),
      autoCompact: false,
      replicas: [],
      [READER_MODE]: true,
    } as SyncConfig<S>;
    this.runtime = new Interocitor<S>(this.adapter, runtimeConfig);
  }

  init(): Promise<void> {
    return this.runtime.init();
  }

  connect(): Promise<void> {
    return this.runtime.connect();
  }

  disconnect(): Promise<void> {
    return this.runtime.disconnect();
  }

  /** Fetch and merge the current manifest, snapshot, and uncovered changes. */
  pull(): Promise<void> {
    return this.runtime.pull();
  }

  async setRemoteStorage(adapter: StorageAdapter | null): Promise<void> {
    if (adapter === this.sourceAdapter) {
      await this.runtime.setRemoteStorage(this.adapter);
      return;
    }
    this.sourceAdapter = adapter;
    this.adapter = adapter ? guardAdapter(adapter) : null;
    await this.runtime.setRemoteStorage(this.adapter);
  }

  table<K extends keyof S & string>(name: K): ReadonlyTable<S[K]> {
    return new ReadonlyTable(this.runtime.table(name));
  }

  query<K extends keyof S & string>(table: K): Promise<S[K][]> {
    return this.runtime.query(table);
  }

  queryWhere<K extends keyof S & string>(table: K, clause: WhereClause): Promise<S[K][]> {
    return this.runtime.queryWhere(table, clause);
  }

  tableNames(): Promise<string[]> {
    return this.runtime.tableNames();
  }

  getFile(target: string | FileRef): Promise<Uint8Array> {
    return this.runtime.getFile(target);
  }

  openFile(target: string | FileRef): Promise<SealedFile> {
    return this.runtime.openFile(target);
  }

  getFileMetadata(target: string | FileRef): Promise<StoredFileMetadata | null> {
    return this.runtime.getFileMetadata(target);
  }

  on(listener: SyncEventListener): () => void {
    return this.runtime.on(listener);
  }

  observeChanges(listener: ChangeObservationListener): () => void {
    return this.runtime.observeChanges(listener);
  }

  isReady(): boolean {
    return this.runtime.isReady();
  }

  isConnected(): boolean {
    return this.runtime.getConnectionStatusDetails().connected;
  }

  isEncrypted(): boolean {
    return this.runtime.isEncrypted();
  }

  getMeshId(): string | undefined {
    return this.runtime.getMeshId();
  }

  getConnectionStatus(): ConnectionStatus {
    return this.runtime.getConnectionStatus();
  }

  getConnectionStatusDetails(): InterocitorReaderConnectionStatusDetails {
    const details = this.runtime.getConnectionStatusDetails();
    return {
      status: details.status,
      solo: false,
      ready: details.ready,
      connected: details.connected,
      remoteAccess: details.remoteAccess,
      remotePath: this.remotePath,
      meshId: details.meshId,
      mode: "reader",
    };
  }

  getRemoteAccessError(): RemoteAccessError | null {
    return this.runtime.getRemoteAccessError();
  }
}
