// compass: interocitor.rows.local-store

/**
 * IndexedSQLiteStore — SQLite-backed LocalStoreAdapter
 *
 * Maps IndexedDB-like concepts onto SQLite:
 *  - rows table       → object store keyed by (table, rowId)
 *  - outbox table     → FIFO queue of pending ChangeEntry JSON blobs
 *  - cursors table    → per-device byte offset
 *  - meta table       → key/value string store
 *
 * Uses the SQLite3 C library shipped with macOS and iOS. The Swift package
 * links `sqlite3` directly and does not require a third-party SQLite wrapper.
 */

import Foundation
import SQLite3

// MARK: - Configuration

public struct IndexedSQLiteStoreConfiguration: Sendable {
    /// Directory where the database file is stored.
    public var databasePath: String
    /// File name (without path) of the SQLite database.
    public var databaseName: String

    public init(databasePath: String, databaseName: String) {
        self.databasePath = databasePath
        self.databaseName = databaseName
    }

    var fullPath: String {
        (databasePath as NSString).appendingPathComponent(databaseName)
    }
}

// MARK: - IndexedSQLiteStore

/// SQLite-backed local store implementing `LocalStoreAdapter`.
///
/// All access is serialised through Swift's actor model — callers do not need
/// additional locking.
public actor IndexedSQLiteStore: LocalStoreAdapter {

    public let configuration: IndexedSQLiteStoreConfiguration
    private var db: OpaquePointer?

    public init(configuration: IndexedSQLiteStoreConfiguration) {
        self.configuration = configuration
    }

    // MARK: - Lifecycle

    public func open() async throws {
        try FileManager.default.createDirectory(
            atPath: configuration.databasePath,
            withIntermediateDirectories: true
        )
        let rc = sqlite3_open(configuration.fullPath, &db)
        guard rc == SQLITE_OK else {
            let msg = db.map { String(cString: sqlite3_errmsg($0)) } ?? "unknown"
            throw SQLiteError.open(msg)
        }
        try enableWAL()
        try createSchema()
    }

    public func close() async throws {
        guard let handle = db else { return }
        let rc = sqlite3_close(handle)
        guard rc == SQLITE_OK else {
            throw SQLiteError.close(String(cString: sqlite3_errmsg(handle)))
        }
        db = nil
    }

    // MARK: - Schema bootstrap

    private func enableWAL() throws {
        try exec("PRAGMA journal_mode=WAL;")
        try exec("PRAGMA foreign_keys=ON;")
    }

    private func createSchema() throws {
        try exec("""
        CREATE TABLE IF NOT EXISTS rows (
            tbl       TEXT    NOT NULL,
            row_id    TEXT    NOT NULL,
            data      TEXT    NOT NULL,
            deleted   INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (tbl, row_id)
        );
        CREATE INDEX IF NOT EXISTS idx_rows_tbl ON rows(tbl, deleted);

        CREATE TABLE IF NOT EXISTS outbox (
            seq  INTEGER PRIMARY KEY AUTOINCREMENT,
            data TEXT    NOT NULL
        );

        CREATE TABLE IF NOT EXISTS cursors (
            device_id TEXT PRIMARY KEY,
            offset    INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS meta (
            key   TEXT PRIMARY KEY,
            value TEXT
        );
        """)
    }

    // MARK: - Rows

    public func getRow(table: String, rowId: String) async throws -> Row? {
        let sql = "SELECT data FROM rows WHERE tbl=? AND row_id=? LIMIT 1;"
        var stmt: OpaquePointer?
        try prepare(sql, &stmt)
        defer { sqlite3_finalize(stmt) }
        bind(stmt, 1, text: table)
        bind(stmt, 2, text: rowId)
        guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }
        guard let json = column(stmt, 0) else { return nil }
        return try decode(Row.self, from: json)
    }

    public func putRow(_ row: Row) async throws {
        let json = try encode(row)
        let sql = "INSERT OR REPLACE INTO rows(tbl, row_id, data, deleted) VALUES(?,?,?,?);"
        var stmt: OpaquePointer?
        try prepare(sql, &stmt)
        defer { sqlite3_finalize(stmt) }
        bind(stmt, 1, text: row._table)
        bind(stmt, 2, text: row._rowId)
        bind(stmt, 3, text: json)
        bind(stmt, 4, int: row._deleted ? 1 : 0)
        try step(stmt)
    }

    public func putRows(_ rows: [Row]) async throws {
        guard !rows.isEmpty else { return }
        try exec("BEGIN;")
        do {
            for row in rows { try await putRow(row) }
            try exec("COMMIT;")
        } catch {
            try? exec("ROLLBACK;")
            throw error
        }
    }

    public func getTable(_ table: String) async throws -> [Row] {
        let sql = "SELECT data FROM rows WHERE tbl=? AND deleted=0;"
        return try queryRows(sql: sql, bindings: [table])
    }

    public func queryWhere(table: String, clause: WhereClause) async throws -> [Row] {
        // Predicate evaluation uses an in-memory full-table scan.
        let all = try await getTable(table)
        return all.filter { row in
            matchesWhereClause(value: row.columns[clause.field]?.value, clause: clause)
        }
    }

    public func getAllRows() async throws -> [Row] {
        let sql = "SELECT data FROM rows;"
        return try queryRows(sql: sql, bindings: [])
    }

    public func clearRows() async throws {
        try exec("DELETE FROM rows;")
    }

    public func getTableNames() async throws -> [String] {
        let sql = "SELECT DISTINCT tbl FROM rows;"
        var stmt: OpaquePointer?
        try prepare(sql, &stmt)
        defer { sqlite3_finalize(stmt) }
        var names: [String] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            if let t = column(stmt, 0) { names.append(t) }
        }
        return names
    }

    // MARK: - Outbox

    public func pushOutbox(_ entry: ChangeEntry) async throws {
        let json = try encode(entry)
        let sql = "INSERT INTO outbox(data) VALUES(?);"
        var stmt: OpaquePointer?
        try prepare(sql, &stmt)
        defer { sqlite3_finalize(stmt) }
        bind(stmt, 1, text: json)
        try step(stmt)
    }

    public func commitLocalMutation(row: Row, entry: ChangeEntry, hlc: String) async throws {
        try exec("BEGIN IMMEDIATE;")
        do {
            try await putRow(row)
            try await pushOutbox(entry)
            try await setMeta(key: "hlc", value: AnyCodable.string(hlc))
            try exec("COMMIT;")
        } catch {
            try? exec("ROLLBACK;")
            throw error
        }
    }

    public func peekOutbox() async throws -> [ChangeEntry] {
        try fetchOutbox()
    }

    public func acknowledgeOutbox(entryIds: [String]) async throws {
        let acknowledged = Set(entryIds)
        guard !acknowledged.isEmpty else { return }
        let sql = "SELECT seq, data FROM outbox ORDER BY seq ASC;"
        var select: OpaquePointer?
        try prepare(sql, &select)
        defer { sqlite3_finalize(select) }
        var sequences: [Int64] = []
        while sqlite3_step(select) == SQLITE_ROW {
            guard let json = column(select, 1),
                  let entry = try? decode(ChangeEntry.self, from: json),
                  acknowledged.contains(entry.id) else { continue }
            sequences.append(sqlite3_column_int64(select, 0))
        }
        try exec("BEGIN IMMEDIATE;")
        do {
            for sequence in sequences {
                var statement: OpaquePointer?
                try prepare("DELETE FROM outbox WHERE seq=?;", &statement)
                sqlite3_bind_int64(statement, 1, sequence)
                do {
                    try step(statement)
                    sqlite3_finalize(statement)
                } catch {
                    sqlite3_finalize(statement)
                    throw error
                }
            }
            try exec("COMMIT;")
        } catch {
            try? exec("ROLLBACK;")
            throw error
        }
    }

    public func replaceOutbox(_ entries: [ChangeEntry]) async throws {
        try exec("BEGIN IMMEDIATE;")
        do {
            try exec("DELETE FROM outbox;")
            for entry in entries {
                try await pushOutbox(entry)
            }
            try exec("COMMIT;")
        } catch {
            try? exec("ROLLBACK;")
            throw error
        }
    }

    public func drainOutbox() async throws -> [ChangeEntry] {
        let entries = try fetchOutbox()
        try exec("DELETE FROM outbox;")
        return entries
    }

    private func fetchOutbox() throws -> [ChangeEntry] {
        let sql = "SELECT data FROM outbox ORDER BY seq ASC;"
        var stmt: OpaquePointer?
        try prepare(sql, &stmt)
        defer { sqlite3_finalize(stmt) }
        var result: [ChangeEntry] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            if let json = column(stmt, 0),
               let entry = try? decode(ChangeEntry.self, from: json) {
                result.append(entry)
            }
        }
        return result
    }

    public func outboxSize() async throws -> Int {
        let sql = "SELECT COUNT(*) FROM outbox;"
        var stmt: OpaquePointer?
        try prepare(sql, &stmt)
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_step(stmt) == SQLITE_ROW else { return 0 }
        return Int(sqlite3_column_int64(stmt, 0))
    }

    // MARK: - Cursors

    public func getCursor(deviceId: String) async throws -> Int {
        let sql = "SELECT offset FROM cursors WHERE device_id=? LIMIT 1;"
        var stmt: OpaquePointer?
        try prepare(sql, &stmt)
        defer { sqlite3_finalize(stmt) }
        bind(stmt, 1, text: deviceId)
        guard sqlite3_step(stmt) == SQLITE_ROW else { return 0 }
        return Int(sqlite3_column_int64(stmt, 0))
    }

    public func setCursor(deviceId: String, offset: Int) async throws {
        let sql = "INSERT OR REPLACE INTO cursors(device_id, offset) VALUES(?,?);"
        var stmt: OpaquePointer?
        try prepare(sql, &stmt)
        defer { sqlite3_finalize(stmt) }
        bind(stmt, 1, text: deviceId)
        bind(stmt, 2, int: Int64(offset))
        try step(stmt)
    }

    public func getAllCursors() async throws -> [String: Int] {
        let sql = "SELECT device_id, offset FROM cursors;"
        var stmt: OpaquePointer?
        try prepare(sql, &stmt)
        defer { sqlite3_finalize(stmt) }
        var result: [String: Int] = [:]
        while sqlite3_step(stmt) == SQLITE_ROW {
            if let key = column(stmt, 0) {
                result[key] = Int(sqlite3_column_int64(stmt, 1))
            }
        }
        return result
    }

    // MARK: - Meta

    public func getMeta(key: String) async throws -> (any Codable & Sendable)? {
        let sql = "SELECT value FROM meta WHERE key=? LIMIT 1;"
        var stmt: OpaquePointer?
        try prepare(sql, &stmt)
        defer { sqlite3_finalize(stmt) }
        bind(stmt, 1, text: key)
        guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }
        guard let val = column(stmt, 0) else { return nil }
        // Values stored as JSON-encoded AnyCodable
        return try? JSONDecoder().decode(AnyCodable.self, from: Data(val.utf8))
    }

    public func setMeta(key: String, value: (any Codable & Sendable)?) async throws {
        if let value {
            let encoded: String
            if let ac = value as? AnyCodable {
                encoded = String(data: try JSONEncoder().encode(ac), encoding: .utf8) ?? "null"
            } else if let s = value as? String {
                encoded = String(data: try JSONEncoder().encode(AnyCodable.string(s)), encoding: .utf8) ?? "null"
            } else if let i = value as? Int {
                encoded = String(data: try JSONEncoder().encode(AnyCodable.int(i)), encoding: .utf8) ?? "null"
            } else if let d = value as? Double {
                encoded = String(data: try JSONEncoder().encode(AnyCodable.double(d)), encoding: .utf8) ?? "null"
            } else if let b = value as? Bool {
                encoded = String(data: try JSONEncoder().encode(AnyCodable.bool(b)), encoding: .utf8) ?? "null"
            } else {
                encoded = "null"
            }
            let sql = "INSERT OR REPLACE INTO meta(key, value) VALUES(?,?);"
            var stmt: OpaquePointer?
            try prepare(sql, &stmt)
            defer { sqlite3_finalize(stmt) }
            bind(stmt, 1, text: key)
            bind(stmt, 2, text: encoded)
            try step(stmt)
        } else {
            let sql = "DELETE FROM meta WHERE key=?;"
            var stmt: OpaquePointer?
            try prepare(sql, &stmt)
            defer { sqlite3_finalize(stmt) }
            bind(stmt, 1, text: key)
            try step(stmt)
        }
    }

    public func clearAll() async throws {
        try exec("BEGIN;")
        try exec("DELETE FROM rows;")
        try exec("DELETE FROM outbox;")
        try exec("DELETE FROM cursors;")
        try exec("DELETE FROM meta;")
        try exec("COMMIT;")
    }

    // MARK: - Private SQLite helpers

    private func exec(_ sql: String) throws {
        guard let db else { throw InterocitorError.notOpened }
        var errmsg: UnsafeMutablePointer<CChar>?
        let rc = sqlite3_exec(db, sql, nil, nil, &errmsg)
        if rc != SQLITE_OK {
            let msg = errmsg.map { String(cString: $0) } ?? "unknown"
            sqlite3_free(errmsg)
            throw SQLiteError.exec(msg)
        }
    }

    private func prepare(_ sql: String, _ stmt: inout OpaquePointer?) throws {
        guard let db else { throw InterocitorError.notOpened }
        let rc = sqlite3_prepare_v2(db, sql, -1, &stmt, nil)
        guard rc == SQLITE_OK else {
            throw SQLiteError.prepare(String(cString: sqlite3_errmsg(db)))
        }
    }

    private func step(_ stmt: OpaquePointer?) throws {
        let rc = sqlite3_step(stmt)
        guard rc == SQLITE_DONE || rc == SQLITE_ROW else {
            let msg = db.map { String(cString: sqlite3_errmsg($0)) } ?? "step failed"
            throw SQLiteError.step(msg)
        }
    }

    private func bind(_ stmt: OpaquePointer?, _ idx: Int32, text: String) {
        sqlite3_bind_text(stmt, idx, (text as NSString).utf8String, -1, nil)
    }

    private func bind(_ stmt: OpaquePointer?, _ idx: Int32, int: Int64) {
        sqlite3_bind_int64(stmt, idx, int)
    }

    private func column(_ stmt: OpaquePointer?, _ idx: Int32) -> String? {
        guard let raw = sqlite3_column_text(stmt, idx) else { return nil }
        return String(cString: raw)
    }

    private func queryRows(sql: String, bindings: [String]) throws -> [Row] {
        var stmt: OpaquePointer?
        try prepare(sql, &stmt)
        defer { sqlite3_finalize(stmt) }
        for (i, val) in bindings.enumerated() {
            bind(stmt, Int32(i + 1), text: val)
        }
        var results: [Row] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            if let json = column(stmt, 0),
               let row = try? decode(Row.self, from: json) {
                results.append(row)
            }
        }
        return results
    }

    // MARK: - JSON helpers

    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    private func encode<T: Encodable>(_ value: T) throws -> String {
        let data = try encoder.encode(value)
        return String(data: data, encoding: .utf8) ?? "{}"
    }

    private func decode<T: Decodable>(_ type: T.Type, from json: String) throws -> T {
        try decoder.decode(type, from: Data(json.utf8))
    }
}

// MARK: - Where clause matching

private func matchesWhereClause(value: AnyCodable?, clause: WhereClause) -> Bool {
    guard let value, !value.isNull else { return false }
    switch clause.op {
    case .equals:
        return value == (clause.value ?? .null)
    case .above:
        return cmpValues(value, clause.value ?? .null) > 0
    case .aboveOrEqual:
        return cmpValues(value, clause.value ?? .null) >= 0
    case .below:
        return cmpValues(value, clause.value ?? .null) < 0
    case .belowOrEqual:
        return cmpValues(value, clause.value ?? .null) <= 0
    case .between:
        let lo = cmpValues(value, clause.lower ?? .null)
        let hi = cmpValues(value, clause.upper ?? .null)
        return (clause.lowerOpen ? lo > 0 : lo >= 0) && (clause.upperOpen ? hi < 0 : hi <= 0)
    case .startsWith:
        if case .string(let s) = value, case .string(let p) = clause.value { return s.hasPrefix(p) }
        return false
    case .anyOf:
        return (clause.values ?? []).contains { value == $0 }
    }
}

private func cmpValues(_ a: AnyCodable, _ b: AnyCodable) -> Int {
    switch (a, b) {
    case (.int(let av), .int(let bv)):       return av < bv ? -1 : av > bv ? 1 : 0
    case (.double(let av), .double(let bv)): return av < bv ? -1 : av > bv ? 1 : 0
    case (.int(let av), .double(let bv)):    return Double(av) < bv ? -1 : Double(av) > bv ? 1 : 0
    case (.double(let av), .int(let bv)):    return av < Double(bv) ? -1 : av > Double(bv) ? 1 : 0
    case (.string(let av), .string(let bv)): return av < bv ? -1 : av > bv ? 1 : 0
    default: return 0
    }
}

// MARK: - SQLiteError

enum SQLiteError: Error, LocalizedError {
    case open(String)
    case close(String)
    case exec(String)
    case prepare(String)
    case step(String)

    var errorDescription: String? {
        switch self {
        case .open(let m):    return "SQLite open failed: \(m)"
        case .close(let m):   return "SQLite close failed: \(m)"
        case .exec(let m):    return "SQLite exec failed: \(m)"
        case .prepare(let m): return "SQLite prepare failed: \(m)"
        case .step(let m):    return "SQLite step failed: \(m)"
        }
    }
}
