/**
 * MemoryLocalStore — In-memory implementation of LocalStoreAdapter
 *
 * Suitable for tests and short-lived sessions where persistence is not needed.
 * Mirrors the contract defined in LocalStoreAdapter.
 */

import Foundation

// MARK: - Where clause matching (mirrors local-store.ts matchesClause)

private func compareValues(_ a: AnyCodable, _ b: AnyCodable) -> Int {
    switch (a, b) {
    case (.int(let av), .int(let bv)):       return av < bv ? -1 : av > bv ? 1 : 0
    case (.double(let av), .double(let bv)): return av < bv ? -1 : av > bv ? 1 : 0
    case (.int(let av), .double(let bv)):    return Double(av) < bv ? -1 : Double(av) > bv ? 1 : 0
    case (.double(let av), .int(let bv)):    return av < Double(bv) ? -1 : av > Double(bv) ? 1 : 0
    case (.string(let av), .string(let bv)): return av < bv ? -1 : av > bv ? 1 : 0
    case (.bool(let av), .bool(let bv)):
        let ai = av ? 1 : 0; let bi = bv ? 1 : 0
        return ai < bi ? -1 : ai > bi ? 1 : 0
    default: return 0
    }
}

private func matchesClause(_ value: AnyCodable?, clause: WhereClause) -> Bool {
    guard let value, !value.isNull else { return false }
    switch clause.op {
    case .equals:
        return compareValues(value, clause.value ?? .null) == 0
    case .above:
        return compareValues(value, clause.value ?? .null) > 0
    case .aboveOrEqual:
        return compareValues(value, clause.value ?? .null) >= 0
    case .below:
        return compareValues(value, clause.value ?? .null) < 0
    case .belowOrEqual:
        return compareValues(value, clause.value ?? .null) <= 0
    case .between:
        let lo = compareValues(value, clause.lower ?? .null)
        let hi = compareValues(value, clause.upper ?? .null)
        let lowerOk = clause.lowerOpen ? lo > 0 : lo >= 0
        let upperOk = clause.upperOpen ? hi < 0 : hi <= 0
        return lowerOk && upperOk
    case .startsWith:
        guard case .string(let s) = value,
              case .string(let prefix) = clause.value else { return false }
        return s.hasPrefix(prefix)
    case .anyOf:
        return (clause.values ?? []).contains { compareValues(value, $0) == 0 }
    }
}

// MARK: - MemoryLocalStore

public actor MemoryLocalStore: LocalStoreAdapter {
    private var rows: [String: Row] = [:]              // key: "table/rowId"
    private var outbox: [ChangeEntry] = []
    private var cursors: [String: Int] = [:]
    private var meta: [String: Data] = [:]             // JSON-encoded values
    private var isOpen = false

    public init() {}

    private func rowKey(table: String, rowId: String) -> String { "\(table)/\(rowId)" }

    private func ensureOpen() throws {
        if !isOpen { throw InterocitorError.notOpened }
    }

    // MARK: Lifecycle

    public func open() async throws { isOpen = true }
    public nonisolated func close() { Task { await self._close() } }
    private func _close() { isOpen = false }

    // MARK: Rows

    public func getRow(table: String, rowId: String) async throws -> Row? {
        try ensureOpen()
        return rows[rowKey(table: table, rowId: rowId)]
    }

    public func putRow(_ row: Row) async throws {
        try ensureOpen()
        rows[rowKey(table: row._table, rowId: row._rowId)] = row
    }

    public func putRows(_ newRows: [Row]) async throws {
        try ensureOpen()
        for row in newRows {
            rows[rowKey(table: row._table, rowId: row._rowId)] = row
        }
    }

    public func getTable(_ table: String) async throws -> [Row] {
        try ensureOpen()
        return rows.values.filter { $0._table == table && !$0._deleted }
    }

    public func queryWhere(table: String, clause: WhereClause) async throws -> [Row] {
        let all = try await getTable(table)
        return all.filter { row in
            matchesClause(row.columns[clause.field]?.value, clause: clause)
        }
    }

    public func getAllRows() async throws -> [Row] {
        try ensureOpen()
        return Array(rows.values)
    }

    public func clearRows() async throws {
        try ensureOpen()
        rows = [:]
    }

    public func getTableNames() async throws -> [String] {
        try ensureOpen()
        var names = Set<String>()
        for row in rows.values { names.insert(row._table) }
        return Array(names).sorted()
    }

    // MARK: Outbox

    public func pushOutbox(_ entry: ChangeEntry) async throws {
        try ensureOpen()
        outbox.append(entry)
    }

    public func drainOutbox() async throws -> [ChangeEntry] {
        try ensureOpen()
        let drained = outbox
        outbox = []
        return drained
    }

    public func outboxSize() async throws -> Int {
        try ensureOpen()
        return outbox.count
    }

    // MARK: Cursors

    public func getCursor(deviceId: String) async throws -> Int {
        try ensureOpen()
        return cursors[deviceId] ?? 0
    }

    public func setCursor(deviceId: String, offset: Int) async throws {
        try ensureOpen()
        cursors[deviceId] = offset
    }

    public func getAllCursors() async throws -> [String: Int] {
        try ensureOpen()
        return cursors
    }

    // MARK: Meta (JSON-encoded)

    public func getMeta(key: String) async throws -> (any Codable & Sendable)? {
        try ensureOpen()
        guard let data = meta[key] else { return nil }
        let decoded = try JSONDecoder().decode(AnyCodable.self, from: data)
        return decoded
    }

    public func setMeta(key: String, value: (any Codable & Sendable)?) async throws {
        try ensureOpen()
        guard let value else { meta.removeValue(forKey: key); return }
        if let codable = value as? AnyCodable {
            meta[key] = try JSONEncoder().encode(codable)
        } else if let str = value as? String {
            meta[key] = try JSONEncoder().encode(AnyCodable.string(str))
        } else if let int = value as? Int {
            meta[key] = try JSONEncoder().encode(AnyCodable.int(int))
        } else if let dbl = value as? Double {
            meta[key] = try JSONEncoder().encode(AnyCodable.double(dbl))
        } else if let bool = value as? Bool {
            meta[key] = try JSONEncoder().encode(AnyCodable.bool(bool))
        }
    }

    public func clearAll() async throws {
        try ensureOpen()
        rows = [:]
        outbox = []
        cursors = [:]
        meta = [:]
    }
}
