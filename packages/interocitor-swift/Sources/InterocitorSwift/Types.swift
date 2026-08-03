/**
 * interocitor-swift — Core type definitions
 *
 * Public and protocol-facing values for the Swift runtime.
 */

import Foundation

// MARK: - Column value

public typealias ColumnValue = AnyCodable

/// A JSON-compatible value that can be stored in a column.
///
/// The wire format intentionally accepts the same JSON surface as Core: scalar
/// values, arrays, objects, and null.  `Int` is preserved for ergonomic Swift
/// use, but both integer and floating-point cases encode as JSON numbers.
public enum AnyCodable: Codable, Sendable, Equatable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    case array([AnyCodable])
    case object([String: AnyCodable])
    case null

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let v = try? c.decode(Bool.self)   { self = .bool(v); return }
        if let v = try? c.decode(Int.self)    { self = .int(v); return }
        if let v = try? c.decode(Double.self) { self = .double(v); return }
        if let v = try? c.decode(String.self) { self = .string(v); return }
        if let v = try? c.decode([AnyCodable].self) { self = .array(v); return }
        if let v = try? c.decode([String: AnyCodable].self) { self = .object(v); return }
        throw DecodingError.typeMismatch(AnyCodable.self,
            .init(codingPath: decoder.codingPath,
                  debugDescription: "Unsupported column value type"))
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let v): try c.encode(v)
        case .int(let v):    try c.encode(v)
        case .double(let v): try c.encode(v)
        case .bool(let v):   try c.encode(v)
        case .array(let v):  try c.encode(v)
        case .object(let v): try c.encode(v)
        case .null:          try c.encodeNil()
        }
    }

    // MARK: Convenience accessors

    public var stringValue: String? {
        if case .string(let v) = self { return v }
        return nil
    }
    public var intValue: Int? {
        if case .int(let v) = self { return v }
        return nil
    }
    public var doubleValue: Double? {
        if case .double(let v) = self { return v }
        if case .int(let v) = self   { return Double(v) }
        return nil
    }
    public var boolValue: Bool? {
        if case .bool(let v) = self { return v }
        return nil
    }
    public var isNull: Bool {
        if case .null = self { return true }
        return false
    }
}

// MARK: - CRDT cell

/// CRDT cell: a column value paired with the serialized HLC that last wrote it.
public struct ColumnEntry: Codable, Sendable, Equatable {
    public var value: AnyCodable
    public var hlc: String   // serialized HLC

    public init(value: AnyCodable, hlc: String) {
        self.value = value
        self.hlc = hlc
    }
}

// MARK: - Operations

public struct UpsertOp: Codable, Sendable {
    public let type: String          // always "upsert"
    public let table: String
    public let rowId: String
    public var columns: [String: ColumnEntry]

    public init(table: String, rowId: String, columns: [String: ColumnEntry]) {
        self.type = "upsert"
        self.table = table
        self.rowId = rowId
        self.columns = columns
    }
}

public struct DeleteOp: Codable, Sendable {
    public let type: String          // always "delete"
    public let table: String
    public let rowId: String
    public let hlc: String

    public init(table: String, rowId: String, hlc: String) {
        self.type = "delete"
        self.table = table
        self.rowId = rowId
        self.hlc = hlc
    }
}

public enum Op: Codable, Sendable {
    case upsert(UpsertOp)
    case delete(DeleteOp)

    private enum CodingKeys: String, CodingKey { case type }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "upsert": self = .upsert(try UpsertOp(from: decoder))
        case "delete": self = .delete(try DeleteOp(from: decoder))
        default: throw DecodingError.dataCorruptedError(forKey: .type, in: c,
                     debugDescription: "Unknown op type: \(type)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .upsert(let op): try op.encode(to: encoder)
        case .delete(let op): try op.encode(to: encoder)
        }
    }

    public var table: String {
        switch self { case .upsert(let o): return o.table; case .delete(let o): return o.table }
    }
    public var rowId: String {
        switch self { case .upsert(let o): return o.rowId; case .delete(let o): return o.rowId }
    }
}

// MARK: - ChangeEntry

/// Serialized batch of CRDT operations written to a device-specific change log.
public struct ChangeEntry: Codable, Sendable {
    public var id: String
    public var ts: Int64
    public var device: String
    public var user: String?
    public var hlc: String
    public var ops: [Op]

    public init(id: String, ts: Int64, device: String, user: String? = nil,
                hlc: String, ops: [Op]) {
        self.id = id
        self.ts = ts
        self.device = device
        self.user = user
        self.hlc = hlc
        self.ops = ops
    }
}

// MARK: - Row

/// Row as stored in the local CRDT cache.
///
/// Swift keeps the historic convenience properties for source compatibility,
/// but its Codable representation is the Core wire shape:
/// `{ "_meta": { ... }, "payload": { field: { value, hlc } } }`.
/// The custom decoder accepts the former flat Swift representation too, so an
/// existing SQLite cache can be opened and rewritten safely.
public struct Row: Codable, Sendable {
    public var _table: String
    public var _rowId: String
    public var _deleted: Bool
    public var _deletedHlc: String?
    public var _schemaVersion: Int
    public var _owner: String?
    public var columns: [String: ColumnEntry]   // user columns

    public init(table: String, rowId: String, deleted: Bool = false,
                deletedHlc: String? = nil, schemaVersion: Int = 1,
                owner: String? = nil, columns: [String: ColumnEntry] = [:]) {
        self._table = table
        self._rowId = rowId
        self._deleted = deleted
        self._deletedHlc = deletedHlc
        self._schemaVersion = schemaVersion
        self._owner = owner
        self.columns = columns
    }

    private enum CodingKeys: String, CodingKey {
        case meta = "_meta"
        case payload
        case table = "_table"
        case rowId = "_rowId"
        case deleted = "_deleted"
        case deletedHlc = "_deletedHlc"
        case schemaVersion = "_schemaVersion"
        case owner = "_owner"
        case columns
    }

    private struct WireMeta: Codable, Sendable {
        var table: String
        var rowId: String
        var deleted: Bool
        var deletedHlc: String?
        var schemaVersion: Int
        var owner: String?
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if container.contains(.meta) {
            let meta = try container.decode(WireMeta.self, forKey: .meta)
            _table = meta.table
            _rowId = meta.rowId
            _deleted = meta.deleted
            _deletedHlc = meta.deletedHlc
            _schemaVersion = meta.schemaVersion
            _owner = meta.owner
            columns = try container.decodeIfPresent([String: ColumnEntry].self, forKey: .payload) ?? [:]
            return
        }

        // Legacy Swift local-cache representation.
        _table = try container.decode(String.self, forKey: .table)
        _rowId = try container.decode(String.self, forKey: .rowId)
        _deleted = try container.decodeIfPresent(Bool.self, forKey: .deleted) ?? false
        _deletedHlc = try container.decodeIfPresent(String.self, forKey: .deletedHlc)
        _schemaVersion = try container.decodeIfPresent(Int.self, forKey: .schemaVersion) ?? 1
        _owner = try container.decodeIfPresent(String.self, forKey: .owner)
        columns = try container.decodeIfPresent([String: ColumnEntry].self, forKey: .columns) ?? [:]
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(
            WireMeta(
                table: _table,
                rowId: _rowId,
                deleted: _deleted,
                deletedHlc: _deletedHlc,
                schemaVersion: _schemaVersion,
                owner: _owner
            ),
            forKey: .meta
        )
        try container.encode(columns, forKey: .payload)
    }
}

// MARK: - Snapshot

public struct Snapshot: Codable, Sendable {
    public var snapshotId: String
    public var timestamp: String
    public var hlc: String
    public var epoch: Int
    public var schemaVersion: Int
    public var tables: [String: [String: Row]]
}

public struct MeshChangePayload: Codable, Sendable {
    public var meshId: String
    public var kind: String
    public var entry: ChangeEntry
}

public struct MeshSnapshotPayload: Codable, Sendable {
    public var meshId: String
    public var kind: String
    public var snapshot: Snapshot
}

// MARK: - Manifest

public struct ServerConfig: Codable, Sendable {
    public var managed: Bool
    public var relayUrl: String?
    public var serverId: String
}

public struct ManifestPointer: Codable, Sendable {
    public var currentGeneration: Int
    public var file: String
}

public struct Manifest: Codable, Sendable {
    public var generation: Int
    public var parentGeneration: Int
    public var writtenBy: String
    public var writtenAt: String
    public var contentHash: String
    public var version: Int
    public var meshId: String
    public var schema: Int
    public var encrypted: Bool
    public var server: ServerConfig
    public var createdAt: String
    public var epoch: Int
    public var watermarkHlc: String
    public var snapshotPath: String?
    public var deltaPath: String?
}

// MARK: - Schema / merge policy

/// Built-in convergent merge strategy shared with `@interocitor/core`.
public enum MergeStrategy: String, Codable, Sendable {
    case lww
}

/// Per-table merge configuration. Field settings take precedence over the
/// table setting, then the database setting.
public struct TableMergeConfig: Sendable {
    public var strategy: MergeStrategy?
    public var fields: [String: MergeStrategy]

    public init(strategy: MergeStrategy? = nil, fields: [String: MergeStrategy] = [:]) {
        self.strategy = strategy
        self.fields = fields
    }
}

/// Protocol-relevant schema information for one Swift table.
///
/// Field descriptors and indexes are local implementation details in Core and
/// are intentionally not sent over the mesh. Merge policy is part of the
/// convergence contract and is represented here explicitly.
public struct TableSchema: Sendable {
    public var merge: TableMergeConfig?

    public init(merge: TableMergeConfig? = nil) {
        self.merge = merge
    }
}

/// Logical mesh schema and merge configuration.
///
/// Every schema defaults to LWW when no more specific strategy applies.
public struct DatabaseSchema: Sendable {
    public var version: Int?
    public var tables: [String: TableSchema]
    public var mergeStrategy: MergeStrategy?

    public init(
        version: Int? = nil,
        tables: [String: TableSchema] = [:],
        mergeStrategy: MergeStrategy? = nil
    ) {
        self.version = version
        self.tables = tables
        self.mergeStrategy = mergeStrategy
    }
}

// MARK: - Where clause

public enum WhereOperator: String, Sendable {
    case equals
    case above
    case aboveOrEqual
    case below
    case belowOrEqual
    case between
    case startsWith
    case anyOf
}

public struct WhereClause: Sendable {
    public var field: String
    public var op: WhereOperator
    public var value: AnyCodable?
    public var values: [AnyCodable]?
    public var lower: AnyCodable?
    public var upper: AnyCodable?
    public var lowerOpen: Bool
    public var upperOpen: Bool

    public init(field: String, op: WhereOperator,
                value: AnyCodable? = nil,
                values: [AnyCodable]? = nil,
                lower: AnyCodable? = nil,
                upper: AnyCodable? = nil,
                lowerOpen: Bool = false,
                upperOpen: Bool = false) {
        self.field = field
        self.op = op
        self.value = value
        self.values = values
        self.lower = lower
        self.upper = upper
        self.lowerOpen = lowerOpen
        self.upperOpen = upperOpen
    }
}

// MARK: - Events

public enum SyncEvent: Sendable {
    case syncStart
    case syncComplete(entriesMerged: Int)
    case syncError(Error)
    case remotePoisoned(error: Error, path: String?)
    case flushStart(entryCount: Int)
    case flushComplete
    case flushError(Error)
    case change(table: String, rowId: String, row: Row)
    case delete(table: String, rowId: String)
    case rehydrateStart
    case rehydrateComplete(rowCount: Int)
    case authRequired
    case authComplete
    case schemaMismatch(local: Int, remote: Int)
    case replicaError(adapter: String, error: Error)
}

public typealias SyncEventListener = @Sendable (SyncEvent) -> Void

// MARK: - Device info

public struct DeviceMetadata: Codable, Sendable {
    public var deviceId: String
    public var registeredAt: String
    public var lastSeenAt: String
    public var userId: String?
    public var name: String?
    public var displayName: String?
    public var deviceType: String?
    public var retired: Bool?
    public var observedManifestGeneration: Int?
    public var observedEpoch: Int?
    public var observedWatermarkHlc: String?
    public var observedAt: String?
    public var cutOffAt: String?
    public var cutOffReason: String?
}

public struct ChangesHead: Codable, Sendable {
    public var latestHlc: String
}

public struct FileEntry: Sendable {
    public var name: String
    public var path: String
    public var size: Int
    public var modifiedTime: String
    public var etag: String?
}
