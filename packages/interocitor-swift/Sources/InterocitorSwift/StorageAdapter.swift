/**
 * StorageAdapter — Remote backend protocol
 *
 * Implement this Swift protocol to connect Interocitor to a remote backend
 * (WebDAV, CloudKit, S3, in-memory test double, etc.).
 */

import Foundation

// MARK: - Protocol

public protocol StorageAdapter: Sendable {
    var name: String { get }

    // Auth
    func authenticate() async throws
    /// Returns whether this adapter has completed its own authentication.
    /// It is async so actor-backed adapters can safely read mutable auth state.
    func isAuthenticated() async -> Bool

    // Folder
    func ensureFolder(path: String) async throws
    func listFiles(path: String) async throws -> [FileEntry]
    func listFolders(path: String) async throws -> [String]

    // File CRUD
    func readFile(path: String) async throws -> Data
    func writeFile(path: String, data: Data) async throws
    func deleteFile(path: String) async throws

    // Metadata
    func getFileMetadata(path: String) async throws -> FileEntry?
}

// MARK: - In-memory adapter (for tests / offline)

/// Thread-safe in-memory storage adapter.
/// Suitable for unit tests and fully-offline use.
public actor MemoryStorageAdapter: StorageAdapter {
    public nonisolated let name = "memory"

    private var files: [String: Data] = [:]
    private var folders: Set<String> = []
    private var authenticated = true

    public init() {}

    public func isAuthenticated() async -> Bool { true }
    public func authenticate() async throws {}

    public func ensureFolder(path: String) async throws {
        folders.insert(path)
    }

    public func listFiles(path: String) async throws -> [FileEntry] {
        let prefix = path.hasSuffix("/") ? path : path + "/"
        return files.keys
            .filter { $0.hasPrefix(prefix) && !$0.dropFirst(prefix.count).contains("/") }
            .map { key in
                let name = String(key.dropFirst(prefix.count))
                return FileEntry(
                    name: name,
                    path: key,
                    size: files[key]?.count ?? 0,
                    modifiedTime: ISO8601DateFormatter().string(from: Date())
                )
            }
            .sorted { $0.name < $1.name }
    }

    public func listFolders(path: String) async throws -> [String] {
        let prefix = path.hasSuffix("/") ? path : path + "/"
        var result = Set<String>()
        for key in files.keys {
            if key.hasPrefix(prefix) {
                let rest = String(key.dropFirst(prefix.count))
                if let slash = rest.firstIndex(of: "/") {
                    result.insert(String(rest[rest.startIndex..<slash]))
                }
            }
        }
        return result.sorted()
    }

    public func readFile(path: String) async throws -> Data {
        guard let data = files[path] else {
            throw InterocitorError.fileNotFound(path)
        }
        return data
    }

    public func writeFile(path: String, data: Data) async throws {
        files[path] = data
        // Auto-create parent folder
        let parent = (path as NSString).deletingLastPathComponent
        if !parent.isEmpty { folders.insert(parent) }
    }

    public func deleteFile(path: String) async throws {
        files.removeValue(forKey: path)
    }

    public func getFileMetadata(path: String) async throws -> FileEntry? {
        guard let data = files[path] else { return nil }
        let name = (path as NSString).lastPathComponent
        return FileEntry(
            name: name,
            path: path,
            size: data.count,
            modifiedTime: ISO8601DateFormatter().string(from: Date())
        )
    }
}

// MARK: - LocalStoreAdapter protocol

/// Contract every local store implementation must satisfy.
public protocol LocalStoreAdapter: Sendable {
    func open() async throws
    nonisolated func close()

    func getRow(table: String, rowId: String) async throws -> Row?
    func putRow(_ row: Row) async throws
    func putRows(_ rows: [Row]) async throws
    func getTable(_ table: String) async throws -> [Row]
    func queryWhere(table: String, clause: WhereClause) async throws -> [Row]
    func getAllRows() async throws -> [Row]
    func clearRows() async throws
    func getTableNames() async throws -> [String]

    func pushOutbox(_ entry: ChangeEntry) async throws
    func drainOutbox() async throws -> [ChangeEntry]
    func outboxSize() async throws -> Int

    func getCursor(deviceId: String) async throws -> Int
    func setCursor(deviceId: String, offset: Int) async throws
    func getAllCursors() async throws -> [String: Int]

    func getMeta(key: String) async throws -> (any Codable & Sendable)?
    func setMeta(key: String, value: (any Codable & Sendable)?) async throws
    func clearAll() async throws
}

// MARK: - Errors

public enum InterocitorError: Error, LocalizedError, Sendable {
    case fileNotFound(String)
    case notOpened
    case adapterRequired(String)
    case manifestVersionUnsupported(Int)
    case schemaMismatch(local: Int, remote: Int)
    case meshEncryptionMismatch(local: Bool, remote: Bool)
    case snapshotDecryptionFailed
    case compactionNotAllowed
    case unauthorized(String)
    case contentHashMismatch
    case staleOutboxAtGcFloor(String)
    case remotePoisoned(String)

    public var errorDescription: String? {
        switch self {
        case .fileNotFound(let p):           return "File not found: \(p)"
        case .notOpened:                     return "Local store not opened"
        case .adapterRequired(let op):       return "No remote adapter configured for: \(op)"
        case .manifestVersionUnsupported(let v): return "Unsupported manifest version \(v)"
        case .schemaMismatch(let l, let r):  return "Schema mismatch: local=\(l) remote=\(r)"
        case .meshEncryptionMismatch(let local, let remote):
            return "Mesh encryption mismatch: local=\(local), remote=\(remote)"
        case .snapshotDecryptionFailed:      return "Failed to decrypt snapshot"
        case .compactionNotAllowed:          return "Compaction is allowed only for the authorized server writer"
        case .unauthorized(let w):           return "Unauthorized manifest writer: \(w)"
        case .contentHashMismatch:           return "Manifest content hash mismatch"
        case .staleOutboxAtGcFloor(let floor):
            return "Refusing to flush changes at or before gcFloorHlc \(floor); rehydrate required"
        case .remotePoisoned(let reason):    return "Remote poisoned: \(reason)"
        }
    }
}
