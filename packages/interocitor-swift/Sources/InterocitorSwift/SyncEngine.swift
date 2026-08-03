/**
 * Interocitor — Swift native Interocitor sync orchestrator
 *
 * Native implementation of Interocitor's local-first row and sync model.
 *
 * Orchestrates:
 *  - Local writes → outbox → flush to cloud (primary + replicas)
 *  - Cloud poll → download → CRDT merge → local DB
 *  - Rehydration from manifest-authoritative snapshot
 *
 * Network is never required for reads or local writes.
 */

import Foundation
import CryptoKit

// MARK: - Cloud path layout
//
// {remotePath}/
//   manifest.json                       ← pointer
//   manifest-{generation}.json          ← immutable
//   devices/{deviceId}.json
//   mainline/snapshot-{epoch}-{writer}.json
//   changes/
//     head.json                         ← { latestHlc }
//     {hlc}-{changeId}.json

private struct CloudPaths {
    let root: String

    var manifestPointer: String { "\(root)/manifest.json" }
    func manifestFile(_ generation: Int) -> String { "\(root)/manifest-\(generation).json" }
    var devicesFolder: String { "\(root)/devices" }
    func deviceFile(_ deviceId: String) -> String { "\(root)/devices/\(deviceId).json" }
    var mainlineFolder: String { "\(root)/mainline" }
    var changesFolder: String { "\(root)/changes" }
    var changesHead: String { "\(root)/changes/head.json" }
    func changeFile(_ fileName: String) -> String { "\(root)/changes/\(fileName)" }
}

private func changeFileHlc(_ name: String) -> String? {
    guard let range = name.range(of: "-chg_", options: .backwards) else { return nil }
    return String(name[..<range.lowerBound])
}

/// Merge order is protocol data. Compare HLCs first, then use a stable
/// code-point filename tie-breaker rather than a locale-sensitive ordering.
private func compareChangeFiles(_ left: FileEntry, _ right: FileEntry) -> Bool {
    if let leftHlc = changeFileHlc(left.name), let rightHlc = changeFileHlc(right.name) {
        let compared = hlcCompareStr(leftHlc, rightHlc)
        if compared != 0 { return compared < 0 }
    }
    return left.name < right.name
}

// MARK: - Manifest wire encoding

// Core hashes `JSON.stringify(payload)`, so manifest property order is part of
// the current wire contract. Swift emits Core's insertion order in compact
// JSON and also accepts the former sorted Swift order when validating a stored
// manifest. Required nullable fields are encoded as `null`, matching Core's
// current manifest shape.
private enum ManifestCodingKey: String, CodingKey, CaseIterable {
    case generation
    case parentGeneration
    case writtenBy
    case writtenAt
    case contentHash
    case version
    case meshId
    case schema
    case encrypted
    case server
    case createdAt
    case epoch
    case watermarkHlc
    case snapshotPath
    case deltaPath
}

private let coreManifestKeyOrder: [ManifestCodingKey] = [
    .generation, .parentGeneration, .writtenBy, .writtenAt, .version,
    .meshId, .schema, .encrypted, .server, .createdAt, .epoch,
    .watermarkHlc, .snapshotPath, .deltaPath, .contentHash,
]

private let sortedManifestKeyOrder: [ManifestCodingKey] =
    ManifestCodingKey.allCases.sorted { $0.rawValue < $1.rawValue }

// MARK: - Replica

public struct ReplicaConfig: Sendable {
    public var adapter: any StorageAdapter
    public var remotePath: String?
    public init(adapter: any StorageAdapter, remotePath: String? = nil) {
        self.adapter = adapter
        self.remotePath = remotePath
    }
}

// MARK: - SyncConfig

public struct SyncConfig: Sendable {
    public var remotePath: String
    public var serverManaged: Bool
    public var serverId: String
    public var pollInterval: TimeInterval
    public var flushDebounce: TimeInterval
    public var flushThreshold: Int
    public var dbName: String
    public var deviceName: String?
    public var deviceType: String?
    public var replicas: [ReplicaConfig]
    /// Optional logical mesh schema. Its version is checked against the
    /// manifest and its merge policies participate in CRDT resolution.
    public var schema: DatabaseSchema?

    public init(
        remotePath: String,
        serverManaged: Bool = false,
        serverId: String = "server_relay_1",
        pollInterval: TimeInterval = 30,
        flushDebounce: TimeInterval = 2,
        flushThreshold: Int = 50,
        dbName: String = "interocitor",
        deviceName: String? = nil,
        deviceType: String? = nil,
        replicas: [ReplicaConfig] = [],
        schema: DatabaseSchema? = nil
    ) {
        self.remotePath = remotePath
        self.serverManaged = serverManaged
        self.serverId = serverId
        self.pollInterval = pollInterval
        self.flushDebounce = flushDebounce
        self.flushThreshold = flushThreshold
        self.dbName = dbName
        self.deviceName = deviceName
        self.deviceType = deviceType
        self.replicas = replicas
        self.schema = schema
    }
}

// MARK: - Interocitor

/// The main sync engine actor.  All public methods are async-safe.
public actor Interocitor {

    private let config: SyncConfig
    private var adapter: (any StorageAdapter)?
    private var local: any LocalStoreAdapter
    private let deviceId: String

    private var hlc: HLC
    private var manifest: Manifest?
    private var remotePoisonError: Error?
    private var tables: [String: [String: Row]] = [:]
    private var knownTables: Set<String> = []

    private var initialized = false
    private var connected  = false
    private var pendingCount = 0

    // Encryption (first principle — all cloud I/O passes through this)
    private var meshKey: MeshKey? = nil
    private var encrypted: Bool = false

    // Flush / poll timers
    private var flushTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?

    // Event listeners
    private var listeners: [(SyncEvent) -> Void] = []

    // JSON helpers
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    // MARK: - Init

    /// Create a fully-local engine (no remote adapter yet).
    public init(config: SyncConfig, localStore: (any LocalStoreAdapter)? = nil) {
        self.config = config
        self.adapter = nil
        self.deviceId = Interocitor.loadOrCreateDeviceId(dbName: config.dbName)
        self.hlc = hlcInit(nodeId: deviceId)
        self.local = localStore ?? MemoryLocalStore()
    }

    /// Create an engine with a remote adapter already attached.
    public init(adapter: any StorageAdapter, config: SyncConfig, localStore: (any LocalStoreAdapter)? = nil) {
        self.config = config
        self.adapter = adapter
        self.deviceId = Interocitor.loadOrCreateDeviceId(dbName: config.dbName)
        self.hlc = hlcInit(nodeId: deviceId)
        self.local = localStore ?? MemoryLocalStore()
    }

    // MARK: - Device ID

    private static func loadOrCreateDeviceId(dbName: String) -> String {
        let key = "interocitor-device-id-\(dbName)"
        if let existing = UserDefaults.standard.string(forKey: key) { return existing }
        let new = "dev_\(randomHex(8))"
        UserDefaults.standard.set(new, forKey: key)
        return new
    }

    // MARK: - Lifecycle

    /// Initialize: open local DB, load state into memory. No network required.
    public func initialize() async throws {
        try await local.open()
        try await loadLocalState()
        initialized = true
    }

    /// Connect to cloud and start background sync.
    public func connect() async throws {
        guard initialized else { throw InterocitorError.adapterRequired("init not called") }
        let adapter = try requireAdapter("connect()")

        if !(await adapter.isAuthenticated()) {
            emit(.authRequired)
            try await adapter.authenticate()
            emit(.authComplete)
        }

        let p = CloudPaths(root: config.remotePath)
        for folder in [config.remotePath, p.devicesFolder, p.mainlineFolder, p.changesFolder] {
            try await adapter.ensureFolder(path: folder)
        }

        try await loadOrCreateManifest()
        try await upsertDeviceMetadata()

        let localEpoch = (try await local.getMeta(key: "epoch") as? AnyCodable)?.intValue ?? 0
        let remoteEpoch = manifest?.epoch ?? 0

        if localEpoch < remoteEpoch {
            try await rehydrate()
        } else {
            try await pull()
        }
        try await flush()
        startPolling()
        connected = true
    }

    /// Stop background sync and close local store.
    public func disconnect() async throws {
        stopPolling()
        cancelFlushTimer()
        if remotePoisonError == nil {
            try await flush()
        }
        local.close()
        connected   = false
        initialized = false
        remotePoisonError = nil
    }

    /// Swap remote adapter. Pass nil to go local-only.
    public func setRemoteStorage(_ newAdapter: (any StorageAdapter)?) async throws {
        let wasConnected = connected
        let hadAdapter   = adapter != nil

        if wasConnected && hadAdapter { try await pull() }

        stopPolling()
        cancelFlushTimer()

        if initialized {
            try await resetRemoteSyncState()
            if newAdapter != nil { _ = try await rebuildOutboxFromLocalState() }
        } else {
            manifest  = nil
            connected = false
        }

        adapter = newAdapter

        if wasConnected, let _ = newAdapter { try await connect() }
    }

    // MARK: - Local writes

    /// Insert or update a row. Never requires network access.
    @discardableResult
    public func put(table: String, rowId: String, columns: [String: AnyCodable], userId: String? = nil) async throws -> Row {
        let current = try await local.getRow(table: table, rowId: rowId)
        let isResurrection = current?._deleted == true
        var row = current ?? Row(
            table: table,
            rowId: rowId,
            schemaVersion: config.schema?.version ?? 0
        )
        if isResurrection {
            // A local write starts a new row incarnation. Do not carry fields
            // from the tombstone into the full-row change we publish.
            row.columns = [:]
        }

        hlc = hlcNow(hlc)
        let hlcStr = hlcSerialize(hlc)

        for (key, value) in columns {
            row.columns[key] = ColumnEntry(value: value, hlc: hlcStr)
        }
        row._deleted = false
        row._deletedHlc = nil
        row._owner = deviceId

        let entry = ChangeEntry(
            id: "chg_\(Interocitor.randomHex(8))",
            ts: Int64(Date().timeIntervalSince1970 * 1000),
            device: deviceId,
            user: userId,
            hlc: hlcStr,
            // Core publishes the complete current payload for local writes.
            // This is especially important after a resurrection, where only
            // the new incarnation's fields may leave the device.
            ops: [.upsert(UpsertOp(table: table, rowId: rowId, columns: row.columns))]
        )
        try await local.commitLocalMutation(row: row, entry: entry, hlc: hlcStr)
        if tables[table] == nil { tables[table] = [:] }
        tables[table]![rowId] = row
        knownTables.insert(table)
        emit(.change(table: table, rowId: rowId, row: row))
        scheduleFlush()
        return row
    }

    /// Soft-delete a row.
    public func delete(table: String, rowId: String, userId: String? = nil) async throws {
        guard var row = try await local.getRow(table: table, rowId: rowId), !row._deleted else {
            return
        }
        hlc = hlcNow(hlc)
        let hlcStr = hlcSerialize(hlc)

        row._deleted = true
        row._deletedHlc = hlcStr
        row._owner = deviceId
        row.columns = [:]
        let entry = ChangeEntry(
            id: "chg_\(Interocitor.randomHex(8))",
            ts: Int64(Date().timeIntervalSince1970 * 1000),
            device: deviceId,
            user: userId,
            hlc: hlcStr,
            ops: [.delete(DeleteOp(table: table, rowId: rowId, hlc: hlcStr))]
        )
        try await local.commitLocalMutation(row: row, entry: entry, hlc: hlcStr)
        if tables[table] == nil { tables[table] = [:] }
        tables[table]![rowId] = row
        emit(.delete(table: table, rowId: rowId))
        scheduleFlush()
    }

    // MARK: - Reads

    /// Read a single live row from local store.
    public func get(table: String, rowId: String) async throws -> Row? {
        let row = try await local.getRow(table: table, rowId: rowId)
        if let row, !row._deleted { return row }
        return nil
    }

    /// Read all live rows in a table.
    public func query(table: String) async throws -> [Row] {
        try await local.getTable(table)
    }

    /// Query with a where-clause.
    public func queryWhere(table: String, clause: WhereClause) async throws -> [Row] {
        try await local.queryWhere(table: table, clause: clause)
    }

    /// All known table names.
    public func tableNames() -> [String] {
        Array(knownTables).sorted()
    }

    public func getDeviceId() -> String { deviceId }
    public func getMeshId() -> String? { manifest?.meshId }
    public func getManifest() -> Manifest? { manifest }

    // MARK: - Events

    /// Subscribe to engine events. Returns an unsubscribe closure.
    public func on(_ listener: @escaping @Sendable (SyncEvent) -> Void) -> () -> Void {
        let id = listeners.count
        listeners.append(listener)
        return { [weak self] in
            Task { await self?.removeListener(at: id) }
        }
    }

    private func removeListener(at index: Int) {
        guard index < listeners.count else { return }
        listeners.remove(at: index)
    }

    private func emit(_ event: SyncEvent) {
        for listener in listeners {
            listener(event)
        }
    }

    // MARK: - Flush (local → cloud)

    private func scheduleFlush() {
        pendingCount += 1
        if pendingCount >= config.flushThreshold {
            flushTask?.cancel()
            flushTask = Task { try? await self.flush() }
            return
        }
        flushTask?.cancel()
        flushTask = Task {
            try? await Task.sleep(nanoseconds: UInt64(config.flushDebounce * 1_000_000_000))
            guard !Task.isCancelled else { return }
            try? await self.flush()
        }
    }

    private func cancelFlushTimer() {
        flushTask?.cancel()
        flushTask = nil
    }

    /// Immediately push the queued outbox to the active remote backend.
    public func flush() async throws {
        guard adapter != nil else { cancelFlushTimer(); return }

        let entries = try await local.peekOutbox()
        guard !entries.isEmpty else { return }

        emit(.flushStart(entryCount: entries.count))
        cancelFlushTimer()
        do {
            let adapter = try requireAdapter("flush()")
            // A long-sleeping client reloads the manifest before publishing,
            // but scalar HLC state never suppresses a durable queued entry.
            try await loadOrCreateManifest()

            pendingCount = 0
            try await flushToAdapter(adapter, remotePath: config.remotePath, entries: entries, isPrimary: true)

            for replica in config.replicas {
                do {
                    if !(await replica.adapter.isAuthenticated()) { try await replica.adapter.authenticate() }
                    let path = replica.remotePath ?? config.remotePath
                    try await flushToAdapter(replica.adapter, remotePath: path, entries: entries, isPrimary: false)
                } catch {
                    emit(.replicaError(adapter: replica.adapter.name, error: error))
                }
            }
            var highestFlushedHlc = ""
            for entry in entries where !entry.hlc.isEmpty {
                if highestFlushedHlc.isEmpty || hlcCompareStr(entry.hlc, highestFlushedHlc) > 0 {
                    highestFlushedHlc = entry.hlc
                }
            }
            if !highestFlushedHlc.isEmpty {
                let cursor = ((try await local.getMeta(key: "cursor")) as? AnyCodable)?.stringValue ?? ""
                if cursor.isEmpty || hlcCompareStr(highestFlushedHlc, cursor) > 0 {
                    try await local.setMeta(key: "cursor", value: AnyCodable.string(highestFlushedHlc))
                }
                var seenChangeFiles = Set<String>()
                if let seen = try await local.getMeta(key: "seenChangeFiles") as? AnyCodable,
                   case .array(let values) = seen {
                    seenChangeFiles.formUnion(values.compactMap(\.stringValue))
                }
                seenChangeFiles.formUnion(entries.filter { !$0.hlc.isEmpty }.map { "\($0.hlc)-\($0.id).json" })
                try await local.setMeta(
                    key: "seenChangeFiles",
                    value: AnyCodable.array(seenChangeFiles.sorted().map(AnyCodable.string))
                )
            }
            try await local.acknowledgeOutbox(entryIds: entries.map(\.id))
            emit(.flushComplete)
        } catch {
            pendingCount = entries.count
            emit(.flushError(error))
            throw error
        }
    }

    private func flushToAdapter(_ adapter: any StorageAdapter, remotePath: String, entries: [ChangeEntry], isPrimary: Bool) async throws {
        let p = CloudPaths(root: remotePath)
        try await adapter.ensureFolder(path: p.changesFolder)

        var lastWrittenHlc = ""

        for entry in entries {
            let fileName = "\(entry.hlc)-\(entry.id).json"
            let data = try encodeChangePayload(entry)
            try await adapter.writeFile(path: p.changeFile(fileName), data: data)
            if lastWrittenHlc.isEmpty || hlcCompareStr(entry.hlc, lastWrittenHlc) > 0 {
                lastWrittenHlc = entry.hlc
            }
        }

        // Update global head
        var bestHlc = lastWrittenHlc
        if let headData = try? await adapter.readFile(path: p.changesHead),
           let head = try? decoder.decode(ChangesHead.self, from: headData),
           hlcCompareStr(head.latestHlc, lastWrittenHlc) > 0 {
            bestHlc = head.latestHlc
        }
        let headData = try encoder.encode(ChangesHead(latestHlc: bestHlc))
        try await adapter.writeFile(path: p.changesHead, data: headData)

        if isPrimary { try await upsertDeviceMetadata() }
    }

    // MARK: - Pull (cloud → local)

    /// Pull remote changes into local store immediately.
    public func pull() async throws {
        let adapter = try requireAdapter("pull()")
        emit(.syncStart)

        do {
            try await loadOrCreateManifest()
            let localEpoch = (try await local.getMeta(key: "epoch") as? AnyCodable)?.intValue ?? 0
            let remoteEpoch = manifest?.epoch ?? 0
            if localEpoch < remoteEpoch {
                // Publication must precede snapshot replacement. rehydrate()
                // flushes the durable outbox before clearing local rows, then
                // restores exact snapshot coverage and resumes pull.
                try await rehydrate()
                return
            }
            let p = CloudPaths(root: config.remotePath)

            let cursorRaw = try await local.getMeta(key: "cursor")
            let cursor = (cursorRaw as? AnyCodable)?.stringValue ?? ""
            var seenChangeFiles = Set<String>()
            if let seen = try await local.getMeta(key: "seenChangeFiles") as? AnyCodable,
               case .array(let values) = seen {
                seenChangeFiles.formUnion(values.compactMap(\.stringValue))
            }

            guard let files = try? await adapter.listFiles(path: p.changesFolder) else {
                try await acknowledgeManifest()
                emit(.syncComplete(entriesMerged: 0))
                return
            }

            let sorted = files.filter { $0.name != "head.json" }
                              .sorted(by: compareChangeFiles)

            var totalMerged = 0
            var latestMergedHlc = cursor

            for file in sorted {
                do {
                    guard let fileHlc = changeFileHlc(file.name) else { continue }
                    if seenChangeFiles.contains(file.name) { continue }

                    let rawData = try await adapter.readFile(path: file.path)
                    let entry = try await decodeChangePayload(rawData, path: file.path)
                    if entry.hlc != fileHlc {
                        throw InterocitorError.protocolCorruption(
                            "change filename does not match payload HLC: \(file.path)"
                        )
                    }

                    let remoteHlc = hlcParse(entry.hlc)
                    hlc = hlcReceive(hlc, remoteHlc)

                    try await ensureRowsCached(ops: entry.ops)
                    let affected = try applyChangeEntry(
                        tables: &tables,
                        entry: entry,
                        schemaVersion: manifest?.schema ?? config.schema?.version ?? 1,
                        schema: config.schema
                    )

                    if !affected.isEmpty {
                        try await local.putRows(affected)
                        totalMerged += affected.count
                        for row in affected {
                            knownTables.insert(row._table)
                            if row._deleted {
                                emit(.delete(table: row._table, rowId: row._rowId))
                            } else {
                                emit(.change(table: row._table, rowId: row._rowId, row: row))
                            }
                        }
                    }
                    if latestMergedHlc.isEmpty || hlcCompareStr(entry.hlc, latestMergedHlc) > 0 {
                        latestMergedHlc = entry.hlc
                    }
                    seenChangeFiles.insert(file.name)
                } catch {
                    throw poisonRemote(error, path: file.path)
                }
            }

            if !latestMergedHlc.isEmpty && latestMergedHlc != cursor {
                try await local.setMeta(key: "cursor", value: AnyCodable.string(latestMergedHlc))
            }
            try await local.setMeta(
                key: "seenChangeFiles",
                value: AnyCodable.array(seenChangeFiles.sorted().map(AnyCodable.string))
            )
            try await local.setMeta(key: "hlc", value: AnyCodable.string(hlcSerialize(hlc)))
            try await acknowledgeManifest()
            emit(.syncComplete(entriesMerged: totalMerged))
        } catch {
            emit(.syncError(error))
            throw error
        }
    }

    // MARK: - Rehydrate (from snapshot)

    /// Rebuild local store from the current remote snapshot, then pull newer changes.
    public func rehydrate() async throws {
        try await flush()
        let adapter = try requireAdapter("rehydrate()")
        emit(.rehydrateStart)

        guard let snapshotPath = manifest?.snapshotPath else {
            emit(.rehydrateComplete(rowCount: 0))
            try await pull()
            return
        }

        do {
            let rawData = try await adapter.readFile(path: snapshotPath)
            let snapshot = try await decodeSnapshotPayload(rawData, path: snapshotPath)

            try await local.clearRows()
            try await local.setMeta(key: "cursor", value: AnyCodable.string(""))
            try await local.setMeta(key: "seenChangeFiles", value: AnyCodable.array([]))
            tables = [:]
            knownTables = []

            var rowCount = 0
            for (tableName, rows) in snapshot.tables {
                knownTables.insert(tableName)
                for row in rows.values {
                    try await local.putRow(row)
                    rowCount += 1
                }
            }

            if !snapshot.hlc.isEmpty {
                var parsed = hlcParse(snapshot.hlc)
                parsed.nodeId = deviceId
                hlc = parsed
            }

            try await local.setMeta(key: "epoch", value: AnyCodable.int(snapshot.epoch))
            emit(.rehydrateComplete(rowCount: rowCount))
        } catch {
            let poisoned = poisonRemote(error, path: snapshotPath)
            emit(.syncError(poisoned))
            throw poisoned
        }

        try await pull()
    }

    // MARK: - Compaction

    /// Publish a new snapshot and manifest generation.
    public func compact() async throws {
        let adapter = try requireAdapter("compact()")

        guard let currentManifest = manifest else {
            throw InterocitorError.adapterRequired("Engine is not connected")
        }
        if currentManifest.server.managed && deviceId != config.serverId {
            throw InterocitorError.compactionNotAllowed
        }

        try await flush()
        try await pull()

        let p = CloudPaths(root: config.remotePath)
        let now = ISO8601DateFormatter().string(from: Date())
        let nextEpoch = currentManifest.epoch + 1
        let nextGeneration = currentManifest.generation + 1
        let snapshotPath = "\(p.mainlineFolder)/snapshot-\(nextEpoch)-\(config.serverId).json"

        let allRows = try await local.getAllRows()
        var snapshotTables: [String: [String: Row]] = [:]
        for row in allRows {
            if snapshotTables[row._table] == nil { snapshotTables[row._table] = [:] }
            snapshotTables[row._table]![row._rowId] = row
        }

        let snapshot = Snapshot(
            snapshotId: "snap_\(Interocitor.randomHex(8))",
            timestamp: now,
            hlc: hlcSerialize(hlc),
            epoch: nextEpoch,
            schemaVersion: currentManifest.schema,
            tables: snapshotTables
        )

        let snapshotData = try encodeSnapshotPayload(snapshot)
        try await adapter.writeFile(path: snapshotPath, data: snapshotData)

        let nextManifest = Manifest(
            generation: nextGeneration,
            parentGeneration: currentManifest.generation,
            writtenBy: config.serverId,
            writtenAt: now,
            contentHash: "",
            version: 3,
            meshId: currentManifest.meshId,
            schema: currentManifest.schema,
            encrypted: currentManifest.encrypted,
            server: currentManifest.server,
            createdAt: currentManifest.createdAt,
            epoch: nextEpoch,
            watermarkHlc: hlcSerialize(hlc),
            snapshotPath: snapshotPath,
            deltaPath: nil
        )

        let writtenManifest = try await writeManifest(
            nextManifest,
            path: p.manifestFile(nextGeneration),
            adapter: adapter
        )

        let pointer = ManifestPointer(currentGeneration: nextGeneration, file: "manifest-\(nextGeneration).json")
        let pointerData = try encoder.encode(pointer)
        try await adapter.writeFile(path: p.manifestPointer, data: pointerData)

        manifest = writtenManifest
        try await local.setMeta(key: "epoch", value: AnyCodable.int(nextEpoch))
        try await acknowledgeManifest()

    }


    // MARK: - Encryption API

    /// Configure the mesh encryption key. Must be called before connect() for encrypted meshes.
    /// All cloud I/O (change entries, snapshots) will be encrypted/decrypted transparently.
    public func setEncryptionKey(_ key: MeshKey) {
        meshKey = key
        encrypted = true
    }

    /// Remove the encryption key (local-only / unencrypted mesh).
    public func clearEncryptionKey() {
        meshKey = nil
        encrypted = false
    }

    public func isEncrypted() -> Bool { encrypted }

    // Encrypt a plaintext string for cloud storage. No-op when not encrypted.
    private func encodeForCloud(_ plaintext: String) throws -> Data {
        if encrypted, let key = meshKey {
            let envelope = try encryptEntry(key, plaintext: plaintext)
            return Data(envelope.utf8)
        }
        return Data(plaintext.utf8)
    }

    // Decrypt data from cloud storage. No-op when not encrypted.
    private func decodeFromCloud(_ data: Data) throws -> String {
        let str = String(data: data, encoding: .utf8) ?? ""
        if encrypted, let key = meshKey {
            return try decryptEntry(key, envelopeStr: str)
        }
        return str
    }

    private func poisonRemote(_ error: Error, path: String? = nil) -> Error {
        if remotePoisonError == nil {
            remotePoisonError = error
            stopPolling()
            cancelFlushTimer()
            connected = false
        }
        emit(.remotePoisoned(error: error, path: path))
        return error
    }

    private func assertExpectedMeshId(_ meshId: String) async throws {
        guard !meshId.isEmpty else { throw InterocitorError.remotePoisoned("missing meshId") }
        if let manifest, manifest.meshId != meshId {
            throw InterocitorError.remotePoisoned("mesh mismatch: expected \(manifest.meshId), got \(meshId)")
        }
        if let stored = try await local.getMeta(key: "meshId") as? AnyCodable,
           let storedMeshId = stored.stringValue,
           !storedMeshId.isEmpty,
           storedMeshId != meshId {
            throw InterocitorError.remotePoisoned("mesh mismatch: expected \(storedMeshId), got \(meshId)")
        }
        try await local.setMeta(key: "meshId", value: AnyCodable.string(meshId))
    }

    private func encodeChangePayload(_ entry: ChangeEntry) throws -> Data {
        guard let meshId = manifest?.meshId else {
            throw InterocitorError.remotePoisoned("manifest not loaded before change encode")
        }
        let payload = MeshChangePayload(meshId: meshId, kind: "change", entry: entry)
        guard let plain = String(data: try encoder.encode(payload), encoding: .utf8) else {
            throw InterocitorError.remotePoisoned("failed to encode change payload")
        }
        return try encodeForCloud(plain)
    }

    private func decodeChangePayload(_ data: Data, path: String) async throws -> ChangeEntry {
        let decoded = try decodeFromCloud(data)
        let payload = try decoder.decode(MeshChangePayload.self, from: Data(decoded.utf8))
        guard payload.kind == "change" else {
            throw InterocitorError.remotePoisoned("invalid change payload at \(path)")
        }
        try await assertExpectedMeshId(payload.meshId)
        return payload.entry
    }

    private func encodeSnapshotPayload(_ snapshot: Snapshot) throws -> Data {
        guard let meshId = manifest?.meshId else {
            throw InterocitorError.remotePoisoned("manifest not loaded before snapshot encode")
        }
        let payload = MeshSnapshotPayload(meshId: meshId, kind: "snapshot", snapshot: snapshot)
        guard let plain = String(data: try encoder.encode(payload), encoding: .utf8) else {
            throw InterocitorError.remotePoisoned("failed to encode snapshot payload")
        }
        return try encodeForCloud(plain)
    }

    private func decodeSnapshotPayload(_ data: Data, path: String) async throws -> Snapshot {
        let decoded = try decodeFromCloud(data)
        let payload = try decoder.decode(MeshSnapshotPayload.self, from: Data(decoded.utf8))
        guard payload.kind == "snapshot" else {
            throw InterocitorError.remotePoisoned("invalid snapshot payload at \(path)")
        }
        try await assertExpectedMeshId(payload.meshId)
        return payload.snapshot
    }

    // MARK: - Manifest integrity

    private func jsonString(_ value: String) throws -> String {
        let stringEncoder = JSONEncoder()
        stringEncoder.outputFormatting = [.withoutEscapingSlashes]
        let data = try stringEncoder.encode(value)
        guard let encoded = String(data: data, encoding: .utf8) else {
            throw InterocitorError.remotePoisoned("failed to encode manifest JSON string")
        }
        return encoded
    }

    private func jsonOptionalString(_ value: String?) throws -> String {
        guard let value else { return "null" }
        return try jsonString(value)
    }

    private func manifestValue(
        _ manifest: Manifest,
        key: ManifestCodingKey,
        includeContentHash: Bool
    ) throws -> String? {
        switch key {
        case .generation: return String(manifest.generation)
        case .parentGeneration: return String(manifest.parentGeneration)
        case .writtenBy: return try jsonString(manifest.writtenBy)
        case .writtenAt: return try jsonString(manifest.writtenAt)
        case .contentHash:
            return includeContentHash ? try jsonString(manifest.contentHash) : nil
        case .version: return String(manifest.version)
        case .meshId: return try jsonString(manifest.meshId)
        case .schema: return String(manifest.schema)
        case .encrypted: return manifest.encrypted ? "true" : "false"
        case .server:
            let relayUrl = try jsonOptionalString(manifest.server.relayUrl)
            let managed = manifest.server.managed ? "true" : "false"
            let serverId = try jsonString(manifest.server.serverId)
            return "{\"managed\":\(managed),\"relayUrl\":\(relayUrl),\"serverId\":\(serverId)}"
        case .createdAt: return try jsonString(manifest.createdAt)
        case .epoch: return String(manifest.epoch)
        case .watermarkHlc: return try jsonString(manifest.watermarkHlc)
        case .snapshotPath: return try jsonOptionalString(manifest.snapshotPath)
        case .deltaPath: return try jsonOptionalString(manifest.deltaPath)
        }
    }

    private func manifestJSON(
        _ manifest: Manifest,
        order: [ManifestCodingKey],
        includeContentHash: Bool
    ) throws -> String {
        var fields: [String] = []
        for key in order {
            guard let value = try manifestValue(manifest, key: key, includeContentHash: includeContentHash) else {
                continue
            }
            fields.append("\(try jsonString(key.rawValue)):\(value)")
        }
        return "{\(fields.joined(separator: ","))}"
    }

    private func manifestHash(_ manifest: Manifest, order: [ManifestCodingKey]) throws -> String {
        let payload = try manifestJSON(manifest, order: order, includeContentHash: false)
        let digest = SHA256.hash(data: Data(payload.utf8))
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        return "sha256:\(hex)"
    }

    private func preparedManifest(_ manifest: Manifest) throws -> (manifest: Manifest, data: Data) {
        var signed = manifest
        signed.contentHash = try manifestHash(signed, order: coreManifestKeyOrder)
        let wireJSON = try manifestJSON(signed, order: coreManifestKeyOrder, includeContentHash: true)
        return (signed, Data(wireJSON.utf8))
    }

    private func writeManifest(
        _ manifest: Manifest,
        path: String,
        adapter: any StorageAdapter
    ) async throws -> Manifest {
        let prepared = try preparedManifest(manifest)
        try await adapter.writeFile(path: path, data: prepared.data)
        return prepared.manifest
    }

    private func validateManifest(_ manifest: Manifest) throws {
        let expectedHashes = try [
            manifestHash(manifest, order: coreManifestKeyOrder),
            manifestHash(manifest, order: sortedManifestKeyOrder),
        ]
        guard expectedHashes.contains(manifest.contentHash) else {
            throw InterocitorError.contentHashMismatch
        }
        guard manifest.version == 3 else {
            throw InterocitorError.manifestVersionUnsupported(manifest.version)
        }
        if let localSchema = config.schema?.version, manifest.schema != localSchema {
            emit(.schemaMismatch(local: localSchema, remote: manifest.schema))
            throw InterocitorError.schemaMismatch(local: localSchema, remote: manifest.schema)
        }
        guard manifest.encrypted == encrypted else {
            throw InterocitorError.meshEncryptionMismatch(local: encrypted, remote: manifest.encrypted)
        }
        if manifest.server.managed, manifest.writtenBy != config.serverId {
            throw InterocitorError.unauthorized(manifest.writtenBy)
        }
    }

    // MARK: - Private helpers

    private func requireAdapter(_ operation: String) throws -> any StorageAdapter {
        if let remotePoisonError { throw remotePoisonError }
        guard let adapter else { throw InterocitorError.adapterRequired(operation) }
        return adapter
    }

    private func loadLocalState() async throws {
        tables = [:]
        knownTables = []
        if let hlcRaw = try await local.getMeta(key: "hlc") as? AnyCodable,
           let hlcStr = hlcRaw.stringValue {
            var parsed = hlcParse(hlcStr)
            parsed.nodeId = deviceId
            hlc = parsed
        }
        let names = try await local.getTableNames()
        for name in names { knownTables.insert(name) }
    }

    private func ensureRowsCached(ops: [Op]) async throws {
        for op in ops {
            if tables[op.table]?[op.rowId] != nil { continue }
            if let existing = try await local.getRow(table: op.table, rowId: op.rowId) {
                if tables[op.table] == nil { tables[op.table] = [:] }
                tables[op.table]![op.rowId] = existing
            }
        }
    }

    private func resetRemoteSyncState() async throws {
        manifest  = nil
        remotePoisonError = nil
        connected = false
        try await local.setMeta(key: "cursor", value: AnyCodable.string(""))
        try await local.setMeta(key: "epoch", value: AnyCodable.int(0))
        try await local.setMeta(key: "meshId", value: AnyCodable.string(""))
    }

    private func rebuildOutboxFromLocalState() async throws -> Int {
        let rows = try await local.getAllRows()
        var entries: [ChangeEntry] = []
        for row in rows {
            guard let op = rowToSyncOp(row) else { continue }
            let hlcStr = getRowHlc(row)
            guard !hlcStr.isEmpty else { continue }
            let entry = ChangeEntry(
                id: "chg_\(Interocitor.randomHex(8))",
                ts: Int64(Date().timeIntervalSince1970 * 1000),
                device: deviceId,
                hlc: hlcStr,
                ops: [op]
            )
            entries.append(entry)
        }
        // Remote migration replaces the outbox in one local transaction. A
        // crash therefore leaves either the prior durable queue or the full
        // state-republication queue, never an empty gap between them.
        try await local.replaceOutbox(entries)
        pendingCount = entries.count
        return entries.count
    }

    private func rowToSyncOp(_ row: Row) -> Op? {
        if row._deleted {
            guard let hlcStr = row._deletedHlc ?? (getRowHlc(row).isEmpty ? nil : getRowHlc(row)) else { return nil }
            return .delete(DeleteOp(table: row._table, rowId: row._rowId, hlc: hlcStr))
        }
        if row.columns.isEmpty { return nil }
        return .upsert(UpsertOp(table: row._table, rowId: row._rowId, columns: row.columns))
    }

    private func getRowHlc(_ row: Row) -> String {
        var latest = row._deletedHlc ?? ""
        for entry in row.columns.values {
            if latest.isEmpty || hlcCompareStr(entry.hlc, latest) > 0 { latest = entry.hlc }
        }
        return latest
    }

    private func loadOrCreateManifest() async throws {
        guard let adapter else { return }
        let p = CloudPaths(root: config.remotePath)

        if (try? await adapter.readFile(path: p.manifestPointer)) == nil {
            try await createBootstrapManifest()
        }

        let pointerData = try await adapter.readFile(path: p.manifestPointer)
        let pointer = try decoder.decode(ManifestPointer.self, from: pointerData)
        let manifestData = try await adapter.readFile(path: "\(config.remotePath)/\(pointer.file)")
        let loaded = try decoder.decode(Manifest.self, from: manifestData)

        try validateManifest(loaded)
        do {
            // A valid manifest from another mesh is still unsafe. Bind it to
            // the persisted local identity before any pull or flush can act
            // on it, as Core does when it loads the manifest.
            try await assertExpectedMeshId(loaded.meshId)
        } catch {
            throw poisonRemote(error, path: "\(config.remotePath)/\(pointer.file)")
        }
        manifest = loaded
    }

    private func createBootstrapManifest() async throws {
        guard let adapter else { return }
        let p = CloudPaths(root: config.remotePath)
        let now = ISO8601DateFormatter().string(from: Date())

        let bootstrapManifest = Manifest(
            generation: 1,
            parentGeneration: 0,
            writtenBy: config.serverId,
            writtenAt: now,
            contentHash: "",
            version: 3,
            meshId: "mesh_\(Interocitor.randomHex(8))",
            schema: config.schema?.version ?? 1,
            encrypted: encrypted,
            server: ServerConfig(managed: config.serverManaged, relayUrl: nil, serverId: config.serverId),
            createdAt: now,
            epoch: 0,
            watermarkHlc: "",
            snapshotPath: nil,
            deltaPath: nil
        )

        _ = try await writeManifest(
            bootstrapManifest,
            path: p.manifestFile(1),
            adapter: adapter
        )

        let pointer = ManifestPointer(currentGeneration: 1, file: "manifest-1.json")
        let pointerData = try encoder.encode(pointer)
        try await adapter.writeFile(path: p.manifestPointer, data: pointerData)
    }

    private func acknowledgeManifest() async throws {
        guard let manifest else { return }
        // Epoch zero has no canonical watermark to acknowledge. Presence
        // was already written during connect, so avoid needless device writes.
        if manifest.epoch == 0, manifest.watermarkHlc.isEmpty {
            return
        }
        try await upsertDeviceMetadata(acknowledgeManifest: true)
    }

    private func upsertDeviceMetadata(acknowledgeManifest: Bool = false) async throws {
        guard let adapter else { return }
        let p = CloudPaths(root: config.remotePath)
        let now = ISO8601DateFormatter().string(from: Date())

        let existing = (try? await adapter.readFile(path: p.deviceFile(deviceId)))
            .flatMap { try? decoder.decode(DeviceMetadata.self, from: $0) }

        let metadata = DeviceMetadata(
            deviceId: deviceId,
            registeredAt: existing?.registeredAt ?? now,
            lastSeenAt: now,
            userId: existing?.userId,
            name: existing?.name,
            displayName: config.deviceName ?? existing?.displayName,
            deviceType: config.deviceType ?? existing?.deviceType,
            retired: existing?.retired,
            observedManifestGeneration: acknowledgeManifest ? manifest?.generation : existing?.observedManifestGeneration,
            observedEpoch: acknowledgeManifest ? manifest?.epoch : existing?.observedEpoch,
            observedWatermarkHlc: acknowledgeManifest ? manifest?.watermarkHlc : existing?.observedWatermarkHlc,
            observedAt: acknowledgeManifest ? now : existing?.observedAt,
            cutOffAt: existing?.cutOffAt,
            cutOffReason: existing?.cutOffReason
        )
        let data = try encoder.encode(metadata)
        try await adapter.writeFile(path: p.deviceFile(deviceId), data: data)
    }

    private func startPolling() {
        stopPolling()
        let interval = config.pollInterval
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
                guard !Task.isCancelled else { break }
                try? await self?.pull()
            }
        }
    }

    private func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }

    // MARK: - Utility

    static func randomHex(_ bytes: Int) -> String {
        var data = [UInt8](repeating: 0, count: bytes)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes, &data)
        return data.map { String(format: "%02x", $0) }.joined()
    }
}
