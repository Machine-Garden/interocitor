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
        replicas: [ReplicaConfig] = []
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

        if !adapter.isAuthenticated() {
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
        hlc = hlcNow(hlc)
        let hlcStr = hlcSerialize(hlc)

        var columnEntries: [String: ColumnEntry] = [:]
        for (key, value) in columns {
            columnEntries[key] = ColumnEntry(value: value, hlc: hlcStr)
        }

        let op = UpsertOp(table: table, rowId: rowId, columns: columnEntries)
        try await ensureRowsCached(ops: [.upsert(op)])
        var row = applyOp(tables: &tables, op: .upsert(op), schemaVersion: manifest?.schema ?? 1)!
        row._owner = deviceId
        knownTables.insert(table)

        try await local.putRow(row)
        try await local.setMeta(key: "hlc", value: AnyCodable.string(hlcSerialize(hlc)))

        let entry = ChangeEntry(
            id: "chg_\(Interocitor.randomHex(8))",
            ts: Int64(Date().timeIntervalSince1970 * 1000),
            device: deviceId,
            user: userId,
            hlc: hlcStr,
            ops: [.upsert(op)]
        )
        try await local.pushOutbox(entry)
        emit(.change(table: table, rowId: rowId, row: row))
        scheduleFlush()
        return row
    }

    /// Soft-delete a row.
    public func delete(table: String, rowId: String, userId: String? = nil) async throws {
        hlc = hlcNow(hlc)
        let hlcStr = hlcSerialize(hlc)

        let op = DeleteOp(table: table, rowId: rowId, hlc: hlcStr)
        try await ensureRowsCached(ops: [.delete(op)])
        applyOp(tables: &tables, op: .delete(op), schemaVersion: manifest?.schema ?? 1)

        if let row = tables[table]?[rowId] { try await local.putRow(row) }
        try await local.setMeta(key: "hlc", value: AnyCodable.string(hlcSerialize(hlc)))

        let entry = ChangeEntry(
            id: "chg_\(Interocitor.randomHex(8))",
            ts: Int64(Date().timeIntervalSince1970 * 1000),
            device: deviceId,
            user: userId,
            hlc: hlcStr,
            ops: [.delete(op)]
        )
        try await local.pushOutbox(entry)
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

        let entries = try await local.drainOutbox()
        guard !entries.isEmpty else { return }

        emit(.flushStart(entryCount: entries.count))
        pendingCount = 0
        cancelFlushTimer()

        do {
            let adapter = try requireAdapter("flush()")
            try await flushToAdapter(adapter, remotePath: config.remotePath, entries: entries, isPrimary: true)

            for replica in config.replicas {
                do {
                    if !replica.adapter.isAuthenticated() { try await replica.adapter.authenticate() }
                    let path = replica.remotePath ?? config.remotePath
                    try await flushToAdapter(replica.adapter, remotePath: path, entries: entries, isPrimary: false)
                } catch {
                    emit(.replicaError(adapter: replica.adapter.name, error: error))
                }
            }
            emit(.flushComplete)
        } catch {
            for entry in entries { try await local.pushOutbox(entry) }
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
            let p = CloudPaths(root: config.remotePath)

            let cursorRaw = try await local.getMeta(key: "cursor")
            let cursor = (cursorRaw as? AnyCodable)?.stringValue ?? ""

            // Fast path: head unchanged
            if let headData = try? await adapter.readFile(path: p.changesHead),
               let head = try? decoder.decode(ChangesHead.self, from: headData),
               !cursor.isEmpty,
               hlcCompareStr(head.latestHlc, cursor) <= 0 {
                emit(.syncComplete(entriesMerged: 0))
                return
            }

            guard let files = try? await adapter.listFiles(path: p.changesFolder) else {
                emit(.syncComplete(entriesMerged: 0))
                return
            }

            let sorted = files.filter { $0.name != "head.json" }
                              .sorted { $0.name < $1.name }

            var totalMerged = 0
            var latestMergedHlc = cursor

            for file in sorted {
                do {
                    guard let chgRange = file.name.range(of: "-chg_", options: .backwards) else { continue }
                    let fileHlc = String(file.name[file.name.startIndex..<chgRange.lowerBound])
                    if !cursor.isEmpty && hlcCompareStr(fileHlc, cursor) <= 0 { continue }

                    let rawData = try await adapter.readFile(path: file.path)
                    let entry = try await decodeChangePayload(rawData, path: file.path)
                    if !cursor.isEmpty && hlcCompareStr(entry.hlc, cursor) <= 0 { continue }

                    let remoteHlc = hlcParse(entry.hlc)
                    hlc = hlcReceive(hlc, remoteHlc)

                    try await ensureRowsCached(ops: entry.ops)
                    let affected = applyChangeEntry(tables: &tables, entry: entry, schemaVersion: manifest?.schema ?? 1)

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
                } catch {
                    throw poisonRemote(error, path: file.path)
                }
            }

            if !latestMergedHlc.isEmpty && latestMergedHlc != cursor {
                try await local.setMeta(key: "cursor", value: AnyCodable.string(latestMergedHlc))
            }
            try await local.setMeta(key: "hlc", value: AnyCodable.string(hlcSerialize(hlc)))
            emit(.syncComplete(entriesMerged: totalMerged))
        } catch {
            emit(.syncError(error))
            throw error
        }
    }

    // MARK: - Rehydrate (from snapshot)

    /// Rebuild local store from the current remote snapshot, then pull newer changes.
    public func rehydrate() async throws {
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

            try await local.clearAll()
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

        let manifestData = try encoder.encode(nextManifest)
        try await adapter.writeFile(path: p.manifestFile(nextGeneration), data: manifestData)

        let pointer = ManifestPointer(currentGeneration: nextGeneration, file: "manifest-\(nextGeneration).json")
        let pointerData = try encoder.encode(pointer)
        try await adapter.writeFile(path: p.manifestPointer, data: pointerData)

        manifest = nextManifest
        try await local.setMeta(key: "epoch", value: AnyCodable.int(nextEpoch))

        // Prune change files captured in the snapshot
        let watermarkHlc = nextManifest.watermarkHlc
        do {
            let files = try await adapter.listFiles(path: p.changesFolder)
            for file in files {
                guard file.name != "head.json",
                      let chgRange = file.name.range(of: "-chg_", options: .backwards) else { continue }
                let fileHlc = String(file.name[file.name.startIndex..<chgRange.lowerBound])
                if hlcCompareStr(fileHlc, watermarkHlc) <= 0 {
                    try? await adapter.deleteFile(path: file.path)
                }
            }
        } catch { /* pruning is non-fatal */ }
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
        _ = try await local.drainOutbox()
        let rows = try await local.getAllRows()
        var queued = 0
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
            try await local.pushOutbox(entry)
            queued += 1
        }
        pendingCount = queued
        return queued
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

        if loaded.version != 3 { throw InterocitorError.manifestVersionUnsupported(loaded.version) }
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
            schema: 1,
            encrypted: false,
            server: ServerConfig(managed: config.serverManaged, relayUrl: nil, serverId: config.serverId),
            createdAt: now,
            epoch: 0,
            watermarkHlc: "",
            snapshotPath: nil,
            deltaPath: nil
        )

        let manifestData = try encoder.encode(bootstrapManifest)
        try await adapter.writeFile(path: p.manifestFile(1), data: manifestData)

        let pointer = ManifestPointer(currentGeneration: 1, file: "manifest-1.json")
        let pointerData = try encoder.encode(pointer)
        try await adapter.writeFile(path: p.manifestPointer, data: pointerData)
    }

    private func upsertDeviceMetadata() async throws {
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
            retired: existing?.retired
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
