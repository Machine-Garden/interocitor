import Foundation

public struct IndexedSQLiteStoreConfiguration: Sendable {
    public var databasePath: String
    public var databaseName: String

    public init(databasePath: String, databaseName: String) {
        self.databasePath = databasePath
        self.databaseName = databaseName
    }
}

public actor IndexedSQLiteStore {
    public let configuration: IndexedSQLiteStoreConfiguration

    public init(configuration: IndexedSQLiteStoreConfiguration) {
        self.configuration = configuration
    }

    public func open() async throws {
        // Placeholder for a SQLite-backed IndexedDB-style runtime.
        // Planned concepts: object stores, indexes, key ranges, transactions,
        // versioned migrations, and change feeds aligned with Interocitor local-store needs.
    }
}
